/**
 * Test della guardia TEST_MODE sul refresh dello scheduler
 * (src/cli/commands/scheduler.ts, piano UAT Task 4).
 *
 * Verificano la costruzione del refresh `buildRefreshForTick(db, client,
 * config, logger)` — il punto testabile del comando (il handler fa solo wiring
 * config→client→refresh→tick) — su SQLite in-memory con CLIENT MOCKATO. Coprono
 * i tre rami della matrice e l'integrazione con `schedulerTick`:
 *   - TEST_MODE=true senza TEST_REFRESH_ALLOWED (default false): il refresh NON
 *     viene costruito (undefined) → `schedulerTick` non chiama l'API, log pino
 *     info di skip in inglese, le azioni del round PROSEGUONO;
 *   - TEST_MODE=true + TEST_REFRESH_ALLOWED=true: refresh costruito con log WARN
 *     di consenso che include il DB_PATH; esegue l'import quando invocato;
 *   - TEST_MODE=false: refresh costruito normalmente (nessun skip/WARN),
 *     TEST_REFRESH_ALLOWED ignorato (gating a consumo, §0.3);
 *   - con la guardia attiva `deps.refresh` è undefined → l'evento
 *     `refresh_failed` è irraggiungibile in test mode (comportamento atteso).
 *
 * I log sono catturati con un logger pino su stream in memoria: livello
 * numerico 30 = info, 40 = warn.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig, type AppConfig } from '../../../src/config.js';
import { buildRefreshForTick } from '../../../src/cli/commands/scheduler.js';
import {
  refreshAllowedWarnMessage,
  SKIP_IMPORT_REFRESH_TEST_MODE
} from '../../../src/cli/commands/data.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import { schedulerTick } from '../../../src/game/scheduler.js';
import { startTournament } from '../../../src/game/tournament.js';
import { createLogger, type Logger } from '../../../src/logger.js';
import type { Match } from '../../../src/data/provider.js';
import { BASE_MATCHES, loadBaseSeason } from '../../fixtures/season.js';

/** Config valida; TEST_MODE/DB_PATH personalizzabili via overrides. */
function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    ...overrides
  });
}

/** Crea un DB in-memory migrato (tabella `match` vuota). */
function createDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

/** Numero di righe della tabella `match`. */
function matchCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM match').get() as { n: number };
  return row.n;
}

/** Client API finto che conta le chiamate a getMatches (nessun fetch reale). */
function spyClient(matches: Match[]): {
  client: { getMatches(): Promise<Match[]> };
  calls: () => number;
} {
  let calls = 0;
  return {
    client: {
      getMatches: async () => {
        calls += 1;
        return matches;
      }
    },
    calls: () => calls
  };
}

/** Logger su stream in memoria: espone le righe pino parsate (livello + messaggio). */
function captureLogger(): {
  logger: Logger;
  entries: () => Array<{ level: number; msg: string }>;
} {
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (chunk: string) => void lines.push(chunk) });
  return {
    logger,
    entries: () => lines.map((line) => JSON.parse(line) as { level: number; msg: string })
  };
}

describe('buildRefreshForTick — skip in test mode (Task 4)', () => {
  it('TEST_MODE=true senza TEST_REFRESH_ALLOWED → refresh NON costruito (undefined) + log info inglese', () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({ TEST_MODE: 'true' });
    const spy = spyClient(BASE_MATCHES);

    const refresh = buildRefreshForTick(db, spy.client, config, logger);

    expect(refresh).toBeUndefined();
    expect(spy.calls()).toBe(0); // nessuna chiamata all'API
    expect(matchCount(db)).toBe(0); // nessun tocco alla tabella match
    expect(entries().some((e) => e.level === 30 && e.msg === SKIP_IMPORT_REFRESH_TEST_MODE)).toBe(true);
    db.close();
  });
});

describe('buildRefreshForTick — consenso con WARN (Task 4)', () => {
  it('TEST_MODE=true + TEST_REFRESH_ALLOWED=true → refresh costruito, WARN con DB_PATH, esegue l\'import', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({
      TEST_MODE: 'true',
      TEST_REFRESH_ALLOWED: 'true',
      DB_PATH: '/tmp/uat-disposable.db'
    });
    const spy = spyClient(BASE_MATCHES);

    const refresh = buildRefreshForTick(db, spy.client, config, logger);

    // WARN di consenso (livello 40) emesso alla costruzione, con DB_PATH.
    const warn = entries().find((e) => e.level === 40);
    expect(warn).toBeDefined();
    expect(warn!.msg).toBe(refreshAllowedWarnMessage(config.DB_PATH));
    expect(warn!.msg).toContain('/tmp/uat-disposable.db');

    // Il refresh costruito esegue normalmente l'import quando invocato.
    expect(refresh).toBeDefined();
    const count = await refresh!();
    expect(count).toBe(BASE_MATCHES.length);
    expect(spy.calls()).toBe(1);
    expect(matchCount(db)).toBe(BASE_MATCHES.length);
    db.close();
  });
});

describe('buildRefreshForTick — regressione senza test mode (Task 4, gating §0.3)', () => {
  it('TEST_MODE=false → refresh costruito normalmente, TEST_REFRESH_ALLOWED ignorato, nessun skip/WARN', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({ TEST_MODE: 'false', TEST_REFRESH_ALLOWED: 'true' });
    const spy = spyClient(BASE_MATCHES);

    const refresh = buildRefreshForTick(db, spy.client, config, logger);

    expect(refresh).toBeDefined();
    expect(entries()).toEqual([]); // nessun skip/WARN

    const count = await refresh!();
    expect(count).toBe(BASE_MATCHES.length);
    expect(spy.calls()).toBe(1);
    expect(matchCount(db)).toBe(BASE_MATCHES.length);
    db.close();
  });
});

describe('buildRefreshForTick + schedulerTick — integrazione (Task 4)', () => {
  it('con la guardia attiva il tick PROSEGUE con le azioni dovute e non emette refresh_failed', async () => {
    const db = createDb();
    loadBaseSeason(db);
    const { logger } = captureLogger();
    const config = testConfig({ TEST_MODE: 'true' }); // refresh saltato
    const spy = spyClient(BASE_MATCHES);
    const ctx: GameContext = {
      db,
      dataProvider: new DbSeasonDataProvider(db),
      config,
      now: new Date('2026-09-01T10:00:00.000Z')
    };
    await startTournament(ctx);

    const refresh = buildRefreshForTick(db, spy.client, config, logger);
    expect(refresh).toBeUndefined();

    const res = await schedulerTick(ctx, { refresh });

    // Nessuna chiamata API, nessun evento refresh_failed, azione dovuta eseguita.
    expect(spy.calls()).toBe(0);
    expect(res.events).toEqual([{ type: 'round_open', round: 1 }]);
    expect(res.events.some((e) => e.type === 'refresh_failed')).toBe(false);
    db.close();
  });
});
