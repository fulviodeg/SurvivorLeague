/**
 * Comandi CLI dell'Elimination Engine (LLD §7.6, piano Task 3.3).
 *
 * Ruolo: espone lo stato di eliminazione in SOLA LETTURA (idempotenti):
 *   - `elimination:check --profileId <id>` — `{eliminated, reason}` del profilo;
 *   - `elimination:list` — lista profili eliminati con email, motivo e istante
 *     (espone `eliminated_reason`/`eliminated_at`, decisione 10 del piano).
 *
 * La scrittura (`eliminate`) è invocata solo dal Round Manager (round:close /
 * round:score, Task 3.5): qui nessuna mutazione. Pattern CLI consolidato
 * (src/cli/commands/db.ts): getConfig → createConnection → migrate → handler.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { checkElimination, listEliminated } from '../../game/elimination.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

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
interface CheckArgs extends JsonArg {
  profileId: number;
}

export const eliminationCheckCommand: CommandModule<object, CheckArgs> = {
  command: 'elimination:check',
  describe: 'Verifica se un profilo è eliminato; output JSON {eliminated, reason}',
  builder: (yargs) =>
    jsonOption(yargs).option('profileId', {
      type: 'number' as const,
      demandOption: true,
      describe: 'ID del profilo'
    }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const status = checkElimination(db, argv.profileId);
      if (argv.json) {
        console.log(jsonWithTestMode(config, { profileId: argv.profileId, ...status }));
      } else {
        printTestModeBanner(config);
        console.log(
          status.eliminated
            ? `Profilo ${argv.profileId} eliminato (${status.reason}) il ${status.eliminatedAt}`
            : `Profilo ${argv.profileId} in gara`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const eliminationListCommand: CommandModule<object, JsonArg> = {
  command: 'elimination:list',
  describe: 'Lista profili eliminati con email, motivo e istante (eliminated_reason/eliminated_at)',
  builder: jsonOption,
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const rows = listEliminated(db);
      if (argv.json) {
        console.log(jsonWithTestMode(config, rows));
      } else if (rows.length === 0) {
        printTestModeBanner(config);
        console.log('Nessun profilo eliminato');
      } else {
        printTestModeBanner(config);
        for (const r of rows) {
          console.log(`Profilo ${r.profileId} (${r.email}) — ${r.reason} il ${r.eliminatedAt}`);
        }
      }
    } finally {
      db.close();
    }
  }
};
