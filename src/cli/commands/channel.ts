/**
 * Comandi CLI del Channel Adapter (LLD §7.9, piano Task 6.1/6.2).
 *
 * Ruolo:
 *   - `channel:email:fetch` — legge le email NON LETTE dalla casella IMAP
 *     (`receivedAt` = internaldate, ADR-001) e le stampa in JSON; NON marca
 *     nulla (D7), idempotente;
 *   - `channel:email:process` — flusso end-to-end (wiring, Task 6.2): fetch →
 *     Message Router → iscrizione/pick con Parser LLM + moduli di gioco →
 *     risposte → flag \Seen a successo (D7); elenca poi per messaggio
 *     l'azione compiuta (diagnostica);
 *   - `channel:email:send --to --subject --body` — invio SMTP di prova
 *     (helper test/debug, LLD §7.9): soggetto dal chiamante (D1).
 *
 * Pattern CLI consolidato (briefing §1-I): il comando costruisce config → DB
 * → componenti email reali (src/cli/email-wiring.ts) e inietta; la logica
 * vive nei moduli (email-adapter, email-processor, Game Engine).
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { migratePlatform } from '../../db/platform-schema.js';
import { DbPlatformRegistry } from '../../platform/registry.js';
import { createLogger } from '../../logger.js';
import { processEmailBatch } from '../../channel/email-processor.js';
import { buildEmailComponents } from '../email-wiring.js';
import { loadTeamAliasesFor } from '../../llm/parser.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';
import { acquireLock, lockPathFor, readHolderPid, releaseLock, touchLock, TOUCH_INTERVAL_MS } from '../email-process-lock.js';

interface JsonArg {
  json: boolean;
}

export const channelEmailFetchCommand: CommandModule<object, JsonArg> = {
  command: 'channel:email:fetch',
  describe:
    'Recupera le email non lette dalla casella IMAP (internaldate = receivedAt, ADR-001; NON marca nulla, D7)',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const config = getConfig();
    const logger = createLogger(config.LOG_LEVEL, undefined, config.testMode, config.TIMEZONE);
    const { channel } = buildEmailComponents(config);
    const messages = await channel.fetchMessages();
    if (argv.json) {
      console.log(jsonWithTestMode(config, messages));
    } else if (messages.length === 0) {
      printTestModeBanner(config);
      console.log('Nessuna email non letta in casella');
    } else {
      printTestModeBanner(config);
      for (const m of messages) {
        console.log(`Da: ${m.from} — ricevuta: ${m.receivedAt.toISOString()}`);
        console.log(`  ${m.body.split('\n')[0] ?? ''}`);
      }
    }
    logger.info({ count: messages.length }, 'channel:email:fetch completato (nessun flag impostato)');
  }
};

interface SendArgs extends JsonArg {
  to: string;
  subject?: string;
  body: string;
}

export const channelEmailSendCommand: CommandModule<object, SendArgs> = {
  command: 'channel:email:send',
  describe: 'Invia un\'email via SMTP (helper test/debug, LLD §7.9); soggetto dal chiamante (D1)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('to', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Destinatario (indirizzo email)'
      })
      .option('subject', { type: 'string' as const, describe: 'Oggetto dell\'email' })
      .option('body', { type: 'string' as const, demandOption: true, describe: 'Corpo dell\'email' }),
  handler: async (argv) => {
    const config = getConfig();
    const { channel } = buildEmailComponents(config);
    await channel.sendMessage(argv.to, argv.body, argv.subject);
    if (argv.json) {
      console.log(jsonWithTestMode(config, { sent: true, to: argv.to }));
    } else {
      printTestModeBanner(config);
      console.log(`Email inviata a ${argv.to}`);
    }
  }
};

export const channelEmailProcessCommand: CommandModule<object, JsonArg> = {
  command: 'channel:email:process',
  describe:
    'Flusso end-to-end: fetch → router → iscrizione/pick (Parser LLM + moduli di gioco) → risposte → flag \\Seen a successo (D7)',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const config = getConfig();
    const logger = createLogger(config.LOG_LEVEL, undefined, config.testMode, config.TIMEZONE);

    // Lock anti-concorrenza (src/cli/email-process-lock.ts): il cron può
    // lanciare un secondo run mentre il primo è ancora in elaborazione (batch
    // > 1 min con retry LLM); senza lock i due processi leggerebbero le stesse
    // email non lette e produrrebbero risposte duplicate/contraddittorie.
    const lockPath = lockPathFor(config.DB_PATH);
    const lock = acquireLock(lockPath);
    if (lock === null) {
      const holderPid = readHolderPid(lockPath);
      logger.info(
        { lockPath, holderPid },
        'email:process skipped: another instance is running (lock file held by a live process)'
      );
      if (argv.json) {
        console.log(jsonWithTestMode(config, { skipped: true, lockPath, holderPid }));
      } else {
        printTestModeBanner(config);
        console.log(
          `Processo email già in esecuzione (lock ${lockPath}, pid ${holderPid ?? '?'}): esecuzione saltata`
        );
      }
      return;
    }

    // Touch periodico del lock (mtime) durante l'elaborazione: un run lungo
    // non appare mai stantio. `unref()`: il timer non tiene vivo il processo
    // oltre il termine del handler.
    const touchTimer = setInterval(() => touchLock(lock), TOUCH_INTERVAL_MS);
    touchTimer.unref();

    const db = createConnection(config.DB_PATH);
    const platformDb = createConnection(config.PLATFORM_DB_PATH);
    try {
      // Migra ENTRAMBI i DB (ADR-009): torneo + piattaforma.
      migrate(db);
      migratePlatform(platformDb);
      const provider = new DbSeasonDataProvider(db);
      const platform = new DbPlatformRegistry(platformDb);
      const { channel, generator, classifier } = buildEmailComponents(config);

      // Dati letti UNA volta per batch (M): lista canonica + alias (D7: risorsa
      // sintetica in test mode). I mittenti NON sono più uno snapshot: lo stato
      // dell'account è riletto dal registry a ogni messaggio (HIGH-2, ADR-009).
      const teams = await provider.getTeams();
      const aliases = await loadTeamAliasesFor(config.testMode);

      const messages = await channel.fetchMessages();
      const result = await processEmailBatch(
        {
          db,
          dataProvider: provider,
          config,
          now: makeNow(config),
          channel,
          generator,
          classifier,
          platform
        },
        messages,
        { teams, aliases, markSeen: (m) => channel.markSeen(m), logger, testMode: config.testMode }
      );

      if (argv.json) {
        console.log(jsonWithTestMode(config, result));
      } else {
        printTestModeBanner(config);
        for (const m of result.messages) {
          console.log(
            `  ${m.seen ? '[letto]' : '[non letto]'} ${m.from}: ${m.action}${m.detail !== undefined ? ` (${m.detail})` : ''}`
          );
        }
        console.log(
          `Processati ${result.processed} messaggi, ${result.seen} marcati letti${result.stopped ? ' — batch FERMATO su errore LLM (retry al prossimo tick)' : ''}`
        );
      }
    } finally {
      clearInterval(touchTimer);
      releaseLock(lock);
      db.close();
      platformDb.close();
    }
  }
};
