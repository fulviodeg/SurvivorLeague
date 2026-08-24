/**
 * Test della simulazione (piano Task 7.1, LLD §7.11; decisioni R1–R4 del
 * briefing Fase 7).
 *
 * Su DB reale SQLite in-memory + provider reale con la mini-stagione (4
 * squadre, 6 round — LLD §8). Verificano:
 * - mulberry32 (R4): funzione pura, stessa seed → stessa sequenza;
 * - simulateSeason (CS3): stagione completa senza errori con tutti i round
 *   scored (i match della fixture vengono "giocati" con setScore);
 * - RNF1: due run con stessa seed su DB freschi e stesso clock → export
 *   identici; seed diverse → export diversi;
 * - guardia R3: torneo già avviato / round non-pending → rifiuto pulito;
 * - aggancio CL13 (--start-round 4 = confine girone) e CL12 (ultimo TC);
 * - simulateRound: round singolo senza tournament:start (apre la finestra se
 *   manca la riga tournament_state), guardia su round già non-pending.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import { migratePlatform } from '../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../src/platform/registry.js';
import type { GameContext } from '../../src/game/context.js';
import { simulateRound, simulateSeason, mulberry32 } from '../../src/game/simulation.js';
import { startTournament, tournamentExport } from '../../src/game/tournament.js';
import { loadBaseSeason, setScore } from '../fixtures/season.js';

/**
 * Crea il contesto con DB in-memory migrato + mini-stagione (clock fisso) e
 * DB PIATTAFORMA in-memory pulito con registry iniettato (ADR-009: il seed
 * crea account piattaforma, i profili nascono per auto-join al TT1).
 */
function makeCtx(): {
  db: Database.Database;
  platformDb: Database.Database;
  platform: DbPlatformRegistry;
  ctx: GameContext;
} {
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
    now: new Date('2026-09-01T10:00:00.000Z'),
    platform
  };
  return { db, platformDb, platform, ctx };
}

/**
 * "Gioca" tutta la mini-stagione: assegna un punteggio a ogni match (la
 * simulazione consuma i dati così come sono: nessuna logica di gioco).
 */
function playAllMatches(db: Database.Database): void {
  const rows = db.prepare('SELECT round, home_team, away_team FROM match').all() as Array<{
    round: number;
    home_team: string;
    away_team: string;
  }>;
  for (const m of rows) setScore(db, m.round, m.home_team, m.away_team, 1, 0);
}

describe('mulberry32 (R4)', () => {
  it('funzione pura: stessa seed → stessa sequenza; seed diversa → sequenza diversa', () => {
    const seq = (seed: number): number[] => {
      const rng = mulberry32(seed);
      return [rng(), rng(), rng(), rng()];
    };
    expect(seq(42)).toEqual(seq(42));
    expect(seq(42)).not.toEqual(seq(43));
  });
});

describe('simulateSeason (CS3, RNF1, R3)', () => {
  it('stagione completa senza errori: 6 round scored, tutti i pick valutati', async () => {
    const { db, ctx } = makeCtx();
    playAllMatches(db);

    const report = await simulateSeason(ctx, { players: 2, seed: 42 });

    expect(report.rounds).toHaveLength(6);
    for (const r of report.rounds) {
      expect(r.status).toBe('scored');
      expect(r.evaluated).toBe(r.picks);
    }
    // Nessun pick residuo in pending.
    const pending = db.prepare("SELECT COUNT(*) AS n FROM pick WHERE status = 'pending'").get() as {
      n: number;
    };
    expect(pending.n).toBe(0);
    // Profili sim registrati.
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 2 });
    // Pool bruciate (RF-10/CS5): nessun team ripetuto nello stesso girone.
    const profiles = db.prepare('SELECT id FROM profile ORDER BY id').all() as Array<{ id: number }>;
    for (const p of profiles) {
      const teams = db
        .prepare('SELECT team FROM pick WHERE profile_id = ? AND round BETWEEN 1 AND 3 ORDER BY round')
        .all(p.id) as Array<{ team: string }>;
      expect(new Set(teams.map((t) => t.team)).size).toBe(teams.length);
    }
  });

  it('RNF1: due run con stessa seed su DB freschi e stesso clock → export identici', async () => {
    const run = async (): Promise<unknown> => {
      const { db, ctx } = makeCtx();
      playAllMatches(db);
      await simulateSeason(ctx, { players: 3, seed: 42 });
      return tournamentExport(ctx);
    };
    expect(await run()).toEqual(await run());
  });

  it('RNF1: seed diverse → export diversi (il seed guida i pick)', async () => {
    const run = async (seed: number): Promise<unknown> => {
      const { db, ctx } = makeCtx();
      playAllMatches(db);
      await simulateSeason(ctx, { players: 3, seed });
      return tournamentExport(ctx);
    };
    expect(await run(1)).not.toEqual(await run(2));
  });

  it('guardia R3: torneo già avviato (season_started=1) → rifiuto pulito', async () => {
    const { ctx } = makeCtx();
    await startTournament(ctx);
    await expect(simulateSeason(ctx)).rejects.toThrow(/già avviato|avviata/);
  });

  it('guardia R3: round_state non-pending → rifiuto pulito', async () => {
    const { db, ctx } = makeCtx();
    db.prepare("INSERT INTO round_state (round, status) VALUES (1, 'open')").run();
    await expect(simulateSeason(ctx)).rejects.toThrow(/iniziato|non-pending|pending/);
  });

  it('CL13: aggancio --start-round 4 (confine girone) → finestra TC 4..6, pool azzerato', async () => {
    const { db, ctx } = makeCtx();
    playAllMatches(db);

    const report = await simulateSeason(ctx, { players: 2, seed: 7, startRound: 4 });

    expect(report.startRound).toBe(4);
    expect(report.rounds.map((r) => r.round)).toEqual([4, 5, 6]);
    for (const r of report.rounds) expect(r.status).toBe('scored');
    // Pool di ritorno azzerato al confine girone (CL13/RF-10): nessun team
    // ripetuto nei pick TC 4..6 di uno stesso profilo.
    const profiles = db.prepare('SELECT id FROM profile ORDER BY id').all() as Array<{ id: number }>;
    for (const p of profiles) {
      const teams = db
        .prepare('SELECT team FROM pick WHERE profile_id = ? ORDER BY round')
        .all(p.id) as Array<{ team: string }>;
      expect(new Set(teams.map((t) => t.team)).size).toBe(teams.length);
    }
  });

  it('CL12: aggancio all\'ultimo TC → lastRoundWarning nel report', async () => {
    const { db, ctx } = makeCtx();
    playAllMatches(db);
    const report = await simulateSeason(ctx, { players: 2, startRound: 6 });
    expect(report.lastRoundWarning).toBe(true);
    expect(report.rounds.map((r) => r.round)).toEqual([6]);
    expect(report.rounds[0]?.status).toBe('scored');
  });
});

describe('simulateRound (Task 7.1/10, ADR-009)', () => {
  it('round singolo su DB fresco: crea tournament_state con start_round, auto-join al TT1, round → scored', async () => {
    const { db, platform, ctx } = makeCtx();
    playAllMatches(db);

    const report = await simulateRound(ctx, 1, { players: 2, seed: 42 });

    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0]).toMatchObject({ round: 1, tc: 1, tt: 1, status: 'scored' });
    // La riga tournament_state è stata creata con start_round = round (RF-P5);
    // nessuna finestra di iscrizione (ADR-009: registration_open resta 0).
    expect(
      db.prepare('SELECT season_started, start_round, registration_open FROM tournament_state WHERE id = 1').get()
    ).toEqual({ season_started: 0, start_round: 1, registration_open: 0 });
    // Gli account sono sulla PIATTAFORMA; i profili sono nati per auto-join.
    expect(platform.list()).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 2 });
    const scored = db.prepare("SELECT COUNT(*) AS n FROM round_state WHERE status = 'scored'").get() as {
      n: number;
    };
    expect(scored.n).toBe(1);
  });

  it('guardia R3: round già non-pending → rifiuto pulito', async () => {
    const { db, ctx } = makeCtx();
    db.prepare("INSERT INTO round_state (round, status) VALUES (1, 'open')").run();
    await expect(simulateRound(ctx, 1)).rejects.toThrow(/iniziato|non-pending|pending/);
  });

  it('guardia R3: torneo già avviato → rifiuto pulito', async () => {
    const { ctx } = makeCtx();
    await startTournament(ctx);
    await expect(simulateRound(ctx, 1)).rejects.toThrow(/già avviato|avviata/);
  });

  it('guardia DB piattaforma sporco (ADR-009/RNF1): account pre-esistenti → rifiuto pulito', async () => {
    const { platform, ctx } = makeCtx();
    platform.register('estraneo@test.it', null, new Date('2026-09-01T10:00:00.000Z'));
    await expect(simulateRound(ctx, 1)).rejects.toThrow(/pulito|pulita/);
  });
});
