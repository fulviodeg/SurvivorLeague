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
    return Promise.resolve(`[${ctx.type}] TT${ctx.tt ?? '?'}TC${ctx.tc ?? '?'}`);
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
    platform.register('a@test.it', T_OPEN);
    platform.register('b@test.it', T_OPEN);
    // c@test.it: account `active` SENZA profilo — all'apertura del TT 1 riceve
    // comunque pick_instructions (amendment RF-P6, 2026-08-21).
    platform.register('c@test.it', T_OPEN);

    // OPEN: deadline fissa 15:30; i 2 profili attivi + il registrato senza
    // profilo vengono notificati.
    const opened = await openRound(ctxAt(T_OPEN), 1);
    expect(opened).toMatchObject({
      round: 1,
      tt: 1,
      tc: 1,
      status: 'open',
      notified: 2,
      registeredNotified: 1
    });
    expect(opened.deadline).toBe('2026-09-12T15:30:00.000Z');
    const invites = generator.contexts.filter((c) => c.type === 'pick_instructions');
    expect(invites).toHaveLength(3);
    // Coppia TT/TC iniettata deterministicamente (RF-25) + sole squadre disponibili.
    expect(invites[0]).toMatchObject({ tt: 1, tc: 1 });
    // (getTeams() è ordinata alfabeticamente: AC Milan, AS Roma, Inter, Juventus)
    expect(invites[0]?.availableTeams).toEqual([AC, MA, IM, JU]);
    // Il contesto del senza-profilo (ultimo invio): stesse squadre in giornata,
    // nessun playerName (account piattaforma senza nome).
    expect(invites[2]).toMatchObject({ tt: 1, tc: 1, availableTeams: [AC, MA, IM, JU] });
    expect('playerName' in (invites[2] ?? {})).toBe(false);
    expect(channel.sent).toHaveLength(3);

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
      generator.contexts.some((c) => c.type === 'pick_missing_elimination' && c.tt === 1 && c.tc === 1)
    ).toBe(true);

    // SCORE: IM-AC finisce 2-1 → pick di A corretto; nessun pending → scored.
    setScore(db, 1, IM, AC, 2, 1);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);
    expect(scored.status).toBe('scored');
    expect(scored.evaluated).toEqual([{ profileId: a, team: IM, outcome: 'win', result: 'correct' }]);
    expect(scored.newlyEliminated).toEqual([]);
    expect(
      generator.contexts.some((c) => c.type === 'round_result_correct' && c.team === IM)
    ).toBe(true);
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

  it('pick sbagliato → wrong + eliminazione wrong_pick (con notifica)', async () => {
    const { db, generator, platform, ctxAt } = makeHarness();
    const a = insertProfile(db, 'a@test.it');
    platform.register('a@test.it', T_OPEN); // account active → notifica attesa
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
    expect(generator.contexts.some((c) => c.type === 'round_result_wrong')).toBe(true);
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
    platform.register('a@test.it', T_OPEN); // account active → notifica attesa
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
    expect(rescore.evaluated).toEqual([{ profileId: a, team: JU, outcome: 'win', result: 'correct' }]);
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
    expect(partial.evaluated).toEqual([{ profileId: a, team: IM, outcome: 'win', result: 'correct' }]);
    expect(partial.status).toBe('closed'); // non scored: resta un pending

    // Arriva anche JU-MA: ora il round va a scored (RF-16).
    setScore(db, 1, JU, MA, 1, 0);
    const full = await scoreRound(ctxAt(new Date('2026-09-12T19:30:00.000Z')), 1);
    expect(full.evaluated).toEqual([{ profileId: b, team: JU, outcome: 'win', result: 'correct' }]);
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
