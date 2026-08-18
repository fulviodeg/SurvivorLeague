/**
 * Comandi CLI del Torneo — vista aggregata (LLD §7.10, piano Task 4.1).
 *
 * Ruolo: espone al commissioner l'avvio della stagione e le viste aggregate:
 *   - `tournament:start [--start-round <n>]` — avvia la stagione (US6, RF-21):
 *     verifica calendario + aggancio, inizializza round_state pending e
 *     tournament_state; rifiuto atomico senza stato parziale; CL12 warning;
 *   - `tournament:status` — stato aggregato: finestra di iscrizione, round
 *     corrente (TT/TC), profili attivi/eliminati, vincitore, anomalie (RF-30);
 *   - `tournament:history <email>` — storico pick del profilo con coppie TT/TC;
 *   - `tournament:leaderboard` — classifica dei profili in gara (TT/TC corrente);
 *   - `tournament:export` — dump JSON di tutte le tabelle + metadati (decisione
 *     6: determinismo simulazione, trasparenza, audit).
 *
 * I comandi di registrazione (`tournament:register:*`) sono nel Task 4.2.
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
  closeRegistration,
  openRegistration,
  registerPlayer
} from '../../game/registration.js';
import {
  startTournament,
  tournamentExport,
  tournamentHistory,
  tournamentLeaderboard,
  tournamentStatus
} from '../../game/tournament.js';
import { normalizeEmail } from '../../channel/email-adapter/message-router.js';
import { attachEmailToContext } from '../email-wiring.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/**
 * Costruisce il contesto di gioco con clock = adesso (CLI del commissioner)
 * e INIETTA le componenti email reali (EmailAdapter+LLMGenerator+LLMParser,
 * Fasi 5–6): le notifiche di tournament:register:open (invito con --contacts)
 * partono via SMTP/LLM reali (problema M del briefing — niente getConfig()
 * nei moduli).
 */
function makeGameContext(): { ctx: GameContext; db: ReturnType<typeof createConnection> } {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const base: GameContext = { db, dataProvider, config, now: makeNow(config) };
  return { ctx: attachEmailToContext(base, config), db };
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
    const { ctx, db } = makeGameContext();
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
        if (result.lastRoundWarning) {
          console.log('  WARNING (CL12): aggancio all\'ultimo TC — i casi di fine torneo collassano (RF-26)');
        }
      }
    } finally {
      db.close();
    }
  }
};

export const tournamentStatusCommand: CommandModule<object, JsonArg> = {
  command: 'tournament:status',
  describe: 'Stato torneo: finestra di iscrizione, round corrente, profili, vincitore, anomalie',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
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
          `Iscrizioni: ${status.registrationOpen ? 'aperte' : 'chiuse'} — attivi: ${status.activeProfiles}, eliminati: ${status.eliminatedProfiles}`
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
    const { ctx, db } = makeGameContext();
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
    const { ctx, db } = makeGameContext();
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
    const { ctx, db } = makeGameContext();
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
    }
  }
};

interface RegisterOpenArgs extends JsonArg {
  contacts?: string;
}
interface RegisterCloseArgs extends JsonArg {
  reason?: string;
}
interface RegisterArgs extends JsonArg {
  email: string;
  name?: string;
  reason?: string;
}

export const tournamentRegisterOpenCommand: CommandModule<object, RegisterOpenArgs> = {
  command: 'tournament:register:open',
  describe:
    'Apre la finestra di iscrizione (US7); con --contacts invia l\'invito best-effort UNA SOLA volta',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('contacts', {
        type: 'string' as const,
        describe: 'Lista contatti separata da virgola (es. "a@x.it,b@x.it")'
      }),
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const contacts = argv.contacts?.split(',').map((c) => c.trim()).filter((c) => c !== '');
      const result = await openRegistration(ctx, { contacts });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Finestra di iscrizione ${result.opened ? 'aperta' : 'già aperta'} — contatti notificati: ${result.notified}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const tournamentRegisterCloseCommand: CommandModule<object, RegisterCloseArgs> = {
  command: 'tournament:register:close',
  describe:
    'Chiude la finestra di iscrizione (RF-28): senza --reason chiusura automatica (RF-22); con --reason chiusura forzata auditata',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('reason', {
        type: 'string' as const,
        describe: "Motivo auditato della chiusura forzata (obbligatorio per RF-28)"
      }),
  handler: (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = closeRegistration(ctx, { reason: argv.reason });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Finestra di iscrizione ${result.closed ? 'chiusa' : 'già chiusa'}${result.forced ? ' (forzata)' : ''}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const tournamentRegisterCommand: CommandModule<object, RegisterArgs> = {
  command: 'tournament:register',
  describe:
    'Registra manualmente un giocatore (US8, bypass email); --reason obbligatorio a finestra chiusa (override US10)',
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
        describe: 'Email del giocatore (univoca)'
      })
      .option('name', { type: 'string' as const, describe: 'Nome del giocatore' })
      .option('reason', {
        type: 'string' as const,
        describe:
          "Motivo auditato dell'override US10 (obbligatorio a finestra chiusa)"
      }),
  handler: (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      // Normalizzazione identità (K): stessa normalizzazione del Message Router
      // (trim, minuscolo, rimozione nome visualizzato) — identità coerente RNF2.
      const email = normalizeEmail(argv.email);
      const result = registerPlayer(ctx, {
        email,
        name: argv.name,
        reason: argv.reason
      });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else if (!result.ok) {
        printTestModeBanner(ctx.config);
        console.log(`Registrazione rifiutata: ${result.reason} (${result.eligibility.reason ?? '—'})`);
      } else {
        printTestModeBanner(ctx.config);
        console.log(`Registrato ${email} (profilo ${result.profileId})`);
      }
    } finally {
      db.close();
    }
  }
};
