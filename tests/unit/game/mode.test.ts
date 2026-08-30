/**
 * Test della guardia di modalità `assertModeConsistent` (ADR-016, win_only).
 *
 * Su DB reale SQLite in-memory (mai mockato). Coprono:
 * - mismatch a torneo APERTO (season_started=1, winner_notified=0) → throw che
 *   nomina `WIN_ONLY` e i valori persistito/configurato + fatal strutturato se
 *   il logger è presente;
 * - no-op quando: torneo non avviato (riga assente o season_started=0),
 *   torneo CHIUSO (winner_notified=1) e valori coincidenti;
 * - gli hook `openRound`/`closeRound`/`scoreRound` invocano la guardia
 *   all'INIZIO: un mismatch lancia PRIMA di qualsiasi scrittura/invio (lo stato
 *   DB resta invariato).
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import { assertModeConsistent } from '../../../src/game/mode.js';
import { closeRound, openRound, scoreRound } from '../../../src/game/round-manager.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const NOW = new Date('2026-09-01T10:00:00.000Z');

/** Logger fake: registra le chiamate `fatal`. */
function fakeLogger(): { fatal: ReturnType<typeof vi.fn>; calls: Array<{ obj: object; msg: string }> } {
  const calls: Array<{ obj: object; msg: string }> = [];
  const fatal = vi.fn((obj: object, msg: string) => {
    calls.push({ obj, msg });
  });
  return { fatal, calls };
}

/**
 * Contesto su DB in-memory migrato + mini-stagione, con `tournament_state`
 * valorizzato. `winOnly` = valore di WIN_ONLY nella config; `persisted` =
 * valore di `tournament_state.win_only` (default 0 se assente).
 */
function makeCtx(winOnly: boolean, persisted: number): {
  db: Database.Database;
  ctx: GameContext;
} {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  db.prepare(
    'INSERT INTO tournament_state (id, season_started, start_round, winner_notified, win_only) VALUES (1, 1, 1, 0, ?)'
  ).run(persisted);
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
      WIN_ONLY: winOnly ? 'true' : 'false'
    }),
    now: NOW
  };
  return { db, ctx };
}

describe('assertModeConsistent (ADR-016)', () => {
  it('torneo non avviato (riga assente) → no-op', () => {
    const db = new Database(':memory:');
    migrate(db);
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
        WIN_ONLY: 'true'
      }),
      now: NOW
    };
    expect(() => assertModeConsistent(ctx)).not.toThrow();
  });

  it('torneo non avviato (season_started=0) → no-op', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      'INSERT INTO tournament_state (id, season_started, win_only) VALUES (1, 0, 1)'
    ).run();
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
        WIN_ONLY: 'false'
      }),
      now: NOW
    };
    expect(() => assertModeConsistent(ctx)).not.toThrow();
  });

  it('torneo CHIUSO (winner_notified=1) → no-op anche con mismatch', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      'INSERT INTO tournament_state (id, season_started, winner_notified, win_only) VALUES (1, 1, 1, 1)'
    ).run();
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
        WIN_ONLY: 'false'
      }),
      now: NOW
    };
    expect(() => assertModeConsistent(ctx)).not.toThrow();
  });

  it('valori coincidenti → no-op (entrambi win_only o entrambi classica)', () => {
    const { ctx: winCtx } = makeCtx(true, 1);
    expect(() => assertModeConsistent(winCtx)).not.toThrow();
    const { ctx: classicCtx } = makeCtx(false, 0);
    expect(() => assertModeConsistent(classicCtx)).not.toThrow();
  });

  it('mismatch a torneo aperto → throw che nomina WIN_ONLY e i valori (persistito vs configurato)', () => {
    const { ctx } = makeCtx(true, 0); // config win_only, DB classica
    expect(() => assertModeConsistent(ctx)).toThrowError(/WIN_ONLY/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/persistita false/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/configurata true/);
  });

  it('mismatch inverso (config classica, DB win_only) → throw coerente', () => {
    const { ctx } = makeCtx(false, 1);
    expect(() => assertModeConsistent(ctx)).toThrowError(/persistita true/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/configurata false/);
  });

  it('con logger presente emette fatal strutturato {persisted, configured} PRIMA del throw', () => {
    const { ctx } = makeCtx(true, 0);
    const logger = fakeLogger();
    ctx.logger = logger as unknown as GameContext['logger'];
    expect(() => assertModeConsistent(ctx)).toThrowError(/WIN_ONLY/);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.obj).toMatchObject({ persisted: false, configured: true });
    expect(logger.calls[0]?.msg).toContain('game mode mismatch');
  });
});

describe('assertModeConsistent — autopick_on_missing (feature AUTOPICK)', () => {
  /** Contesto con win_only coincidente e autopick_on_missing persistito/configurato espliciti. */
  function makeAutopickCtx(persistedAutopick: number, configuredAutopick: boolean): GameContext {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
    db.prepare(
      'INSERT INTO tournament_state (id, season_started, start_round, winner_notified, win_only, autopick_on_missing) VALUES (1, 1, 1, 0, 1, ?)'
    ).run(persistedAutopick);
    return {
      db,
      dataProvider: new DbSeasonDataProvider(db),
      config: parseConfig({
        IMAP_USER: 'u',
        IMAP_PASS: 'p',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        LLM_API_KEY: 'k',
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true',
        AUTOPICK_ON_MISSING: configuredAutopick ? 'true' : 'false'
      }),
      now: NOW
    };
  }

  it('mismatch solo su autopick_on_missing → throw che nomina AUTOPICK_ON_MISSING', () => {
    const ctx = makeAutopickCtx(0, true); // persistita false, configurata true
    expect(() => assertModeConsistent(ctx)).toThrowError(/AUTOPICK_ON_MISSING/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/persistita false/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/configurata true/);
  });

  it('autopick_on_missing coincidente → no-op (entrambi 0 o entrambi 1)', () => {
    expect(() => assertModeConsistent(makeAutopickCtx(0, false))).not.toThrow();
    expect(() => assertModeConsistent(makeAutopickCtx(1, true))).not.toThrow();
  });

  it('con logger presente emette fatal strutturato con persistedAutopick/configuredAutopick', () => {
    const ctx = makeAutopickCtx(0, true);
    const logger = fakeLogger();
    ctx.logger = logger as unknown as GameContext['logger'];
    expect(() => assertModeConsistent(ctx)).toThrowError(/AUTOPICK_ON_MISSING/);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.obj).toMatchObject({ persistedAutopick: false, configuredAutopick: true });
  });
});

describe('assertModeConsistent — jollies_per_player (feature JOLLY)', () => {
  /** Contesto con win_only coincidente e jollies_per_player persistito/configurato espliciti. */
  function makeJollyCtx(persistedJollies: number, configuredJollies: number): GameContext {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
    db.prepare(
      'INSERT INTO tournament_state (id, season_started, start_round, winner_notified, win_only, jollies_per_player) VALUES (1, 1, 1, 0, 1, ?)'
    ).run(persistedJollies);
    return {
      db,
      dataProvider: new DbSeasonDataProvider(db),
      config: parseConfig({
        IMAP_USER: 'u',
        IMAP_PASS: 'p',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        LLM_API_KEY: 'k',
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true',
        JOLLIES_PER_PLAYER: String(configuredJollies)
      }),
      now: NOW
    };
  }

  it('mismatch su jollies_per_player → throw che nomina JOLLIES_PER_PLAYER e i valori (persistito vs configurato)', () => {
    const ctx = makeJollyCtx(1, 2); // persistito 1, configurato 2
    expect(() => assertModeConsistent(ctx)).toThrowError(/JOLLIES_PER_PLAYER/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/persistito 1/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/configurato 2/);
  });

  it('mismatch inverso (persistito 3, configurato 1) → throw coerente', () => {
    const ctx = makeJollyCtx(3, 1);
    expect(() => assertModeConsistent(ctx)).toThrowError(/persistito 3/);
    expect(() => assertModeConsistent(ctx)).toThrowError(/configurato 1/);
  });

  it('jollies_per_player coincidente → no-op', () => {
    expect(() => assertModeConsistent(makeJollyCtx(1, 1))).not.toThrow();
    expect(() => assertModeConsistent(makeJollyCtx(0, 0))).not.toThrow();
  });

  it('con logger presente emette fatal strutturato con persistedJollies/configuredJollies', () => {
    const ctx = makeJollyCtx(1, 2);
    const logger = fakeLogger();
    ctx.logger = logger as unknown as GameContext['logger'];
    expect(() => assertModeConsistent(ctx)).toThrowError(/JOLLIES_PER_PLAYER/);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.obj).toMatchObject({ persistedJollies: 1, configuredJollies: 2 });
  });
});

describe('hook della guardia in openRound/closeRound/scoreRound (ADR-016)', () => {
  const [IM] = FIXTURE_TEAMS;

  function openRound1(db: Database.Database): void {
    db.prepare("INSERT INTO round_state (round, status, deadline, opened_at) VALUES (1, 'open', '2026-09-12T15:30:00.000Z', ?)")
      .run(NOW.toISOString());
  }

  it('openRound: mismatch → throw PRIMA di scrivere round_state (stato invariato)', async () => {
    const { db, ctx } = makeCtx(true, 0); // mismatch
    const before = db.prepare('SELECT COUNT(*) AS n FROM round_state').get() as { n: number };
    await expect(openRound(ctx, 1)).rejects.toThrowError(/WIN_ONLY/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_state').get()).toEqual(before);
  });

  it('closeRound: mismatch → throw PRIMA di eliminare/notificare (stato invariato)', async () => {
    const { db, ctx } = makeCtx(true, 0); // mismatch
    openRound1(db);
    await expect(closeRound(ctx, 1)).rejects.toThrowError(/WIN_ONLY/);
    // Nessuna eliminazione: la chiusura non ha consolidato nulla.
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile WHERE eliminated = 1").get()).toEqual({ n: 0 });
  });

  it('scoreRound: mismatch → throw PRIMA di valutare/aggiornare (stato invariato)', async () => {
    const { db, ctx } = makeCtx(true, 0); // mismatch
    openRound1(db);
    const pid = db.prepare('INSERT INTO player (email) VALUES (?)').run('p@test.it').lastInsertRowid as number;
    db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid);
    db.prepare("INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, 1, ?, 'win')").run(pid, IM);
    await expect(scoreRound(ctx, 1)).rejects.toThrowError(/WIN_ONLY/);
    expect(db.prepare("SELECT status FROM pick WHERE profile_id = ?").get(pid)).toEqual({ status: 'pending' });
  });
});
