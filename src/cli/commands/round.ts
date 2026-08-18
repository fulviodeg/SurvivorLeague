/**
 * Comandi CLI del Round Manager (LLD §7.3, piano Task 3.5).
 *
 * Ruolo: espone il ciclo di vita dei round al commissioner:
 *   - `round:open --round <n>` — apre il round (deadline fissa RF-14, email pick
 *     ai profili attivi via EmailAdapter+LLMGenerator REALI iniettati nel
 *     contesto — Fasi 5–6, problema M del briefing; src/cli/email-wiring.ts);
 *   - `round:close --round <n> [--force --reason <motivo>]` — consolida: elimina
 *     i mancanti + notifica; `--force` richiede `--reason` (RF-29);
 *   - `round:score --round <n>` — contabilizzazione incrementale (pending →
 *     correct/wrong, postponed oltre tcClose → frozen, frozen con punteggio →
 *     valutato; round → scored quando nessun pending, RF-16);
 *   - `round:status --round <n>` — stato del round con coppia TT/TC (RF-25);
 *   - `round:deadline --round <n>` — deadline registrata + kickoff effettivo
 *     (istante di accettazione, RF-31).
 *
 * Pattern CLI consolidato (briefing §1-I): il comando costruisce il contesto
 * `{ db, dataProvider, config, now }` e lo passa al Round Manager — la logica
 * resta tutta nel modulo di gioco.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import type { GameContext } from '../../game/context.js';
import {
  closeRound,
  openRound,
  roundDeadline,
  roundStatus,
  scoreRound
} from '../../game/round-manager.js';
import { attachEmailToContext } from '../email-wiring.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/**
 * Costruisce il contesto di gioco con clock = adesso (CLI del commissioner)
 * e INIETTA le componenti email reali (EmailAdapter+LLMGenerator+LLMParser,
 * Fasi 5–6): le notifiche di round:open/close/score partono via SMTP/LLM
 * reali (problema M del briefing — niente getConfig() nei moduli).
 */
function makeGameContext(): { ctx: GameContext; db: ReturnType<typeof createConnection> } {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const base: GameContext = { db, dataProvider, config, now: makeNow(config) };
  return { ctx: attachEmailToContext(base, config), db };
}

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
interface RoundArgs extends JsonArg {
  round: number;
}
interface CloseArgs extends RoundArgs {
  force?: boolean;
  reason?: string;
}

/**
 * Builder condiviso dei comandi round:* (json + round), inline a catena unica
 * per preservare l'accumulo dei tipi yargs (come pickBuilder in pick.ts).
 */
const roundBuilder = (yargs: Argv<object>) =>
  jsonOption(yargs).option('round', {
    type: 'number' as const,
    demandOption: true,
    describe: 'Numero del round (TC)'
  });

export const roundOpenCommand: CommandModule<object, RoundArgs> = {
  command: 'round:open',
  describe: 'Apre un round: crea round_state con deadline fissa (RF-14) e invia le email pick',
  builder: roundBuilder,
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await openRound(ctx, argv.round);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Round ${result.tc} (TT ${result.tt}) aperto — deadline ${result.deadline}, profili notificati: ${result.notified}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const roundCloseCommand: CommandModule<object, CloseArgs> = {
  command: 'round:close',
  describe:
    'Chiude un round consolidando: elimina i profili senza pick (missing_pick) e notifica; --force richiede --reason (RF-29)',
  builder: (yargs) =>
    roundBuilder(yargs)
      .option('force', {
        type: 'boolean' as const,
        default: false,
        describe: 'Chiusura forzata (stessa semantica di consolidamento, RF-29)'
      })
      .option('reason', {
        type: 'string' as const,
        describe: "Motivo auditato della chiusura forzata (obbligatorio con --force)"
      }),
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await closeRound(ctx, argv.round, { force: argv.force, reason: argv.reason });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Round ${result.tc} (TT ${result.tt}) chiuso${result.forced ? ' (forzata)' : ''} — eliminati per pick mancante: ${
            result.eliminatedMissing.length === 0 ? 'nessuno' : result.eliminatedMissing.join(', ')
          }`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const roundScoreCommand: CommandModule<object, RoundArgs> = {
  command: 'round:score',
  describe:
    'Contabilizza un round (incrementale): pending → correct/wrong, postponed oltre tcClose → frozen, frozen con punteggio → valutato',
  builder: roundBuilder,
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await scoreRound(ctx, argv.round);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Round ${result.tc} (TT ${result.tt}) → ${result.status} — valutati: ${result.evaluated.length}, frozen: ${result.newlyFrozen.length}, eliminati: ${result.newlyEliminated.length}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const roundStatusCommand: CommandModule<object, RoundArgs> = {
  command: 'round:status',
  describe: 'Stato di un round con coppia TT/TC e conteggi pick (sola lettura)',
  builder: roundBuilder,
  handler: (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = roundStatus(ctx, argv.round);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        const picks = Object.entries(result.picks)
          .map(([s, n]) => `${s}: ${n}`)
          .join(', ');
        console.log(
          `Round ${result.tc} (TT ${result.tt}) — ${result.status}${picks === '' ? '' : ` — pick: ${picks}`}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const roundDeadlineCommand: CommandModule<object, RoundArgs> = {
  command: 'round:deadline',
  describe: 'Deadline registrata e kickoff effettivo di un round (istante di accettazione, RF-31)',
  builder: roundBuilder,
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await roundDeadline(ctx, argv.round);
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Round ${result.tc} (TT ${result.tt}) — deadline: ${result.deadline ?? 'non registrata'}, kickoff: ${result.kickoff}, accettazione: ${result.acceptance}`
        );
      }
    } finally {
      db.close();
    }
  }
};
