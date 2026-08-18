/**
 * Comandi CLI del Rules Engine (LLD §7.5, piano Task 3.1).
 *
 * Ruolo: espone la verifica delle regole dei gironi e delle squadre:
 *   - `rules:burned-teams --profile-id <id> [--half <1|2>]` — squadre già usate
 *     (bruciate) da un profilo; di default nel girone CORRENTE (derivato dal
 *     round più avanzato di round_state, andata se nessun round aperto);
 *   - `rules:available-teams --profile-id <id> --round <n>` — squadre
 *     disponibili in un round: quelle in giornata non bruciate nel girone
 *     (decisione 12 del piano, CL4 — briefing §2.3);
 *   - `rules:check-half --round <n>` — girone di un round (1 andata / 2 ritorno).
 *
 * Pattern CLI consolidato (vedi src/cli/commands/data.ts): il comando legge
 * `getConfig()`, apre e migra il DB, costruisce il contesto `{ db,
 * dataProvider, config, now }` e lo passa al modulo di gioco — mai
 * `getConfig()` dentro il Rules Engine (briefing §1-I). Output `--json` o
 * testo (LLD §7.13).
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { checkHalf, getAvailableTeams, getBurnedTeamsForHalf } from '../../game/rules.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/** Opzione JSON condivisa dai comandi (LLD §7.13). */
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
interface BurnedArgs extends JsonArg {
  profileId: number;
  half?: number;
}
interface AvailableArgs extends JsonArg {
  profileId: number;
  round: number;
}
interface HalfArgs extends JsonArg {
  round: number;
}

export const rulesBurnedCommand: CommandModule<object, BurnedArgs> = {
  command: 'rules:burned-teams',
  describe: 'Squadre già usate (bruciate) da un profilo, nel girone indicato o in quello corrente',
  builder: (yargs) =>
    jsonOption(yargs)
      .option('profileId', {
        type: 'number' as const,
        demandOption: true,
        describe: 'ID del profilo'
      })
      .option('half', {
        type: 'number' as const,
        describe: 'Girone: 1 = andata, 2 = ritorno (default: girone corrente)'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const dataProvider = new DbSeasonDataProvider(db);
      const totalRounds = await dataProvider.getTotalRounds();
      const row = db
        .prepare('SELECT MAX(round) AS r FROM round_state')
        .get() as { r: number | null };
      // Girone richiesto o corrente (dal round più avanzato; andata se nessuno).
      const half = (argv.half ??
        (row.r === null ? 1 : checkHalf(row.r, totalRounds))) as 1 | 2;
      const teams = getBurnedTeamsForHalf(db, argv.profileId, half, totalRounds);
      if (argv.json) {
        console.log(jsonWithTestMode(config, { profileId: argv.profileId, half, teams }));
      } else {
        printTestModeBanner(config);
        console.log(
          `Profilo ${argv.profileId} — girone ${half === 1 ? 'andata' : 'ritorno'}: ${
            teams.length === 0 ? 'nessuna squadra bruciata' : teams.join(', ')
          }`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const rulesAvailableCommand: CommandModule<object, AvailableArgs> = {
  command: 'rules:available-teams',
  describe: 'Squadre disponibili per un profilo in un round (in giornata, non bruciate nel girone)',
  builder: (yargs) =>
    jsonOption(yargs)
      .option('profileId', {
        type: 'number' as const,
        demandOption: true,
        describe: 'ID del profilo'
      })
      .option('round', {
        type: 'number' as const,
        demandOption: true,
        describe: 'Numero del round (TC)'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const dataProvider = new DbSeasonDataProvider(db);
      const teams = await getAvailableTeams(db, dataProvider, argv.profileId, argv.round);
      if (argv.json) {
        console.log(jsonWithTestMode(config, { profileId: argv.profileId, round: argv.round, teams }));
      } else {
        printTestModeBanner(config);
        console.log(
          `Profilo ${argv.profileId} — round ${argv.round}: ${
            teams.length === 0 ? 'nessuna squadra disponibile' : teams.join(', ')
          }`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const rulesCheckHalfCommand: CommandModule<object, HalfArgs> = {
  command: 'rules:check-half',
  describe: 'Girone di un round: 1 = andata, 2 = ritorno (LLD §3.1)',
  builder: (yargs) =>
    jsonOption(yargs).option('round', {
      type: 'number' as const,
      demandOption: true,
      describe: 'Numero del round (TC)'
    }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const totalRounds = await new DbSeasonDataProvider(db).getTotalRounds();
      const half = checkHalf(argv.round, totalRounds);
      if (argv.json) {
        console.log(
          jsonWithTestMode(config, {
            round: argv.round,
            half,
            totalRounds,
            label: half === 1 ? 'andata' : 'ritorno'
          })
        );
      } else {
        printTestModeBanner(config);
        console.log(`Round ${argv.round} — girone ${half === 1 ? 'andata' : 'ritorno'} (confine derivato da ${totalRounds} round)`);
      }
    } finally {
      db.close();
    }
  }
};
