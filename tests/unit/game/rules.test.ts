/**
 * Test del Rules Engine (piano Task 3.1, LLD §7.5) — gironi e squadre.
 *
 * Girano sul DB reale SQLite in-memory + DbSeasonDataProvider reale con le
 * fixture sintetiche (LLD §8: il provider non è mai mockato). Verificano:
 * - confine andata/ritorno DERIVATO (RF-19, nessun letterale): checkHalf con
 *   N pari (6) e dispari (5), round al confine → ritorno;
 * - azzeramento del pool al ritorno (squadre bruciate per girone);
 * - i pick in Freeze contano come bruciati (LLD §1.1, CRITICAL-01);
 * - getAvailableTeams = squadre in giornata non bruciate (decisione 12/CL4);
 * - pickOutcomeFor (win/draw/lose) per la contabilizzazione del Round Manager.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import {
  checkHalf,
  getAvailableTeams,
  getBurnedTeams,
  getFirstAvailableTeamByShortName,
  halfBoundary,
  isBurned,
  lastAndataRound,
  pickOutcomeFor
} from '../../../src/game/rules.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

/** Crea un DB in-memory migrato con la mini-stagione e il provider reale. */
function makeCtx(): { db: Database.Database; provider: DbSeasonDataProvider } {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  return { db, provider: new DbSeasonDataProvider(db) };
}

/** Inserisce un profilo attivo (helper minimo: riga profilo + player). */
function insertProfile(db: Database.Database, email: string): number {
  const pid = db
    .prepare('INSERT INTO player (email) VALUES (?)')
    .run(email).lastInsertRowid as number;
  return db
    .prepare('INSERT INTO profile (player_id) VALUES (?)')
    .run(pid).lastInsertRowid as number;
}

/** Inserisce un pick con stato esplicito (pending/frozen/correct/wrong). */
function insertPick(
  db: Database.Database,
  profileId: number,
  round: number,
  team: string,
  status = 'pending'
): void {
  db.prepare(
    'INSERT INTO pick (profile_id, round, team, outcome, status) VALUES (?, ?, ?, ?, ?)'
  ).run(profileId, round, team, 'win', status);
}

describe('checkHalf — confine andata/ritorno derivato (RF-19, LLD §3.1)', () => {
  it('con N pari (6) il confine è floor(6/2)+1 = 4: round 3 = andata, round 4 = ritorno', () => {
    expect(halfBoundary(6)).toBe(4);
    expect(lastAndataRound(6)).toBe(3);
    expect(checkHalf(1, 6)).toBe(1);
    expect(checkHalf(3, 6)).toBe(1);
    expect(checkHalf(4, 6)).toBe(2);
    expect(checkHalf(6, 6)).toBe(2);
  });

  it('con N=38: andata 1-19, ritorno 20-38 (confine = 20, il round al confine è di ritorno)', () => {
    // Serie A reale: N=38 (la mini-stagione usa N=6; la regola è parametrizzata
    // da N e non da costanti — RF-19).
    expect(halfBoundary(38)).toBe(20);
    expect(checkHalf(19, 38)).toBe(1);
    expect(checkHalf(20, 38)).toBe(2);
    expect(checkHalf(38, 38)).toBe(2);
  });

  it("con N dispari (5) l'andata ha floor(N/2)=2 round e il ritorno inizia a 3", () => {
    expect(halfBoundary(5)).toBe(3);
    expect(checkHalf(2, 5)).toBe(1);
    expect(checkHalf(3, 5)).toBe(2);
  });
});

describe('getBurnedTeams/isBurned — squadre bruciate per profilo+round (LLD §1.1)', () => {
  it('il pick in andata conta solo per il girone di andata (pool azzerato al ritorno)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p@test.it');
    insertPick(db, profile, 1, IM); // andata: IM bruciata
    const totalRounds = await provider.getTotalRounds();

    // Round 1 (andata): IM bruciata, AC no.
    expect(getBurnedTeams(db, profile, 1, totalRounds)).toEqual([IM]);
    expect(isBurned(db, profile, IM, 1, totalRounds)).toBe(true);
    expect(isBurned(db, profile, AC, 1, totalRounds)).toBe(false);

    // Round 4 (ritorno): il pool è azzerato — IM NON è bruciata.
    expect(getBurnedTeams(db, profile, 4, totalRounds)).toEqual([]);
    expect(isBurned(db, profile, IM, 4, totalRounds)).toBe(false);
  });

  it('un pick in Freeze conta come squadra bruciata (CRITICAL-01, nessun filtro di stato)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p2@test.it');
    insertPick(db, profile, 1, JU, 'frozen'); // pick in Freeze nel girone di andata
    const totalRounds = await provider.getTotalRounds();

    expect(isBurned(db, profile, JU, 1, totalRounds)).toBe(true);
    // Anche i pick pending/correct/wrong contano: copertura completa degli stati.
    insertPick(db, profile, 3, MA, 'correct');
    expect(isBurned(db, profile, MA, 1, totalRounds)).toBe(true);
    expect(isBurned(db, profile, JU, 4, totalRounds)).toBe(false);
  });

  it('la query delle bruciate non filtra la finestra torneo [start_round..N] (ADR-008)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p3@test.it');
    // Un torneo agganciato a start_round=4 non perde le bruciate del ritorno.
    insertPick(db, profile, 4, JU);
    insertPick(db, profile, 5, IM);
    const totalRounds = await provider.getTotalRounds();

    expect(getBurnedTeams(db, profile, 6, totalRounds)).toEqual([JU, IM]);
  });
});

describe('getAvailableTeams — squadre in giornata non bruciate (decisione 12, CL4)', () => {
  it('restituisce solo le squadre che giocano nel round, escludendo le bruciate del girone', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p4@test.it');
    insertPick(db, profile, 1, IM); // IM bruciata in andata
    insertPick(db, profile, 4, JU); // JU bruciata in ritorno

    // Round 2 (andata): in giornata IM-JU e AC-MA; IM bruciata → disponibili AC, MA, JU (ordine di getTeams).
    expect(await getAvailableTeams(db, provider, profile, 2)).toEqual([AC, MA, JU]);
    // Round 4 (ritorno): in giornata AC-IM e MA-JU; JU bruciata → disponibili AC, MA, IM.
    expect(await getAvailableTeams(db, provider, profile, 4)).toEqual([AC, MA, IM]);
  });

  it('una squadra bruciata in andata torna disponibile al ritorno (azzeramento pool)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p5@test.it');
    insertPick(db, profile, 1, IM); // IM bruciata SOLO in andata

    // Round 4 (ritorno): IM gioca (AC-IM) e torna disponibile.
    expect(await getAvailableTeams(db, provider, profile, 4)).toContain(IM);
    // Round 1 (andata): IM è bruciata → non disponibile.
    expect(await getAvailableTeams(db, provider, profile, 1)).not.toContain(IM);
  });

  it('il ritorno della mini-stagione non perde squadre per un profilo senza pick', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'p6@test.it');

    // Nessun pick: tutte le squadre in giornata al round 6 (MA-IM, JU-AC).
    expect(await getAvailableTeams(db, provider, profile, 6)).toEqual([AC, MA, IM, JU]);
  });
});

describe('getFirstAvailableTeamByShortName — auto-pick (feature AUTOPICK, D1/D4)', () => {
  /** Nomi generici (shortName) della mini-stagione: ordine alfabetico atteso. */
  const SHORT = new Map<string, string>([
    [IM, 'Inter'],
    [AC, 'Milan'],
    [JU, 'Juventus'],
    [MA, 'Roma']
  ]);

  it('restituisce la prima disponibile in ordine alfabetico per shortName (non per nome canonico)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'auto@test.it');
    const totalRounds = await provider.getTotalRounds();

    // Round 6 (ritorno): in giornata MA-IM e JU-AC. Nessuna bruciata.
    // Ordine canonico (getTeams): AC Milan, AS Roma, Inter, Juventus → prima "AC Milan".
    // Ordine per shortName: Inter, Juventus, Milan, Roma → prima "Inter" (FC Internazionale Milano).
    const matches = await provider.getMatchesForRound(6);
    const teams = await provider.getTeams();
    expect(getFirstAvailableTeamByShortName(db, profile, 6, totalRounds, matches, teams, SHORT)).toBe(IM);
  });

  it('esclude le bruciate del girone (stessa fonte di getAvailableTeams)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'auto2@test.it');
    insertPick(db, profile, 4, IM); // IM bruciata nel ritorno
    const totalRounds = await provider.getTotalRounds();

    const matches = await provider.getMatchesForRound(6);
    const teams = await provider.getTeams();
    // IM bruciata → prima disponibile per shortName = JU ("Juventus").
    expect(getFirstAvailableTeamByShortName(db, profile, 6, totalRounds, matches, teams, SHORT)).toBe(JU);
  });

  it('ritorna null quando nessuna squadra è disponibile (tutte bruciate in giornata)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'auto3@test.it');
    const totalRounds = await provider.getTotalRounds();

    const matches = await provider.getMatchesForRound(6);
    // Lista canonica VUOTA (o senza sovrapposizione con le partite) → nessuna
    // squadra disponibile → null (il chiamante mantiene il fallback missing_pick).
    expect(
      getFirstAvailableTeamByShortName(db, profile, 6, totalRounds, matches, [], SHORT)
    ).toBeNull();
  });

  it('degrade all\'ordine canonico quando lo shortName è assente (tabella team vuota, DB legacy)', async () => {
    const { db, provider } = makeCtx();
    const profile = insertProfile(db, 'auto4@test.it');
    const totalRounds = await provider.getTotalRounds();

    const matches = await provider.getMatchesForRound(6);
    const teams = await provider.getTeams();
    // Mappa vuota → fallback sul nome canonico: prima "AC Milan".
    expect(getFirstAvailableTeamByShortName(db, profile, 6, totalRounds, matches, teams, new Map())).toBe(AC);
  });
});

describe('pickOutcomeFor — esito di un pick su un match concluso (briefing §3.2)', () => {
  it('classifica win/lose/draw per una squadra di casa e per una ospite', () => {
    const matchIM = {
      round: 1,
      matchDate: new Date('2026-09-12T16:00:00Z'),
      homeTeam: IM,
      awayTeam: AC,
      homeScore: 2,
      awayScore: 1,
      postponed: false
    };
    expect(pickOutcomeFor(IM, matchIM)).toBe('win'); // casa vince 2-1
    expect(pickOutcomeFor('FC Internazionale Milano', matchIM)).toBe('win');
    expect(pickOutcomeFor('AC Milan', matchIM)).toBe('lose');
  });

  it('pareggio → draw per entrambe le squadre', () => {
    const match = {
      round: 4,
      matchDate: new Date('2026-10-03T16:00:00Z'),
      homeTeam: AC,
      awayTeam: IM,
      homeScore: 0,
      awayScore: 0,
      postponed: false
    };
    expect(pickOutcomeFor(AC, match)).toBe('draw');
    expect(pickOutcomeFor(IM, match)).toBe('draw');
  });

  it('lancia per un match senza punteggio (contratto: solo a esito noto)', () => {
    const match = {
      round: 1,
      matchDate: new Date('2026-09-12T16:00:00Z'),
      homeTeam: IM,
      awayTeam: AC,
      postponed: false
    };
    expect(() => pickOutcomeFor(IM, match)).toThrow(/senza punteggio/);
  });

  it('lancia se la squadra non gioca nel match (bug del chiamante)', () => {
    const match = {
      round: 1,
      matchDate: new Date('2026-09-12T16:00:00Z'),
      homeTeam: IM,
      awayTeam: AC,
      homeScore: 1,
      awayScore: 0,
      postponed: false
    };
    expect(() => pickOutcomeFor('AS Roma', match)).toThrow(/non gioca/);
  });

  it('confronta sui nomi canonici esatti (nessuna normalizzazione post-parse)', () => {
    const match = {
      round: 1,
      matchDate: new Date('2026-09-12T16:00:00Z'),
      homeTeam: JU,
      awayTeam: MA,
      homeScore: 0,
      awayScore: 2,
      postponed: false
    };
    // "AS Roma" (nome canonico) vince anche da ospite.
    expect(pickOutcomeFor(MA, match)).toBe('win');
  });
});
