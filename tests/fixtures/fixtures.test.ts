/**
 * Test delle fixture sintetiche (piano Task 2.5, "Dati stagione").
 *
 * Verificano il "loader a stadi" e gli helper di mutazione di
 * tests/fixtures/season.ts: la mini-stagione si carica nel DB in-memory dei
 * test con lo stesso formato riga di `match` di produzione (upsert condiviso
 * di src/data/importer.ts), e i casi limite di rinvio NON sono snapshot
 * statici ma SEQUENZE temporali simulate (import→refresh) con gli helper:
 *   - CL7  recupero giocato entro la finestra (rinviata → punteggio disponibile);
 *   - CL1  recupero fuori finestra non ancora giocato (rinviata, senza punteggio);
 *   - CL8  UPP (ultima partita programmata del TC) rinviata, senza punteggio;
 *   - frozen→valutato  partita giocata a recupero concluso con un refresh successivo;
 *   - RF-31/CL17 variazione: PRIMA partita del TC rinviata.
 * La classificazione "dentro/fuori finestra del TC" è del Round Manager
 * (Fase 3): qui i dati sono preparati nei loro stati intermedi.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import {
  BASE_MATCHES,
  FIXTURE_TEAMS,
  loadBaseSeason,
  setMatchDate,
  setPostponedFlag,
  setScore
} from './season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

/** Crea un DB in-memory migrato (vuoto) per ogni test. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** Legge un singolo match via provider (getMatchesForRound) per le asserzioni. */
async function match(db: Database.Database, round: number, home: string, away: string) {
  const m = (await new DbSeasonDataProvider(db).getMatchesForRound(round)).find(
    (x) => x.homeTeam === home && x.awayTeam === away
  );
  if (m === undefined) throw new Error(`match non trovato: R${round} ${home}-${away}`);
  return m;
}

describe('loader della mini-stagione base (2.5 §6-A)', () => {
  it('carica 12 partite (6 round × 2) nel DB in-memory, leggibili dal provider', async () => {
    const db = makeDb();
    const n = loadBaseSeason(db);
    expect(n).toBe(12);

    const provider = new DbSeasonDataProvider(db);
    expect(await provider.getCalendar()).toHaveLength(BASE_MATCHES.length);
    expect(await provider.getTotalRounds()).toBe(6);
    db.close();
  });

  it('ogni round ha esattamente 2 partite e la stagione copre le 4 squadre', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    const provider = new DbSeasonDataProvider(db);
    for (let round = 1; round <= 6; round++) {
      expect(await provider.getMatchesForRound(round)).toHaveLength(2);
    }
    expect(await provider.getTeams()).toEqual([...FIXTURE_TEAMS].sort());
    db.close();
  });

  it('il confine di girone della mini-stagione è ceil(6/2)=3 (azzeramento pool in Fase 3)', async () => {
    const db = makeDb();
    loadBaseSeason(db);
    const total = await new DbSeasonDataProvider(db).getTotalRounds();
    db.close();
    expect(Math.ceil(total / 2)).toBe(3);
    expect(Math.ceil(BASE_MATCHES.length / 2)).toBe(6);
  });
});

describe('sequenze rinvio come stati dati (2.5 §6-B)', () => {
  it('CL7 — recupero giocato entro la finestra: rinviata prima, punteggio poi', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    // Fase 1: la partita è rinviata (esito non determinabile, pick non contabilizzabile).
    setPostponedFlag(db, 1, JU, MA);
    expect(await match(db, 1, JU, MA)).toMatchObject({ postponed: true });
    expect((await match(db, 1, JU, MA)).homeScore).toBeUndefined();

    // Fase 2 (refresh): il recupero è stato giocato → punteggio, non più rinviata (CL7 emerge dai dati).
    setScore(db, 1, JU, MA, 1, 0);
    expect(await match(db, 1, JU, MA)).toMatchObject({
      postponed: false,
      homeScore: 1,
      awayScore: 0
    });
    db.close();
  });

  it('CL1 — recupero fuori finestra non ancora giocato: rinviata senza punteggio (stato Frozen)', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    setPostponedFlag(db, 3, IM, MA);
    const m = await match(db, 3, IM, MA);
    expect(m.postponed).toBe(true);
    expect(m.homeScore).toBeUndefined();
    expect(m.awayScore).toBeUndefined();
    db.close();
  });

  it('CL8 — UPP (ultima partita programmata del round) rinviata senza punteggio', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    // In R1 la UPP è la partita con match_date più tarda: Juventus FC - AS Roma (18:45).
    const upp = (await new DbSeasonDataProvider(db).getMatchesForRound(1)).reduce((a, b) =>
      a.matchDate > b.matchDate ? a : b
    );
    expect(upp.homeTeam).toBe(JU);

    setPostponedFlag(db, 1, JU, MA);
    const m = await match(db, 1, JU, MA);
    expect(m.postponed).toBe(true);
    expect(m.homeScore).toBeUndefined(); // il TC si chiude comunque, il pick va in Frozen (CL8)
    db.close();
  });

  it('frozen→valutato: punteggio arrivato a recupero concluso in un refresh successivo', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    // R4 rinviata (frozen): nessun punteggio alla chiusura del TT.
    setPostponedFlag(db, 4, MA, JU);
    expect((await match(db, 4, MA, JU)).homeScore).toBeUndefined();

    // Refresh successivo: la partita è stata giocata a recupero concluso → punteggio
    // disponibile per la valutazione a posteriori (round:score sui frozen, decisione 4).
    setScore(db, 4, MA, JU, 2, 2);
    expect(await match(db, 4, MA, JU)).toMatchObject({
      postponed: false,
      homeScore: 2,
      awayScore: 2
    });
    db.close();
  });
});

describe('variazione RF-31 / CL17 (2.5 §6-C)', () => {
  it('prima partita del TC rinviata: il kickoff effettivo passa alla partita non rinviata', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    // In R1 la prima partita (16:00) è rinviata: il fischio effettivo è quello delle 18:45.
    setPostponedFlag(db, 1, IM, AC);
    expect((await new DbSeasonDataProvider(db).getFirstMatchDateTime(1)).toISOString()).toBe(
      '2026-09-12T18:45:00.000Z'
    );
    db.close();
  });

  it('CL18 — calendario che anticipa una partita dopo l’apertura: il kickoff segue i dati correnti', async () => {
    const db = makeDb();
    loadBaseSeason(db);

    setMatchDate(db, 1, IM, AC, '2026-09-11T17:00:00Z');
    expect((await new DbSeasonDataProvider(db).getFirstMatchDateTime(1)).toISOString()).toBe(
      '2026-09-11T17:00:00.000Z'
    );
    db.close();
  });
});
