/**
 * Test di integrazione del Round Manager (piano Task 3.5, LLD §7.3/§1.1/§1.4).
 *
 * Flusso open → pick → close → score su DB reale SQLite in-memory + provider
 * reale con la mini-stagione (LLD §8). ChannelAdapter/LLMGenerator sono fake
 * in-memory (mock solo ai confini esterni): registrano i messaggi e i contesti
 * email per verificare il contratto di notifica (coppia TT/TC iniettata, RF-25).
 *
 * Il contesto inietta anche un PlatformRegistry su DB piattaforma in-memory
 * (ADR-009): le notifiche partono SOLO per gli account `active` registrati nel
 * test (filtro fail-closed, B3/decisione (c) — senza registry nessuna email,
 * come fanno le CLI reali che lo iniettano sempre). All'apertura del TT 1
 * `round:open` notifica anche gli account `active` SENZA profilo (amendment
 * RF-P6, 2026-08-21); dal TT 2 il comportamento è invariato.
 *
 * Copre: idempotenza di round:score (RF-17); CL1/CL7/CL8 (rinvii, fixture);
 * frozen valutato a recupero concluso; chiusura forzata con/senza --reason
 * (RF-29); contabilizzazione incrementale; round → scored solo quando nessun
 * pending (RF-16); nessuna doppia eliminazione; coppia TT/TC negli output.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../src/channel/adapter.js';
import { parseConfig } from '../../src/config.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import { migratePlatform } from '../../src/db/platform-schema.js';
import type { GameContext } from '../../src/game/context.js';
import { checkElimination } from '../../src/game/elimination.js';
import type { EmailContext, LLMGenerator } from '../../src/llm/generator.js';
import { registerPick } from '../../src/game/pick-processor.js';
import { DbPlatformRegistry } from '../../src/platform/registry.js';
import {
  closeRound,
  openRound,
  roundDeadline,
  roundStatus,
  scoreRound
} from '../../src/game/round-manager.js';
import {
  FIXTURE_TEAMS,
  loadBaseSeason,
  setPostponedFlag,
  setScore
} from '../fixtures/season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

// Temporale del round 1: kickoff 16:00, deadline 15:30 (anticipo 30'),
// tcClose = 18:45 (UPP) + 105' + 15' = 20:45.
const T_OPEN = new Date('2026-09-12T10:00:00.000Z');
const T_PICK = new Date('2026-09-12T15:00:00.000Z');
const T_CLOSE = new Date('2026-09-12T16:30:00.000Z');
const T_SCORE = new Date('2026-09-12T19:45:00.000Z');
const T_AFTER_TC_CLOSE = new Date('2026-09-12T21:00:00.000Z');

/** Fake ChannelAdapter: registra i messaggi inviati (mock al confine esterno). */
class FakeChannel implements ChannelAdapter {
  sent: Array<{ to: string; body: string }> = [];
  fetchMessages(): Promise<IncomingMessage[]> {
    return Promise.resolve([]);
  }
  sendMessage(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
    return Promise.resolve();
  }
}

/** Fake LLMGenerator: registra i contesti e risponde con testo fisso. */
class FakeGenerator implements LLMGenerator {
  contexts: EmailContext[] = [];
  generate(ctx: EmailContext): Promise<string> {
    this.contexts.push(ctx);
    return Promise.resolve(`[${ctx.type}] TT${ctx.round ?? '?'}·TC${ctx.championshipRound ?? '?'}`);
  }
}

interface Harness {
  db: Database.Database;
  channel: FakeChannel;
  generator: FakeGenerator;
  /** Registry account PIATTAFORMA (ADR-009) su DB dedicato in-memory. */
  platform: DbPlatformRegistry;
  ctxAt: (now: Date) => GameContext;
}

/** Crea il banco di prova: DB in-memory migrato + mini-stagione + fake I/O. */
function makeHarness(): Harness {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const dataProvider = new DbSeasonDataProvider(db);
  // DB PIATTAFORMA in-memory dedicato + registry iniettato nel contesto
  // (ADR-009): senza registry il filtro notifiche fallisce chiuso (B3,
  // decisione (c)) e nessuna email parte — le CLI reali lo iniettano sempre.
  const platformDb = new Database(':memory:');
  migratePlatform(platformDb);
  const platform = new DbPlatformRegistry(platformDb);
  const config = parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    // Test in modalità CLASSICA: l'esito `lose` è valido solo con WIN_ONLY=false.
    WIN_ONLY: 'false',
    // Parametri temporali espliciti per un controllo deterministico dei tempi:
    // tcClose(R1) = 18:45 (UPP) + 105' + 15' = 20:45.
    DEADLINE_ADVANCE_MIN: '30',
    MATCH_DURATION_MIN: '105',
    TC_CLOSE_SKEW_MIN: '15'
  });
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  return {
    db,
    channel,
    generator,
    platform,
    ctxAt: (now: Date) => ({ db, dataProvider, config, now, channel, generator, platform })
  };
}

/** Crea un profilo attivo con email. */
function insertProfile(db: Database.Database, email: string, name = ''): number {
  const pid = db.prepare('INSERT INTO player (email, name) VALUES (?, ?)').run(email, name)
    .lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid)
    .lastInsertRowid as number;
}

describe('flusso open → pick → close → score (RF-16)', () => {
  it('apre il round, registra un pick, elimina i mancanti al close e contabilizza', async () => {
    const { db, channel, generator, platform, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    const b = insertProfile(db, 'b@test.it', 'Beppe');
    // Account piattaforma `active` per i due profili (ADR-009/RF-P6): senza
    // registry o senza account le notifiche non partono (filtro fail-closed).
    platform.register('a@test.it', null, T_OPEN);
    platform.register('b@test.it', null, T_OPEN);
    // c@test.it: account `active` SENZA profilo — ADR-019: NON riceve la mail
    // pick (la nascita dei profili non è più legata al pick; l'eccezione TT1
    // RF-P6 è RIMOSSA).
    platform.register('c@test.it', null, T_OPEN);

    // OPEN: deadline fissa 15:30; SOLO i 2 profili attivi vengono notificati.
    const opened = await openRound(ctxAt(T_OPEN), 1);
    expect(opened).toMatchObject({
      round: 1,
      tt: 1,
      tc: 1,
      status: 'open',
      notified: 2
    });
    expect(opened.deadline).toBe('2026-09-12T15:30:00.000Z');
    const invites = generator.contexts.filter((c) => c.type === 'pick_instructions');
    expect(invites).toHaveLength(2);
    // Coppia UMANA iniettata deterministicamente (ADR-011) + sole squadre disponibili.
    expect(invites[0]).toMatchObject({ round: 1, championshipRound: 1 });
    // (getTeams() è ordinata alfabeticamente: AC Milan, AS Roma, Inter, Juventus)
    expect(invites[0]?.availableTeams).toEqual([AC, MA, IM, JU]);
    // ADR-019: l'account senza profilo c NON riceve la mail pick.
    expect(channel.sent).toHaveLength(2);

    // PICK: A registra IM win entro la deadline.
    const reg = await registerPick(
      ctxAt(T_PICK),
      { profileId: a, round: 1, team: IM, outcome: 'win', receivedAt: T_PICK }
    );
    expect(reg).toMatchObject({ ok: true, status: 'pending' });

    // CLOSE: B non ha pick → eliminato missing_pick e notificato.
    const closed = await closeRound(ctxAt(T_CLOSE), 1);
    expect(closed).toMatchObject({ status: 'closed', eliminatedMissing: [b], forced: false });
    expect(checkElimination(db, b)).toMatchObject({ eliminated: true, reason: 'missing_pick' });
    expect(
      generator.contexts.some((c) => c.type === 'pick_missing_elimination' && c.round === 1 && c.championshipRound === 1)
    ).toBe(true);

    // SCORE: IM-AC finisce 2-1 → pick di A corretto; nessun pending → scored.
    setScore(db, 1, IM, AC, 2, 1);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.status).toBe('scored');
    expect(scored.evaluated).toEqual([{ profileId: a, team: IM, outcome: 'win', result: 'correct', jollyUsed: false, savedByJolly: false }]);
    expect(scored.newlyEliminated).toEqual([]);
    // MEDIUM-2 (emendamento post-revisione ADR-011): il closeRound ha già
    // chiuso il torneo (caso 1: A è l'unico superstite) → round:score aggiorna
    // lo stato DB ma TACE sulle email di esito (nessun round_result_correct).
    expect(
      generator.contexts.some((c) => c.type === 'round_result_correct' && c.team === IM)
    ).toBe(false);
  });

  it('round:score è idempotente (RF-17): una seconda esecuzione non valuta nulla', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setScore(db, 1, IM, AC, 2, 1);

    const first = await scoreRound(ctxAt(T_SCORE), 1);
    const second = await scoreRound(ctxAt(T_SCORE), 1);

    expect(first.evaluated).toHaveLength(1);
    expect(second.evaluated).toEqual([]);
    expect(second.newlyFrozen).toEqual([]);
    expect(second.status).toBe('scored');
  });

  it('pick sbagliato → wrong + eliminazione wrong_pick', async () => {
    const { db, generator, platform, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    platform.register('a@test.it', null, T_OPEN); // account active → notifica attesa
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'lose', // IM vincerà 2-1 → esito sbagliato
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setScore(db, 1, IM, AC, 2, 1);

    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.evaluated[0]?.result).toBe('wrong');
    expect(scored.newlyEliminated).toEqual([a]);
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'wrong_pick' });
    // MEDIUM-2 (emendamento post-revisione ADR-011): il closeRound ha già
    // chiuso il torneo (caso 1: unico superstite) → round:score aggiorna lo
    // stato DB (eliminazione) ma TACE sull'email di esito (nessun
    // round_result_wrong). La notifica round_result_wrong è coperta dal test
    // "round:score con eliminati" in round-notifications.test.ts (2 profili).
    expect(generator.contexts.some((c) => c.type === 'round_result_wrong')).toBe(false);
  });
});

describe('rinvii: CL7 (entro finestra), CL1/CL8 (oltre tcClose), recupero (frozen→valutato)', () => {
  it('CL7: rinviata senza punteggio entro la finestra del TC → il pick resta pending', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setPostponedFlag(db, 1, JU, MA); // JU-MA rinviata, nessun punteggio

    // 18:45 < tcClose (20:00): il pick resta pending, il round NON va a scored.
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.newlyFrozen).toEqual([]);
    expect(scored.status).toBe('closed');
    expect(roundStatus(ctxAt(T_SCORE), 1).picks['pending']).toBe(1);
  });

  it('CL1/CL8: rinviata oltre tcClose → frozen (con notifica pick_postponed)', async () => {
    const { db, generator, platform, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    // Secondo profilo che sopravvive: evita che il closeRound chiuda il torneo
    // (caso 1, unico superstite) prima di round:score, così la notifica
    // pick_postponed resta osservabile (MEDIUM-2 tace solo a torneo già chiuso).
    const b = insertProfile(db, 'b@test.it');
    platform.register('a@test.it', null, T_OPEN); // account active → notifica attesa
    platform.register('b@test.it', null, T_OPEN);
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await registerPick(ctxAt(T_PICK), {
      profileId: b,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setPostponedFlag(db, 1, JU, MA);
    setScore(db, 1, IM, AC, 2, 1); // IM vince: il pick di b è corretto

    // 21:00 > tcClose (20:45): frozen; i frozen sono terminali per il TT → scored.
    const scored = await scoreRound(ctxAt(T_AFTER_TC_CLOSE), 1);
    expect(scored.newlyFrozen).toEqual([a]);
    expect(scored.status).toBe('scored');
    expect(roundStatus(ctxAt(T_AFTER_TC_CLOSE), 1).picks['frozen']).toBe(1);
    expect(generator.contexts.some((c) => c.type === 'pick_postponed' && c.team === JU)).toBe(true);
  });

  it('recupero: frozen valutato a punteggio disponibile, anche su round già scored (LLD §1.4)', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setPostponedFlag(db, 1, JU, MA);
    await scoreRound(ctxAt(T_AFTER_TC_CLOSE), 1); // → frozen, round scored

    // Il recupero si gioca e finisce 3-1 per JU: il frozen viene valutato.
    setScore(db, 1, JU, MA, 3, 1);
    const rescore = await scoreRound(ctxAt(new Date('2026-09-20T18:00:00.000Z')), 1);
    expect(rescore.evaluated).toEqual([{ profileId: a, team: JU, outcome: 'win', result: 'correct', jollyUsed: false, savedByJolly: false }]);
    expect(checkElimination(db, a)).toEqual({ eliminated: false });
  });

  it('frozen sbagliato a recupero → eliminazione a posteriori', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setPostponedFlag(db, 1, JU, MA);
    await scoreRound(ctxAt(T_AFTER_TC_CLOSE), 1);

    setScore(db, 1, JU, MA, 0, 2); // JU perde il recupero
    const rescore = await scoreRound(ctxAt(new Date('2026-09-20T18:00:00.000Z')), 1);
    expect(rescore.evaluated[0]?.result).toBe('wrong');
    expect(rescore.newlyEliminated).toEqual([a]);
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'wrong_pick' });
  });

  it('contabilizzazione incrementale: valuta un match alla volta (ADR-003)', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await registerPick(ctxAt(T_PICK), {
      profileId: b,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);

    // Solo IM-AC ha un punteggio: valutato solo il pick di A; B resta pending.
    setScore(db, 1, IM, AC, 2, 1);
    const partial = await scoreRound(ctxAt(T_SCORE), 1);
    expect(partial.evaluated).toEqual([{ profileId: a, team: IM, outcome: 'win', result: 'correct', jollyUsed: false, savedByJolly: false }]);
    expect(partial.status).toBe('closed'); // non scored: resta un pending

    // Arriva anche JU-MA: ora il round va a scored (RF-16).
    setScore(db, 1, JU, MA, 1, 0);
    const full = await scoreRound(ctxAt(new Date('2026-09-12T19:30:00.000Z')), 1);
    expect(full.evaluated).toEqual([{ profileId: b, team: JU, outcome: 'win', result: 'correct', jollyUsed: false, savedByJolly: false }]);
    expect(full.status).toBe('scored');
  });
});

describe('chiusura forzata (RF-29) e invarianti', () => {
  it('--force senza --reason → errore (audit obbligatorio)', async () => {
    const { db, ctxAt } = makeHarness();
    insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await expect(closeRound(ctxAt(T_CLOSE), 1, { force: true })).rejects.toThrow(/--reason/);
  });

  it('--force --reason consolida con la STESSA semantica (elimina i mancanti)', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    const closed = await closeRound(ctxAt(T_CLOSE), 1, { force: true, reason: 'emergenza meteo' });
    expect(closed).toMatchObject({ forced: true, reason: 'emergenza meteo', eliminatedMissing: [a] });
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'missing_pick' });
  });

  it('nessuna doppia eliminazione: frozen sbagliato su profilo già eliminato → no-op', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: JU,
      outcome: 'win',
      receivedAt: T_PICK
    });
    await closeRound(ctxAt(T_CLOSE), 1);
    setPostponedFlag(db, 1, JU, MA);
    await scoreRound(ctxAt(T_AFTER_TC_CLOSE), 1); // pick di A → frozen

    // A viene eliminato per missing_pick in un round successivo (simulato qui).
    db.prepare("UPDATE profile SET eliminated = 1, eliminated_reason = 'missing_pick', eliminated_at = ? WHERE id = ?")
      .run('2026-09-19T20:00:00.000Z', a);

    // Il recupero di R1 va male per JU: la valutazione a posteriori NON ri-elimina A.
    setScore(db, 1, JU, MA, 0, 2);
    const rescore = await scoreRound(ctxAt(new Date('2026-09-20T18:00:00.000Z')), 1);
    expect(rescore.evaluated[0]?.result).toBe('wrong');
    expect(rescore.newlyEliminated).toEqual([]);
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'missing_pick' });
  });

  it('round:open su round già aperto → errore (niente duplicati)', async () => {
    const { ctxAt } = makeHarness();
    await openRound(ctxAt(T_OPEN), 1);
    await expect(openRound(ctxAt(T_OPEN), 1)).rejects.toThrow(/esiste già/);
  });
});

describe('guardia apertura con deadline già scaduta (fix UAT 2026-08-22)', () => {
  it('round:open con now DOPO la deadline → rifiuto pulito, NESSUN round_state scritto', async () => {
    const { db, ctxAt } = makeHarness();
    // Fixture: kickoff R1 = 16:00Z, deadline = 15:30Z (anticipo 30'). Aprire il
    // round alle 15:45 (dopo la deadline, prima del kickoff) renderebbe OGNI
    // pick inaccettabile (RF-31: receivedAt > deadline → after_acceptance): il
    // fix UAT rifiuta l'apertura con un errore chiaro invece di creare una
    // trappola (come l'UAT reale del 2026-08-22, round aperto 24s dopo la
    // deadline con 0 pick registrati e 0 profili creati).
    await expect(openRound(ctxAt(new Date('2026-09-12T15:45:00.000Z')), 1)).rejects.toThrow(
      /non futura/
    );
    const row = db.prepare('SELECT round FROM round_state WHERE round = 1').get();
    expect(row).toBeUndefined();
  });

  it('round:open con now ESATTAMENTE alla deadline → rifiuto (finestra pick nulla)', async () => {
    const { db, ctxAt } = makeHarness();
    await expect(openRound(ctxAt(new Date('2026-09-12T15:30:00.000Z')), 1)).rejects.toThrow(
      /non futura/
    );
    expect(db.prepare('SELECT round FROM round_state WHERE round = 1').get()).toBeUndefined();
  });

  it('round:open con now PRIMA della deadline → apertura normale (regressione su flusso OK)', async () => {
    const { db, ctxAt } = makeHarness();
    const opened = await openRound(ctxAt(T_OPEN), 1);
    expect(opened.deadline).toBe('2026-09-12T15:30:00.000Z');
    const row = db.prepare('SELECT status FROM round_state WHERE round = 1').get() as {
      status: string;
    };
    expect(row.status).toBe('open');
  });
});

describe('round:status / round:deadline (sola lettura, RF-25/RF-31)', () => {
  it('round:status espone stato, timestamp e conteggi pick con coppia TT/TC', async () => {
    const { db, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: T_PICK
    });
    const status = roundStatus(ctxAt(T_PICK), 1);
    expect(status).toMatchObject({ round: 1, tt: 1, tc: 1, status: 'open' });
    expect(status.deadline).toBe('2026-09-12T15:30:00.000Z');
    expect(status.picks).toEqual({ pending: 1 });
  });

  it('round:deadline espone deadline registrata E kickoff effettivo (accettazione, RF-31)', async () => {
    const { ctxAt } = makeHarness();
    await openRound(ctxAt(T_OPEN), 1);
    const dl = await roundDeadline(ctxAt(T_OPEN), 1);
    expect(dl.deadline).toBe('2026-09-12T15:30:00.000Z');
    expect(dl.kickoff).toBe('2026-09-12T16:00:00.000Z');
    // Accettazione = min(deadline, kickoff) = deadline.
    expect(dl.acceptance).toBe('2026-09-12T15:30:00.000Z');
  });

  it('coppia TT/TC derivata da start_round (ADR-008): aggancio al TC 6 → TT 1', async () => {
    const { db, ctxAt } = makeHarness();
    db.prepare('INSERT INTO tournament_state (id, start_round) VALUES (1, 6)').run();
    const opened = await openRound(ctxAt(new Date('2026-10-10T10:00:00.000Z')), 6);
    expect(opened).toMatchObject({ tt: 1, tc: 6 });
  });
});

describe('jolly — scoring: salvataggio dal pareggio e righe giocatore (feature JOLLY, D1/D7)', () => {
  /** Harness in modalità win_only CON jolly attivi (JOLLIES_PER_PLAYER=1). */
  function makeJollyHarness(): Harness {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
    const dataProvider = new DbSeasonDataProvider(db);
    const platformDb = new Database(':memory:');
    migratePlatform(platformDb);
    const platform = new DbPlatformRegistry(platformDb);
    const config = parseConfig({
      IMAP_USER: 'u',
      IMAP_PASS: 'p',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      LLM_API_KEY: 'k',
      FOOTBALL_DATA_TOKEN: 't',
      WIN_ONLY: 'true',
      JOLLIES_PER_PLAYER: '1',
      DEADLINE_ADVANCE_MIN: '30',
      MATCH_DURATION_MIN: '105',
      TC_CLOSE_SKEW_MIN: '15'
    });
    const channel = new FakeChannel();
    const generator = new FakeGenerator();
    return {
      db,
      channel,
      generator,
      platform,
      ctxAt: (now: Date) => ({ db, dataProvider, config, now, channel, generator, platform })
    };
  }

  it('pareggio + jolly → pick correct SENZA eliminazione (salvato dal jolly, D1)', async () => {
    const { db, generator, platform, ctxAt } = makeJollyHarness();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    const b = insertProfile(db, 'b@test.it', 'Beppe');
    platform.register('a@test.it', null, T_OPEN);
    platform.register('b@test.it', null, T_OPEN);
    await openRound(ctxAt(T_OPEN), 1);
    // A dichiara IM con JOLLY; B dichiara JU senza jolly.
    const reg = await registerPick(ctxAt(T_PICK), {
      profileId: a, round: 1, team: IM, outcome: 'win', jolly: true, receivedAt: T_PICK
    });
    expect(reg.ok).toBe(true);
    await registerPick(ctxAt(T_PICK), {
      profileId: b, round: 1, team: JU, outcome: 'win', receivedAt: T_PICK
    });
    // IM-AC pareggia 1-1 → A avrebbe sbagliato (draw ≠ win) ma il jolly salva.
    setScore(db, 1, IM, AC, 1, 1);
    setScore(db, 1, JU, MA, 2, 1); // JU vince → B corretto.
    await closeRound(ctxAt(T_CLOSE), 1);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.evaluated).toEqual(
      expect.arrayContaining([
        { profileId: a, team: IM, outcome: 'win', result: 'correct', jollyUsed: true, savedByJolly: true }
      ])
    );
    // A NON è eliminato e il suo pick risulta correct.
    expect(db.prepare('SELECT eliminated FROM profile WHERE id = ?').get(a)).toEqual({ eliminated: 0 });
    expect(db.prepare("SELECT status FROM pick WHERE profile_id = ?").get(a)).toEqual({ status: 'correct' });
    // La mail di esito porta i flag runtime jollyUsed/savedByJolly.
    const correct = generator.contexts.find(
      (c) => c.type === 'round_result_correct' && c.team === IM
    );
    expect(correct).toMatchObject({ jollyUsed: true, savedByJolly: true });
  });

  it('sconfitta + jolly → wrong + eliminazione (il jolly non salva dalla sconfitta)', async () => {
    const { db, ctxAt } = makeJollyHarness();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a, round: 1, team: IM, outcome: 'win', jolly: true, receivedAt: T_PICK
    });
    setScore(db, 1, IM, AC, 0, 1); // IM perde → sconfitta, il jolly NON salva.
    await closeRound(ctxAt(T_CLOSE), 1);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.evaluated).toEqual(
      expect.arrayContaining([
        { profileId: a, team: IM, outcome: 'win', result: 'wrong', jollyUsed: true, savedByJolly: false }
      ])
    );
    expect(scored.newlyEliminated).toEqual([a]);
    expect(db.prepare('SELECT eliminated FROM profile WHERE id = ?').get(a)).toEqual({ eliminated: 1 });
  });

  it('vittoria + jolly → correct (jolly comunque consumato alla dichiarazione)', async () => {
    const { db, ctxAt } = makeJollyHarness();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a, round: 1, team: IM, outcome: 'win', jolly: true, receivedAt: T_PICK
    });
    setScore(db, 1, IM, AC, 2, 0); // IM vince → correct (jolly usato ma non necessario).
    await closeRound(ctxAt(T_CLOSE), 1);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.evaluated).toEqual(
      expect.arrayContaining([
        { profileId: a, team: IM, outcome: 'win', result: 'correct', jollyUsed: true, savedByJolly: false }
      ])
    );
    // Consumo alla dichiarazione: contatore già a 0 (non ripristinato allo score).
    expect(db.prepare('SELECT jollies_remaining FROM profile WHERE id = ?').get(a)).toEqual({
      jollies_remaining: 0
    });
  });

  it('il riepilogo round_closed_survived espone il marcatore jolly nella riga giocatore (D9)', async () => {
    const { db, generator, platform, ctxAt } = makeJollyHarness();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    const b = insertProfile(db, 'b@test.it', 'Beppe');
    platform.register('a@test.it', null, T_OPEN);
    platform.register('b@test.it', null, T_OPEN);
    await openRound(ctxAt(T_OPEN), 1);
    await registerPick(ctxAt(T_PICK), {
      profileId: a, round: 1, team: IM, outcome: 'win', jolly: true, receivedAt: T_PICK
    });
    await registerPick(ctxAt(T_PICK), {
      profileId: b, round: 1, team: JU, outcome: 'win', receivedAt: T_PICK
    });
    setScore(db, 1, IM, AC, 2, 0);
    setScore(db, 1, JU, MA, 2, 1);
    await closeRound(ctxAt(T_CLOSE), 1);
    await scoreRound(ctxAt(T_SCORE), 1);
    const summary = generator.contexts.find((c) => c.type === 'round_closed_survived');
    expect(summary).toBeDefined();
    // La riga del giocatore con jolly porta il marcatore jolly:true.
    const aldRow = summary?.players?.find((p) => p.name === 'Aldo');
    expect(aldRow).toMatchObject({ team: IM, jolly: true });
    const bepRow = summary?.players?.find((p) => p.name === 'Beppe');
    expect(bepRow).toMatchObject({ team: JU });
    expect(bepRow?.jolly).toBeUndefined();
    // Il riepilogo porta anche il contatore del DESTINATARIO (per destinatario).
    expect(summary?.jolliesRemaining).toBe(0);
  });
});
