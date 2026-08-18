/**
 * Test di integrazione del comando `data:seed-synthetic`
 * (piano UAT Task 2, decisioni D5/D6/D7/D8).
 *
 * Verificano l'orchestrazione `seedSyntheticSeason(db, opts, config, logger)`
 * (src/cli/commands/data.ts) su SQLite in-memory reale, SENZA invocare yargs:
 * la funzione pura è il punto testabile del comando (genera → guardie →
 * overlap → upsert → riepilogo), il handler fa solo wiring config→opzioni.
 * Coprono:
 *   - seed base: popola `match` con la stagione sintetica (nomi da
 *     `SYNTHETIC_TEAMS`, D7; punteggi pre-seedati, D5) e riepilogo;
 *   - upsert idempotente sulla PK `(round, home_team, away_team)`;
 *   - guardia anti-sovrascrittura (D6): rifiuto senza `--force` su tabella
 *     non vuota, nessuna modifica;
 *   - `--force` senza `--clear` su tabella non vuota → WARN (inglese) di
 *     calendario misto, righe esistenti NON cancellate;
 *   - `--force --clear` → (previa guardia stato di gioco, Task 3) tabella
 *     svuotata e ri-seedata, zero righe residue; `--clear` senza `--force` →
 *     rifiuto (doppia conferma);
 *   - guardia stato di gioco: `season_started=1` o righe in `pick`/
 *     `round_state` → rifiuto esplicito del `--clear`;
 *   - rilevazione sovrapposizione (D8): spacing < MATCH_DURATION_MIN +
 *     TC_CLOSE_SKEW_MIN → log `error` pino (inglese) con suggerimento dei
 *     parametri coinvolti, seed che PROSEGUE (log, non blocco);
 *   - gate test-only: `testMode=false` → WARN pino (inglese) + warning nel
 *     riepilogo, seed che procede.
 *
 * I log sono catturati con un logger pino su stream in memoria
 * (stesso pattern di tests/unit/logger.test.ts): pino emette una riga JSON
 * per evento, con livello numerico 40 = warn, 50 = error.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { migrate } from '../../src/db/schema.js';
import { parseConfig, type AppConfig } from '../../src/config.js';
import { createLogger, type Logger } from '../../src/logger.js';
import {
  seedSyntheticSeason,
  WARN_FORCE_WITHOUT_CLEAR,
  WARN_SEED_OUTSIDE_TEST_MODE,
  type SeedSyntheticOptions
} from '../../src/cli/commands/data.js';
import { SYNTHETIC_TEAMS } from '../../src/data/synthetic-season.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { loadBaseSeason } from '../fixtures/season.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Config valida: testMode attivo di default (i test di gate lo disattivano esplicitamente). */
function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    TEST_MODE: 'true',
    ...overrides
  });
}

/** Opzioni CLI di default del comando (gli stessi default del builder yargs). */
function opts(overrides: Partial<SeedSyntheticOptions> = {}): SeedSyntheticOptions {
  return {
    teams: 8,
    rounds: 7,
    spacingMin: 90,
    firstKickoffOffsetMin: 120,
    seed: 42,
    force: false,
    clear: false,
    ...overrides
  };
}

/** Crea un DB in-memory migrato (nessun stato di gioco). */
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

/** Logger su stream in memoria: espone le righe pino parsate (livello numerico + messaggio). */
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

describe('seed-synthetic — seed base (Task 2)', () => {
  it('popola la tabella match con la stagione sintetica e restituisce il riepilogo', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T18:00:00.000Z'));
    const db = createDb();
    const { logger } = captureLogger();

    const summary = seedSyntheticSeason(db, opts(), testConfig(), logger);

    // Riepilogo: 8 squadre, 7 giornate (round-robin completo), 4 partite × 7.
    expect(summary).toMatchObject({
      teams: 8,
      rounds: 7,
      matches: 28,
      firstKickoff: '2026-08-20T20:00:00.000Z', // now + 120 min (clock reale, TEST_OFFSET_DAYS=0)
      lastKickoff: '2026-08-21T05:00:00.000Z', // primo fischio + 6 × 90 min
      warnings: []
    });
    // D7: i nomi provengono da SYNTHETIC_TEAMS (coerenza alias garantita dal test di coincidenza).
    const teams = [...new Set(db.prepare('SELECT home_team AS t FROM match UNION SELECT away_team AS t FROM match').all().map((r) => (r as { t: string }).t))];
    expect(teams.sort()).toEqual([...SYNTHETIC_TEAMS].sort());
    expect(matchCount(db)).toBe(28);
    db.close();
  });

  it('upsert idempotente sulla PK (round, home_team, away_team): il re-run con --force non duplica', async () => {
    // Clock fissato: i due seed generano lo STESSO calendario (stesso primo fischio).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T18:00:00.000Z'));
    const db = createDb();
    const { logger } = captureLogger();

    seedSyntheticSeason(db, opts(), testConfig(), logger);
    const before = await new DbSeasonDataProvider(db).getCalendar();

    // Re-run con --force (tabella non vuota): upsert, nessuna riga nuova né modifica.
    const summary = seedSyntheticSeason(db, opts({ force: true }), testConfig(), logger);

    expect(matchCount(db)).toBe(28);
    expect(summary.matches).toBe(28);
    expect(await new DbSeasonDataProvider(db).getCalendar()).toEqual(before);
    db.close();
  });
});

describe('seed-synthetic — guardia anti-sovrascrittura (D6, Task 3)', () => {
  it('su tabella non vuota senza --force rifiuta con errore chiaro e nessuna modifica', async () => {
    const db = createDb();
    const { logger } = captureLogger();
    seedSyntheticSeason(db, opts(), testConfig(), logger);
    const before = await new DbSeasonDataProvider(db).getCalendar();

    expect(() => seedSyntheticSeason(db, opts(), testConfig(), logger)).toThrow(/non è vuota/);

    expect(await new DbSeasonDataProvider(db).getCalendar()).toEqual(before);
    expect(matchCount(db)).toBe(28);
    db.close();
  });

  it('--clear senza --force rifiuta (doppia conferma), anche su tabella vuota', () => {
    const db = createDb();
    const { logger } = captureLogger();

    expect(() => seedSyntheticSeason(db, opts({ clear: true }), testConfig(), logger)).toThrow(
      /--clear richiede --force/
    );

    expect(matchCount(db)).toBe(0);
    db.close();
  });

  it('--force senza --clear su tabella non vuota: WARN inglese di calendario misto, righe NON cancellate', async () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    loadBaseSeason(db); // 12 righe Serie A pre-esistenti (simula un DB reale)

    const summary = seedSyntheticSeason(db, opts({ force: true }), testConfig(), logger);

    // Upsert senza DELETE: le 12 righe Serie A restano, si aggiungono le 28 sintetiche.
    expect(matchCount(db)).toBe(40);
    // WARN esplicito (inglese) nel log e nel riepilogo.
    expect(summary.warnings).toEqual([WARN_FORCE_WITHOUT_CLEAR]);
    expect(entries().some((e) => e.level === 40 && e.msg.includes('mixed'))).toBe(true);
    const teams = await new DbSeasonDataProvider(db).getTeams();
    expect(teams.some((t) => t === 'FC Internazionale Milano')).toBe(true); // calendario MISTO
    expect(teams.some((t) => t === SYNTHETIC_TEAMS[0])).toBe(true);
    db.close();
  });
});

describe('seed-synthetic — --force --clear (D6, Task 3)', () => {
  it('su tabella non vuota senza stato di gioco svuota match e ri-seeda (zero righe residue)', async () => {
    const db = createDb();
    const { logger } = captureLogger();
    loadBaseSeason(db); // 12 righe Serie A

    const summary = seedSyntheticSeason(db, opts({ force: true, clear: true }), testConfig(), logger);

    expect(matchCount(db)).toBe(28); // solo la stagione sintetica: zero righe residue Serie A
    expect(summary.matches).toBe(28);
    const teams = await new DbSeasonDataProvider(db).getTeams();
    expect(teams.sort()).toEqual([...SYNTHETIC_TEAMS].sort());
    db.close();
  });

  it('su tabella vuota (senza stato di gioco) svuota (no-op) e ri-seeda', () => {
    const db = createDb();
    const { logger } = captureLogger();

    const summary = seedSyntheticSeason(db, opts({ force: true, clear: true }), testConfig(), logger);

    expect(summary.matches).toBe(28);
    expect(summary.warnings).toEqual([]);
    expect(matchCount(db)).toBe(28);
    db.close();
  });

  it('rifiuta se season_started=1 (stato di gioco presente), nessuna modifica', () => {
    const db = createDb();
    const { logger } = captureLogger();
    loadBaseSeason(db);
    db.prepare('INSERT INTO tournament_state (id, season_started) VALUES (1, 1)').run();

    expect(() =>
      seedSyntheticSeason(db, opts({ force: true, clear: true }), testConfig(), logger)
    ).toThrow(/stato di gioco/);

    expect(matchCount(db)).toBe(12); // invariata
    db.close();
  });

  it('rifiuta se esistono righe in pick (stato di gioco presente), nessuna modifica', () => {
    const db = createDb();
    const { logger } = captureLogger();
    loadBaseSeason(db);
    // Riga di pick valida (le FK su player/profile sono attive: righe reali minime).
    db.prepare("INSERT INTO player (email, name) VALUES ('test@example.com', 'T')").run();
    db.prepare('INSERT INTO profile (player_id) VALUES (1)').run();
    db.prepare("INSERT INTO pick (profile_id, round, team, outcome) VALUES (1, 1, 'X', 'win')").run();

    expect(() =>
      seedSyntheticSeason(db, opts({ force: true, clear: true }), testConfig(), logger)
    ).toThrow(/stato di gioco/);

    expect(matchCount(db)).toBe(12);
    db.close();
  });

  it('rifiuta se esistono righe in round_state (stato di gioco presente), nessuna modifica', () => {
    const db = createDb();
    const { logger } = captureLogger();
    loadBaseSeason(db);
    db.prepare("INSERT INTO round_state (round, status) VALUES (1, 'open')").run();

    expect(() =>
      seedSyntheticSeason(db, opts({ force: true, clear: true }), testConfig(), logger)
    ).toThrow(/stato di gioco/);

    expect(matchCount(db)).toBe(12);
    db.close();
  });
});

describe('seed-synthetic — rilevazione sovrapposizione (D8)', () => {
  it('spacing < MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN → log error (inglese) con i parametri coinvolti, seed prosegue', () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    // Config UAT compressa: 5 + 10 = 15 min di finestra; --spacing-min 10 → sovrapposta.
    const config = testConfig({ MATCH_DURATION_MIN: '5', TC_CLOSE_SKEW_MIN: '10' });

    const summary = seedSyntheticSeason(db, opts({ spacingMin: 10 }), config, logger);

    // È un LOG, NON un blocco: il seed prosegue.
    expect(summary.matches).toBe(28);
    expect(matchCount(db)).toBe(28);
    // Messaggio in INGLESE con il suggerimento dei parametri coinvolti (livello pino 50 = error).
    const errorEntry = entries().find((e) => e.level === 50);
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.msg).toMatch(/MATCH_DURATION_MIN/);
    expect(errorEntry!.msg).toMatch(/TC_CLOSE_SKEW_MIN/);
    expect(errorEntry!.msg).toMatch(/--spacing-min/);
    expect(errorEntry!.msg).toMatch(/overlap/);
    db.close();
  });

  it('spacing ≥ durata + skew → nessun log error di sovrapposizione', () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({ MATCH_DURATION_MIN: '5', TC_CLOSE_SKEW_MIN: '10' });

    seedSyntheticSeason(db, opts({ spacingMin: 90 }), config, logger);

    expect(entries().some((e) => e.level === 50)).toBe(false);
    expect(matchCount(db)).toBe(28);
    db.close();
  });
});

describe('seed-synthetic — gate test-only (WARN, non blocco)', () => {
  it('testMode=false → procede con WARN inglese "test-only command" nel log e nel riepilogo', () => {
    const db = createDb();
    const { logger, entries } = captureLogger();
    const config = testConfig({ TEST_MODE: 'false' });

    const summary = seedSyntheticSeason(db, opts(), config, logger);

    expect(summary.warnings).toEqual([WARN_SEED_OUTSIDE_TEST_MODE]);
    expect(entries().some((e) => e.level === 40 && e.msg.includes('test-only'))).toBe(true);
    expect(matchCount(db)).toBe(28);
    db.close();
  });

  it('testMode=true → nessun WARN test-only', () => {
    const db = createDb();
    const { logger, entries } = captureLogger();

    const summary = seedSyntheticSeason(db, opts(), testConfig(), logger);

    expect(summary.warnings).toEqual([]);
    expect(entries().some((e) => e.level === 40)).toBe(false);
    db.close();
  });
});

describe('seed-synthetic — opzioni (--teams, --first-kickoff-offset-min)', () => {
  it('--teams fuori [2, SYNTHETIC_TEAMS.length] → errore chiaro, nessuna modifica', () => {
    const db = createDb();
    const { logger } = captureLogger();

    expect(() => seedSyntheticSeason(db, opts({ teams: 1 }), testConfig(), logger)).toThrow(
      /--teams/
    );
    expect(() =>
      seedSyntheticSeason(db, opts({ teams: SYNTHETIC_TEAMS.length + 1 }), testConfig(), logger)
    ).toThrow(/--teams/);

    expect(matchCount(db)).toBe(0);
    db.close();
  });

  it('--teams 4 usa i primi 4 nomi di SYNTHETIC_TEAMS (slice(0, n)) e rispetta gli offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T18:00:00.000Z'));
    const db = createDb();
    const { logger } = captureLogger();

    const summary = seedSyntheticSeason(
      db,
      opts({ teams: 4, rounds: 3, spacingMin: 45, firstKickoffOffsetMin: 30 }),
      testConfig(),
      logger
    );

    expect(summary.matches).toBe(6); // 2 partite × 3 giornate
    expect(summary.firstKickoff).toBe('2026-08-20T18:30:00.000Z'); // now + 30 min
    expect(summary.lastKickoff).toBe('2026-08-20T20:00:00.000Z'); // + 2 × 45 min
    const teams = [
      ...new Set(
        db.prepare('SELECT home_team AS t FROM match UNION SELECT away_team AS t FROM match')
          .all()
          .map((r) => (r as { t: string }).t)
      )
    ];
    expect(teams.sort()).toEqual([...SYNTHETIC_TEAMS.slice(0, 4)].sort());
    db.close();
  });
});
