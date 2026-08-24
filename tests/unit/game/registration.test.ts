/**
 * Test di auto-join ed eligibilità (piano Task 7/10, ADR-009, RF-P5).
 *
 * Su DB reale SQLite in-memory (torneo + PIATTAFORMA) + provider reale con la
 * mini-stagione (LLD §8). Verificano:
 * - auto-join RF-P5 (CL2/CL5/RF-24): profilo+pick ATOMICI nel TT1 con
 *   `register_id` replicato (RF-P7); pick invalido → ROLLBACK senza profilo
 *   orfano; post-TT1 → rifiuto; round non aperto → rifiuto;
 * - gate eligibilità ADR-009: account `pending_unsubscribe`/`unsubscribed`/
 *   sconosciuto → `not_eligible`; re-iscrizione con lo stesso `registerID`
 *   (RF-P3); `checkEligibility` senza registry → `platform_unavailable`.
 * (Le funzionalità legacy registerPlayer/openRegistration/closeRegistration/
 * autoRegisterFromPick sono RIMOSSE nel Task 10, ADR-009.)
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../../src/channel/adapter.js';
import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';
import type { GameContext } from '../../../src/game/context.js';
import type { LLMGenerator } from '../../../src/llm/generator.js';
import { openRound } from '../../../src/game/round-manager.js';
import { autoJoinFromPick } from '../../../src/game/registration.js';
import { checkEligibility } from '../../../src/game/eligibility.js';
import { startTournament } from '../../../src/game/tournament.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM, AC] = FIXTURE_TEAMS;

const NOW = new Date('2026-09-01T10:00:00.000Z'); // prima della deadline TT1 (15:30 del 12/09)
const T_PICK = new Date('2026-09-12T15:00:00.000Z'); // entro la deadline del TT1

/** Fake ChannelAdapter per le notifiche. */
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

/** Fake LLMGenerator con contesti registrati. */
class FakeGenerator implements LLMGenerator {
  contexts: Array<{ type: string }> = [];
  generate(ctx: { type: string }): Promise<string> {
    this.contexts.push(ctx);
    return Promise.resolve(`[${ctx.type}]`);
  }
}

interface Harness {
  db: Database.Database;
  channel: FakeChannel;
  generator: FakeGenerator;
  ctx: GameContext;
}

/** Banco di prova: DB migrato + mini-stagione + fake I/O + torneo avviato. */
async function makeHarness(): Promise<Harness> {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  const ctx: GameContext = {
    db,
    dataProvider: new DbSeasonDataProvider(db),
    config: parseConfig({
      IMAP_USER: 'u',
      IMAP_PASS: 'p',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      LLM_API_KEY: 'k',
      FOOTBALL_DATA_TOKEN: 't'
    }),
    now: NOW,
    channel,
    generator
  };
  await startTournament(ctx);
  return { db, channel, generator, ctx };
}

/** Apre il round 1 (TT1) per i test di auto-iscrizione. */
async function openTT1(h: Pick<Harness, 'db' | 'ctx'>): Promise<void> {
  await openRound(h.ctx, 1);
}

describe('auto-join RF-P5 (ADR-009) — eligibilità piattaforma + profilo+pick atomici', () => {
  /** Banco di prova con PlatformRegistry iniettato (account registrabili). */
  async function makePlatformHarness(): Promise<
    Harness & { platformDb: Database.Database; platform: DbPlatformRegistry }
  > {
    const base = await makeHarness();
    const platformDb = new Database(':memory:');
    migratePlatform(platformDb);
    const platform = new DbPlatformRegistry(platformDb);
    base.ctx.platform = platform;
    return { ...base, platformDb, platform };
  }

  it('iscritto active senza profilo + pick valido nel TT1 → profilo+pick atomici con register_id replicato (RF-P5/P7)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    const account = platform.register('iscritto@test.it', null, NOW);

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'iscritto@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      const pick = db
        .prepare('SELECT profile_id, round, team, outcome, status FROM pick WHERE id = ?')
        .get(res.pickId) as {
        profile_id: number;
        round: number;
        team: string;
        outcome: string;
        status: string;
      };
      expect(pick).toMatchObject({ profile_id: res.profileId, round: 1, team: IM, outcome: 'win', status: 'pending' });
      // register_id REPLICATO sull'account piattaforma (RF-P7).
      const player = db.prepare('SELECT register_id FROM player WHERE id = (SELECT player_id FROM profile WHERE id = ?)').get(res.profileId) as { register_id: number };
      const profile = db.prepare('SELECT register_id FROM profile WHERE id = ?').get(res.profileId) as { register_id: number };
      expect(player.register_id).toBe(account.registerId);
      expect(profile.register_id).toBe(account.registerId);
    }
  });

  it('auto-join: il nome del player nasce dall\'account piattaforma; assente → email (ADR-011, RF-P1)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    // Account CON nome (dedotto dalla mail di registrazione).
    platform.register('mario@test.it', 'Mario Rossi', NOW);
    // Account SENZA nome → il player usa l'email.
    platform.register('anonimo@test.it', null, NOW);

    const resMario = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'mario@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );
    const resAnonimo = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'anonimo@test.it' },
      { team: AC, outcome: 'win' },
      1,
      T_PICK
    );

    expect(resMario.ok).toBe(true);
    expect(resAnonimo.ok).toBe(true);
    const names = db
      .prepare('SELECT email, name FROM player ORDER BY id')
      .all() as Array<{ email: string; name: string | null }>;
    expect(names).toEqual([
      { email: 'mario@test.it', name: 'Mario Rossi' },
      { email: 'anonimo@test.it', name: 'anonimo@test.it' }
    ]);
  });

  it('player legacy senza profile (register_id NULL) + pick valido nel TT1 → profilo sul player ESISTENTE con backfill register_id (A8/B7, decisione (g))', async () => {    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    const account = platform.register('legacy@test.it', null, NOW);

    // Dato legacy (decisione 2 "nessuna migrazione"): riga player preesistente
    // SENZA profile e con register_id NULL.
    const legacyPlayerId = db
      .prepare('INSERT INTO player (email, name, register_id, created_at) VALUES (?, NULL, NULL, ?)')
      .run('legacy@test.it', '2026-08-01T00:00:00.000Z').lastInsertRowid as number;

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'legacy@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      // NESSUNA nuova riga player (UNIQUE email rispettato): il profilo nasce
      // collegato al player legacy ESISTENTE.
      const players = db
        .prepare('SELECT id, email, register_id FROM player ORDER BY id')
        .all() as Array<{ id: number; email: string; register_id: number | null }>;
      expect(players).toHaveLength(1);
      const player = players[0];
      expect(player).toBeDefined();
      expect(player?.id).toBe(legacyPlayerId);

      // Backfill register_id: NULL (legacy) → account.registerId (RF-P7).
      expect(player?.register_id).toBe(account.registerId);

      const profile = db
        .prepare('SELECT player_id, register_id FROM profile WHERE id = ?')
        .get(res.profileId) as { player_id: number; register_id: number };
      expect(profile.player_id).toBe(legacyPlayerId);
      expect(profile.register_id).toBe(account.registerId);

      // Pick inserito per il profilo appena creato.
      const pick = db
        .prepare('SELECT profile_id, round, team, outcome, status FROM pick WHERE id = ?')
        .get(res.pickId) as {
        profile_id: number;
        round: number;
        team: string;
        outcome: string;
        status: string;
      };
      expect(pick).toMatchObject({ profile_id: res.profileId, round: 1, team: IM, outcome: 'win', status: 'pending' });
    }
  });

  it('pick invalido nel TT1 → ROLLBACK senza profilo orfano (RF-P5)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    platform.register('rollback@test.it', null, NOW);

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'rollback@test.it' },
      { team: 'Napoli', outcome: 'win' }, // fuori lista canonica → unknown_team
      1,
      T_PICK
    );

    expect(res).toEqual({ ok: false, reason: 'pick_rejected', pickReason: 'unknown_team' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pick').get()).toEqual({ n: 0 });
  });

  it('post-TT1: iscritto senza profilo → not_tt1 (rifiuto con risposta nel wiring)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    platform.register('tardi@test.it', null, NOW);

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'tardi@test.it' },
      { team: IM, outcome: 'win' },
      2,
      new Date('2026-09-19T15:00:00Z')
    );

    expect(res).toEqual({ ok: false, reason: 'not_tt1' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('round non aperto nel TT1 → round_not_open (nessun profilo)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    platform.register('chiuso@test.it', null, NOW);
    // Nessun round:open sul TC 1: round_state.status = 'pending'.

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'chiuso@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );

    expect(res).toEqual({ ok: false, reason: 'round_not_open' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('account pending_unsubscribe → not_eligible (barriera a due passi, RF-P2/P6)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    platform.register('pendente@test.it', null, NOW);
    platform.beginUnsubscribe('pendente@test.it', NOW);

    const res = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'pendente@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );
    expect(res).toEqual({ ok: false, reason: 'not_eligible' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('account unsubscribed o mai iscritto → not_eligible (nessun profilo)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    platform.register('disiscritto@test.it', null, NOW);
    platform.beginUnsubscribe('disiscritto@test.it', NOW);
    platform.confirmUnsubscribe('disiscritto@test.it', NOW);

    expect(
      await autoJoinFromPick(
        ctx,
        { channel: 'email', identifier: 'disiscritto@test.it' },
        { team: IM, outcome: 'win' },
        1,
        T_PICK
      )
    ).toEqual({ ok: false, reason: 'not_eligible' });
    expect(
      await autoJoinFromPick(
        ctx,
        { channel: 'email', identifier: 'sconosciuto@test.it' },
        { team: IM, outcome: 'win' },
        1,
        T_PICK
      )
    ).toEqual({ ok: false, reason: 'not_eligible' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('re-iscrizione con stesso registerID: dopo unsubscribe il profilo mantiene il register_id originale (RF-P3)', async () => {
    const { db, ctx, platform } = await makePlatformHarness();
    await openTT1({ db, ctx });
    const account = platform.register('riuso@test.it', null, NOW);

    const first = await autoJoinFromPick(
      ctx,
      { channel: 'email', identifier: 'riuso@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );
    expect(first.ok).toBe(true);
    const profile = db
      .prepare('SELECT register_id FROM profile WHERE id = ?')
      .get(first.ok ? first.profileId : 0) as { register_id: number };
    expect(profile.register_id).toBe(account.registerId);

    // Disiscrizione + re-iscrizione: registerID invariato (RF-P3).
    platform.beginUnsubscribe('riuso@test.it', NOW);
    platform.confirmUnsubscribe('riuso@test.it', NOW);
    const reactivated = platform.register('riuso@test.it', null, NOW);
    expect(reactivated.registerId).toBe(account.registerId);
  });

  it('checkEligibility: registry assente → platform_unavailable; sconosciuto → account_not_active (nessun bypass)', () => {
    const base = new Database(':memory:');
    migrate(base);
    const ctxNoPlatform: GameContext = {
      db: base,
      dataProvider: new DbSeasonDataProvider(base),
      config: parseConfig({
        IMAP_USER: 'u',
        IMAP_PASS: 'p',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        LLM_API_KEY: 'k',
        FOOTBALL_DATA_TOKEN: 't'
      }),
      now: NOW
    };
    expect(checkEligibility(ctxNoPlatform, { channel: 'email', identifier: 'x@test.it' })).toEqual({
      eligible: false,
      reason: 'platform_unavailable'
    });

    const platformDb = new Database(':memory:');
    migratePlatform(platformDb);
    const platform = new DbPlatformRegistry(platformDb);
    const ctxWithPlatform: GameContext = { ...ctxNoPlatform, platform };
    expect(checkEligibility(ctxWithPlatform, { channel: 'email', identifier: 'x@test.it' })).toEqual({
      eligible: false,
      reason: 'account_not_active'
    });
    platform.register('a@test.it', null, NOW);
    expect(checkEligibility(ctxWithPlatform, { channel: 'email', identifier: 'a@test.it' })).toEqual({
      eligible: true
    });
    // Override US10 con motivo: forzabile e auditato.
    expect(
      checkEligibility(ctxWithPlatform, { channel: 'email', identifier: 'x@test.it' }, {
        forceEligible: true,
        reason: 'override manuale'
      })
    ).toEqual({ eligible: true, reason: 'override manuale' });
    expect(
      checkEligibility(ctxWithPlatform, { channel: 'email', identifier: 'x@test.it' }, {
        forceEligible: true
      })
    ).toEqual({ eligible: false, reason: 'override_requires_reason' });
  });
});
