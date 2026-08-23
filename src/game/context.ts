/**
 * Contesto iniettato dalla CLI ai moduli di gioco (briefing Fase 3 §1-I).
 *
 * Ruolo: contratto unico per l'INIEZIONE delle dipendenze nei moduli del Game
 * Engine. Ogni modulo di gioco riceve `{ db, dataProvider, config, now }` e non
 * chiama MAI `getConfig()` né accede a `process.env` (separazione di
 * responsabilità, AGENTS.md §1.3): è la CLI (src/cli/) a costruire il contesto
 * dal pattern consolidato `getConfig() → createConnection → migrate`.
 *
 * `now` è il CLOCK iniettabile (decisione A del briefing): il Game Engine non
 * usa mai `new Date()` direttamente — riceve il tempo corrente da qui. In POC è
 * un orologio fisso nei test (determinismo RNF1/CS4); in Fase 1 (dati live)
 * sarà l'orologio reale, senza cambi di logica.
 *
 * `config` è la configurazione validata (src/config.ts) passata in sola
 * lettura (accede solo ai parametri di gioco come DEADLINE_ADVANCE_MIN).
 */
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { ChannelAdapter } from '../channel/adapter.js';
import type { AppConfig } from '../config.js';
import type { SeasonDataProvider } from '../data/provider.js';
import type { LLMGenerator } from '../llm/generator.js';
import type { LLMIntentClassifier } from '../llm/intent-classifier.js';
import type { LLMParser } from '../llm/parser.js';
import type { PlatformRegistry } from '../platform/registry.js';

/** Dipendenze iniettate dalla CLI a tutti i moduli di gioco (briefing §1-I). */
export interface GameContext {
  /** Connessione SQLite aperta e migrata (src/db/). */
  db: Database.Database;
  /** Accesso ai dati stagione (DbSeasonDataProvider, mai mockato nei test). */
  dataProvider: SeasonDataProvider;
  /** Configurazione validata (sola lettura dei parametri di gioco). */
  config: AppConfig;
  /** Clock iniettabile: unico istante "adesso" per le decisioni temporali. */
  now: Date;
  /**
   * Canale di notifica (opzionale): presente nei test (fake in-memory) e in
   * produzione (Fase 6); assente nella CLI di Fase 3 — le email reali sono
   * implementate nelle Fasi 5–6, qui vale solo il contratto (briefing §6.5).
   */
  channel?: ChannelAdapter;
  /** Generatore LLM dei testi email (opzionale, come `channel`). */
  generator?: LLMGenerator;
  /**
   * Parser LLM delle email in ingresso (opzionale, come `channel`): usato dal
   * wiring `channel:email:process` (Task 6.2); i test del wiring lo mockano.
   */
  parser?: LLMParser;
  /**
   * Classificatore di intento LLM (opzionale, ADR-009): intento + pick in UNA
   * chiamata; usato dal wiring `channel:email:process` (Task 8) al posto del
   * solo Parser.
   */
  classifier?: LLMIntentClassifier;
  /**
   * Registry degli account PIATTAFORMA (opzionale, ADR-009/RF-P7): connessione
   * DEDICATA al DB piattaforma, SOLO LETTA dai flussi di torneo (gate
   * eligibilità/notifiche/pick). Iniettato dai comandi CLI che toccano la
   * piattaforma (`channel:email:process`, `round:*`, `tournament:start`,
   * `simulate:*`, `pick:register`); assente nei contesti che non la
   * richiedono (comandi puramente di torneo senza gate).
   */
  platform?: PlatformRegistry;
  /**
   * Logger strutturato (pino) opzionale (B2, decisione (b)): iniettato dalle
   * CLI di produzione che orchestrano notifiche (`round:*`,
   * `scheduler:tick`) con lo stesso pattern degli altri componenti I/O, per
   * rendere visibili nei log i fallimenti BEST-EFFORT dei moduli di gioco
   * (es. riepilogo di round non inviato a un destinatario — warn pino in
   * inglese, senza far fallire il flusso). Livello e binding `testMode`
   * derivano dalla configurazione nel punto di iniezione (src/logger.ts).
   * Assente nei contesti che non loggano (test senza asserzioni sui log,
   * comandi senza email): in quel caso i moduli non emettono log.
   */
  logger?: Logger;
  /**
   * ADR-011 (§1.3): archivia l'export JSON del torneo e restituisce il path
   * assoluto del file scritto; iniettato dal wiring (mai `node:fs` nei moduli
   * di gioco). Assente nei contesti dry-run (simulazione, test senza
   * archiviazione): in quel caso `settleWinnerIfNeeded` logga un warn e NON
   * scrive export né `tournament_state.export_path` (riavvio rifiutato).
   */
  archiveTournament?: (dump: unknown, now: Date) => string;
  /**
   * ADR-011 (§5.5): se `false`, la CHIUSURA AUTOMATICA del torneo è
   * disattivata — `closeRound`/`scoreRound` NON invocano
   * `settleWinnerIfNeeded` (nessun winner_notified/export/inibizione). Usato
   * SOLO dalla simulazione (`simulate:*`, dry-run R1): riproduce l'intera
   * stagione senza i side-effect di produzione, e il vincitore è riportato a
   * fine run da `checkWinner` (sola lettura). Default (assente) = `true`: i
   * flussi reali chiudono il torneo automaticamente.
   */
  autoClose?: boolean;
}
