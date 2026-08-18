/**
 * Entry point della CLI (LLD §5).
 *
 * Ruolo: avvia yargs con i comandi registrati in src/cli/index.ts e traduce
 * gli errori in uscita pulita: un ConfigError (LLD §4.5) stampa il messaggio
 * esplicito con le variabili mancanti/invalid e termina con exit code 1,
 * senza stack trace; qualsiasi altro errore di un comando stampa il messaggio
 * e termina con exit code 1.
 *
 * Interazioni: invocato da `npm run cli` / `npm run db:migrate` (tsx).
 */
import process from 'node:process';

import { createCli } from './cli/index.js';

try {
  await createCli().parseAsync();
} catch (error) {
  // Errori di configurazione (ConfigError) e di comando: messaggio pulito, niente stack trace.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
