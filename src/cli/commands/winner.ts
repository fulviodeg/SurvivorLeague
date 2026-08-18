/**
 * Comando CLI del Winner Engine (LLD §7.7, piano Task 3.4).
 *
 * Ruolo: `winner:check` verifica se il torneo è finito e chi ha vinto, in SOLA
 * LETTURA (idempotente); output JSON `{finished, winners, case}` (LLD §7.7) o
 * testo leggibile per il commissioner.
 *
 * La logica è tutta nel Winner Engine (src/game/winner.ts): qui solo wiring —
 * getConfig → createConnection → migrate → contesto → checkWinner. Pattern CLI
 * consolidato (briefing §1-I): il modulo riceve il contesto iniettato.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { checkWinner } from '../../game/winner.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

interface JsonArg {
  json: boolean;
}

export const winnerCheckCommand: CommandModule<object, JsonArg> = {
  command: 'winner:check',
  describe: 'Verifica se il torneo è finito; output JSON {finished, winners, case}',
  builder: (yargs: Argv<object>) =>
    yargs.option('json', {
      type: 'boolean' as const,
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const result = await checkWinner({
        db,
        dataProvider: new DbSeasonDataProvider(db),
        config,
        now: makeNow(config)
      });
      if (argv.json) {
        console.log(jsonWithTestMode(config, result));
      } else if (!result.finished) {
        printTestModeBanner(config);
        console.log('Torneo in corso');
      } else {
        printTestModeBanner(config);
        const names = result.winners.map((w) => `${w.email} (profilo ${w.profileId})`).join(', ');
        console.log(`Torneo finito (caso ${result.case}): vincitore/i — ${names}`);
      }
    } finally {
      db.close();
    }
  }
};
