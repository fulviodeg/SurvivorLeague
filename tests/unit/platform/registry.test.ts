/**
 * Unit test del PlatformRegistry (ADR-009, piano Task 5 — TDD).
 *
 * Coprono: register (nuovo account con registerID stabile e created_at dal
 * clock iniettato, RF-P8), unsubscribe a due passi (beginUnsubscribe →
 * pending_unsubscribe senza soft-delete; confirmUnsubscribe → unsubscribed
 * con unsubscribed_at dal clock, RF-P2), reactivate con lo STESSO registerID
 * (RF-P3), unsubscribe da unsubscribed/sconosciuto → null (log silenzioso nel
 * chiamante), soft-delete diretto `unregister` (US8), `activeEmails` solo
 * `active` (RF-P6), `list` ordinata per register_id, migrazione idempotente.
 */
import Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';

/** Crea un DB piattaforma in-memory migrato + registry pronto. */
function makeRegistry(): DbPlatformRegistry {
  const db = new Database(':memory:');
  migratePlatform(db);
  return new DbPlatformRegistry(db);
}

describe('PlatformRegistry (ADR-009, RF-P1/P2/P3/P8)', () => {
  it('register di un nuovo mittente crea l\'account active con created_at dal clock iniettato (RF-P8)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    const account = registry.register('mario@example.com', null, now);

    expect(account.status).toBe('active');
    expect(account.registerId).toBe(1);
    expect(account.createdAt).toBe('2026-08-20T12:00:00.000Z');
    expect(account.unsubscribedAt).toBeNull();
  });

  it('register di una email già active è idempotente (stesso registerID, nessun duplicato)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    const first = registry.register('mario@example.com', null, now);
    const second = registry.register('mario@example.com', null, new Date('2026-08-21T12:00:00.000Z'));

    expect(second.registerId).toBe(first.registerId);
    expect(second.status).toBe('active');
    // La data di creazione originale non cambia alle riattivazioni.
    expect(second.createdAt).toBe(first.createdAt);
    expect(registry.list()).toHaveLength(1);
  });

  it('nome salvato SOLO alla prima creazione (ADR-011); assente → null', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    // Iscrizione con nome dedotto dalla mail.
    const withName = registry.register('mario@example.com', 'Mario', now);
    expect(withName.name).toBe('Mario');
    // Iscrizione senza nome → name null (il sistema userà l'email).
    const noName = registry.register('luigi@example.com', null, now);
    expect(noName.name).toBeNull();
    // Il nome NON viene sovrascritto alle riattivazioni (prima creazione vince).
    registry.beginUnsubscribe('mario@example.com', now);
    const reactivated = registry.register('mario@example.com', 'Mario Nuovo', now);
    expect(reactivated.name).toBe('Mario');
    expect(registry.find('mario@example.com')?.name).toBe('Mario');
  });

  it('beginUnsubscribe: active → pending_unsubscribe SENZA soft-delete (RF-P2)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);

    const pending = registry.beginUnsubscribe('mario@example.com', new Date('2026-08-22T12:00:00.000Z'));

    expect(pending?.status).toBe('pending_unsubscribe');
    expect(pending?.unsubscribedAt).toBeNull();
    // L'account NON è stato eliminato: esiste ancora e non è più active.
    expect(registry.find('mario@example.com')?.status).toBe('pending_unsubscribe');
    expect(registry.activeEmails()).toEqual([]);
  });

  it('confirmUnsubscribe: pending_unsubscribe → unsubscribed con unsubscribed_at dal clock (RF-P2)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);
    registry.beginUnsubscribe('mario@example.com', now);

    const confirmAt = new Date('2026-08-23T12:00:00.000Z');
    const unsubscribed = registry.confirmUnsubscribe('mario@example.com', confirmAt);

    expect(unsubscribed?.status).toBe('unsubscribed');
    expect(unsubscribed?.unsubscribedAt).toBe('2026-08-23T12:00:00.000Z');
    expect(registry.activeEmails()).toEqual([]);
  });

  it('confirmUnsubscribe da active/sconosciuto → null (mai soft-delete al primo messaggio)', () => {
    const registry = makeRegistry();
    registry.register('mario@example.com', null, new Date('2026-08-20T12:00:00.000Z'));

    expect(registry.confirmUnsubscribe('mario@example.com', new Date())).toBeNull();
    expect(registry.confirmUnsubscribe('sconosciuto@example.com', new Date())).toBeNull();
    expect(registry.find('mario@example.com')?.status).toBe('active');
  });

  it('beginUnsubscribe da unsubscribed o sconosciuto → null (log silenzioso nel chiamante)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);
    registry.beginUnsubscribe('mario@example.com', now);
    registry.confirmUnsubscribe('mario@example.com', now);

    expect(registry.beginUnsubscribe('mario@example.com', now)).toBeNull();
    expect(registry.beginUnsubscribe('sconosciuto@example.com', now)).toBeNull();
  });

  it('reactivate riporta ad active con lo STESSO registerID da pending e da unsubscribed (RF-P3)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    const original = registry.register('mario@example.com', null, now);

    registry.beginUnsubscribe('mario@example.com', now);
    const reactivated = registry.reactivate('mario@example.com', new Date('2026-08-24T12:00:00.000Z'));
    expect(reactivated?.registerId).toBe(original.registerId);
    expect(reactivated?.status).toBe('active');

    registry.beginUnsubscribe('mario@example.com', now);
    registry.confirmUnsubscribe('mario@example.com', now);
    const reSubscribed = registry.register('mario@example.com', null, new Date('2026-08-25T12:00:00.000Z'));
    expect(reSubscribed.registerId).toBe(original.registerId);
    expect(reSubscribed.status).toBe('active');
    expect(registry.list()).toHaveLength(1);
  });

  it('unregister (CLI, US8): soft-delete diretto con unsubscribed_at dal clock; sconosciuto → null', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);

    const unregistered = registry.unregister('mario@example.com', new Date('2026-08-26T12:00:00.000Z'));
    expect(unregistered?.status).toBe('unsubscribed');
    expect(unregistered?.unsubscribedAt).toBe('2026-08-26T12:00:00.000Z');

    expect(registry.unregister('sconosciuto@example.com', now)).toBeNull();
  });

  it('activeEmails restituisce SOLO gli account active (RF-P6) e list è ordinata per register_id', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('a@example.com', null, now);
    registry.register('b@example.com', null, now);
    registry.register('c@example.com', null, now);
    registry.beginUnsubscribe('b@example.com', now);

    expect(registry.activeEmails()).toEqual(['a@example.com', 'c@example.com']);
    expect(registry.list().map((a) => a.registerId)).toEqual([1, 2, 3]);
    expect(registry.list().map((a) => a.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com'
    ]);
  });

  it('find restituisce null per un mittente mai iscritto', () => {
    const registry = makeRegistry();
    expect(registry.find('sconosciuto@example.com')).toBeNull();
  });

  it('migratePlatform è idempotente (riesecuzione senza errori né perdita dati)', () => {
    const db = new Database(':memory:');
    migratePlatform(db);
    migratePlatform(db);
    const registry = new DbPlatformRegistry(db);
    registry.register('mario@example.com', null, new Date('2026-08-20T12:00:00.000Z'));
    migratePlatform(db);
    expect(registry.list()).toHaveLength(1);
  });
});

describe('PlatformRegistry — flag partecipazione opt-in (ADR-019, D2/D9)', () => {
  it('register scrive ENTRAMBI i flag a true alla PRIMA creazione (default opt-in)', () => {
    const registry = makeRegistry();
    const account = registry.register('mario@example.com', null, new Date('2026-08-20T12:00:00.000Z'));

    expect(account.receiveTournamentStartNotification).toBe(true);
    expect(account.tournamentAutoJoin).toBe(true);
  });

  it('le riattivazioni NON toccano i flag (registration-pure): una preferenza cambiata resta', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);
    // Cambio preferenza via setPreferences (auto-join OFF).
    registry.setPreferences('mario@example.com', { tournamentAutoJoin: false });
    // Disiscrizione + re-iscrizione: il flag resta OFF (non riasserito).
    registry.beginUnsubscribe('mario@example.com', now);
    registry.confirmUnsubscribe('mario@example.com', now);
    const reactivated = registry.register('mario@example.com', null, now);

    expect(reactivated.status).toBe('active');
    expect(reactivated.tournamentAutoJoin).toBe(false);
  });

  it('setPreferences aggiorna solo i campi indicati e non scrive timestamp', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('mario@example.com', null, now);

    const updated = registry.setPreferences('mario@example.com', { tournamentAutoJoin: false });

    expect(updated?.tournamentAutoJoin).toBe(false);
    // Il campo non indicato resta invariato.
    expect(updated?.receiveTournamentStartNotification).toBe(true);
    // created_at e unsubscribed_at restano quelli originali (nessuna data scritta).
    expect(updated?.createdAt).toBe('2026-08-20T12:00:00.000Z');
    expect(updated?.unsubscribedAt).toBeNull();
  });

  it('setPreferences con prefs vuoto è una sola lettura; account sconosciuto → null', () => {
    const registry = makeRegistry();
    registry.register('mario@example.com', null, new Date('2026-08-20T12:00:00.000Z'));

    expect(registry.setPreferences('mario@example.com', {})).toMatchObject({
      email: 'mario@example.com',
      tournamentAutoJoin: true
    });
    expect(registry.setPreferences('sconosciuto@example.com', { tournamentAutoJoin: false })).toBeNull();
  });

  it('find/list/activeAccounts espongono i due flag (booleani)', () => {
    const registry = makeRegistry();
    const now = new Date('2026-08-20T12:00:00.000Z');
    registry.register('a@example.com', null, now);
    registry.register('b@example.com', null, now);
    registry.setPreferences('b@example.com', { receiveTournamentStartNotification: false });
    registry.beginUnsubscribe('a@example.com', now); // a non è più active

    expect(registry.find('b@example.com')).toMatchObject({
      tournamentAutoJoin: true,
      receiveTournamentStartNotification: false
    });
    // activeAccounts: SOLO gli active (a escluso), con i flag.
    expect(registry.activeAccounts()).toEqual([
      expect.objectContaining({ email: 'b@example.com', tournamentAutoJoin: true, receiveTournamentStartNotification: false })
    ]);
    // list: TUTTI gli account (incluso a), flag inclusi.
    expect(registry.list().map((acc) => acc.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('migrazione additiva: un DB legacy senza le colonne le guadagna con default 1', () => {
    const db = new Database(':memory:');
    // Schema "legacy" (pre-opt-in): la DDL attuale include già le colonne, quindi
    // si ricrea la tabella senza i due flag per verificare la migrazione additiva.
    db.exec(`
      CREATE TABLE platform_account (
        register_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT NOT NULL UNIQUE,
        name            TEXT,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'pending_unsubscribe', 'unsubscribed')),
        created_at      TEXT NOT NULL,
        unsubscribed_at TEXT
      );
    `);
    db.prepare(
      "INSERT INTO platform_account (email, name, status, created_at) VALUES ('legacy@example.com', NULL, 'active', '2026-08-01T00:00:00.000Z')"
    ).run();

    migratePlatform(db);

    const registry = new DbPlatformRegistry(db);
    const account = registry.find('legacy@example.com');
    expect(account).toMatchObject({
      receiveTournamentStartNotification: true,
      tournamentAutoJoin: true
    });
  });
});
