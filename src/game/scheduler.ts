/**
 * Scheduler (LLD §1.4, piano Task 7.2; decisioni R5–R7 del briefing Fase 7).
 *
 * Ruolo: ORCHESTRATORE sottile della produzione — decide QUANDO agire in base
 * al calendario e allo stato del torneo, e invoca esclusivamente i comandi
 * del Game Engine esistenti (`closeRegistration`, `openRound`, `closeRound`,
 * `scoreRound`): nessuna logica di gioco qui (LLD §1.4, AGENTS.md §1.3).
 *
 * Azioni (LLD §1.4, finestra `[start_round..N]`, ADR-008):
 *   - finestra di iscrizione: `register_close_auto` alla deadline del TT 1
 *     (RF-22); `register_close_safety` alla chiusura del TC se la deadline
 *     del TT 1 manca (RF-30, causa `deadline_missing`); `warn_not_calculable`
 *     se nemmeno la chiusura del TC è calcolabile (uscita manuale RF-28);
 *   - `round_open`: TT 1 all'apertura del torneo (RF-23), poi un `pending`
 *     quando il TC precedente è `scored`;
 *   - `round_close`: round `open` con deadline registrata scaduta;
 *   - `round_close_safety`: round `open` con deadline NULL oltre la chiusura
 *     del TC ricalcolata dai dati correnti (RF-30, stessa semantica di
 *     consolidamento; causa `deadline_missing`); `warn_not_calculable` se il
 *     TC non è calcolabile;
 *   - `round_score`: round `closed` non `scored` (se `SCHEDULER_AUTO_SCORE`);
 *   - `round_score_frozen`: round `scored` con pick `frozen` (`SELECT
 *     DISTINCT round FROM pick WHERE status='frozen'`).
 *
 * Design (R5–R7): nessuno stato persistito (l'audit sta nel log pino della
 * CLI, non nei moduli); `computeActions` è pura (sola lettura, decisione);
 * `schedulerTick` esegue con check-then-act idempotente (RNF9: un tick
 * ripetuto non produce effetti; un'azione fallita perché lo stato è cambiato
 * si salta senza crash); il refresh dei dati stagione è INIETTATO
 * (`deps.refresh` — CLI: `importMatches`+`FootballDataClient`; test: stub) e
 * un suo errore produce l'evento `refresh_failed` senza bloccare le azioni.
 */
import type Database from 'better-sqlite3';

import type { GameContext } from './context.js';
import { closeRegistration } from './registration.js';
import { closeRound, openRound, scoreRound } from './round-manager.js';
import { computeTcClose } from './round-time.js';
import { getStartRound, turnFor } from './turn.js';

/** Un'azione pendente calcolata dallo stato (decisione pura, nessuna scrittura). */
export type PendingAction =
  | { type: 'register_close_auto' }
  | { type: 'register_close_safety' }
  | { type: 'round_open'; round: number }
  | { type: 'round_close'; round: number }
  | { type: 'round_close_safety'; round: number }
  | { type: 'round_score'; round: number }
  | { type: 'round_score_frozen'; round: number }
  | { type: 'warn_not_calculable'; round: number };

/** Evento prodotto da un tick (audit: la CLI li logga con pino, R5). */
export type SchedulerEvent =
  | { type: 'round_open'; round: number }
  | { type: 'round_close'; round: number }
  | { type: 'round_close_safety'; round: number; cause: 'deadline_missing' }
  | { type: 'round_score'; round: number }
  | { type: 'round_score_frozen'; round: number }
  | { type: 'register_close_auto' }
  | { type: 'register_close_safety'; cause: 'deadline_missing' }
  | { type: 'refresh_failed' }
  | { type: 'warn_not_calculable'; round: number };

/** Dipendenze del tick: il refresh è iniettato dalla CLI (R6). */
export interface SchedulerTickDeps {
  /**
   * Aggiorna i dati stagione dall'API (CLI: `importMatches` +
   * `FootballDataClient`; test: stub). Un errore NON blocca le azioni (RNF9).
   */
  refresh?: () => Promise<unknown>;
}

/** Esito di un tick: gli eventi eseguiti (vuoto se non c'era nulla da fare). */
export interface SchedulerTickResult {
  events: SchedulerEvent[];
}

/** Stato computato di `scheduler:status` (R5: nessuna persistenza). */
export interface SchedulerStatusResult {
  enabled: boolean;
  seasonStarted: boolean;
  registrationOpen: boolean;
  startRound: number;
  totalRounds: number;
  rounds: Array<{
    round: number;
    tt: number;
    tc: number;
    status: string;
    deadline: string | null;
  }>;
  /** Anomalie rilevabili dallo stato (RF-30: round open con deadline NULL). */
  anomalies: Array<{ round: number; type: 'deadline_missing' }>;
  /** Prossime azioni calcolate dallo stato corrente (sola lettura). */
  nextActions: PendingAction[];
}

/** Riga `tournament_state` letta dal DB. */
interface TournamentStateRow {
  season_started: number;
  start_round: number | null;
  registration_open: number;
}

/** Riga `round_state` letta dal DB (sola lettura). */
interface RoundStateRow {
  round: number;
  status: string;
  deadline: string | null;
}

/** Legge lo stato registrato del torneo. */
function getTournamentState(db: Database.Database): TournamentStateRow | undefined {
  return db
    .prepare('SELECT season_started, start_round, registration_open FROM tournament_state WHERE id = 1')
    .get() as TournamentStateRow | undefined;
}

/** Legge le righe round_state della finestra `[start..N]`, ordinate per round. */
function getRoundStates(db: Database.Database, startRound: number, totalRounds: number): RoundStateRow[] {
  return db
    .prepare('SELECT round, status, deadline FROM round_state WHERE round BETWEEN ? AND ? ORDER BY round')
    .all(startRound, totalRounds) as unknown as RoundStateRow[];
}

/**
 * Chiusura del TC ricalcolata DAI DATI CORRENTI (R7, RF-30): null se il round
 * non ha partite (non calcolabile) o se il provider solleva un errore.
 */
async function computeRoundTcClose(ctx: GameContext, round: number): Promise<Date | null> {
  const { dataProvider, config } = ctx;
  let matches;
  try {
    matches = await dataProvider.getMatchesForRound(round);
  } catch {
    return null;
  }
  return computeTcClose(matches, config.MATCH_DURATION_MIN, config.TC_CLOSE_SKEW_MIN);
}

/**
 * Decisione pura (sola lettura, nessuna scrittura): calcola le azioni da
 * eseguire dallo stato corrente al clock `ctx.now`, nell'ordine LLD §1.4 —
 * finestra di iscrizione, poi i round della finestra in ordine crescente
 * (determinismo). Ogni round produce al più un'azione (open/close/safety/
 * score/score_frozen a seconda dello stato).
 */
export async function computeActions(ctx: GameContext): Promise<PendingAction[]> {
  const { db, dataProvider, config, now } = ctx;
  const actions: PendingAction[] = [];

  const state = getTournamentState(db);
  const totalRounds = await dataProvider.getTotalRounds();
  const startRound = state?.start_round ?? getStartRound(db);
  const rounds = getRoundStates(db, startRound, totalRounds);

  // Finestra di iscrizione: aperta dall'avvio del torneo (RF-22), si
  // auto-chiude alla deadline del TT 1; di sicurezza se la deadline manca.
  if (state?.season_started === 1 && state.registration_open === 1) {
    const tt1 = rounds.find((r) => r.round === startRound);
    const tt1Deadline = tt1?.deadline != null ? new Date(tt1.deadline) : null;
    if (tt1Deadline !== null && now > tt1Deadline) {
      actions.push({ type: 'register_close_auto' });
    } else if (tt1Deadline === null) {
      const tcClose = await computeRoundTcClose(ctx, startRound);
      if (tcClose !== null && now > tcClose) {
        actions.push({ type: 'register_close_safety' });
      } else if (tcClose === null) {
        actions.push({ type: 'warn_not_calculable', round: startRound });
      }
    }
  }

  // Round della finestra [start_round..N] (ADR-008).
  for (let i = 0; i < rounds.length; i++) {
    const rs = rounds[i];
    if (rs === undefined) continue;
    if (rs.status === 'pending') {
      // TT 1 all'apertura del torneo (RF-23); gli altri al termine del TC
      // precedente (finestra contigua: il precedente è rounds[i-1]).
      const prevScored = i > 0 && rounds[i - 1]?.status === 'scored';
      if (rs.round === startRound || prevScored) {
        actions.push({ type: 'round_open', round: rs.round });
      }
    } else if (rs.status === 'open') {
      const deadline = rs.deadline != null ? new Date(rs.deadline) : null;
      if (deadline !== null && now > deadline) {
        actions.push({ type: 'round_close', round: rs.round });
      } else if (deadline === null) {
        // RF-30: chiusura di sicurezza alla chiusura del TC dai dati correnti.
        const tcClose = await computeRoundTcClose(ctx, rs.round);
        if (tcClose !== null && now > tcClose) {
          actions.push({ type: 'round_close_safety', round: rs.round });
        } else if (tcClose === null) {
          actions.push({ type: 'warn_not_calculable', round: rs.round });
        }
      }
    } else if (rs.status === 'closed' && config.SCHEDULER_AUTO_SCORE) {
      actions.push({ type: 'round_score', round: rs.round });
    } else if (rs.status === 'scored' && config.SCHEDULER_AUTO_SCORE) {
      // Frozen rivalutati a recupero concluso (LLD §1.4), anche su round scored.
      const frozen = db
        .prepare("SELECT 1 FROM pick WHERE round = ? AND status = 'frozen' LIMIT 1")
        .get(rs.round);
      if (frozen !== undefined) actions.push({ type: 'round_score_frozen', round: rs.round });
    }
  }

  return actions;
}

/** Esegue un'azione e produce l'evento di audit corrispondente. */
async function executeAction(ctx: GameContext, action: PendingAction): Promise<SchedulerEvent> {
  switch (action.type) {
    case 'register_close_auto':
      closeRegistration(ctx);
      return { type: 'register_close_auto' };
    case 'register_close_safety':
      closeRegistration(ctx);
      return { type: 'register_close_safety', cause: 'deadline_missing' };
    case 'round_open':
      await openRound(ctx, action.round);
      return { type: 'round_open', round: action.round };
    case 'round_close':
      await closeRound(ctx, action.round);
      return { type: 'round_close', round: action.round };
    case 'round_close_safety':
      await closeRound(ctx, action.round);
      return { type: 'round_close_safety', round: action.round, cause: 'deadline_missing' };
    case 'round_score':
      await scoreRound(ctx, action.round);
      return { type: 'round_score', round: action.round };
    case 'round_score_frozen':
      await scoreRound(ctx, action.round);
      return { type: 'round_score_frozen', round: action.round };
    case 'warn_not_calculable':
      // Nessuna esecuzione: l'anomalia è già esposta da tournament:status.
      return { type: 'warn_not_calculable', round: action.round };
  }
}

/**
 * Esegue un tick (LLD §1.4): refresh dei dati (se iniettato, errore →
 * `refresh_failed` e prosegui, RNF9), poi le azioni calcolate da
 * `computeActions` in ordine. Check-then-act idempotente: un'azione che
 * fallisce perché lo stato è cambiato (tick concorrente) si salta senza
 * crash. Restituisce gli eventi per l'audit (log pino nella CLI, R5).
 */
export async function schedulerTick(
  ctx: GameContext,
  deps: SchedulerTickDeps = {}
): Promise<SchedulerTickResult> {
  const events: SchedulerEvent[] = [];

  if (deps.refresh !== undefined) {
    try {
      await deps.refresh();
    } catch {
      events.push({ type: 'refresh_failed' });
    }
  }

  for (const action of await computeActions(ctx)) {
    try {
      events.push(await executeAction(ctx, action));
    } catch {
      // Stato cambiato tra check e act (già eseguita da un tick concorrente):
      // l'azione si salta — i moduli restano idempotenti (RNF9).
    }
  }

  return { events };
}

/**
 * Stato COMPUTATO dello scheduler (R5, LLD §7.12): nessuna persistenza — il
 * comando `scheduler:status` riporta lo stato del torneo, le anomalie
 * (RF-30) e le prossime azioni calcolate al volo.
 */
export async function schedulerStatus(ctx: GameContext): Promise<SchedulerStatusResult> {
  const { db, dataProvider, config } = ctx;
  const state = getTournamentState(db);
  const totalRounds = await dataProvider.getTotalRounds();
  const startRound = state?.start_round ?? 1;
  const rounds = getRoundStates(db, startRound, totalRounds);

  return {
    enabled: config.SCHEDULER_ENABLED,
    seasonStarted: state?.season_started === 1,
    registrationOpen: state?.registration_open === 1,
    startRound,
    totalRounds,
    rounds: rounds.map((r) => {
      const { tt, tc } = turnFor(db, r.round);
      return { round: r.round, tt, tc, status: r.status, deadline: r.deadline };
    }),
    anomalies: rounds
      .filter((r) => r.status === 'open' && r.deadline === null)
      .map((r) => ({ round: r.round, type: 'deadline_missing' as const })),
    nextActions: await computeActions(ctx)
  };
}
