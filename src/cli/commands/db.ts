/**
 * Comando CLI db:migrate (LLD §7.1, Setup).
 *
 * Ruolo: crea il database SQLite a DB_PATH e applica lo schema del modello
 * dati (LLD §3) tramite migrate(); è idempotente e rieseguibile senza
 * errori. Valida l'intera configurazione all'avvio (getConfig, LLD §4.5):
 * se manca una variabile richiesta il comando fallisce con messaggio
 * esplicito prima di toccare il DB.
 *
 * Interazioni: usa src/config.ts (DB_PATH), src/db/connection.ts
 * (apertura DB e creazione directory) e src/db/schema.ts (DDL). Registrato
 * in src/cli/index.ts; invocabile con `npm run db:migrate`.
 */
import type { CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

interface MigrateArgs {
  json: boolean;
}

export const dbMigrateCommand: CommandModule<object, MigrateArgs> = {
  command: 'db:migrate',
  describe: 'Crea il database e le tabelle del modello dati (LLD §3); idempotente',
  builder: (yargs) =>
    yargs.option('json', {
      type: 'boolean',
      default: false,
      describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
    }),
  handler: (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
    } finally {
      db.close();
    }
    if (argv.json) {
      console.log(jsonWithTestMode(config, { dbPath: config.DB_PATH, migrated: true }));
    } else {
      printTestModeBanner(config);
      console.log(`Database migrato: ${config.DB_PATH}`);
    }
  }
};
