/**
 * Wiring di ARCHIVIAZIONE dell'export del torneo (ADR-011 §1.3, emendamento
 * post-revisione HIGH-1/D2).
 *
 * Ruolo: unico punto dove il sistema tocca il filesystem per l'export
 * automatico della chiusura. Il Game Engine (src/game/) NON importa MAI
 * `node:fs`: riceve il seam `GameContext.archiveTournament` iniettato qui
 * (pattern "la CLI inietta", AGENTS.md §1.3). Separare I/O e regole di gioco
 * rende i moduli di gioco testabili e dry-run sicuri (la simulazione NON
 * inietta il seam → nessun file scritto).
 *
 * Funzioni:
 *   - `archiveTournamentFile(dump, exportDir, now)` — scrive il dump JSON in
 *     `exportDir` con filename derivato dal clock iniettato (`exportFilename`,
 *     deterministico, RNF1: nessun RNG/UUID) e DEDUP deterministico: se il
 *     file esiste già, appende `-1`, `-2`, … (MEDIUM-3). Restituisce il path
 *     ASSOLUTO del file scritto.
 *   - `makeArchiveTournament(config)` — chiude su `TOURNAMENT_EXPORT_DIR` e
 *     produce il seam `(dump, now) => string` da iniettare nel GameContext.
 *   - `attachArchiveToContext(ctx, config)` — copia del contesto con
 *     `archiveTournament` impostato.
 *
 * Usato da: `round:*` e `scheduler:*` (i comandi che eseguono
 * `closeRound`/`scoreRound` in produzione). MAI da `simulate:*` (R1: dry-run
 * senza I/O).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import type { GameContext } from '../game/context.js';
import { exportFilename } from '../game/tournament.js';

/**
 * Scrive il dump JSON del torneo su file, con dedup deterministico del nome
 * (MEDIUM-3): se `exportFilename(now)` esiste già nella directory, appende
 * `-1`, `-2`, … prima dell'estensione. Restituisce il path ASSOLUTO del file
 * scritto (mai un path relativo, così `tournament_state.export_path` è
 * utilizzabile come archivio anche da una working directory diversa).
 */
export function archiveTournamentFile(dump: unknown, exportDir: string, now: Date): string {
  mkdirSync(exportDir, { recursive: true });
  const base = exportFilename(now);
  const dot = base.lastIndexOf('.json');
  const stem = dot === -1 ? base : base.slice(0, dot);
  let candidate = join(exportDir, base);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(exportDir, `${stem}-${i}.json`);
    i += 1;
  }
  writeFileSync(candidate, JSON.stringify(dump, null, 2));
  return resolve(candidate);
}

/** Seam `(dump, now) => string` chiuso su `TOURNAMENT_EXPORT_DIR` della config. */
export function makeArchiveTournament(config: AppConfig): (dump: unknown, now: Date) => string {
  return (dump, now) => archiveTournamentFile(dump, config.TOURNAMENT_EXPORT_DIR, now);
}

/** Copia del contesto con il seam `archiveTournament` iniettato (mai node:fs nel Game Engine). */
export function attachArchiveToContext(ctx: GameContext, config: AppConfig): GameContext {
  return { ...ctx, archiveTournament: makeArchiveTournament(config) };
}
