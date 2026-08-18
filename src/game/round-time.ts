/**
 * Derivatori di tempo del Game Engine (briefing Fase 3 §8, decisione A) — PURI.
 *
 * Ruolo: funzioni pure sui dati per le soglie temporali del torneo. Sono la
 * SEAM che la Fase 1 userà con i dati live (orologio reale + `rescheduled_date`/
 * `end_time` dal provider): in POC operano sui dati importati, senza cambi di
 * logica. Nessun accesso a DB, nessun clock: il tempo arriva come parametro.
 *
 * Usato da: Round Manager (Task 3.5, freeze con soglia tcClose), torneo (4.1,
 * validazione RF-21 deadline TT1 futura) e registrazione (4.2, finestra TT1).
 * Estratto qui per non accoppiare 4.1/4.2 all'intero Round Manager (§8).
 */
import type { Match } from '../data/provider.js';

const MINUTE_MS = 60_000;

/**
 * Deadline di un round (RF-14): `kickoff - advanceMin` minuti. Il kickoff è il
 * fischio d'inizio effettivo della prima partita del TC (da
 * `SeasonDataProvider.getFirstMatchDateTime`). Calcolata una sola volta in
 * `round:open` e registrata in `round_state.deadline` (resta fissa, RF-14).
 */
export function computeDeadline(kickoff: Date, advanceMin: number): Date {
  return new Date(kickoff.getTime() - advanceMin * MINUTE_MS);
}

/**
 * Chiusura del TC = fine prevista dell'ULTIMA partita programmata (UPP) +
 * `skewMin` (PRD §5.4): la fine prevista è `match_date + durationMin`,
 * INDIPENDENTE dal punteggio. Definisce la finestra del TC
 * `[kickoff, tcClose]` usata per le decisioni sui rinvii (CL7 entro, CL1/CL8
 * oltre) — finestra di riferimento, NON trigger della contabilizzazione
 * (LLD §1.4/§3.1).
 *
 * Restituisce `null` se il round non ha partite (chiusura non calcolabile: il
 * caso è coperto dalla chiusura di sicurezza RF-30 dello scheduler).
 */
export function computeTcClose(matches: Match[], durationMin: number, skewMin: number): Date | null {
  if (matches.length === 0) return null;
  const first = matches[0];
  if (first === undefined) return null;
  const uppStart = matches.reduce(
    (max, m) => (m.matchDate > max ? m.matchDate : max),
    first.matchDate
  );
  return new Date(uppStart.getTime() + (durationMin + skewMin) * MINUTE_MS);
}
