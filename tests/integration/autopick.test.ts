/**
 * Test di integrazione dell'AUTO-PICK al mancato invio (feature AUTOPICK,
 * terzo incremento di win_only).
 *
 * Girano sul DB reale SQLite in-memory + provider reale con la mini-stagione,
 * con ChannelAdapter/LLMGenerator FAKE ai confini (stesso pattern di
 * round-flow.test.ts). Verificano la regola D3/D4/D5:
 *   - con AUTOPICK_ON_MISSING attivo (e WIN_ONLY=true) e deadline REALE, alla
 *     chiusura il profilo in gara senza pick riceve la PRIMA squadra
 *     disponibile in ordine alfabetico per short_name (pick diretto,
 *     `auto_pick=1`, outcome 'win') e NON viene eliminato; notifica
 *     `pick_auto_assigned`;
 *   - con AUTOPICK disattivato → eliminazione `missing_pick` come oggi;
 *   - con deadline NULL (close_safety, RF-30) → NESSUN auto-assign, si elimina;
 *   - idempotenza: il re-close NON ri-assegna (il profilo ha già il pick);
 *   - il pick auto-assignato segue il normale scoring (correct/wrong).
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
import { closeRound, openRound, scoreRound } from '../../src/game/round-manager.js';
import { FIXTURE_TEAMS, loadBaseSeason, setScore } from '../fixtures/season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

const T_OPEN = new Date('2026-09-12T10:00:00.000Z');
const T_PICK = new Date('2026-09-12T15:00:00.000Z');
const T_CLOSE = new Date('2026-09-12T16:30:00.000Z'); // dopo la deadline 15:30
const T_SCORE = new Date('2026-09-12T19:45:00.000Z');

/** Fake ChannelAdapter: registra gli invii (mock al confine esterno). */
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

/** Fake LLMGenerator: registra i contesti per tipo. */
class FakeGenerator implements LLMGenerator {
  contexts: EmailContext[] = [];
  generate(ctx: EmailContext): Promise<string> {
    this.contexts.push(ctx);
    return Promise.resolve(`[${ctx.type}]`);
  }
  byType(type: string): EmailContext[] {
    return this.contexts.filter((c) => c.type === type);
  }
}

interface Harness {
  db: Database.Database;
  generator: FakeGenerator;
  platform: DbPlatformRegistry;
  ctxAt: (now: Date) => GameContext;
}

/**
 * Crea il banco di prova con WIN_ONLY=true e AUTOPICK_ON_MISSING impostabile,
 * tabella `team` popolata con gli short_name della mini-stagione.
 */
function makeHarness(autopick: boolean): Harness {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  // Popola la tabella team (short_name) come farebbe data:import/synthetic.
  const shortNames: Array<[string, string]> = [
    [IM, 'Inter'],
    [AC, 'Milan'],
    [JU, 'Juventus'],
    [MA, 'Roma']
  ];
  const ins = db.prepare('INSERT INTO team (name, short_name) VALUES (?, ?)');
  for (const [name, shortName] of shortNames) ins.run(name, shortName);

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
    AUTOPICK_ON_MISSING: autopick ? 'true' : 'false',
    DEADLINE_ADVANCE_MIN: '30'
  });
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  return {
    db,
    generator,
    platform,
    ctxAt: (now: Date) => ({ db, dataProvider, config, now, channel, generator, platform })
  };
}

/** Crea un profilo attivo con email e account piattaforma `active`. */
function insertProfile(db: Database.Database, platform: DbPlatformRegistry, email: string): number {
  const registerId = platform.register(email, null, T_OPEN).registerId;
  const pid = db
    .prepare('INSERT INTO player (email, name, register_id) VALUES (?, ?, ?)')
    .run(email, email, registerId).lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id, register_id) VALUES (?, ?)').run(pid, registerId)
    .lastInsertRowid as number;
}

describe('AUTOPICK — auto-assign alla chiusura (feature AUTOPICK, D3/D4/D5)', () => {
  it('con autopick attivo e deadline reale assegna la prima disponibile per short_name (pick diretto, auto_pick=1, outcome win)', async () => {
    const { db, generator, platform, ctxAt } = makeHarness(true);
    const a = insertProfile(db, platform, 'a@test.it');
    const b = insertProfile(db, platform, 'b@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    // Solo a invia il pick; b manca → auto-assign alla chiusura.
    await registerPick(ctxAt(T_PICK), { profileId: a, round: 1, team: AC, outcome: 'win', receivedAt: T_PICK });

    const closed = await closeRound(ctxAt(T_CLOSE), 1);

    expect(closed.autoAssigned).toEqual([b]);
    expect(closed.eliminatedMissing).toEqual([]);
    // Prima disponibile per short_name in R1 (andata, nessuna bruciata):
    // Inter (IM) < Juventus (JU) < Milan (AC) < Roma (MA) → IM.
    const pick = db
      .prepare('SELECT team, outcome, auto_pick FROM pick WHERE profile_id = ? AND round = 1')
      .get(b) as { team: string; outcome: string; auto_pick: number };
    expect(pick).toEqual({ team: IM, outcome: 'win', auto_pick: 1 });
    // b NON è eliminato.
    expect(checkElimination(db, b)).toEqual({ eliminated: false });
    // Notifica pick_auto_assigned con la squadra assegnata.
    const notif = generator.byType('pick_auto_assigned');
    expect(notif).toHaveLength(1);
    expect(notif[0]).toMatchObject({ round: 1, championshipRound: 1, team: IM, playerName: 'b@test.it' });
    expect(generator.byType('pick_missing_elimination')).toHaveLength(0);
  });

  it('con autopick disattivato → eliminazione missing_pick (comportamento invariato)', async () => {
    const { db, generator, platform, ctxAt } = makeHarness(false);
    const a = insertProfile(db, platform, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);

    const closed = await closeRound(ctxAt(T_CLOSE), 1);

    expect(closed.autoAssigned).toEqual([]);
    expect(closed.eliminatedMissing).toEqual([a]);
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'missing_pick' });
    expect(generator.byType('pick_auto_assigned')).toHaveLength(0);
    expect(generator.byType('pick_missing_elimination')).toHaveLength(1);
  });

  it('con deadline NULL (close_safety, RF-30) → NESSUN auto-assign, si elimina missing_pick', async () => {
    const { db, generator, platform, ctxAt } = makeHarness(true);
    const a = insertProfile(db, platform, 'a@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    // Simula una chiusura di sicurezza: deadline assente (round open anomalo).
    db.prepare('UPDATE round_state SET deadline = NULL WHERE round = 1').run();

    const closed = await closeRound(ctxAt(T_CLOSE), 1);

    expect(closed.autoAssigned).toEqual([]);
    expect(closed.eliminatedMissing).toEqual([a]);
    expect(checkElimination(db, a)).toMatchObject({ eliminated: true, reason: 'missing_pick' });
    expect(generator.byType('pick_auto_assigned')).toHaveLength(0);
  });

  it('idempotenza: il re-close non ri-assegna (il profilo auto-assegnato ha già il pick)', async () => {
    const { db, platform, ctxAt } = makeHarness(true);
    const b = insertProfile(db, platform, 'b@test.it');
    await openRound(ctxAt(T_OPEN), 1);

    const first = await closeRound(ctxAt(T_CLOSE), 1);
    expect(first.autoAssigned).toEqual([b]);

    const second = await closeRound(ctxAt(T_CLOSE), 1);
    expect(second.autoAssigned).toEqual([]);
    expect(second.eliminatedMissing).toEqual([]);
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM pick WHERE profile_id = ? AND round = 1')
      .get(b) as { n: number };
    expect(n.n).toBe(1);
  });

  it('il pick auto-assignato segue il normale scoring (wrong → eliminazione wrong_pick)', async () => {
    const { db, platform, ctxAt } = makeHarness(true);
    const a = insertProfile(db, platform, 'a@test.it');
    const b = insertProfile(db, platform, 'b@test.it');
    await openRound(ctxAt(T_OPEN), 1);
    // a ha un pick (AC); b manca → auto IM.
    await registerPick(ctxAt(T_PICK), { profileId: a, round: 1, team: AC, outcome: 'win', receivedAt: T_PICK });
    await closeRound(ctxAt(T_CLOSE), 1);

    // IM perde 0-2 → il pick auto di b è wrong; AC vince → a correct.
    setScore(db, 1, IM, AC, 0, 2);
    const scored = await scoreRound(ctxAt(T_SCORE), 1);

    expect(scored.evaluated).toContainEqual({ profileId: b, team: IM, outcome: 'win', result: 'wrong' });
    expect(checkElimination(db, b)).toMatchObject({ eliminated: true, reason: 'wrong_pick' });
  });
});
