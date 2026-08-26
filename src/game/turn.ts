/**
 * Mappatura Turno di Torneo (TT) ↔ Turno di Campionato (TC) (ADR-008, RF-20/25).
 *
 * Ruolo: derivazione della coppia (tt, tc) da `tournament_state.start_round`.
 * Il TT è il numero progressivo del turno di gioco nel torneo; il TC è il round
 * assoluto di campionato. La mappatura è DERIVATA, mai persistita su pick/
 * round_state (RF-25): `TT = TC − start_round + 1`.
 *
 * `start_round` è GLU (scritto da `tournament:start`, Task 4.1): prima che il
 * torneo sia avviato la riga `tournament_state` può non esistere o avere
 * `start_round` NULL → fallback 1 (comportamento legacy, ADR-008 n. 4).
 *
 * La coppia è INIETTATA deterministicamente nei template email e negli output
 * CLI/log (forma compatta `TT2TC7`, estesa `TT 2, TC 7`), mai generata dall'LLM
 * (ADR-004, briefing §1-E).
 */
import type Database from 'better-sqlite3';

/**
 * TC di aggancio del torneo: legge `tournament_state.start_round`; riga assente
 * o NULL → 1 (TC 1 legacy, ADR-008). Sola lettura, nessun default inventato.
 */
export function getStartRound(db: Database.Database): number {
  const row = db
    .prepare('SELECT start_round FROM tournament_state WHERE id = 1')
    .get() as { start_round: number | null } | undefined;
  return row?.start_round ?? 1;
}

/** TT = TC − startRound + 1 (RF-20). Es. TC 7 con start_round 6 → TT 2. */
export function ttFor(tc: number, startRound: number): number {
  return tc - startRound + 1;
}

/** Coppia derivata per un TC dallo stato del torneo: `{ tt, tc }`. */
export function turnFor(db: Database.Database, tc: number): { tt: number; tc: number } {
  return { tt: ttFor(tc, getStartRound(db)), tc };
}

/** Forma compatta per log/CLI: `TT2TC7` (RF-25). */
export function turnCompact(tt: number, tc: number): string {
  return `TT${tt}TC${tc}`;
}

/** Forma estesa per il corpo email: `TT 2, TC 7` (RF-25). */
export function turnExtended(tt: number, tc: number): string {
  return `TT ${tt}, TC ${tc}`;
}

/**
 * Forma UMANA del turno di torneo per il RENDERER email ("Round 2"): usata
 * SOLO dal renderer (src/llm/email-renderer.ts, opzione 2 approvata) — MAI
 * nel prompt LLM (ADR-004) e MAI nei log/CLI, che restano sulla forma
 * compatta `TT2TC7` (RF-25).
 */
export function roundLabel(tt: number): string {
  return `Round ${tt}`;
}

/**
 * Forma UMANA del turno di torneo per l'HEADER del renderer email ("Round del
 * torneo 2", ADR-015 email v4): label DEDICATA all'header, distinta da
 * `roundLabel` (usata dal box "squadre già usate" nella forma compatta
 * "(Round N)"). Solo renderer, mai prompt, mai log/CLI.
 */
export function roundHeaderLabel(tt: number): string {
  return `Round del torneo ${tt}`;
}

/**
 * Forma UMANA del turno di campionato per l'HEADER del renderer email ("Turno
 * di Campionato 7", ADR-015 email v4): label DEDICATA all'header, con
 * "Campionato" maiuscolo per coerenza col soggetto (`subjectFor`). Solo
 * renderer, mai prompt, mai log/CLI. La coppia
 * "Round del torneo N · Turno di Campionato M" è la forma approvata dal PO
 * per le comunicazioni verso l'esterno (mai sigle TT/TC).
 */
export function championshipHeaderLabel(tc: number): string {
  return `Turno di Campionato ${tc}`;
}
