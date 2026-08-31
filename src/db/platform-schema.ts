/**
 * Schema del DB PIATTAFORMA (ADR-009, RF-P7) e migrazione.
 *
 * Ruolo: definisce il modello dati degli account piattaforma — una singola
 * tabella `platform_account` con `register_id` interno STABILE (riusato alla
 * re-iscrizione, RF-P3), email univoca, status soft-delete a due passi
 * (`active | pending_unsubscribe | unsubscribed`, RF-P2) e date scritte
 * SEMPRE dal clock iniettato (RF-P8, RNF1: mai il default datetime('now')).
 *
 * Storage separato: il DB piattaforma vive in `PLATFORM_DB_PATH` (default
 * `./data/platform.db`), MAI nello stesso file del DB torneo (`DB_PATH`):
 * due connessioni distinte, nessuna transazione cross-DB — la piattaforma è
 * SOLO LETTA dai flussi di torneo (gate notifiche/pick, ADR-009).
 *
 * Interazioni: `migratePlatform(db)` è invocata dal comando `platform:migrate`
 * (src/cli/commands/platform.ts), dal wiring di `channel:email:process` (che
 * migra ENTRAMBI i DB) e dai comandi `simulate:*`; l'impl del registry è
 * `DbPlatformRegistry` (src/platform/registry.ts). La connessione è aperta da
 * src/db/connection.ts con lo stesso pattern del DB torneo.
 *
 * Idempotenza: CREATE TABLE IF NOT EXISTS + eventuali migrazioni additive
 * guardate da PRAGMA table_info (stesso pattern di src/db/schema.ts), così
 * rieseguire la migrazione è sempre un no-op e non perde dati.
 */
import type Database from 'better-sqlite3';

/** DDL del DB piattaforma (ADR-009, LLD §3 — versione 0.5.0; ADR-011 name). */
export const PLATFORM_SCHEMA_DDL = `
-- Account piattaforma (ADR-009, RF-P1/P2/P8): sorgente degli iscritti per le notifiche.
CREATE TABLE IF NOT EXISTS platform_account (
  register_id     INTEGER PRIMARY KEY AUTOINCREMENT, -- registerID INTERNO STABILE, riusato alla re-iscrizione (RF-P3)
  email           TEXT NOT NULL UNIQUE,              -- univocità: il sistema ricorda l'email (RF-P3)
  name            TEXT,                              -- nome del giocatore (ADR-011, RF-P1): dedotto dalla mail di registrazione; NULL se ignoto
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'pending_unsubscribe', 'unsubscribed')),
  created_at      TEXT NOT NULL,      -- SEMPRE dal clock iniettato (RF-P8, RNF1): mai default datetime('now')
  unsubscribed_at TEXT,               -- istante della soft-delete (clock iniettato), NULL finché non disiscritto
  -- Partecipazione opt-in (ADR-019, piano opt-in): due preferenze PER-ACCOUNT
  -- canale-agnostiche, default ON (=1) alla registrazione. Gestite SOLO via
  -- CLI (platform:register / platform:preferences); snapshot a tournament:start.
  receive_tournament_start_notification INTEGER NOT NULL DEFAULT 1, -- 1 = riceve la mail tournament_open (D9)
  tournament_auto_join                  INTEGER NOT NULL DEFAULT 1  -- 1 = auto-joinato a tournament:start (D2/D6)
);
`;

/**
 * Migrazioni additive idempotenti (stesso pattern di src/db/schema.ts):
 * `name` (ADR-011) e i due flag di partecipazione opt-in (ADR-019) sono
 * aggiunti con ALTER TABLE guardato da PRAGMA table_info, così i DB
 * piattaforma pre-esistenti guadagnano le colonne senza perdere dati e
 * rieseguire la migrazione resta un no-op. Default 1 per i due flag: gli
 * account pre-esistenti diventano auto-join ON + notifiche ON (D2).
 */
export function applyPlatformAdditiveMigrations(db: Database.Database): void {
  const columns = (db.prepare('PRAGMA table_info(platform_account)').all() as Array<{
    name: string;
  }>).map((c) => c.name);
  if (!columns.includes('name')) {
    db.exec('ALTER TABLE platform_account ADD COLUMN name TEXT');
  }
  if (!columns.includes('receive_tournament_start_notification')) {
    db.exec(
      'ALTER TABLE platform_account ADD COLUMN receive_tournament_start_notification INTEGER NOT NULL DEFAULT 1'
    );
  }
  if (!columns.includes('tournament_auto_join')) {
    db.exec('ALTER TABLE platform_account ADD COLUMN tournament_auto_join INTEGER NOT NULL DEFAULT 1');
  }
}

/**
 * Applica lo schema del DB piattaforma. Idempotente: può essere rieseguita
 * senza errori e senza perdere dati (CREATE TABLE IF NOT EXISTS + migrazione
 * additiva guardata di `name`).
 */
export function migratePlatform(db: Database.Database): void {
  db.exec(PLATFORM_SCHEMA_DDL);
  applyPlatformAdditiveMigrations(db);
}
