/**
 * Test dello scheduler (piano Task 7.2, LLD §1.4; decisioni R5–R7 del
 * briefing Fase 7).
 *
 * Su DB reale SQLite in-memory + provider reale con la mini-stagione (4
 * squadre, 6 round). Verificano con clock finto:
 * - tick su torneo NON avviato → no-op (nessun evento, nessuna scrittura);
 * - sequenza completa: start → open TT1 (RF-23) → close finestra iscrizione
 *   a deadline TT1 (RF-22) + close round a deadline → score (RF-16) → open
 *   del TC successivo;
 * - idempotenza (RNF9): secondo tick con lo stesso clock → nessun evento;
 * - chiusura di sicurezza RF-30: round open con deadline NULL oltre il
 *   tcClose → round_close_safety (causa deadline_missing) + finestra chiusa
 *   di sicurezza;
 * - warn_not_calculable: round open con deadline NULL e TC non calcolabile
 *   (nessuna partita) → nessuna chiusura, warn + anomalia in tournament:status;
 * - refresh iniettato (R6): stub chiamato; se lancia → refresh_failed senza
 *   crash e le azioni dello stato corrente proseguono (RNF9);
 * - SCHEDULER_AUTO_SCORE=false → nessun round_score;
 * - round scored con pick frozen → round_score_frozen e rivalutazione;
 * - schedulerStatus: stato computato (R5) con anomalie e prossime azioni.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import type { GameContext } from '../../src/game/context.js';
import { openRound } from '../../src/game/round-manager.js';
import {
  computeActions,
  schedulerStatus,
  schedulerTick
} from '../../src/game/scheduler.js';
import { startTournament, tournamentStatus } from '../../src/game/tournament.js';
import { FIXTURE_TEAMS, loadBaseSeason, setScore } from '../fixtures/season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

// La mini-stagione ha TC 1..6; deadline TC1 = 2026-09-12T15:30:00Z; tcClose
// TC1 = fine UPP (18:45) + 425min = 2026-09-13T01:50:00Z.
const NOW = new Date('2026-09-01T10:00:00.000Z'); // prima della deadline TT1
const AFTER_TT1_DEADLINE = new Date('2026-09-12T15:35:00.000Z');
const AFTER_TC1_CLOSE = new Date('2026-09-13T02:00:00.000Z');

/** Crea il contesto con DB in-memory migrato + mini-stagione + clock finto. */
function makeCtx(
  now: Date = NOW,
  overrides: Record<string, string> = {}
): { db: Database.Database; ctx: GameContext } {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const ctx: GameContext = {
    db,
    dataProvider: new DbSeasonDataProvider(db),
    config: parseConfig({
      IMAP_USER: 'u',
      IMAP_PASS: 'p',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      LLM_API_KEY: 'k',
      FOOTBALL_DATA_TOKEN: 't',
      ...overrides
    }),
    now
  };
  return { db, ctx };
}

/** Crea un profilo attivo con email. */
function insertProfile(db: Database.Database, email: string): number {
  const pid = db.prepare('INSERT INTO player (email) VALUES (?)').run(email).lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid).lastInsertRowid as number;
}

describe('schedulerTick (LLD §1.4, R6/R7)', () => {
  it('no-op su torneo non avviato: nessun evento e nessuna scrittura', async () => {
    const { db, ctx } = makeCtx();
    let refreshCalls = 0;
    const res = await schedulerTick(ctx, { refresh: async () => { refreshCalls += 1; } });

    expect(refreshCalls).toBe(1);
    expect(res.events).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tournament_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_state').get()).toEqual({ n: 0 });
  });

  it('sequenza: start → open TT1 → close finestra+round a deadline → score → open TC2', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);

    // TT1 si apre all\'avvio del torneo (RF-23).
    const t1 = await schedulerTick(ctx);
    expect(t1.events).toEqual([{ type: 'round_open', round: 1 }]);

    // Deadline del TT1 scaduta: chiusura finestra di iscrizione (RF-22) e
    // chiusura del round a deadline.
    ctx.now = AFTER_TT1_DEADLINE;
    const t2 = await schedulerTick(ctx);
    expect(t2.events).toEqual([
      { type: 'register_close_auto' },
      { type: 'round_close', round: 1 }
    ]);
    expect(db.prepare('SELECT registration_open FROM tournament_state WHERE id = 1').get()).toEqual({
      registration_open: 0
    });

    // Risultati disponibili: contabilizzazione del TC1 chiuso (RF-16).
    setScore(db, 1, IM, AC, 1, 0);
    setScore(db, 1, JU, MA, 0, 0);
    ctx.now = AFTER_TC1_CLOSE;
    const t3 = await schedulerTick(ctx);
    expect(t3.events).toEqual([{ type: 'round_score', round: 1 }]);
    expect(db.prepare('SELECT status FROM round_state WHERE round = 1').get()).toEqual({ status: 'scored' });

    // TC1 scored → si apre il TC2 pending.
    const t4 = await schedulerTick(ctx);
    expect(t4.events).toEqual([{ type: 'round_open', round: 2 }]);
  });

  it('idempotenza (RNF9): tick ripetuto con lo stesso clock → nessun evento', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);
    await schedulerTick(ctx); // open TT1
    ctx.now = AFTER_TT1_DEADLINE;
    await schedulerTick(ctx); // register_close_auto + round_close (TC1)
    await schedulerTick(ctx); // round_score (TC1 closed → scored)
    await schedulerTick(ctx); // TC1 scored → open TC2 (RF-23)
    const t = await schedulerTick(ctx); // stesso clock: nulla da fare
    expect(t.events).toEqual([]);
    expect(db.prepare("SELECT status FROM round_state WHERE round = 1").get()).toEqual({ status: 'scored' });
    expect(db.prepare("SELECT status FROM round_state WHERE round = 2").get()).toEqual({ status: 'open' });
  });

  it('RF-30: round open con deadline NULL oltre il tcClose → round_close_safety (causa deadline_missing)', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);
    db.prepare("UPDATE round_state SET status = 'open', deadline = NULL WHERE round = 1").run();

    ctx.now = AFTER_TC1_CLOSE;
    const res = await schedulerTick(ctx);

    expect(res.events).toContainEqual({ type: 'register_close_safety', cause: 'deadline_missing' });
    expect(res.events).toContainEqual({ type: 'round_close_safety', round: 1, cause: 'deadline_missing' });
    expect(db.prepare("SELECT status FROM round_state WHERE round = 1").get()).toEqual({ status: 'closed' });
    expect(db.prepare('SELECT registration_open FROM tournament_state WHERE id = 1').get()).toEqual({
      registration_open: 0
    });
  });

  it('warn_not_calculable: round open senza partite e deadline NULL → nessuna chiusura, warn + anomalia', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);
    db.prepare('DELETE FROM match WHERE round = 1').run();
    db.prepare("UPDATE round_state SET status = 'open', deadline = NULL WHERE round = 1").run();

    ctx.now = AFTER_TC1_CLOSE;
    const res = await schedulerTick(ctx);

    expect(res.events).toContainEqual({ type: 'warn_not_calculable', round: 1 });
    expect(db.prepare("SELECT status FROM round_state WHERE round = 1").get()).toEqual({ status: 'open' });
    const status = await tournamentStatus(ctx);
    expect(status.anomalies).toContainEqual({ round: 1, type: 'deadline_missing' });
  });

  it('R6/RNF9: refresh iniettato chiamato; se lancia → refresh_failed e le azioni proseguono', async () => {
    const { ctx } = makeCtx();
    await startTournament(ctx);

    let calls = 0;
    const ok = await schedulerTick(ctx, { refresh: async () => { calls += 1; } });
    expect(calls).toBe(1);
    expect(ok.events).toEqual([{ type: 'round_open', round: 1 }]);

    // Refresh che lancia: l'evento è refresh_failed ma la chiusura a deadline
    // dello stato corrente viene comunque eseguita (RNF9).
    ctx.now = AFTER_TT1_DEADLINE;
    const failing = await schedulerTick(ctx, {
      refresh: async () => {
        throw new Error('api giù');
      }
    });
    expect(failing.events).toEqual([
      { type: 'refresh_failed' },
      { type: 'register_close_auto' },
      { type: 'round_close', round: 1 }
    ]);
  });

  it('SCHEDULER_AUTO_SCORE=false → nessun round_score (config §4.4)', async () => {
    const { ctx } = makeCtx(NOW, { SCHEDULER_AUTO_SCORE: 'false' });
    await startTournament(ctx);
    await schedulerTick(ctx); // open TT1

    ctx.now = AFTER_TT1_DEADLINE;
    const t = await schedulerTick(ctx);
    expect(t.events).toEqual([
      { type: 'register_close_auto' },
      { type: 'round_close', round: 1 }
    ]);

    // Round chiuso e non scored: il tick successivo NON emette round_score.
    const t2 = await schedulerTick(ctx);
    expect(t2.events).toEqual([]);
  });

  it('round scored con pick frozen → round_score_frozen: il frozen viene rivalutato', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);
    await openRound(ctx, 1);
    const pid = insertProfile(db, 'p@test.it');
    db.prepare("INSERT INTO pick (profile_id, round, team, outcome, status) VALUES (?, 1, ?, 'win', 'frozen')").run(
      pid,
      IM
    );
    db.prepare("UPDATE round_state SET status = 'scored' WHERE round = 1").run();

    // Recupero concluso: la partita di IM ora ha punteggio (IM vince 2-1).
    setScore(db, 1, IM, AC, 2, 1);
    setScore(db, 1, JU, MA, 0, 0);
    const res = await schedulerTick(ctx);

    // Round 1 scored con frozen → rivalutazione; TC1 scored → si apre il TC2.
    expect(res.events).toEqual([
      { type: 'round_score_frozen', round: 1 },
      { type: 'round_open', round: 2 }
    ]);
    const pick = db.prepare('SELECT status FROM pick WHERE profile_id = ?').get(pid) as {
      status: string;
    };
    expect(pick.status).toBe('correct');
  });
});

describe('computeActions / schedulerStatus (R5)', () => {
  it('computeActions: nessuna azione a torneo non avviato', async () => {
    const { ctx } = makeCtx();
    expect(await computeActions(ctx)).toEqual([]);
  });

  it('schedulerStatus: stato computato con anomalie e prossime azioni', async () => {
    const { ctx } = makeCtx();
    await startTournament(ctx);
    ctx.db.prepare("UPDATE round_state SET status = 'open', deadline = NULL WHERE round = 1").run();
    ctx.now = AFTER_TC1_CLOSE;

    const status = await schedulerStatus(ctx);

    expect(status).toMatchObject({
      enabled: false,
      seasonStarted: true,
      registrationOpen: true,
      startRound: 1,
      totalRounds: 6
    });
    expect(status.rounds[0]).toMatchObject({ round: 1, tt: 1, tc: 1, status: 'open', deadline: null });
    expect(status.anomalies).toEqual([{ round: 1, type: 'deadline_missing' }]);
    expect(status.nextActions.map((a) => a.type)).toEqual([
      'register_close_safety',
      'round_close_safety'
    ]);
    expect(status.nextActions[1]).toMatchObject({ round: 1 });
  });
});
