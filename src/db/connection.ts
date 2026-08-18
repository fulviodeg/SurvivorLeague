/**
 * Connessione al database SQLite (better-sqlite3, LLD §2).
 *
 * Ruolo: unico punto di apertura del database. Riceve il percorso da
 * DB_PATH (src/config.ts, LLD §4.2) e crea la directory contenitrice se
 * assente (es. data/ al primo avvio). Accetta anche ':memory:' per i test
 * di integrazione su SQLite in-memory (LLD §8).
 *
 * Interazioni: usata dai comandi CLI che toccano il DB (es. db:migrate in
 * src/cli/commands/db.ts) e dai test; lo schema è applicato da
 * src/db/schema.ts (migrate).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

/**
 * Apre (creandolo se necessario) il database SQLite a dbPath.
 * Per path su file crea ricorsivamente la directory se manca; ':memory:'
 * restituisce un DB volatile per i test. La chiusura spetta al chiamante.
 */
export function createConnection(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  return new Database(dbPath);
}
