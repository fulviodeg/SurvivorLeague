/**
 * Fixture sintetiche dei dati stagione (piano Task 2.5) e loader condiviso.
 *
 * Ruolo: mini-stagione deterministica (4 squadre, 6 round: 3 di andata + 3 di
 * ritorno, confine girone `ceil(6/2)=3`) per esercitare l'azzeramento del pool
 * nella Fase 3, usata dai test di Task 2.2 (DbSeasonDataProvider), 2.3
 * (import) e 2.5 (varianti rinvii). I nomi squadra sono i `name` REALI della
 * API football-data.org (non shortName/tla): così la coincidenza tra alias
 * (Task 2.4) e `getTeams()` è verificabile sui dati (briefing §1-C/§5-A).
 *
 * Le varianti CL7/CL1/CL8/frozen→valutato NON sono snapshot statici: sono
 * SEQUENZE temporali simulate con gli helper di mutazione sotto
 * (`setScore`, `setPostponedFlag`, `setMatchDate`), che riproducono i passi
 * import→refresh del sistema reale (briefing §6-B): la classificazione finale
 * (dentro/fuori la finestra del TC) è del Round Manager (Fase 3), qui i dati
 * sono preparati nei loro stati intermedi.
 *
 * Le partite sono caricate con `upsertMatches` (src/data/importer.ts): stesso
 * formato riga e stessa logica di upsert dell'import di produzione.
 */
import type Database from 'better-sqlite3';

import { upsertMatches } from '../../src/data/importer.js';
import type { Match } from '../../src/data/provider.js';

/** Le 4 squadre della mini-stagione (nomi `name` reali dell'API 2025/26). */
export const FIXTURE_TEAMS = [
  'FC Internazionale Milano',
  'AC Milan',
  'Juventus FC',
  'AS Roma'
] as const;

/** Un match della mini-stagione come `Match` (canonici, senza punteggio: calendario non ancora giocato). */
function at(round: number, isoDate: string, homeTeam: string, awayTeam: string): Match {
  return { round, matchDate: new Date(isoDate), homeTeam, awayTeam, postponed: false };
}

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

/**
 * Mini-stagione base: calendario completo di 6 round (2 partite per round,
 * orari distinti per esercitare MIN(match_date)). Orari fissi e fittizi; il
 * formato `match_date` è canonico ISO-8601 UTC come quello scritto da
 * `data:import`.
 */
export const BASE_MATCHES: Match[] = [
  // Andata (TC 1-3)
  at(1, '2026-09-12T16:00:00Z', IM, AC),
  at(1, '2026-09-12T18:45:00Z', JU, MA),
  at(2, '2026-09-19T16:00:00Z', IM, JU),
  at(2, '2026-09-19T18:45:00Z', AC, MA),
  at(3, '2026-09-26T16:00:00Z', IM, MA),
  at(3, '2026-09-26T18:45:00Z', AC, JU),
  // Ritorno (TC 4-6)
  at(4, '2026-10-03T16:00:00Z', AC, IM),
  at(4, '2026-10-03T18:45:00Z', MA, JU),
  at(5, '2026-10-10T16:00:00Z', JU, IM),
  at(5, '2026-10-10T18:45:00Z', MA, AC),
  at(6, '2026-10-17T16:00:00Z', MA, IM),
  at(6, '2026-10-17T18:45:00Z', JU, AC)
];

/**
 * Carica la mini-stagione base nel DB in-memory (o nel DB passato), usando lo
 * stesso upsert di produzione. Restituisce il numero di righe processate.
 */
export function loadBaseSeason(db: Database.Database): number {
  return upsertMatches(db, BASE_MATCHES);
}

/**
 * Helper di mutazione — step "refresh con punteggio": la partita è stata
 * giocata/recuperata, quindi ha punteggio e non è più rinviata. Simula il
 * recupero delle CL7 e il frozen→valutato (punteggio arrivato a recupero
 * concluso).
 */
export function setScore(
  db: Database.Database,
  round: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number
): void {
  db.prepare(
    `UPDATE match SET home_score = ?, away_score = ?, postponed = 0
     WHERE round = ? AND home_team = ? AND away_team = ?`
  ).run(homeScore, awayScore, round, home, away);
}

/**
 * Helper di mutazione — step "rinvio": segna la partita come rinviata/sospesa
 * e azzera il punteggio (nessun esito determinabile, PRD §5.4/ADR-002).
 * Simula lo stato intermedio di CL1/CL7 (prima del recupero) e CL8.
 */
export function setPostponedFlag(
  db: Database.Database,
  round: number,
  home: string,
  away: string
): void {
  db.prepare(
    `UPDATE match SET postponed = 1, home_score = NULL, away_score = NULL
     WHERE round = ? AND home_team = ? AND away_team = ?`
  ).run(round, home, away);
}

/**
 * Helper di mutazione — step "recupero ripianificato": sposta l'orario di un
 * match (es. recupero in una data diversa da quella programmata). Simula la
 * `utcDate` aggiornata di un rinvio recuperato che arriva dal refresh
 * (la regola operativa POC non ha `rescheduled_date`: il dato emerge da qui).
 */
export function setMatchDate(
  db: Database.Database,
  round: number,
  home: string,
  away: string,
  isoDate: string
): void {
  db.prepare(
    `UPDATE match SET match_date = ? WHERE round = ? AND home_team = ? AND away_team = ?`
  ).run(isoDate, round, home, away);
}
