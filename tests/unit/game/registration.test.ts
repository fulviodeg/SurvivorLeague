/**
 * Test di creazione profilo, auto-join e dichiarazione di partecipazione
 * (ADR-019, partecipazione opt-in; sostituisce RF-P5 di ADR-009).
 *
 * Su DB reale SQLite in-memory (torneo + PIATTAFORMA) + provider reale con la
 * mini-stagione (LLD §8). Verificano:
 * - `createProfileForAccount` (UNICA fonte di nascita profilo): player+profile
 *   con `register_id` replicato (RF-P7) e `jollies_remaining`; riuso/backfill
 *   del player legacy (decisione (g)/B7);
 * - `autoJoinProfilesAtStart`: auto-join degli account `active` con
 *   `tournament_auto_join = ON`, idempotente, skip degli OFF, no-op senza
 *   registry (D2/D6/D11);
 * - `declareParticipation`: finestra TT1 (pending/open), già in gara
 *   (idempotenza D8), nessun torneo, rifiuto late senza `--reason`, override
 *   late con `--reason` (D10), gate eligibilità `not_active`;
 * - `checkEligibility` invariato (registry assente → platform_unavailable,
 *   sconosciuto → account_not_active, override US10).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';
import type { GameContext } from '../../../src/game/context.js';
import { openRound } from '../../../src/game/round-manager.js';
import {
  autoJoinProfilesAtStart,
  createProfileForAccount,
  declareParticipation
} from '../../../src/game/registration.js';
import { checkEligibility } from '../../../src/game/eligibility.js';
import { startTournament } from '../../../src/game/tournament.js';
import { loadBaseSeason } from '../../fixtures/season.js';

const NOW = new Date('2026-09-01T10:00:00.000Z'); // prima della deadline TT1 (15:30 del 12/09)

interface Harness {
  db: Database.Database;
  platformDb: Database.Database;
  platform: DbPlatformRegistry;
  ctx: GameContext;
}

/** Banco di prova: DB torneo + DB PIATTAFORMA + mini-stagione, SENZA avviare il torneo. */
function makeHarness(): Harness {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const platformDb = new Database(':memory:');
  migratePlatform(platformDb);
  const platform = new DbPlatformRegistry(platformDb);
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
    platform
  };
  return { db, platformDb, platform, ctx };
}

/** Banco di prova con torneo AVVIATO (round 1 `pending`). */
async function makeStartedHarness(): Promise<Harness> {
  const h = makeHarness();
  await startTournament(h.ctx);
  return h;
}

describe('createProfileForAccount (ADR-019, unica fonte di nascita profilo)', () => {
  it('crea player + profile con register_id replicato e jollies_remaining (RF-P7, JOLLY D3)', async () => {
    const { db, platform } = await makeStartedHarness();
    const account = platform.register('mario@test.it', 'Mario Rossi', NOW);

    const profileId = createProfileForAccount(db, account, NOW, 1);

    const player = db
      .prepare('SELECT name, register_id FROM player WHERE email = ?')
      .get('mario@test.it') as { name: string | null; register_id: number };
    const profile = db
      .prepare('SELECT player_id, register_id, jollies_remaining FROM profile WHERE id = ?')
      .get(profileId) as { player_id: number; register_id: number; jollies_remaining: number };
    expect(player.name).toBe('Mario Rossi');
    expect(player.register_id).toBe(account.registerId);
    expect(profile.register_id).toBe(account.registerId);
    expect(profile.jollies_remaining).toBe(1);
  });

  it('nome assente → il player usa l\'email (ADR-011, RF-P1)', async () => {
    const { db, platform } = await makeStartedHarness();
    const account = platform.register('anonimo@test.it', null, NOW);

    createProfileForAccount(db, account, NOW, 1);

    const player = db
      .prepare('SELECT name FROM player WHERE email = ?')
      .get('anonimo@test.it') as { name: string };
    expect(player.name).toBe('anonimo@test.it');
  });

  it('player legacy senza profile (register_id NULL) → riuso del player + backfill register_id (B7, decisione (g))', async () => {
    const { db, platform } = await makeStartedHarness();
    const account = platform.register('legacy@test.it', null, NOW);
    // Dato legacy: riga player preesistente SENZA profile e con register_id NULL.
    const legacyPlayerId = db
      .prepare('INSERT INTO player (email, name, register_id, created_at) VALUES (?, NULL, NULL, ?)')
      .run('legacy@test.it', '2026-08-01T00:00:00.000Z').lastInsertRowid as number;

    const profileId = createProfileForAccount(db, account, NOW, 1);

    const players = db
      .prepare('SELECT id, register_id FROM player WHERE email = ?')
      .all('legacy@test.it') as Array<{ id: number; register_id: number | null }>;
    expect(players).toHaveLength(1);
    expect(players[0]?.id).toBe(legacyPlayerId);
    expect(players[0]?.register_id).toBe(account.registerId);
    const profile = db
      .prepare('SELECT player_id FROM profile WHERE id = ?')
      .get(profileId) as { player_id: number };
    expect(profile.player_id).toBe(legacyPlayerId);
  });
});

describe('autoJoinProfilesAtStart (ADR-019, D2/D6/D11)', () => {
  it('auto-join degli account active con flag ON; skip degli OFF; idempotente', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('a@test.it', null, NOW); // ON (default)
    platform.register('b@test.it', null, NOW); // ON (default)
    platform.register('c@test.it', null, NOW); // OFF
    platform.setPreferences('c@test.it', { tournamentAutoJoin: false });

    const created = autoJoinProfilesAtStart(ctx);

    expect(created).toHaveLength(2);
    const emails = db
      .prepare(
        `SELECT pl.email FROM profile p JOIN player pl ON pl.id = p.player_id ORDER BY p.id`
      )
      .all() as Array<{ email: string }>;
    expect(emails.map((r) => r.email).sort()).toEqual(['a@test.it', 'b@test.it']);

    // Idempotente: una seconda chiamata non crea duplicati.
    expect(autoJoinProfilesAtStart(ctx)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 2 });
  });

  it('skip degli account non-active (pending/unsubscribed)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('a@test.it', null, NOW);
    platform.register('b@test.it', null, NOW);
    platform.beginUnsubscribe('b@test.it', NOW);

    autoJoinProfilesAtStart(ctx);

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
  });

  it('no-op senza registry nel contesto (guard coerente col broadcast)', async () => {
    const { db, ctx } = await makeStartedHarness();
    const ctxNoPlatform: GameContext = { ...ctx, platform: undefined };
    expect(autoJoinProfilesAtStart(ctxNoPlatform)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });
});

describe('declareParticipation (ADR-019, D7/D8/D10)', () => {
  it('account active + round 1 pending → join confermato (finestra aperta PRIMA di round:open)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    const account = platform.register('mario@test.it', null, NOW);

    const res = declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const profile = db
        .prepare('SELECT register_id FROM profile WHERE id = ?')
        .get(res.profileId) as { register_id: number };
      expect(profile.register_id).toBe(account.registerId);
    }
  });

  it('account active + round 1 open → join confermato (finestra open)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    await openRound(ctx, 1);
    platform.register('mario@test.it', null, NOW);

    const res = declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' });

    expect(res.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
  });

  it('profilo già esistente → already_joined (idempotenza D8)', async () => {
    const { platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    // Auto-join a start crea il profilo (flag ON).
    autoJoinProfilesAtStart(ctx);

    const res = declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' });

    expect(res).toEqual({ ok: false, reason: 'already_joined' });
  });

  it('profilo già esistente + round 1 chiuso senza reason → already_joined (idempotenza D8 incondizionata, precede la finestra)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    // Auto-join a start crea il profilo (flag ON).
    autoJoinProfilesAtStart(ctx);
    db.prepare("UPDATE round_state SET status = 'closed' WHERE round = 1").run();

    const res = declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' });

    // Un partecipante GIÀ in gara riceve already_joined anche a TT1 chiuso
    // (il check precede la finestra): "sei già in gara", non "il torneo è iniziato".
    expect(res).toEqual({ ok: false, reason: 'already_joined' });
  });

  it('nessun torneo avviato → no_tournament', async () => {
    const { platform, ctx } = makeHarness();
    platform.register('mario@test.it', null, NOW);

    expect(declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' })).toEqual({
      ok: false,
      reason: 'no_tournament'
    });
  });

  it('round_state[startRound] assente → no_tournament', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    db.prepare('DELETE FROM round_state WHERE round = 1').run();

    expect(declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' })).toEqual({
      ok: false,
      reason: 'no_tournament'
    });
  });

  it('round 1 closed/scored senza reason → late_requires_reason (D10)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    db.prepare("UPDATE round_state SET status = 'closed' WHERE round = 1").run();

    expect(declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' })).toEqual({
      ok: false,
      reason: 'late_requires_reason'
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('round 1 closed/scored CON reason → override late (crea profilo, pool intatto, D10/ADR-008 §6)', async () => {
    const { db, platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    db.prepare("UPDATE round_state SET status = 'scored' WHERE round = 1").run();

    const res = declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' }, {
      reason: 'override manuale'
    });

    expect(res.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
  });

  it('account non active → not_active (gate eligibilità, ADR-009)', async () => {
    const { platform, ctx } = await makeStartedHarness();
    platform.register('mario@test.it', null, NOW);
    platform.beginUnsubscribe('mario@test.it', NOW);

    expect(declareParticipation(ctx, { channel: 'email', identifier: 'mario@test.it' })).toEqual({
      ok: false,
      reason: 'not_active'
    });
  });

  it('account sconosciuto → not_active (mai una registration, ADR-019)', async () => {
    const { ctx } = await makeStartedHarness();

    expect(declareParticipation(ctx, { channel: 'email', identifier: 'x@test.it' })).toEqual({
      ok: false,
      reason: 'not_active'
    });
  });
});

describe('checkEligibility (invariato, ADR-009)', () => {
  it('registry assente → platform_unavailable; sconosciuto → account_not_active; override US10', () => {
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
