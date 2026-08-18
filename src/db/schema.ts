/**
 * Schema del database (DDL di LLD §3) e migrazione.
 *
 * Ruolo: definisce l'intero modello dati della POC — player, profile (con
 * eliminated_at/eliminated_reason, decisione 10 del piano), pick, match,
 * round_state, tournament_state (con start_round, ADR-008) — e lo applica
 * con migrate(). I vincoli applicativi (squadre bruciate per girone,
 * deadline, freeze, guard anti-frode RF-31) NON vivono qui: sono gestiti
 * dal Game Engine (LLD §3.1).
 *
 * Interazioni: migrate(db) è invocata dal comando db:migrate
 * (src/cli/commands/db.ts) e dai test di integrazione su DB in-memory.
 * La connessione è aperta da src/db/connection.ts.
 *
 * Nota sulla DDL: usa CREATE TABLE IF NOT EXISTS (idempotente) e, per
 * i cambi di schema successivi alla prima versione, una strategia di
 * migrazione ADDITIVA: migrate() applica prima la DDL, poi le migrazioni
 * additive idempotenti (es. ALTER TABLE … ADD COLUMN guardato da una
 * PRAGMA table_info) così un DB pre-esistente guadagna le colonne nuove
 * senza perdere dati (ADR-008, LLD §3: start_round).
 */
import type Database from 'better-sqlite3';

/** DDL completa del modello dati (LLD §3, adattata per idempotenza). */
export const SCHEMA_DDL = `
-- Giocatore (persona reale)
CREATE TABLE IF NOT EXISTS player (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Profilo (iscrizione al torneo)
-- Nella PoC: 1 profilo per giocatore
CREATE TABLE IF NOT EXISTS profile (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         INTEGER NOT NULL UNIQUE REFERENCES player(id),
  eliminated        INTEGER NOT NULL DEFAULT 0,
  eliminated_at     TEXT,  -- timestamp dell'eliminazione (ISO 8601), NULL se in gara
  eliminated_reason TEXT CHECK (eliminated_reason IN ('missing_pick', 'wrong_pick')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- eliminated_at / eliminated_reason sono esposte da elimination:list (LLD §7.6)

-- Pick registrato
CREATE TABLE IF NOT EXISTS pick (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profile(id),
  round      INTEGER NOT NULL,
  team       TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'lose')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'frozen', 'correct', 'wrong')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, round)
);

-- Dati stagione (calendario + risultati Serie A)
CREATE TABLE IF NOT EXISTS match (
  round      INTEGER NOT NULL,
  match_date TEXT NOT NULL,
  home_team  TEXT NOT NULL,
  away_team  TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  postponed  INTEGER NOT NULL DEFAULT 0,  -- rinviata (nella POC include le sospese: PRD §5.4)
  PRIMARY KEY (round, home_team, away_team)
);

-- Stato round
CREATE TABLE IF NOT EXISTS round_state (
  round      INTEGER PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'scored')),
  deadline   TEXT,
  opened_at  TEXT,
  closed_at  TEXT,
  scored_at  TEXT
);

-- Stato del torneo (riga singola nell'istanza: PoC monoutente)
-- Gestisce la finestra di iscrizione (PRD §4.1, US7/US8), l'avvio della
-- stagione (US6) e l'aggancio del torneo a un TC arbitrario (ADR-008, RF-20)
CREATE TABLE IF NOT EXISTS tournament_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  season_started    INTEGER NOT NULL DEFAULT 0,  -- stagione avviata (operazioni preliminari concluse, US6)
  registration_open INTEGER NOT NULL DEFAULT 0,  -- finestra di iscrizione aperta: si accettano iscrizioni automatiche;
                                                 -- si chiude da sola alla deadline del TT1 (RF-22) o per chiusura forzata (RF-28)
  start_round       INTEGER,                     -- TC di aggancio del torneo (NULL = TC 1 legacy, ADR-008);
                                                 -- da esso si deriva TT = TC - start_round + 1 (RF-20, RF-25)
  registration_notified INTEGER NOT NULL DEFAULT 0 -- invito all'iscrizione inviato una sola volta (tournament:register:open, US7)
);
`;

/**
 * Migrazioni additive idempotenti da applicare DOPO la DDL.
 *
 * Le tabelle sono create con CREATE TABLE IF NOT EXISTS, che non aggiunge
 * colonne ai DB esistenti: per i campi introdotti dopo la prima versione
 * (es. tournament_state.start_round, ADR-008/LLD §3) usiamo ALTER TABLE
 * ADD COLUMN guardato da una PRAGMA table_info, così rieseguire la
 * migrazione è sempre un no-op e non perde dati su un DB pre-esistente.
 */
export function applyAdditiveMigrations(db: Database.Database): void {
  const stateColumns = (db.prepare('PRAGMA table_info(tournament_state)').all() as Array<{
    name: string;
  }>).map((c) => c.name);

  // start_round: TC di aggancio del torneo (NULL = TC 1 legacy). Introdotto da ADR-008.
  if (!stateColumns.includes('start_round')) {
    db.exec('ALTER TABLE tournament_state ADD COLUMN start_round INTEGER');
  }

  // registration_notified: invito all'iscrizione inviato una sola volta (US7).
  if (!stateColumns.includes('registration_notified')) {
    db.exec(
      'ALTER TABLE tournament_state ADD COLUMN registration_notified INTEGER NOT NULL DEFAULT 0'
    );
  }
}

/**
 * Applica lo schema al database. Idempotente: può essere rieseguita senza
 * errori e senza perdere dati (CREATE TABLE IF NOT EXISTS + migrazioni
 * additive condizionate).
 */
export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_DDL);
  applyAdditiveMigrations(db);
}
