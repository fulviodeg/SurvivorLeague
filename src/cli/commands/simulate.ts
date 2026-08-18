/**
 * Comandi CLI di simulazione (LLD §7.11, piano Task 7.1; decisioni R1–R4 del
 * briefing Fase 7).
 *
 * Ruolo: espone al commissioner (e all'UAT CS3/RNF1) la simulazione del
 * torneo su dati storici:
 *   - `simulate:full [--start-round <n>] [--seed <n>]` — intera stagione (o
 *     dalla finestra `[start_round..N]`, ADR-008/RF-20): registra SIM_PLAYERS
 *     profili sim, per ogni round open → pick seeded → close → score, report;
 *   - `simulate:round --round <n> [--seed <n>]` — round singolo (open →
 *     close → score) sul TC n, senza avviare il torneo.
 *
 * Pattern CLI consolidato (briefing §1-I): il contesto è costruito QUI, la
 * logica è nel modulo di gioco (`src/game/simulation.ts`). Differenza
 * voluta (R1): il contesto di simulazione NON inietta channel/generator —
 * nessuna email reale, le notifiche dei moduli sono no-op.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import type { GameContext } from '../../game/context.js';
import { simulateRound, simulateSeason } from '../../game/simulation.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/** Opzione JSON condivisa (LLD §7.13). */
function jsonOption(y: Argv<object>) {
  return y.option('json', {
    type: 'boolean' as const,
    default: false,
    describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
  });
}

/**
 * Costruisce il contesto di simulazione: DB reale migrato, provider reale,
 * clock reale di partenza (la simulazione lo deriva poi dai dati, R2) e
 * NESSUNA componente email (R1). Pattern "la CLI inietta" (niente
 * getConfig() nei moduli).
 */
function makeSimulationContext(): { ctx: GameContext; db: ReturnType<typeof createConnection> } {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const ctx: GameContext = { db, dataProvider, config, now: new Date() };
  return { ctx, db };
}

interface JsonArg {
  json: boolean;
}
interface FullArgs extends JsonArg {
  startRound: number;
  seed: number;
}
interface RoundArgs extends JsonArg {
  round: number;
  seed: number;
}

/** Stampa la parte testuale comune del report (righe round + vincitore). */
function printReport(report: Awaited<ReturnType<typeof simulateSeason>>): void {
  for (const r of report.rounds) {
    console.log(
      `  TC ${r.tc} (TT ${r.tt}): ${r.picks} pick, ${r.evaluated} valutati, ${r.frozen} frozen, ${r.eliminated} eliminati — ${r.status}`
    );
  }
  if (report.winner.finished) {
    console.log(`Vincitore/i (caso ${report.winner.case}): ${report.winner.winners.map((w) => w.email).join(', ')}`);
  } else {
    console.log('Torneo in corso (nessun vincitore a fine stagione simulata)');
  }
}

export const simulateFullCommand: CommandModule<object, FullArgs> = {
  command: 'simulate:full',
  describe:
    'Simula la stagione completa (o la finestra [start_round..N] con aggancio, ADR-008): profili sim + pick seeded + open/close/score per ogni round (CS3)',
  builder: (yargs: Argv<object>) =>
    jsonOption(yargs)
      .option('startRound', {
        type: 'number' as const,
        default: 1,
        describe: 'TC di aggancio della finestra simulata (TT1 = start_round; default 1)'
      })
      .option('seed', {
        type: 'number' as const,
        default: 42,
        describe: 'Seed del RNG deterministico (mulberry32; default 42, R4)'
      }),
  handler: async (argv) => {
    const { ctx, db } = makeSimulationContext();
    try {
      const report = await simulateSeason(ctx, { startRound: argv.startRound, seed: argv.seed });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, report));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Simulazione completa — seed ${report.seed}, TT1 = TC ${report.startRound} (${report.totalRounds} TC), profili sim: ${report.playersRegistered}`
        );
        printReport(report);
        if (report.lastRoundWarning) {
          console.log("  WARNING (CL12): aggancio all'ultimo TC — i casi di fine torneo collassano (RF-26)");
        }
      }
    } finally {
      db.close();
    }
  }
};

export const simulateRoundCommand: CommandModule<object, RoundArgs> = {
  command: 'simulate:round',
  describe: 'Simula un round singolo (open → pick seeded → close → score) sul TC n',
  builder: (yargs: Argv<object>) =>
    jsonOption(yargs)
      .option('round', {
        type: 'number' as const,
        demandOption: true,
        describe: 'Numero del round (TC) da simulare'
      })
      .option('seed', {
        type: 'number' as const,
        default: 42,
        describe: 'Seed del RNG deterministico (mulberry32; default 42, R4)'
      }),
  handler: async (argv) => {
    const { ctx, db } = makeSimulationContext();
    try {
      const report = await simulateRound(ctx, argv.round, { seed: argv.seed });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, report));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          `Simulazione round — seed ${report.seed}, TC ${argv.round}, profili sim: ${report.playersRegistered}`
        );
        printReport(report);
      }
    } finally {
      db.close();
    }
  }
};
