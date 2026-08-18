/**
 * Test di integrazione del database (LLD §3, §7.1; piano Task 1.3).
 * Girano su better-sqlite3 reale in-memory (nessun mock, LLD §8): migrano lo
 * schema a ogni test e verificano i vincoli dichiarati nel modello dati —
 * in particolare UNIQUE(profile_id, round) su pick, base del caso limite CL6
 * (un solo pick per profilo per round anche in caso di invii concorrenti) — e
 * la migrazione ADDITIVA di ADR-008: un DB pre-esistente senza la colonna
 * tournament_state.start_round la riceve senza perdere dati.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createConnection } from '../../src/db/connection.js';
import { migrate } from '../../src/db/schema.js';

/** Crea un DB in-memory migrato: setup comune di ogni test. */
function createMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** Inserisce un giocatore con il suo profilo e restituisce l'id del profilo. */
function insertProfile(db: Database.Database): number {
  const playerId = db
    .prepare("INSERT INTO player (email) VALUES ('mario@example.com')")
    .run().lastInsertRowid;
  return Number(
    db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(playerId).lastInsertRowid
  );
}

describe('migrate (schema LLD §3)', () => {
  it('crea tutte le tabelle del modello dati', () => {
    const db = createMigratedDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      'match',
      'pick',
      'player',
      'profile',
      'round_state',
      'sqlite_sequence',
      'tournament_state'
    ]);
    db.close();
  });

  it('è idempotente: rieseguirla non produce errori né perde dati', () => {
    const db = createMigratedDb();
    const profileId = insertProfile(db);

    migrate(db); // seconda esecuzione: deve essere un no-op

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
    expect(profileId).toBeGreaterThan(0);
    db.close();
  });
});

describe('vincoli pick', () => {
  it('UNIQUE(profile_id, round) respinge il secondo pick dello stesso profilo nello stesso round (CL6)', () => {
    const db = createMigratedDb();
    const profileId = insertProfile(db);
    const insertPick = db.prepare(
      "INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, ?, 'Inter', 'win')"
    );

    insertPick.run(profileId, 1);

    expect(() => insertPick.run(profileId, 1)).toThrowError(/UNIQUE/);
    // Lo stesso profilo può però fare pick in un round diverso.
    expect(() => insertPick.run(profileId, 2)).not.toThrow();
    db.close();
  });

  it("CHECK su outcome respinge un esito fuori enum ('win' | 'draw' | 'lose')", () => {
    const db = createMigratedDb();
    const profileId = insertProfile(db);

    expect(() =>
      db
        .prepare("INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, 1, 'Inter', 'draw?')")
        .run(profileId)
    ).toThrowError(/CHECK/);
    db.close();
  });
});

describe('vincoli profile (decisione 10 del piano)', () => {
  it("CHECK su eliminated_reason accetta solo 'missing_pick' | 'wrong_pick'", () => {
    const db = createMigratedDb();
    const playerId = db
      .prepare("INSERT INTO player (email) VALUES ('luigi@example.com')")
      .run().lastInsertRowid;

    expect(() =>
      db
        .prepare(
          "INSERT INTO profile (player_id, eliminated, eliminated_at, eliminated_reason) VALUES (?, 1, datetime('now'), 'cheating')"
        )
        .run(playerId)
    ).toThrowError(/CHECK/);

    // Profilo in gara: eliminated_at/eliminated_reason NULL sono ammessi.
    expect(() =>
      db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(playerId)
    ).not.toThrow();
    db.close();
  });
});

describe('migrazione additiva start_round (ADR-008, LLD §3)', () => {
  // Costruisce un DB "legacy" con la definizione di tournament_state priva di start_round.
  function createLegacyDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tournament_state (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        season_started    INTEGER NOT NULL DEFAULT 0,
        registration_open INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO tournament_state (id) VALUES (1)').run();
    return db;
  }

  it('aggiunge la colonna start_round a un DB pre-esistente senza perdere dati', () => {
    const db = createLegacyDb();
    expect(
      (db.prepare('PRAGMA table_info(tournament_state)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    ).not.toContain('start_round');

    migrate(db);

    const columns = (
      db.prepare('PRAGMA table_info(tournament_state)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('start_round');
    // La riga pre-esistente è preservata e la nuova colonna è NULL (TC 1 legacy).
    expect(db.prepare('SELECT id, start_round FROM tournament_state WHERE id = 1').get()).toEqual({
      id: 1,
      start_round: null
    });
    db.close();
  });

  it('è idempotente: rieseguire migrate() non duplica la colonna né perde dati', () => {
    const db = createLegacyDb();
    migrate(db);

    const before = (
      db.prepare('PRAGMA table_info(tournament_state)').all() as Array<{ name: string }>
    ).filter((c) => c.name === 'start_round').length;

    migrate(db); // seconda esecuzione: no-op

    const after = (
      db.prepare('PRAGMA table_info(tournament_state)').all() as Array<{ name: string }>
    ).filter((c) => c.name === 'start_round').length;
    expect(after).toBe(1);
    expect(before).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tournament_state').get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('createConnection', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('crea la directory del DB se assente e apre il file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'survivor-db-'));
    const dbPath = join(tmpDir, 'annidata', 'survivor.db');

    const db = createConnection(dbPath);
    migrate(db);
    db.close();

    const reopened = new Database(dbPath);
    expect(
      reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pick'").get()
    ).toEqual({ name: 'pick' });
    reopened.close();
  });
});
