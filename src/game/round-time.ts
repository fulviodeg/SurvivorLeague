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

const HOUR_MS = 60 * MINUTE_MS;

/**
 * Countdown leggibile tra due istanti ("Mancano circa …"), puro e
 * deterministico (RNF1): riceve entrambi gli istanti, MAI il clock. Forme
 * per il box deadline del renderer email (opzione 2 approvata):
 *   - differenza ≤ 0 → "meno di un minuto";
 *   - < 60 minuti → "meno di un'ora" (o "meno di N minuti"? no: <1h → "meno
 *     di un'ora", precisione inutile su orari non esatti);
 *   - < 24 ore → "X ore e Y minuti" (Y = 0 → "X ore");
 *   - ≥ 24 ore → "X giorni e Y ore" (Y = 0 → "X giorni");
 * singolare/plurale corretti (1 ora, 2 ore; 1 minuto, 2 minuti; 1 giorno,
 * 2 giorni). I minuti sono scartati oltre le 24 ore (approssimazione "circa").
 */
export function formatRemaining(from: Date, to: Date): string {
  const diffMs = to.getTime() - from.getTime();
  if (diffMs <= 0) return 'meno di un minuto';
  const totalMinutes = Math.floor(diffMs / MINUTE_MS);
  if (totalMinutes < 60) return "meno di un'ora";
  const hours = Math.floor(diffMs / HOUR_MS);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    const hoursText = hours === 1 ? '1 ora' : `${hours} ore`;
    return minutes === 0 ? hoursText : `${hoursText} e ${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const daysText = days === 1 ? '1 giorno' : `${days} giorni`;
  return remainingHours === 0 ? daysText : `${daysText} e ${remainingHours} ${remainingHours === 1 ? 'ora' : 'ore'}`;
}
