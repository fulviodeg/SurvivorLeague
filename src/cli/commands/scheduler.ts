/**
 * Comandi CLI dello scheduler (LLD §7.12, piano Task 7.2; decisioni R5–R7 del
 * briefing Fase 7).
 *
 * Ruolo: espone l'orchestratore di produzione al cron:
 *   - `scheduler:tick` — esegue le azioni dovute (finestra di iscrizione,
 *     open/close/score round, chiusure di sicurezza RF-30) dopo un
 *     `data:refresh` reale; se `SCHEDULER_ENABLED=false` stampa e ESCE senza
 *     effetti (LLD §7.12: in sviluppo il commissioner usa i comandi manuali).
 *     Ogni evento è loggato con pino (audit R5: warn per le chiusure di
 *     sicurezza e il refresh fallito);
 *   - `scheduler:status` — SEMPRE attivo (sola lettura, idempotente): stato
 *     computato (R5), anomalie (RF-30) e prossime azioni.
 *
 * Pattern CLI consolidato (briefing §1-I): il contesto è costruito QUI (con
 * le componenti email reali come `round:*` — in produzione le chiusure
 * notificano; niente getConfig() nei moduli), la logica è nel modulo
 * `src/game/scheduler.ts`.
 */
import type Database from 'better-sqlite3';
import type { Argv, CommandModule } from 'yargs';

import { getConfig, type AppConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { FootballDataClient } from '../../data/football-data-client.js';
import { importMatches } from '../../data/importer.js';
import type { Match } from '../../data/provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import type { GameContext } from '../../game/context.js';
import {
  schedulerStatus,
  schedulerTick,
  type SchedulerEvent
} from '../../game/scheduler.js';
import { createLogger, type Logger } from '../../logger.js';
import { attachEmailToContext } from '../email-wiring.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';
import { SKIP_IMPORT_REFRESH_TEST_MODE, refreshAllowedWarnMessage } from './data.js';

/** Opzione JSON condivisa (LLD §7.13). */
function jsonOption(y: Argv<object>) {
  return y.option('json', {
    type: 'boolean' as const,
    default: false,
    describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
  });
}

interface JsonArg {
  json: boolean;
}

/** Contesto di produzione dello scheduler: clock reale + email reali (R7/§G). */
function makeSchedulerContext(): {
  ctx: GameContext;
  db: ReturnType<typeof createConnection>;
  config: AppConfig;
  logger: Logger;
} {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const base: GameContext = { db, dataProvider, config, now: makeNow(config) };
  return {
    ctx: attachEmailToContext(base, config),
    db,
    config,
    logger: createLogger(config.LOG_LEVEL, undefined, config.testMode)
  };
}

/**
 * Logga un evento con pino (audit R5): warn per le chiusure di sicurezza
 * (`*_safety`), per il refresh fallito e per il TC non calcolabile; info per
 * le azioni normali. Campi strutturati `{event, round?, cause?}` (LLD §1.4).
 */
function logEvent(logger: Logger, e: SchedulerEvent): void {
  const fields = {
    event: e.type,
    ...('round' in e && e.round !== undefined ? { round: e.round } : {}),
    ...('cause' in e && e.cause !== undefined ? { cause: e.cause } : {})
  };
  const warn =
    e.type === 'round_close_safety' ||
    e.type === 'register_close_safety' ||
    e.type === 'refresh_failed' ||
    e.type === 'warn_not_calculable';
  if (warn) logger.warn(fields, `scheduler: ${e.type}`);
  else logger.info(fields, `scheduler: ${e.type}`);
}

/**
 * Costruisce il refresh dei dati stagione per il tick applicando la guardia
 * TEST_MODE (piano UAT Task 4) — punto testabile del comando: il handler
 * costruisce il client dalla config e passa db/client/config/logger. La
 * decisione vive QUI, nel comando CLI: il modulo `src/game/scheduler.ts` NON
 * viene toccato (il `deps.refresh` non viene passato quando la guardia è
 * attiva).
 *
 * CONVENZIONE (AGENTS.md §5): come `importMatchesWithGuard` in data.ts, ogni
 * futura chiamata a `importMatches` dai comandi deve applicare la stessa guardia.
 *
 * Matrice (gating a consumo, §0.3):
 *   - testMode=true e TEST_REFRESH_ALLOWED=false (default) → restituisce
 *     `undefined` (nessun refresh: nessuna chiamata API) e logga lo skip
 *     (info, inglese). Con `deps.refresh` assente l'evento `refresh_failed` è
 *     IRRAGGIUNGIBILE in test mode (comportamento atteso, Task 4);
 *   - testMode=true e TEST_REFRESH_ALLOWED=true → log WARN di consenso (con
 *     DB_PATH) a OGNI tick che esegue il refresh, poi refresh normale;
 *   - testMode=false → refresh normale (TEST_REFRESH_ALLOWED ignorato).
 */
export function buildRefreshForTick(
  db: Database.Database,
  client: { getMatches(): Promise<Match[]> },
  config: AppConfig,
  logger: Logger
): (() => Promise<number>) | undefined {
  if (config.testMode && !config.TEST_REFRESH_ALLOWED) {
    logger.info(SKIP_IMPORT_REFRESH_TEST_MODE);
    return undefined;
  }
  if (config.testMode && config.TEST_REFRESH_ALLOWED) {
    logger.warn({ dbPath: config.DB_PATH }, refreshAllowedWarnMessage(config.DB_PATH));
  }
  return () => importMatches(db, client);
}

export const schedulerTickCommand: CommandModule<object, JsonArg> = {
  command: 'scheduler:tick',
  describe:
    'Orchestratore sottile (LLD §1.4): refresh dati + azioni dovute (finestra iscrizione, open/close/score, chiusure di sicurezza RF-30); esce senza effetti se SCHEDULER_ENABLED=false',
  builder: jsonOption,
  handler: async (argv) => {
    const { ctx, db, config, logger } = makeSchedulerContext();
    try {
      // LLD §7.12: in sviluppo/test lo scheduler non è attivo — il comando
      // esiste ma non esegue azioni automatiche.
      if (!config.SCHEDULER_ENABLED) {
        printTestModeBanner(config);
        console.log(
          'Scheduler disabilitato (SCHEDULER_ENABLED=false): nessuna azione eseguita — usa i comandi manuali (LLD §7.12)'
        );
        return;
      }

      // R6 + guardia TEST_MODE (Task 4): il client è costruito QUI, la
      // decisione di passare il refresh vive in `buildRefreshForTick`
      // (nessun getConfig() nei moduli: importMatches resta pura;
      // src/game/scheduler.ts NON toccato — con guardia attiva `deps.refresh`
      // non viene passato e l'evento `refresh_failed` è irraggiungibile in
      // test mode, comportamento atteso).
      const client = new FootballDataClient({
        baseUrl: config.FOOTBALL_DATA_BASE_URL,
        token: config.FOOTBALL_DATA_TOKEN,
        competition: config.FOOTBALL_DATA_COMPETITION,
        season: config.FOOTBALL_DATA_SEASON
      });
      const refresh = buildRefreshForTick(db, client, config, logger);

      const { events } = await schedulerTick(ctx, { refresh });
      for (const e of events) logEvent(logger, e);

      if (argv.json) {
        console.log(jsonWithTestMode(config, { events }));
      } else if (events.length === 0) {
        printTestModeBanner(config);
        console.log('Tick completato — nessuna azione da eseguire');
      } else {
        printTestModeBanner(config);
        console.log('Tick completato — eventi:');
        for (const e of events) {
          const detail = 'round' in e && e.round !== undefined ? ` (TC ${e.round})` : '';
          console.log(`  ${e.type}${detail}`);
        }
      }
    } finally {
      db.close();
    }
  }
};

export const schedulerStatusCommand: CommandModule<object, JsonArg> = {
  command: 'scheduler:status',
  describe:
    'Stato computato dello scheduler (R5): round, anomalie RF-30 e prossime azioni — sempre attivo, sola lettura',
  builder: jsonOption,
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const dataProvider = new DbSeasonDataProvider(db);
      const ctx: GameContext = { db, dataProvider, config, now: makeNow(config) };
      const status = await schedulerStatus(ctx);

      if (argv.json) {
        console.log(jsonWithTestMode(config, status));
      } else {
        printTestModeBanner(config);
        console.log(
          `Scheduler: ${status.enabled ? 'abilitato' : 'disabilitato'} (SCHEDULER_ENABLED) — torneo ${status.seasonStarted ? 'avviato' : 'non avviato'}, iscrizioni ${status.registrationOpen ? 'aperte' : 'chiuse'}, start TC ${status.startRound} (${status.totalRounds} TC)`
        );
        for (const r of status.rounds) {
          console.log(
            `  TC ${r.tc} (TT ${r.tt}): ${r.status}${r.deadline === null ? '' : ` (deadline ${r.deadline})`}`
          );
        }
        for (const a of status.anomalies) {
          console.log(`  Anomalia TC ${a.round}: ${a.type} (chiusura di sicurezza non applicabile, RF-30)`);
        }
        if (status.nextActions.length > 0) {
          console.log(
            `Prossime azioni: ${status.nextActions
              .map((a) => ('round' in a ? `${a.type} (TC ${a.round})` : a.type))
              .join(', ')}`
          );
        } else {
          console.log('Prossime azioni: nessuna');
        }
      }
    } finally {
      db.close();
    }
  }
};
