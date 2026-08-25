/**
 * Comandi CLI dei dati stagione (LLD §7.2, piano Task 2.3).
 *
 * Ruolo: espone l'operatività sui dati stagione:
 *   - `data:import`  — scarica la stagione dall'API football-data.org e fa
 *     l'upsert idempotente nella tabella `match` (ADL transcazionale, nessuno
 *     stato parziale; src/data/importer.ts);
 *   - `data:refresh` — stessa logica di import, per aggiornare i risultati
 *     durante il gioco (invocato dallo scheduler a ogni tick, LLD §1.4);
 *   - `data:calendar` — stampa il calendario completo dal DB;
 *   - `data:results --round <n>` — stampa i risultati di un round dal DB;
 *   - `data:seed-synthetic` — genera la stagione sintetica UAT (piano UAT
 *     Task 2, decisioni D5-D8) con `generateSyntheticSeason` e la carica in
 *     `match` con `upsertMatches` (guardie anti-sovrascrittura e stato di
 *     gioco, log di sovrapposizione D8, gate test-only).
 *
 * Config-driven: il comando legge `getConfig()` (pattern di
 * src/cli/commands/db.ts) e INIETTA `{ baseUrl, token, competition, season }`
 * al `FootballDataClient` — mai `getConfig()`/`process.env` dentro il client
 * (briefing Fase 2, 2.1-8). Il Game Engine non passa da qui: legge il DB via
 * `DbSeasonDataProvider` (ADR-007).
 *
 * Output: `--json` strutturato (LLD §7.13) o testo leggibile per il commissioner.
 */
import type { Argv, CommandModule } from 'yargs';
import type Database from 'better-sqlite3';

import { type AppConfig, getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { FootballDataClient } from '../../data/football-data-client.js';
import { clearMatches, importMatches, upsertMatches } from '../../data/importer.js';
import type { Match } from '../../data/provider.js';
import { SYNTHETIC_TEAMS, generateSyntheticSeason } from '../../data/synthetic-season.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { createLogger, type Logger } from '../../logger.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/** Opzione condivisa dai comandi: output JSON strutturato invece del testo. */
const jsonOption = (yargs: Argv<object>): Argv<DataArgs> =>
  yargs.option('json', {
    type: 'boolean',
    default: false,
    describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
  });

/** Serializza un Match per l'output JSON (data canonica ISO-8601 UTC). */
function matchToJson(m: Match): Record<string, unknown> {
  return {
    round: m.round,
    matchDate: m.matchDate.toISOString(),
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    homeScore: m.homeScore ?? null,
    awayScore: m.awayScore ?? null,
    postponed: m.postponed
  };
}

/**
 * Formatta un Match per l'output testuale: round, orario canonico, coppia,
 * punteggio (o "–" se assente) e nota di stato (rinviata / da giocare).
 */
function matchToLine(m: Match): string {
  const score = m.homeScore != null && m.awayScore != null ? `${m.homeScore}-${m.awayScore}` : '–';
  const note = m.postponed ? ' [rinviata]' : m.homeScore == null ? ' [da giocare]' : '';
  return `R${m.round} ${m.matchDate.toISOString()} ${m.homeTeam} ${score} ${m.awayTeam}${note}`;
}

/**
 * Messaggio (inglese) di skip per import/refresh in test mode senza consenso
 * (piano UAT Task 4): usato sia nel log pino (livello info) sia nell'output
 * CLI testuale. Vincolo log_messages_english: log e output restano in inglese.
 */
export const SKIP_IMPORT_REFRESH_TEST_MODE =
  'import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled';

/**
 * Messaggio (inglese) del WARN di consenso per import/refresh in test mode con
 * TEST_REFRESH_ALLOWED=true (piano UAT Task 4): include il DB_PATH così
 * l'operatore vede su quale database sta operando (configurazione pericolosa su
 * DB sintetico, da rimuovere a fine UAT 3.3).
 */
export function refreshAllowedWarnMessage(dbPath: string): string {
  return `TEST_REFRESH_ALLOWED=true: import/refresh allowed in TEST MODE — operating on database ${dbPath}`;
}

/** Esito dell'import/refresh con guardia test mode (piano UAT Task 4). */
export interface ImportGuardResult {
  /** true se l'operazione è stata saltata per TEST MODE senza consenso. */
  skipped: boolean;
  /** Partite processate (0 se saltata). */
  matches: number;
}

/**
 * Guardia TEST_MODE su import/refresh (piano UAT Task 4) — punto testabile del
 * comando: il handler costruisce il client dalla config e passa db/client/
 * config/logger. `importMatches` resta PURA (nessun getConfig nei moduli): la
 * decisione di saltare o consentire vive QUI, nel comando CLI.
 *
 * CONVENZIONE (AGENTS.md §5): qualsiasi FUTURA chiamata a `importMatches` dai
 * comandi deve applicare la stessa guardia — mai invocare `importMatches` senza
 * passare da questa funzione o da una guardia equivalente.
 *
 * Matrice (gating a consumo, §0.3):
 *   - testMode=true e TEST_REFRESH_ALLOWED=false (default) → skip: log info
 *     (inglese), nessuna chiamata API né scrittura in `match`;
 *   - testMode=true e TEST_REFRESH_ALLOWED=true → log WARN di consenso (con
 *     DB_PATH) a OGNI operazione, poi import/refresh normali;
 *   - testMode=false → TEST_REFRESH_ALLOWED ignorato: import/refresh reali,
 *     nessun log di skip/WARN (comportamento attuale invariato).
 */
export async function importMatchesWithGuard(
  db: Database.Database,
  client: { getMatches(): Promise<Match[]> },
  config: AppConfig,
  logger: Logger
): Promise<ImportGuardResult> {
  if (config.testMode && !config.TEST_REFRESH_ALLOWED) {
    logger.info(SKIP_IMPORT_REFRESH_TEST_MODE);
    return { skipped: true, matches: 0 };
  }
  if (config.testMode && config.TEST_REFRESH_ALLOWED) {
    logger.warn({ dbPath: config.DB_PATH }, refreshAllowedWarnMessage(config.DB_PATH));
  }
  const matches = await importMatches(db, client);
  return { skipped: false, matches };
}

/** Esecuzione condivisa di import/refresh: config → client → guardia → output. */
async function runImport(mode: 'import' | 'refresh', json: boolean): Promise<void> {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  const logger = createLogger(config.LOG_LEVEL, undefined, config.testMode, config.TIMEZONE);
  try {
    migrate(db);
    const client = new FootballDataClient({
      baseUrl: config.FOOTBALL_DATA_BASE_URL,
      token: config.FOOTBALL_DATA_TOKEN,
      competition: config.FOOTBALL_DATA_COMPETITION,
      season: config.FOOTBALL_DATA_SEASON
    });
    const result = await importMatchesWithGuard(db, client, config, logger);
    if (json) {
      // Con skip il payload non riporta `matches` (nessun import eseguito).
      console.log(
        jsonWithTestMode(
          config,
          result.skipped ? { mode, skipped: true } : { mode, matches: result.matches }
        )
      );
    } else {
      printTestModeBanner(config);
      if (result.skipped) {
        console.log(SKIP_IMPORT_REFRESH_TEST_MODE);
      } else {
        const verb = mode === 'import' ? 'Importate' : 'Aggiornate';
        console.log(`${verb} ${result.matches} partite nella tabella match`);
      }
    }
  } finally {
    db.close();
  }
}

interface DataArgs {
  json: boolean;
}

interface ResultsArgs extends DataArgs {
  round?: number;
}

// ──── data:seed-synthetic (piano UAT Task 2, decisioni D5-D8) ────

/**
 * Warning pino/CLI: il seed è uno strumento del test mode e non va usato su
 * database di produzione. Messaggio IN INGLESE (vincolo log_messages_english).
 */
export const WARN_SEED_OUTSIDE_TEST_MODE =
  'data:seed-synthetic is a test-only command: seeding with TEST_MODE=false may pollute a production database with synthetic data';

/**
 * Warning pino/CLI: --force senza --clear su tabella non vuota produce un
 * calendario MISTO perché l'upsert non cancella mai. Messaggio IN INGLESE.
 */
export const WARN_FORCE_WITHOUT_CLEAR =
  '--force without --clear on a non-empty match table: existing rows are kept (upsert never deletes); the calendar may become mixed (Serie A + synthetic) and getTeams()/getTotalRounds() become inconsistent with the synthetic alias resource. Use --force --clear to wipe the match table first';

/**
 * Opzioni del comando `data:seed-synthetic`.
 * I default coincidono con quelli del builder yargs sotto.
 */
export interface SeedSyntheticOptions {
  /** Numero di squadre (2..SYNTHETIC_TEAMS.length): i nomi sono SYNTHETIC_TEAMS.slice(0, n). */
  teams: number;
  /** Numero di giornate (≥ 1); > teams-1 ripete gli accoppiamenti (wrap, D8). */
  rounds: number;
  /** Minuti tra due giornate consecutive (D8: distanzia SOLO le giornate, non le partite). */
  spacingMin: number;
  /** Minuti da Date.now() al fischio della prima giornata (clock REALE, TEST_OFFSET_DAYS=0). */
  firstKickoffOffsetMin: number;
  /** Seed del PRNG dei punteggi (D5): stesso seed → stessi gol. */
  seed: number;
  /** Consente il seed su tabella match non vuota (D6): upsert SENZA DELETE. */
  force: boolean;
  /** Svuota la tabella match prima del seed (SOLO match). Richiede --force e rifiuta se il torneo è in corso (Task 3). */
  clear: boolean;
}

/** Riepilogo del seed per l'output CLI (testuale o --json). */
export interface SeedSyntheticSummary {
  teams: number;
  rounds: number;
  /** Numero di partite generate e upsertate (4 per giornata con 8 squadre). */
  matches: number;
  /** Fischio della prima giornata (ISO-8601 UTC). */
  firstKickoff: string;
  /** Fischio dell'ultima giornata (ISO-8601 UTC). */
  lastKickoff: string;
  /** Warning non bloccanti emessi durante il seed (inglese). */
  warnings: string[];
}

/**
 * Numero di righe di una delle tabelle guardate dal seed.
 * I nomi delle tabelle sono letterali fissi, non input utente: nessun rischio
 * di SQL injection.
 */
function countRows(db: Database.Database, table: 'match' | 'pick' | 'round_state'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/**
 * Orchestrazione del seed (punto testabile del comando): contiene l'intera
 * logica — validazione, guardie, rilevazione sovrapposizione, generazione e
 * upsert — senza dipendere da yargs o dalla CLI. Il handler fa solo wiring
 * config → opzioni → funzione → output.
 *
 * Guardie e comportamenti:
 * 1. Gate test-only (WARN pino + warning riepilogo, NON blocco):
 *    con `testMode=false` il seed procede ma avvisa che è uno strumento UAT.
 * 2. Doppia conferma: `--clear` senza `--force` → rifiuto (operazione distruttiva).
 * 3. Guardia stato di gioco (Task 3): con `--force --clear`, rifiuta se
 *    `tournament_state.season_started=1` o esistono righe in `pick`/`round_state`
 *    (il DELETE lascerebbe orfani i pronostici).
 * 4. Anti-sovrascrittura (D6): tabella non vuota senza `--force` → rifiuto.
 *    Con `--force` senza `--clear`: WARN di calendario misto (upsert senza DELETE).
 * 5. Rilevazione sovrapposizione (D8): se `--spacing-min < MATCH_DURATION_MIN +
 *    TC_CLOSE_SKEW_MIN` → log `error` pino (inglese) con i parametri coinvolti;
 *    NON blocca.
 * 6. Generazione (`generateSyntheticSeason`, Task 1) e upsert (`upsertMatches`)
 *    sulla PK `(round, home_team, away_team)` — stessa pipeline di `data:import`.
 */
export function seedSyntheticSeason(
  db: Database.Database,
  opts: SeedSyntheticOptions,
  config: AppConfig,
  logger: Logger
): SeedSyntheticSummary {
  const warnings: string[] = [];

  // 0. Validazione --teams: errori chiari (ITALIANO, coerente con gli errori CLI del repo).
  if (!Number.isInteger(opts.teams) || opts.teams < 2 || opts.teams > SYNTHETIC_TEAMS.length) {
    throw new Error(
      `--teams deve essere un intero tra 2 e ${SYNTHETIC_TEAMS.length} (rosa sintetica disponibile)`
    );
  }

  // 1. Gate test-only (WARN, NON blocco).
  if (!config.testMode) {
    logger.warn(WARN_SEED_OUTSIDE_TEST_MODE);
    warnings.push(WARN_SEED_OUTSIDE_TEST_MODE);
  }

  // 2. Doppia conferma (D6): --clear è distruttivo, serve --force.
  if (opts.clear && !opts.force) {
    throw new Error(
      '--clear richiede --force (doppia conferma): svuota tutte le righe della tabella match prima del seed'
    );
  }

  const existing = countRows(db, 'match');

  if (opts.clear) {
    // 3. Guardia stato di gioco (Task 3): --clear solo a torneo NON in corso.
    const state = db
      .prepare('SELECT season_started AS started FROM tournament_state WHERE id = 1')
      .get() as { started: number } | undefined;
    const picks = countRows(db, 'pick');
    const roundStates = countRows(db, 'round_state');
    if ((state?.started ?? 0) === 1 || picks > 0 || roundStates > 0) {
      throw new Error(
        'Rifiuto --clear: stato di gioco presente (season_started=1 oppure righe in pick/round_state). La tabella match non può essere svuotata a torneo in corso'
      );
    }
    // Agisce SOLO sulla tabella match (task 2: documentato).
    if (existing > 0) clearMatches(db);
  } else if (existing > 0) {
    // 4a. Anti-sovrascrittura (D6): senza --force nessuna modifica.
    if (!opts.force) {
      throw new Error(
        `La tabella match non è vuota (${existing} righe): il seed sintetico non sovrascrive. ` +
          'Usa --force per l\'upsert (possibile calendario misto) oppure --force --clear per svuotare e ri-seedare'
      );
    }
    // 4b. --force senza --clear: upsert senza DELETE → calendario MISTO (WARN).
    logger.warn(WARN_FORCE_WITHOUT_CLEAR);
    warnings.push(WARN_FORCE_WITHOUT_CLEAR);
  }

  // 5. Rilevazione sovrapposizione (D8): log error pino (inglese), NON un blocco.
  const windowMin = config.MATCH_DURATION_MIN + config.TC_CLOSE_SKEW_MIN;
  if (opts.spacingMin < windowMin) {
    logger.error(
      {
        spacingMin: opts.spacingMin,
        matchDurationMin: config.MATCH_DURATION_MIN,
        tcCloseSkewMin: config.TC_CLOSE_SKEW_MIN
      },
      `Synthetic seed: spacing between rounds (--spacing-min = ${opts.spacingMin} min) is less than MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN (${config.MATCH_DURATION_MIN} + ${config.TC_CLOSE_SKEW_MIN} = ${windowMin} min): TC windows of consecutive rounds would overlap; verify MATCH_DURATION_MIN, TC_CLOSE_SKEW_MIN and --spacing-min`
    );
  }

  // 6. Generazione e upsert (stessa pipeline di data:import, ADR-007).
  const firstKickoff = new Date(Date.now() + opts.firstKickoffOffsetMin * 60_000);
  const matches = generateSyntheticSeason({
    teams: SYNTHETIC_TEAMS.slice(0, opts.teams),
    rounds: opts.rounds,
    spacingMin: opts.spacingMin,
    firstKickoff,
    seed: opts.seed
  });
  upsertMatches(db, matches);

  const lastKickoff = matches.reduce(
    (latest, m) => (m.matchDate.getTime() > latest.getTime() ? m.matchDate : latest),
    firstKickoff
  );

  return {
    teams: opts.teams,
    rounds: opts.rounds,
    matches: matches.length,
    firstKickoff: firstKickoff.toISOString(),
    lastKickoff: lastKickoff.toISOString(),
    warnings
  };
}

/** Argomenti CLI del comando (estende DataArgs con le opzioni del seed). */
interface SeedSyntheticArgs extends DataArgs {
  teams: number;
  rounds: number;
  spacingMin: number;
  firstKickoffOffsetMin: number;
  seed: number;
  force: boolean;
  clear: boolean;
}

export const dataSeedSyntheticCommand: CommandModule<object, SeedSyntheticArgs> = {
  command: 'data:seed-synthetic',
  describe:
    'Genera il calendario sintetico UAT (rosa Serie A, test mode) e lo carica nella tabella match (upsert idempotente)',
  builder: (yargs) =>
    jsonOption(yargs)
      .option('teams', {
        type: 'number',
        default: 8,
        describe: `Numero club Serie A (2..${SYNTHETIC_TEAMS.length}): nomi da SYNTHETIC_TEAMS.slice(0, n) — default = 8`
      })
      .option('rounds', {
        type: 'number',
        default: 7,
        describe:
          'Numero di giornate (round-robin per 8 squadre: di default 7, girone completo). > teams-1 ripete accoppiamenti (wrap, D8)'
      })
      .option('spacingMin', {
        type: 'number',
        default: 90,
        describe:
          'Minuti tra due giornate consecutive (D8: distanzia SOLO le giornate, nessuna partita della stessa giornata ha orari diversi). Default 90 → finestra di pick ~90 min per le giornate 2+'
      })
      .option('firstKickoffOffsetMin', {
        type: 'number',
        default: 120,
        describe:
          'Minuti da adesso (clock REALE, TEST_OFFSET_DAYS=0) al fischio d\'inizio della prima giornata. Default 120 → le prime partite cominciano 2 ore dopo il seed'
      })
      .option('seed', {
        type: 'number',
        default: 42,
        describe:
          'Seed deterministico dei gol (D5). Stesso seed → stessi punteggi su tutte le partite. Default 42'
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe:
          'Consente il seed su una tabella match già popolata (D6). Con --force senza --clear l\'upsert non cancella mai le righe esistenti → calendario MISTO possibile'
      })
      .option('clear', {
        type: 'boolean',
        default: false,
        describe:
          'Svuota la tabella match (e SOLO match) prima del seed. Richiede --force (doppia conferma). Rifiuta se il torneo è in corso (season_started=1 o righe in pick/round_state)'
      }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const logger = createLogger(config.LOG_LEVEL, undefined, config.testMode, config.TIMEZONE);
      const summary = seedSyntheticSeason(
        db,
        {
          teams: argv.teams,
          rounds: argv.rounds,
          spacingMin: argv.spacingMin,
          firstKickoffOffsetMin: argv.firstKickoffOffsetMin,
          seed: argv.seed,
          force: argv.force,
          clear: argv.clear
        },
        config,
        logger
      );
      if (argv.json) {
        console.log(jsonWithTestMode(config, summary));
      } else {
        printTestModeBanner(config);
        for (const warning of summary.warnings) console.log(`WARNING: ${warning}`);
        console.log(
          `Seed completato: ${summary.teams} squadre, ${summary.rounds} giornate, ${summary.matches} partite`
        );
        console.log(`Primo fischio: ${summary.firstKickoff}`);
        console.log(`Ultimo fischio: ${summary.lastKickoff}`);
      }
    } finally {
      db.close();
    }
  }
};

// ──── data:import ────

export const dataImportCommand: CommandModule<object, DataArgs> = {
  command: 'data:import',
  describe:
    "Importa calendario e risultati dalla stagione dall'API football-data.org (upsert idempotente)",
  builder: jsonOption,
  handler: (argv) => runImport('import', argv.json)
};

export const dataRefreshCommand: CommandModule<object, DataArgs> = {
  command: 'data:refresh',
  describe:
    'Aggiorna calendario e risultati dalla stagione dall’API football-data.org (upsert, idempotente)',
  builder: jsonOption,
  handler: (argv) => runImport('refresh', argv.json)
};

export const dataCalendarCommand: CommandModule<object, DataArgs> = {
  command: 'data:calendar',
  describe: 'Mostra il calendario completo della stagione dalla tabella match',
  builder: jsonOption,
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const matches = await new DbSeasonDataProvider(db).getCalendar();
      if (argv.json) {
        console.log(jsonWithTestMode(config, matches.map(matchToJson)));
      } else {
        printTestModeBanner(config);
        for (const m of matches) console.log(matchToLine(m));
      }
    } finally {
      db.close();
    }
  }
};

export const dataResultsCommand: CommandModule<object, ResultsArgs> = {
  command: 'data:results',
  describe: 'Mostra i risultati di un round dalla tabella match',
  builder: (yargs) =>
    jsonOption(yargs).option('round', {
      type: 'number',
      demandOption: true,
      describe: 'Numero del round (TC) di cui mostrare i risultati'
    }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      // --round è richiesto dal builder (demandOption): qui è sempre definito.
      const matches = await new DbSeasonDataProvider(db).getMatchesForRound(argv.round as number);
      if (argv.json) {
        console.log(jsonWithTestMode(config, matches.map(matchToJson)));
      } else if (matches.length === 0) {
        printTestModeBanner(config);
        console.log(`Nessuna partita per il round ${argv.round}`);
      } else {
        printTestModeBanner(config);
        for (const m of matches) console.log(matchToLine(m));
      }
    } finally {
      db.close();
    }
  }
};
