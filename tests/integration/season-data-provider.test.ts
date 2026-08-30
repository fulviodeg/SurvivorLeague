/**
 * Test di integrazione del DbSeasonDataProvider (piano Task 2.2, LLD §6.1).
 *
 * Girano su DbSeasonDataProvider REALE su SQLite in-memory popolato con le
 * fixture sintetiche (tests/fixtures/season.ts, Task 2.5): nessun mock del
 * provider (LLD §8 — il provider non è mai mockato). Verificano: lettura
 * calendario/round/squadre/totale round, parsing del formato canonico
 * `match_date`, e la SEMANTICA di `getFirstMatchDateTime` per le partite
 * rinviate fissata dal briefing Fase 2 (§3-B) per il guard anti-frode RF-31:
 * MIN(match_date) tra i match NON rinviati, con fallback programmato se tutte
 * rinviate e `SeasonDataError` se il round non ha partite.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { SeasonDataError } from '../../src/data/provider.js';
import { migrate } from '../../src/db/schema.js';
import { loadBaseSeason, setMatchDate, setPostponedFlag, setScore } from '../fixtures/season.js';

/** Colonna `match_date` del primo match del round: usata nelle asserzioni temporali. */
const R1_EARLIEST = '2026-09-12T16:00:00.000Z';
const R1_LATER = '2026-09-12T18:45:00.000Z';

/** Crea un DB in-memory migrato con le fixture base caricate e il provider. */
function makeProvider(): { db: Database.Database; provider: DbSeasonDataProvider } {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  return { db, provider: new DbSeasonDataProvider(db) };
}

describe('DbSeasonDataProvider — calendario e query di base (LLD §6.1)', () => {
  it('getCalendar restituisce tutta la mini-stagione (12 partite) ordinata per round e orario', async () => {
    const { provider } = makeProvider();

    const calendar = await provider.getCalendar();
    expect(calendar).toHaveLength(12);
    // Ordinamento deterministico: per round, poi per match_date.
    for (let i = 1; i < calendar.length; i++) {
      const prev = calendar[i - 1]!;
      const curr = calendar[i]!;
      const prevKey = prev.round * 1_000_000 + prev.matchDate.getTime();
      const currKey = curr.round * 1_000_000 + curr.matchDate.getTime();
      expect(currKey).toBeGreaterThan(prevKey);
    }
  });

  it('getMatchesForRound filtra per round (2 partite nel primo round)', async () => {
    const { provider } = makeProvider();

    const round1 = await provider.getMatchesForRound(1);
    expect(round1).toHaveLength(2);
    expect(round1.every((m) => m.round === 1)).toBe(true);
  });

  it('getTotalRounds deriva MAX(round) dalla stagione importata', async () => {
    const { provider } = makeProvider();
    expect(await provider.getTotalRounds()).toBe(6);
  });

  it('getTeams deriva la lista canonica dalla UNION di home_team e away_team (distinta, ordinata)', async () => {
    const { provider } = makeProvider();

    const teams = await provider.getTeams();
    expect(teams).toHaveLength(4);
    expect(teams).toEqual(['AC Milan', 'AS Roma', 'FC Internazionale Milano', 'Juventus FC']);
  });

  it('getTeamsOrderedByShortName legge la tabella team ordinata per short_name (feature AUTOPICK)', async () => {
    const { db, provider } = makeProvider();
    // La tabella team NON è popolata dalle fixture base (BASE_MATCHES non ha
    // shortName): la popoliamo esplicitamente con l'upsert reale.
    db.prepare('INSERT INTO team (name, short_name) VALUES (?, ?)').run('Juventus FC', 'Juventus');
    db.prepare('INSERT INTO team (name, short_name) VALUES (?, ?)').run('FC Internazionale Milano', 'Inter');
    db.prepare('INSERT INTO team (name, short_name) VALUES (?, ?)').run('AC Milan', 'Milan');

    // Ordine alfabetico per short_name: Inter < Juventus < Milan.
    expect(await provider.getTeamsOrderedByShortName()).toEqual([
      { name: 'FC Internazionale Milano', shortName: 'Inter' },
      { name: 'Juventus FC', shortName: 'Juventus' },
      { name: 'AC Milan', shortName: 'Milan' }
    ]);
  });

  it('getTeamsOrderedByShortName su tabella team vuota → [] (nessun errore)', async () => {
    const { provider } = makeProvider();
    expect(await provider.getTeamsOrderedByShortName()).toEqual([]);
  });
});

describe('DbSeasonDataProvider — parsing match_date (formato canonico, briefing §1-B)', () => {
  it('converte match_date (ISO-8601 UTC) in una Date esatta', async () => {
    const { provider } = makeProvider();

    const [first] = await provider.getMatchesForRound(1);
    expect(first?.matchDate).toBeInstanceOf(Date);
    expect(first?.matchDate.toISOString()).toBe(R1_EARLIEST);
  });

  it('espone punteggi e stato postponed dalla tabella match (base Round Manager, nota CRITICAL-02)', async () => {
    const { db, provider } = makeProvider();
    setScore(db, 1, 'FC Internazionale Milano', 'AC Milan', 2, 1);
    setPostponedFlag(db, 1, 'Juventus FC', 'AS Roma');

    const round1 = await provider.getMatchesForRound(1);
    const played = round1.find((m) => m.homeTeam === 'FC Internazionale Milano')!;
    const postponed = round1.find((m) => m.homeTeam === 'Juventus FC')!;

    expect(played).toMatchObject({ homeScore: 2, awayScore: 1, postponed: false });
    expect(postponed).toMatchObject({ postponed: true });
    expect(postponed.homeScore).toBeUndefined();
    expect(postponed.awayScore).toBeUndefined();
  });
});

describe('DbSeasonDataProvider — getFirstMatchDateTime e RF-31 (briefing §3-B)', () => {
  it('restituisce MIN(match_date) della prima partita NON rinviata del round', async () => {
    const { provider } = makeProvider();
    expect((await provider.getFirstMatchDateTime(1)).toISOString()).toBe(R1_EARLIEST);
  });

  it('con la prima partita rinviata restituisce la prima NON rinviata del round', async () => {
    const { db, provider } = makeProvider();
    setPostponedFlag(db, 1, 'FC Internazionale Milano', 'AC Milan');

    // La partita delle 16:00 è rinviata → il kickoff effettivo è quello delle 18:45.
    const kickoff = await provider.getFirstMatchDateTime(1);
    expect(kickoff.toISOString()).toBe(R1_LATER);
  });

  it('con TUTTE le partite rinviate restituisce il MIN programmato del round (fallback documentato)', async () => {
    const { db, provider } = makeProvider();
    setPostponedFlag(db, 1, 'FC Internazionale Milano', 'AC Milan');
    setPostponedFlag(db, 1, 'Juventus FC', 'AS Roma');

    // Kickoff effettivo non noto a priori → valore di fallback = orario programmato più vicino.
    const kickoff = await provider.getFirstMatchDateTime(1);
    expect(kickoff.toISOString()).toBe(R1_EARLIEST);
  });

  it('il kickoff riflette i dati correnti (anticipo di calendario riprogrammato, RF-31/CL18)', async () => {
    const { db, provider } = makeProvider();
    // Il calendario anticipa la prima partita dopo l'apertura del round.
    setMatchDate(db, 1, 'FC Internazionale Milano', 'AC Milan', '2026-09-11T17:00:00Z');

    expect((await provider.getFirstMatchDateTime(1)).toISOString()).toBe(
      '2026-09-11T17:00:00.000Z'
    );
  });

  it('lancio SeasonDataError per un round senza partite in calendario', async () => {
    const { db, provider } = makeProvider();
    db.prepare('DELETE FROM match WHERE round = 2').run();

    await expect(provider.getFirstMatchDateTime(2)).rejects.toBeInstanceOf(SeasonDataError);
  });
});
