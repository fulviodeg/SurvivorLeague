/**
 * Test della guardia TEST_MODE su `data:import`/`data:refresh`
 * (src/cli/commands/data.ts, piano UAT Task 4).
 *
 * Verificano l'orchestrazione `importMatchesWithGuard(db, client, config,
 * logger)` — il punto testabile del comando (il handler fa solo wiring
 * config→client→output) — su SQLite in-memory con un CLIENT MOCKATO (il client
 * API è il confine esterno mockato, LLD §8). Coprono i tre rami della matrice:
 *   - TEST_MODE=true senza TEST_REFRESH_ALLOWED (default false): import/refresh
 *     SALTATI — nessuna chiamata API (client.getMatches mai invocato), nessuna
 *     scrittura in `match`, log pino info in inglese;
 *   - TEST_MODE=true + TEST_REFRESH_ALLOWED=true: import/refresh eseguono
 *     normalmente con log WARN di consenso che include il DB_PATH;
 *   - TEST_MODE=false: TEST_REFRESH_ALLOWED ignorato (gating a consumo, §0.3) —
 *     import/refresh reali, nessun log di skip/WARN (regressione).
 *
 * I log sono catturati con un logger pino su stream in memoria (stesso pattern
 * di tests/integration/seed-synthetic.test.ts): pino emette una riga JSON per
 * evento, con livello numerico 30 = info, 40 = warn.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig, type AppConfig } from '../../../src/config.js';
import {
  importMatchesWithGuard,
  refreshAllowedWarnMessage,
  SKIP_IMPORT_REFRESH_TEST_MODE
} from '../../../src/cli/commands/data.js';
import { migrate } from '../../../src/db/schema.js';
import { createLogger, type Logger } from '../../../src/logger.js';
import type { Match } from '../../../src/data/provider.js';
import { BASE_MATCHES } from '../../fixtures/season.js';

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

describe('importMatchesWithGuard — skip in test mode (Task 4)', () => {
  it('TEST_MODE=true senza TEST_REFRESH_ALLOWED → skip: nessuna API, nessuna scrittura, log info inglese', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    // TEST_REFRESH_ALLOWED assente → default false.
    const config = testConfig({ TEST_MODE: 'true' });
    const spy = spyClient(BASE_MATCHES);

    const result = await importMatchesWithGuard(db, spy.client, config, logger);

    expect(result).toEqual({ skipped: true, matches: 0 });
    expect(spy.calls()).toBe(0); // nessuna chiamata all'API
    expect(matchCount(db)).toBe(0); // nessun tocco alla tabella match
    expect(entries().some((e) => e.level === 30 && e.msg === SKIP_IMPORT_REFRESH_TEST_MODE)).toBe(true);
    db.close();
  });

  it('TEST_MODE=true con TEST_REFRESH_ALLOWED=false esplicito → stesso skip (default ed esplicito coincidono)', async () => {
    const db = createDb();
    const { logger } = captureLogger();
    const config = testConfig({ TEST_MODE: 'true', TEST_REFRESH_ALLOWED: 'false' });
    const spy = spyClient(BASE_MATCHES);

    const result = await importMatchesWithGuard(db, spy.client, config, logger);

    expect(result.skipped).toBe(true);
    expect(spy.calls()).toBe(0);
    expect(matchCount(db)).toBe(0);
    db.close();
  });
});

describe('importMatchesWithGuard — consenso con WARN (Task 4)', () => {
  it('TEST_MODE=true + TEST_REFRESH_ALLOWED=true → esegue normalmente, WARN di consenso con DB_PATH', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({
      TEST_MODE: 'true',
      TEST_REFRESH_ALLOWED: 'true',
      DB_PATH: '/tmp/uat-disposable.db'
    });
    const spy = spyClient(BASE_MATCHES);

    const result = await importMatchesWithGuard(db, spy.client, config, logger);

    expect(result).toEqual({ skipped: false, matches: BASE_MATCHES.length });
    expect(spy.calls()).toBe(1);
    expect(matchCount(db)).toBe(BASE_MATCHES.length);
    // WARN di consenso (livello 40) che include il DB_PATH.
    const warn = entries().find((e) => e.level === 40);
    expect(warn).toBeDefined();
    expect(warn!.msg).toBe(refreshAllowedWarnMessage(config.DB_PATH));
    expect(warn!.msg).toContain('/tmp/uat-disposable.db');
    db.close();
  });
});

describe('importMatchesWithGuard — regressione senza test mode (Task 4, gating §0.3)', () => {
  it('TEST_MODE=false → TEST_REFRESH_ALLOWED ignorato: import reale, nessun skip/WARN', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    // TEST_REFRESH_ALLOWED=true con TEST_MODE=false: ignorato (gating a consumo).
    const config = testConfig({ TEST_MODE: 'false', TEST_REFRESH_ALLOWED: 'true' });
    const spy = spyClient(BASE_MATCHES);

    const result = await importMatchesWithGuard(db, spy.client, config, logger);

    expect(result).toEqual({ skipped: false, matches: BASE_MATCHES.length });
    expect(spy.calls()).toBe(1);
    expect(matchCount(db)).toBe(BASE_MATCHES.length);
    // Nessun log di skip né WARN: comportamento attuale invariato.
    expect(entries()).toEqual([]);
    db.close();
  });
});
