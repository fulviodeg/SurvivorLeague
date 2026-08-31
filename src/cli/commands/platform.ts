/**
 * Comandi CLI della Piattaforma (ADR-009, LLD §7.10).
 *
 * Ruolo: espone al commissioner la gestione degli account piattaforma su
 * storage separato (`PLATFORM_DB_PATH`):
 *   - `platform:migrate` — crea/migra le tabelle del DB piattaforma
 *     (idempotente, RF-P7);
 *   - `platform:register --email [--name] [--auto-join] [--receive-notifications]`
 *     — UNICO comando di creazione account (RF-P1): crea/riattiva l'account con
 *     registerID stabile e NON crea profili (partecipazione opt-in, ADR-019);
 *     i due flag di partecipazione sono scritti via `setPreferences`;
 *   - `platform:preferences --email [--auto-join on|off]
 *     [--receive-notifications on|off]` — legge/aggiorna i flag di
 *     partecipazione opt-in (ADR-019), gestiti SOLO via CLI;
 *   - `platform:unregister --email [--reason]` — soft-delete DIRETTO
 *     (`unsubscribed`, US8/RF-P2): il profilo torneo resta intatto;
 *   - `platform:list [--json]` — elenco account (registerID, email, status,
 *     flag partecipazione, date) in ordine di registerID (US7).
 *
 * Pattern CLI consolidato (briefing §1-I): il comando costruisce config →
 * connessione PIATTAFORMA → migrazione → registry; la logica vive nel modulo
 * (src/platform/registry.ts). Il clock è iniettato (`makeNow`, RF-P8/RNF1).
 * L'email è normalizzata con la STESSA `normalizeEmail` del Message Router
 * (identità coerente su tutto il sistema, K/RNF2).
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { createConnection } from '../../db/connection.js';
import { migratePlatform } from '../../db/platform-schema.js';
import { DbPlatformRegistry } from '../../platform/registry.js';
import { normalizeEmail } from '../../channel/email-adapter/message-router.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

interface JsonArg {
  json: boolean;
}

/** Opzione JSON condivisa (LLD §7.13). */
function jsonOption(y: Argv<object>) {
  return y.option('json', {
    type: 'boolean' as const,
    default: false,
    describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
  });
}

export const platformMigrateCommand: CommandModule<object, JsonArg> = {
  command: 'platform:migrate',
  describe:
    'Crea/migra le tabelle del DB piattaforma (PLATFORM_DB_PATH, ADR-009/RF-P7); idempotente',
  builder: jsonOption,
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.PLATFORM_DB_PATH);
    try {
      migratePlatform(db);
      if (argv.json) {
        console.log(jsonWithTestMode(config, { migrated: true, dbPath: config.PLATFORM_DB_PATH }));
      } else {
        printTestModeBanner(config);
        console.log(`DB piattaforma migrato: ${config.PLATFORM_DB_PATH}`);
      }
    } finally {
      db.close();
    }
  }
};

interface RegisterArgs extends JsonArg {
  email: string;
  name?: string;
  reason?: string;
  autoJoin: boolean;
  receiveNotifications: boolean;
}

export const platformRegisterCommand: CommandModule<object, RegisterArgs> = {
  command: 'platform:register',
  describe:
    'UNICO comando di creazione account (RF-P1): crea/riattiva l\'account con registerID stabile; NON crea profili (partecipazione opt-in, ADR-019)',
  builder: (yargs: Argv<object>) =>
    jsonOption(yargs)
      .option('email', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Email dell\'account (univoca; normalizzata come il Message Router, K)'
      })
      .option('name', {
        type: 'string' as const,
        describe:
          'Nome del giocatore (ADR-011, RF-P1): salvato alla prima creazione; assente → il sistema usa l\'email al posto del nome'
      })
      .option('reason', {
        type: 'string' as const,
        describe: 'Motivo auditato dell\'operazione (tracciabilità, US10)'
      })
      .option('autoJoin', {
        type: 'boolean' as const,
        default: true,
        describe:
          'Preferenza di partecipazione opt-in (ADR-019, D2): true = auto-join a tournament:start; false = solo dichiarazione esplicita (PARTECIPO/tournament:join). Default true. Applicata SOLO alla prima creazione (le riattivazioni preservano la preferenza)'
      })
      .option('receiveNotifications', {
        type: 'boolean' as const,
        default: true,
        describe:
          'Preferenza di notifica (ADR-019, D9): true = riceve la mail tournament_open; false = nessuna mail di apertura. Default true. Applicata SOLO alla prima creazione (le riattivazioni preservano la preferenza)'
      }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.PLATFORM_DB_PATH);
    try {
      migratePlatform(db);
      const registry = new DbPlatformRegistry(db);
      // Normalizzazione identità (K): stessa normalizzazione del Message Router
      // (trim, minuscolo, rimozione nome visualizzato) — identità coerente RNF2.
      const email = normalizeEmail(argv.email);
      // ADR-019 (D2/D4): i flag di partecipazione sono scritti via setPreferences
      // SOLO alla PRIMA creazione (le riattivazioni NON li toccano: registration-
      // pure). Un account esistente riattivato con platform:register conserva la
      // preferenza; per cambiarla si usa platform:preferences.
      const isNew = registry.find(email) === null;
      registry.register(email, argv.name ?? null, makeNow(config));
      const account = isNew
        ? registry.setPreferences(email, {
            tournamentAutoJoin: argv.autoJoin,
            receiveTournamentStartNotification: argv.receiveNotifications
          })
        : registry.find(email);
      if (argv.json) {
        console.log(jsonWithTestMode(config, { account, reason: argv.reason }));
      } else {
        printTestModeBanner(config);
        console.log(
          `Account ${account?.email} (registerID ${account?.registerId}) — status ${account?.status} — auto-join ${account?.tournamentAutoJoin ? 'on' : 'off'}, notifiche apertura ${account?.receiveTournamentStartNotification ? 'on' : 'off'}`
        );
      }
    } finally {
      db.close();
    }
  }
};

interface UnregisterArgs extends JsonArg {
  email: string;
  reason?: string;
}

export const platformUnregisterCommand: CommandModule<object, UnregisterArgs> = {
  command: 'platform:unregister',
  describe:
    'Soft-delete DIRETTO dell\'account (US8, RF-P2): status → unsubscribed; il profilo torneo resta intatto',
  builder: (yargs: Argv<object>) =>
    jsonOption(yargs)
      .option('email', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Email dell\'account da disiscrivere (normalizzata, K)'
      })
      .option('reason', {
        type: 'string' as const,
        describe: 'Motivo auditato della disiscrizione (obbligatorio per buona pratica, US8)'
      }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.PLATFORM_DB_PATH);
    try {
      migratePlatform(db);
      const registry = new DbPlatformRegistry(db);
      const email = normalizeEmail(argv.email);
      const account = registry.unregister(email, makeNow(config));
      if (argv.json) {
        console.log(jsonWithTestMode(config, { account, reason: argv.reason }));
      } else if (account === null) {
        printTestModeBanner(config);
        console.log(`Nessun account per ${email} (mai iscritto)`);
      } else {
        printTestModeBanner(config);
        console.log(
          `Account ${account.email} disiscritto (registerID ${account.registerId}, status ${account.status})`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const platformListCommand: CommandModule<object, JsonArg> = {
  command: 'platform:list',
  describe:
    'Elenco account piattaforma (registerID, email, status, flag partecipazione, date) in ordine di registerID (US7)',
  builder: jsonOption,
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.PLATFORM_DB_PATH);
    try {
      migratePlatform(db);
      const registry = new DbPlatformRegistry(db);
      const accounts = registry.list();
      if (argv.json) {
        console.log(jsonWithTestMode(config, { accounts }));
      } else {
        printTestModeBanner(config);
        if (accounts.length === 0) {
          console.log('Nessun account piattaforma registrato');
        } else {
          for (const a of accounts) {
            console.log(
              `  [${a.registerId}] ${a.email} — ${a.status} — auto-join ${a.tournamentAutoJoin ? 'on' : 'off'}, notifiche apertura ${a.receiveTournamentStartNotification ? 'on' : 'off'}${
                a.unsubscribedAt !== null ? ` (disiscritto il ${a.unsubscribedAt})` : ''
              }`
            );
          }
        }
      }
    } finally {
      db.close();
    }
  }
};

/** Converte una preferenza `on`/`off` in booleano (assente → undefined = invariata). */
function parseOnOff(value: 'on' | 'off' | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'on';
}

interface PreferencesArgs extends JsonArg {
  email: string;
  autoJoin?: 'on' | 'off';
  receiveNotifications?: 'on' | 'off';
}

export const platformPreferencesCommand: CommandModule<object, PreferencesArgs> = {
  command: 'platform:preferences',
  describe:
    'Legge/aggiorna le preferenze di partecipazione opt-in (ADR-019): senza flag legge, con flag aggiorna (auto-join + notifica apertura)',
  builder: (yargs: Argv<object>) =>
    jsonOption(yargs)
      .option('email', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Email dell\'account (normalizzata, K)'
      })
      .option('autoJoin', {
        type: 'string' as const,
        choices: ['on', 'off'] as const,
        describe: 'Auto-join a tournament:start (ADR-019, D2): on | off'
      })
      .option('receiveNotifications', {
        type: 'string' as const,
        choices: ['on', 'off'] as const,
        describe: 'Ricezione mail tournament_open (ADR-019, D9): on | off'
      }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.PLATFORM_DB_PATH);
    try {
      migratePlatform(db);
      const registry = new DbPlatformRegistry(db);
      const email = normalizeEmail(argv.email);
      const account = registry.setPreferences(email, {
        tournamentAutoJoin: parseOnOff(argv.autoJoin),
        receiveTournamentStartNotification: parseOnOff(argv.receiveNotifications)
      });
      if (argv.json) {
        console.log(jsonWithTestMode(config, { account }));
      } else if (account === null) {
        printTestModeBanner(config);
        console.log(`Nessun account per ${email} (mai iscritto)`);
      } else {
        printTestModeBanner(config);
        console.log(
          `${account.email} (registerID ${account.registerId}) — auto-join ${account.tournamentAutoJoin ? 'on' : 'off'}, notifiche apertura ${account.receiveTournamentStartNotification ? 'on' : 'off'}`
        );
      }
    } finally {
      db.close();
    }
  }
};
