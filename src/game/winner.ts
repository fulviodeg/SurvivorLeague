/**
 * Winner Engine (LLD §7.7, PRD §4.6 RF-18/RF-26; piano Task 3.4).
 *
 * Ruolo: determina la fine del torneo e il/i vincitore/i dal SOLO stato di
 * profili/pick/round_state (logica deterministica, CS6), senza richiedere
 * `tournament:start`: l'ultimo TC è `getTotalRounds()` (derivato dai dati,
 * RF-19). Finestra-agnostico (ADR-008/RF-26/CL12): nessuna logica speciale per
 * un torneo agganciato o di un solo turno — i tre casi collassano naturalmente.
 *
 * I tre casi (PRD §4.6, US5):
 *   - caso 1 — resta UN SOLO profilo non eliminato → vincitore unico;
 *   - caso 2 — ZERO profili attivi: gli ultimi eliminati condividono la vittoria
 *     (decisione 2 del briefing: i profili eliminati nella stessa ondata di
 *     round:score/round:close, con lo stesso clock, hanno `eliminated_at`
 *     IDENTICO; vincitori = profili con `eliminated_at` = MAX — condivisa se 2+,
 *     unica se l'ultima ondata ne ha uno solo: ha resistito più a lungo);
 *   - caso 3 — 2+ profili attivi DOPO che l'ultimo TC della stagione è `scored`
 *     → vittoria condivisa.
 *
 * CS6 (freeze a fine stagione): un profilo con pick `frozen` non contabilizzato
 * RESTA in gara (non è eliminato) → rientra nei superstiti e non blocca la
 * determinazione del vincitore.
 *
 * Interazioni: invocato dal comando CLI `winner:check`
 * (src/cli/commands/winner.ts) e dal Round Manager dopo la contabilizzazione
 * (`settleWinnerIfNeeded` in src/game/round-manager.ts, ADR-011: alla
 * chiusura di ogni round il sistema verifica automaticamente se c'è un
 * vincitore, lo notifica e chiude il torneo). Sola lettura: non scrive nulla.
 */
import type Database from 'better-sqlite3';

import type { GameContext } from './context.js';

/** I tre casi di fine torneo (PRD §4.6). */
export type WinnerCase = 1 | 2 | 3;

/** Vincitore (profilo + email del giocatore per l'output). */
export interface WinnerInfo {
  profileId: number;
  email: string;
}

/** Esito di `winner:check`: `{finished, winners, case}` (LLD §7.7). */
export interface WinnerResult {
  finished: boolean;
  winners: WinnerInfo[];
  /** Presente solo se finished = true. */
  case?: WinnerCase;
}

interface ProfileLite {
  id: number;
  email: string;
}

/** Profili ancora in gara (eliminated = 0): i frozen restano in gara (CS6). */
function getActiveProfiles(db: Database.Database): ProfileLite[] {
  return db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email
       FROM profile p
       LEFT JOIN player pl ON pl.id = p.player_id
       WHERE p.eliminated = 0
       ORDER BY p.id`
    )
    .all() as unknown as ProfileLite[];
}

/**
 * Profili eliminati nell'ULTIMA ondata (decisione 2): quelli con
 * `eliminated_at` = MAX(eliminated_at). Stessa ondata = stesso clock → stesso
 * timestamp. Se l'ultima ondata ha 2+ profili → vittoria condivisa.
 */
function getLastEliminationWave(db: Database.Database): ProfileLite[] {
  return db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email
       FROM profile p
       LEFT JOIN player pl ON pl.id = p.player_id
       WHERE p.eliminated = 1
         AND p.eliminated_at = (SELECT MAX(eliminated_at) FROM profile WHERE eliminated = 1)
       ORDER BY p.id`
    )
    .all() as unknown as ProfileLite[];
}

function toWinners(rows: ProfileLite[]): WinnerInfo[] {
  return rows.map((r) => ({ profileId: r.id, email: r.email }));
}

/**
 * Verifica se il torneo è finito e chi ha vinto (sola lettura, idempotente).
 * Regole nei commenti di intestazione: caso 1 (un attivo), caso 2 (zero attivi,
 * ultima ondata), caso 3 (2+ attivi dopo l'ultimo TC `scored`).
 */
export async function checkWinner(ctx: GameContext): Promise<WinnerResult> {
  const { db, dataProvider } = ctx;

  const active = getActiveProfiles(db);

  // Caso 1: un solo profilo in gara → vincitore unico.
  if (active.length === 1) {
    return { finished: true, case: 1, winners: toWinners(active) };
  }

  // Caso 2: zero attivi → vincono gli eliminati nell'ultima ondata (condivisa
  // se 2+; se non c'è nessun eliminato — torneo senza profili — non è finito).
  if (active.length === 0) {
    const lastWave = getLastEliminationWave(db);
    if (lastWave.length === 0) return { finished: false, winners: [] };
    return { finished: true, case: 2, winners: toWinners(lastWave) };
  }

  // 2+ attivi: finito solo se l'ultimo TC della stagione è stato contabilizzato
  // (round_state.status = 'scored'); i frozen restano in gara (CS6).
  const totalRounds = await dataProvider.getTotalRounds();
  const lastRound = db
    .prepare('SELECT status FROM round_state WHERE round = ?')
    .get(totalRounds) as { status: string } | undefined;
  if (lastRound !== undefined && lastRound.status === 'scored') {
    return { finished: true, case: 3, winners: toWinners(active) };
  }
  return { finished: false, winners: [] };
}
