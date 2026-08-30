/**
 * Test di integrazione dell'import stagione (piano Task 2.3, LLD §7.2).
 *
 * Verificano il contratto di `importMatches`/`upsertMatches` (src/data/importer.ts)
 * su SQLite in-memory reale con un CLIENT MOCKATO (il client API è il confine
 * esterno mockato nei test, LLD §8): import che popola le righe, idempotenza
 * (il secondo import con gli stessi dati non duplica né modifica), refresh che
 * AGGIORNA la riga (nuovo punteggio, rinvio recuperato con nuovo orario) e
 * atomicità senza stato parziale (un match malformato fa fallire TUTTO
 * l'import, il DB resta invariato).
 *
 * Nota: il formato `match_date` scritto è quello canonico ISO-8601 UTC
 * (`toISOString()`), richiesto dal briefing §1-B per i confronti lessicografici
 * di SQLite e il parsing del provider.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/schema.js';
import { importMatches, toMatchRow } from '../../src/data/importer.js';
import type { Match } from '../../src/data/provider.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { BASE_MATCHES } from '../fixtures/season.js';

/** Fake del client API: confina il mock al confine esterno (nessun fetch reale). */
function fakeClient(matches: Match[]): { getMatches(): Promise<Match[]> } {
  return { getMatches: async () => matches };
}

/** Crea un DB in-memory migrato. */
function createDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('data:import — popolamento e idempotenza (Task 2.3 §4-A)', () => {
  it('import popola la tabella match con tutte le partite della stagione', async () => {
    const db = createDb();

    const count = await importMatches(db, fakeClient(BASE_MATCHES));

    expect(count).toBe(BASE_MATCHES.length);
    const provider = new DbSeasonDataProvider(db);
    expect(await provider.getCalendar()).toHaveLength(BASE_MATCHES.length);
    expect(await provider.getTotalRounds()).toBe(6);
    db.close();
  });

  it('il secondo import con gli stessi dati è idempotente: nessun duplicato né modifica', async () => {
    const db = createDb();
    await importMatches(db, fakeClient(BASE_MATCHES));

    const before = await new DbSeasonDataProvider(db).getCalendar();
    await importMatches(db, fakeClient(BASE_MATCHES)); // secondo import

    const after = await new DbSeasonDataProvider(db).getCalendar();
    expect(after).toHaveLength(before.length); // nessun duplicato (PK (round, home_team, away_team))
    expect(after).toEqual(before); // nessuna modifica a parità di dati
    db.close();
  });
});

describe('data:refresh — aggiorna la riga esistente senza duplicarla (Task 2.3 §4-A/E)', () => {
  it('un refresh che aggiunge il punteggio aggiorna la riga (stesso round, stessa coppia)', async () => {
    const db = createDb();
    await importMatches(db, fakeClient(BASE_MATCHES));

    const scored = BASE_MATCHES.map((m) =>
      m.round === 1 && m.homeTeam === 'FC Internazionale Milano'
        ? { ...m, homeScore: 2, awayScore: 1 }
        : m
    );
    await importMatches(db, fakeClient(scored)); // refresh

    const provider = new DbSeasonDataProvider(db);
    const calendar = await provider.getCalendar();
    const played = calendar.find(
      (m) => m.round === 1 && m.homeTeam === 'FC Internazionale Milano'
    )!;
    expect(played.homeScore).toBe(2);
    expect(played.awayScore).toBe(1);
    // Aggiornamento, non inserimento: il numero di righe non cresce.
    expect(calendar).toHaveLength(BASE_MATCHES.length);
    db.close();
  });

  it('un rinvio recuperato con nuovo orario aggiorna match_date in formato canonico (non duplica)', async () => {
    const db = createDb();
    await importMatches(db, fakeClient(BASE_MATCHES));

    // Il match rinviato viene recuperato con una nuova utcDate (regola operativa rinvii, LLD §3.1).
    const rescheduled = BASE_MATCHES.map((m) =>
      m.round === 1 && m.homeTeam === 'Juventus FC'
        ? {
            ...m,
            postponed: false,
            homeScore: 1,
            awayScore: 1,
            matchDate: new Date('2026-09-13T14:00:00Z')
          }
        : m
    );
    await importMatches(db, fakeClient(rescheduled));

    const provider = new DbSeasonDataProvider(db);
    const calendar = await provider.getCalendar();
    const recovered = calendar.find((m) => m.round === 1 && m.homeTeam === 'Juventus FC')!;
    expect(recovered.matchDate.toISOString()).toBe('2026-09-13T14:00:00.000Z');
    expect(recovered.postponed).toBe(false);
    expect(recovered.homeScore).toBe(1);
    expect(calendar).toHaveLength(BASE_MATCHES.length);
    db.close();
  });
});

describe('data:import — popola la tabella team (feature AUTOPICK, D1)', () => {
  it('deriva name → short_name dai match con shortName e li upserta nella tabella team', async () => {
    const db = createDb();
    const matches = BASE_MATCHES.map((m) => ({
      ...m,
      homeTeamShort: `${m.homeTeam} SHORT`,
      awayTeamShort: `${m.awayTeam} SHORT`
    }));
    await importMatches(db, fakeClient(matches));

    const rows = db
      .prepare('SELECT name, short_name FROM team ORDER BY name')
      .all() as Array<{ name: string; short_name: string }>;
    // 4 squadre della mini-stagione, ognuna col proprio shortName derivato.
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.name === 'FC Internazionale Milano')).toMatchObject({
      short_name: 'FC Internazionale Milano SHORT'
    });
    db.close();
  });

  it('un match senza shortName NON crea righe nella tabella team (fallback sicuro)', async () => {
    const db = createDb();
    await importMatches(db, fakeClient(BASE_MATCHES)); // BASE_MATCHES senza shortName
    const n = (db.prepare('SELECT COUNT(*) AS n FROM team').get() as { n: number }).n;
    expect(n).toBe(0);
    db.close();
  });
});

describe('data:import — formato canonico match_date e atomicità (briefing §1-B, §4-C)', () => {
  it('scrive match_date in formato canonico ISO-8601 UTC (suffisso Z)', () => {
    const row = toMatchRow({ ...BASE_MATCHES[0]!, matchDate: new Date('2026-09-12T16:00:00Z') });
    expect(row.match_date).toBe('2026-09-12T16:00:00.000Z');
    expect(row.match_date.endsWith('Z')).toBe(true);
  });

  it('un match malformato (data invalida) fa fallire TUTTO l’import: nessuno stato parziale', async () => {
    const db = createDb();

    const mixed = [
      ...BASE_MATCHES.slice(0, 3),
      { ...BASE_MATCHES[3]!, matchDate: new Date(Number.NaN) }
    ];
    await expect(importMatches(db, fakeClient(mixed))).rejects.toThrow(/Invalid time value/);

    // Atomicità: la transazione è fallita prima di scrivere, il DB è vuoto.
    const provider = new DbSeasonDataProvider(db);
    expect(await provider.getCalendar()).toHaveLength(0);
    expect(await provider.getTotalRounds()).toBe(0);
    db.close();
  });
});
