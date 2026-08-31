/**
 * Comandi CLI del Torneo — vista aggregata (LLD §7.10, piano Task 4.1).
 *
 * Ruolo: espone al commissioner l'avvio della stagione e le viste aggregate:
 *   - `tournament:start [--start-round <n>]` — avvia la stagione (US6, RF-21):
 *     verifica calendario + aggancio, inizializza round_state pending e
 *     tournament_state; rifiuto atomico senza stato parziale; CL12 warning;
 *     auto-join bulk degli account con flag ON (ADR-019);
 *   - `tournament:join --email <email> [--reason]` — dichiarazione esplicita
 *     di partecipazione (ADR-019): crea il profilo nella finestra TT 1;
 *     `--reason` = override late (fuori finestra, D10);
 *   - `tournament:status` — stato aggregato: round corrente (TT/TC), profili
 *     attivi/eliminati, iscritti piattaforma, vincitore, anomalie (RF-30);
 *   - `tournament:history <email>` — storico pick del profilo con coppie TT/TC;
 *   - `tournament:leaderboard` — classifica dei profili in gara (TT/TC corrente);
 *   - `tournament:export` — dump JSON di tutte le tabelle + metadati (decisione
 *     6: determinismo simulazione, trasparenza, audit).
 *
 * RIMOSSI (ADR-009): `tournament:register:open`, `tournament:register:close`,
 * `tournament:register` — non esiste più una finestra di iscrizione e
 * `platform:register` è l'unico comando di creazione account.
 * Pattern CLI consolidato (briefing §1-I): contesto costruito qui, logica nel
 * modulo di gioco.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import type { GameContext } from '../../game/context.js';
import {
  startTournament,
  tournamentExport,
  tournamentHistory,
  tournamentLeaderboard,
  tournamentStatus
} from '../../game/tournament.js';
import { declareParticipation } from '../../game/registration.js';
import { normalizeEmail } from '../../channel/email-adapter/message-router.js';
import { attachEmailToContext, attachPlatformToContext } from '../email-wiring.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/**
 * Costruisce il contesto di gioco con clock = adesso (CLI del commissioner)
 * e INIETTA le componenti email reali (EmailAdapter+LLMGenerator+classifier)
 * e il PlatformRegistry (ADR-009): il broadcast `tournament_open` di
 * tournament:start parte via SMTP/LLM reali (problema M del briefing — niente
 * getConfig() nei moduli).
 */
function makeGameContext(): {
  ctx: GameContext;
  db: ReturnType<typeof createConnection>;
  platformDb: ReturnType<typeof createConnection>;
} {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const base: GameContext = { db, dataProvider, config, now: makeNow(config) };
  // Registry piattaforma iniettato (ADR-009, RF-P6): il broadcast
  // tournament_open e le notifiche di round filtrano su account `active`.
  const { ctx, platformDb } = attachPlatformToContext(attachEmailToContext(base, config), config);
  return { ctx, db, platformDb };
}

interface JsonArg {
  json: boolean;
}
interface StartArgs extends JsonArg {
  startRound?: number;
}
interface HistoryArgs extends JsonArg {
  email: string;
}

export const tournamentStartCommand: CommandModule<object, StartArgs> = {
  command: 'tournament:start',
  describe:
    'Avvia la stagione (US6/RF-21): verifica calendario e aggancio, inizializza lo stato; --start-round = TC di aggancio (RF-20)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('startRound', {
        type: 'number' as const,
        default: 1,
        describe: 'TC di aggancio del torneo (TT1 = start_round, ADR-008; default 1)'
      }),
  handler: async (argv) => {
    const { ctx, db, platformDb } = makeGameContext();
    try {
      const result = await startTournament(ctx, { startRound: argv.startRound });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Stagione avviata: TT1 = TC ${result.startRound}, ${result.initializedRounds} round inizializzati (confine girone ${result.halfBoundary})`
        );
        console.log(`  Deadline TT1: ${result.tt1Deadline} (kickoff ${result.tt1Kickoff})`);
        console.log(
          `  Auto-join a start: ${result.autoJoined} profili creati (account con flag ON), notifiche apertura: ${result.notified}`
        );
        if (result.lastRoundWarning) {
          console.log('  WARNING (CL12): aggancio all\'ultimo TC — i casi di fine torneo collassano (RF-26)');
        }
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};

interface JoinArgs extends JsonArg {
  email: string;
  reason?: string;
}

/**
 * Contesto di `tournament:join` (ADR-019): DB torneo + DB PIATTAFORMA, SENZA
 * wiring email (nessun channel/generator — il join via CLI non invia email,
 * D12). Il join è un'azione amministrativa: il giocatore apprende via
 * `tournament_open`/`pick_instructions`.
 */
function makeJoinContext(): {
  ctx: GameContext;
  db: ReturnType<typeof createConnection>;
  platformDb: ReturnType<typeof createConnection>;
} {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const base: GameContext = { db, dataProvider, config, now: makeNow(config) };
  const { ctx, platformDb } = attachPlatformToContext(base, config);
  return { ctx, db, platformDb };
}

export const tournamentJoinCommand: CommandModule<object, JoinArgs> = {
  command: 'tournament:join',
  describe:
    'Dichiarazione esplicita di partecipazione (ADR-019): crea il profilo nella finestra TT 1; --reason = override late (fuori finestra)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('email', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Email dell\'account (normalizzata, K)'
      })
      .option('reason', {
        type: 'string' as const,
        describe: 'Motivo auditato dell\'override late (obbligatorio fuori finestra, D10)'
      }),
  handler: (argv) => {
    const { ctx, db, platformDb } = makeJoinContext();
    try {
      const email = normalizeEmail(argv.email);
      const result = declareParticipation(ctx, { channel: 'email', identifier: email }, {
        reason: argv.reason
      });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, { email, result, reason: argv.reason }));
      } else {
        printTestModeBanner(ctx.config);
        if (result.ok) {
          console.log(
            `Partecipazione confermata: profilo ${result.profileId} per ${email}`
          );
        } else if (result.reason === 'already_joined') {
          console.log(`${email} è già in gara (partecipazione esistente)`);
        } else if (result.reason === 'no_tournament') {
          console.log('Nessun torneo aperto: avvia la stagione con tournament:start');
        } else if (result.reason === 'not_active') {
          console.log(`${email} non è un account attivo della piattaforma (usa platform:register)`);
        } else if (result.reason === 'late_requires_reason') {
          console.log(
            'Il torneo è già iniziato: la partecipazione è chiusa — per un ingresso tardivo usa --reason (override, D10)'
          );
        } else {
          console.log('Il torneo è già iniziato: la partecipazione è chiusa');
        }
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};

export const tournamentStatusCommand: CommandModule<object, JsonArg> = {
  command: 'tournament:status',
  describe: 'Stato torneo: round corrente, profili, iscritti piattaforma, vincitore, anomalie',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const { ctx, db, platformDb } = makeGameContext();
    try {
      const status = await tournamentStatus(ctx);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, status));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Stagione: ${status.seasonStarted ? 'avviata' : 'non avviata'} (start TC ${status.startRound}, ${status.totalRounds} TC, confine ${status.halfBoundary})`
        );
        console.log(
          `Iscritti piattaforma (attivi): ${status.platformSubscribers} — partecipanti in gara: ${status.activeProfiles}, eliminati: ${status.eliminatedProfiles}`
        );
        console.log(
          `Round corrente: ${status.currentRound === null ? '—' : `TC ${status.currentRound.tc} (TT ${status.currentRound.tt}) [${status.currentRound.status}]`}`
        );
        if (status.winner.finished) {
          console.log(
            `Vincitore/i (caso ${status.winner.case}): ${status.winner.winners.map((w) => w.email).join(', ')}`
          );
        } else {
          console.log('Torneo in corso');
        }
        for (const a of status.anomalies) {
          console.log(`  Anomalia TC ${a.round}: ${a.type} (chiusura di sicurezza non applicabile, RF-30)`);
        }
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};

export const tournamentHistoryCommand: CommandModule<object, HistoryArgs> = {
  command: 'tournament:history',
  describe: 'Storico pick di un profilo (output con coppia TT/TC)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('email', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Email del giocatore'
      }),
  handler: (argv) => {
    const { ctx, db, platformDb } = makeGameContext();
    try {
      const history = tournamentHistory(ctx, argv.email);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, history));
      } else if (history === null) {
        printTestModeBanner(ctx.config);
        console.log(`Nessun profilo trovato per ${argv.email}`);
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `${history.email} (${history.name}) — ${history.eliminated ? `eliminato (${history.eliminatedReason}) il ${history.eliminatedAt}` : 'in gara'}`
        );
        for (const p of history.picks) {
          console.log(`  TT${p.tt}TC${p.tc}: ${p.team} (${p.outcome}) [${p.status}]`);
        }
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};

export const tournamentLeaderboardCommand: CommandModule<object, JsonArg> = {
  command: 'tournament:leaderboard',
  describe: 'Classifica profili ancora in gara (output con coppia TT/TC)',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: (argv) => {
    const { ctx, db, platformDb } = makeGameContext();
    try {
      const lb = tournamentLeaderboard(ctx);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, lb));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Classifica${lb.currentTurn === null ? '' : ` (TC ${lb.currentTurn.tc} / TT ${lb.currentTurn.tt})`}`
        );
        for (const e of lb.entries) {
          console.log(
            `  ${e.active ? 'IN GARA' : 'eliminato'} ${e.email} — corretti: ${e.picksCorrect}, sbagliati: ${e.picksWrong}${e.eliminatedReason !== null ? ` (${e.eliminatedReason})` : ''}`
          );
        }
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};

export const tournamentExportCommand: CommandModule<object, JsonArg> = {
  command: 'tournament:export',
  describe:
    'Dump JSON di tutte le tabelle + metadati (timestamp, parametri derivati, mappatura TT/TC)',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const { ctx, db, platformDb } = makeGameContext();
    try {
      const dump = await tournamentExport(ctx);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, dump));
      } else {
        printTestModeBanner(ctx.config);
        console.log(JSON.stringify(dump, null, 2));
      }
    } finally {
      db.close();
      platformDb.close();
    }
  }
};
