/**
 * Simulazione full-season e per-round (LLD §7.11, piano Task 7.1; decisioni
 * R1–R4 del briefing Fase 7).
 *
 * Ruolo: riproduce l'intero flusso di gioco su dati storici con attori
 * sintetici (profili `sim-XX@survivor.test`), per la verifica CS3
 * (contabilizzazione corretta su tutta la stagione) e RNF1 (determinismo:
 * due run con stessa seed e stesso clock → `tournament:export` identici).
 * È un ORCHESTRATORE: invoca esclusivamente i moduli del Game Engine
 * esistenti (`startTournament` con la seam, `registerPlayer`, `openRound`,
 * `registerPick`, `closeRound`, `scoreRound`, `getAvailableTeams`,
 * `checkWinner`) — nessuna logica di gioco duplicata (AGENTS.md §1.3,
 * ADR-004, briefing §1-B).
 *
 * Determinismo (R2/R4/RNF1): il clock di ogni fase è DERIVATO dai dati —
 * `open` a deadline − 1min, `receivedAt` dei pick = deadline − 1min, `close`
 * a deadline + 1min, `score` a tcClose + 1min — mai dall'orologio reale; la
 * registrazione dei profili sim usa un istante derivato (kickoff TT1 −
 * anticipo − 2min) così anche `created_at` è deterministico (Decisione A).
 * Il RNG è `mulberry32` (funzione pura, seed default 42); l'iterazione è
 * stabile (ORDER BY id/round).
 *
 * Il contesto NON ha channel/generator (R1): le notifiche dei moduli di
 * gioco sono no-op (round-manager.ts) — nessuna email reale in simulazione.
 */
import type Database from 'better-sqlite3';

import type { GameContext } from './context.js';
import { registerPick } from './pick-processor.js';
import { openRegistration, registerPlayer } from './registration.js';
import { getAvailableTeams } from './rules.js';
import { closeRound, openRound, scoreRound } from './round-manager.js';
import { computeDeadline, computeTcClose } from './round-time.js';
import { startTournament } from './tournament.js';
import { getStartRound, turnFor } from './turn.js';
import { checkWinner } from './winner.js';

const MINUTE_MS = 60_000;

/** Esiti validi generati dai pick simulati (stessi valori della cascata). */
const OUTCOMES = ['win', 'draw', 'lose'] as const;

/**
 * RNG deterministico mulberry32 (R4): funzione pura che da un seed produce
 * una sequenza di numeri in [0, 1). Stesso seed → stessa sequenza (RNF1);
 * nessuno stato globale, nessuna dipendenza. Implementazione a mano
 * documentata (standard mulberry32, alternativa libera da librerie).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Opzioni di una simulazione (seed e numero di profili sim opzionali). */
export interface SimulateOptions {
  /** Seed del RNG mulberry32 (default 42, R4). */
  seed?: number;
  /** Numero di profili sintetici da registrare (default `config.SIM_PLAYERS`). */
  players?: number;
  /** TC di aggancio del torneo simulato (default 1; ADR-008 RF-20). */
  startRound?: number;
}

/** Report di un singolo round simulato. */
export interface SimulatedRoundReport {
  /** TC assoluto di campionato. */
  round: number;
  tt: number;
  tc: number;
  /** Profili attivi per cui è stato registrato un pick. */
  picks: number;
  /** Pick valutati (correct/wrong) in questa contabilizzazione. */
  evaluated: number;
  /** Profili passati in Freeze (CL1/CL8). */
  frozen: number;
  /** Profili eliminati per pick sbagliato in questo round. */
  eliminated: number;
  /** Stato finale del round (scored se non restano pending, RF-16). */
  status: string;
}

/** Report completo di una simulazione (full o round singolo). */
export interface SimulationReport {
  startRound: number;
  totalRounds: number;
  seed: number;
  playersRegistered: number;
  /** CL12: true se l'aggancio è all'ultimo TC (warning informativo). */
  lastRoundWarning: boolean;
  rounds: SimulatedRoundReport[];
  /** Esito del Winner Engine a fine simulazione (CS6). */
  winner: Awaited<ReturnType<typeof checkWinner>>;
}

/**
 * Guardia R3: la simulazione richiede un DB SENZA stato di gioco — niente
 * torneo avviato (`season_started=1`) e niente round non-pending. Rifiuta
 * con un errore pulito che spiega il motivo (pattern `tournament:start`).
 */
function assertSimulable(db: Database.Database, command: string): void {
  const state = db
    .prepare('SELECT season_started FROM tournament_state WHERE id = 1')
    .get() as { season_started: number } | undefined;
  if (state?.season_started === 1) {
    throw new Error(
      `${command}: la stagione è già avviata (season_started=1) — la simulazione richiede un DB non avviato`
    );
  }
  const nonPending = db
    .prepare("SELECT COUNT(*) AS n FROM round_state WHERE status != 'pending'")
    .get() as { n: number };
  if (nonPending.n > 0) {
    throw new Error(
      `${command}: esistono round non-pending — la simulazione richiede un DB senza stato di gioco`
    );
  }
}

/** Registra i profili sintetici `sim-XX@survivor.test` a finestra aperta. */
function registerSimPlayers(
  ctx: GameContext,
  count: number
): void {
  const { db } = ctx;
  for (let i = 1; i <= count; i++) {
    const email = `sim-${String(i).padStart(2, '0')}@survivor.test`;
    const res = registerPlayer(ctx, { email, name: `Sim ${i}` });
    if (!res.ok) {
      throw new Error(
        `Registrazione profilo simulato rifiutata (${email}): ${res.reason} (${res.eligibility.reason ?? '—'})`
      );
    }
  }
  // Sanità: almeno un profilo attivo da cui generare i pick.
  const active = db.prepare('SELECT COUNT(*) AS n FROM profile WHERE eliminated = 0').get() as {
    n: number;
  };
  if (active.n === 0) {
    throw new Error('Simulazione impossibile: nessun profilo attivo registrato');
  }
}

/**
 * Simula un round completo (open → pick → close → score) con il clock
 * derivato dai dati (R2): open a deadline − 1min, `receivedAt` dei pick =
 * deadline − 1min (entro l'accettazione, RF-31), close a deadline + 1min,
 * score a tcClose + 1min. Per ogni profilo SIM attivo sceglie squadra (tra
 * le disponibili, R4) ed esito col RNG; un rifiuto inatteso di `registerPick`
 * è un errore (mai silenzioso, briefing §1-B).
 */
async function simulateOneRound(
  ctx: GameContext,
  round: number,
  rng: () => number
): Promise<SimulatedRoundReport> {
  const { db, dataProvider, config } = ctx;

  // Fase 1 — open: il round si apre a deadline − 1min (R2). `openRound`
  // calcola la stessa deadline (kickoff − anticipo, RF-14): la rileggiamo dal
  // DB come fonte autorevole (stessa semantica dello scheduler, LLD §1.4).
  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = computeDeadline(kickoff, config.DEADLINE_ADVANCE_MIN);
  ctx.now = new Date(deadline.getTime() - MINUTE_MS);
  await openRound(ctx, round);

  const rs = db
    .prepare('SELECT deadline FROM round_state WHERE round = ?')
    .get(round) as { deadline: string };
  const deadlineDate = new Date(rs.deadline);

  // Fase 2 — pick: `receivedAt` = deadline − 1min per ogni profilo attivo.
  ctx.now = new Date(deadlineDate.getTime() - MINUTE_MS);
  const active = db
    .prepare('SELECT id FROM profile WHERE eliminated = 0 ORDER BY id')
    .all() as Array<{ id: number }>;
  let picks = 0;
  for (const profile of active) {
    const available = await getAvailableTeams(db, dataProvider, profile.id, round);
    if (available.length === 0) {
      throw new Error(
        `Simulazione impossibile: nessuna squadra disponibile per il profilo ${profile.id} al round ${round}`
      );
    }
    // Indici sempre in range: rng() ∈ [0, 1) → floor(rng() * n) ∈ [0, n-1].
    const team = available[Math.floor(rng() * available.length)]!;
    const outcome = OUTCOMES[Math.floor(rng() * OUTCOMES.length)]!;
    const res = await registerPick(ctx, {
      profileId: profile.id,
      round,
      team,
      outcome,
      receivedAt: ctx.now
    });
    if (!res.ok) {
      throw new Error(
        `Pick simulato rifiutato (round ${round}, profilo ${profile.id}, ${team}/${outcome}): ${res.reason}`
      );
    }
    picks += 1;
  }

  // Fase 3 — close a deadline + 1min (consolida: elimina i mancanti — nella
  // simulazione nessuno, tutti i profili attivi hanno il pick).
  ctx.now = new Date(deadlineDate.getTime() + MINUTE_MS);
  await closeRound(ctx, round);

  // Fase 4 — score a tcClose + 1min (R2); se il TC non è calcolabile
  // (nessuna partita) si usa un istante oltre la deadline (difensivo).
  const matches = await dataProvider.getMatchesForRound(round);
  const tcClose = computeTcClose(matches, config.MATCH_DURATION_MIN, config.TC_CLOSE_SKEW_MIN);
  ctx.now =
    tcClose === null
      ? new Date(deadlineDate.getTime() + 2 * MINUTE_MS)
      : new Date(tcClose.getTime() + MINUTE_MS);
  const scored = await scoreRound(ctx, round);

  const { tt, tc } = turnFor(db, round);
  return {
    round,
    tt,
    tc,
    picks,
    evaluated: scored.evaluated.length,
    frozen: scored.newlyFrozen.length,
    eliminated: scored.newlyEliminated.length,
    status: scored.status
  };
}

/**
 * Simulazione full-season (`simulate:full`, LLD §7.11): guardia R3 →
 * `startTournament` con la SEAM `allowPastDeadline` (solo qui; RF-21 su dati
 * storici richiederebbe la deadline TT1 futura) → registrazione dei profili
 * SIM (clock derivato, R2) → per ogni round della finestra `simulateOneRound`
 * → report con esito del Winner Engine.
 */
export async function simulateSeason(
  ctx: GameContext,
  opts: SimulateOptions = {}
): Promise<SimulationReport> {
  const { db, dataProvider, config } = ctx;
  const seed = opts.seed ?? 42;
  const players = opts.players ?? config.SIM_PLAYERS;
  const startRound = opts.startRound ?? 1;

  assertSimulable(db, 'simulate:full');

  // Seam di simulazione: salta RF-21 (deadline del TT 1 non futura). Mai
  // usata dai flussi reali (tournament:start CLI la lascia attiva).
  const started = await startTournament(ctx, { startRound, allowPastDeadline: true });

  // Registrazione a finestra aperta (RF-22): clock derivato dai dati per il
  // determinismo di created_at (Decisione A) — kickoff TT1 − anticipo − 2min.
  const kickoffTT1 = await dataProvider.getFirstMatchDateTime(startRound);
  const deadlineTT1 = computeDeadline(kickoffTT1, config.DEADLINE_ADVANCE_MIN);
  ctx.now = new Date(deadlineTT1.getTime() - 2 * MINUTE_MS);
  const rng = mulberry32(seed);
  registerSimPlayers(ctx, players);

  const totalRounds = await dataProvider.getTotalRounds();
  const rounds: SimulatedRoundReport[] = [];
  for (let r = startRound; r <= totalRounds; r++) {
    rounds.push(await simulateOneRound(ctx, r, rng));
  }

  return {
    startRound,
    totalRounds,
    seed,
    playersRegistered: players,
    lastRoundWarning: started.lastRoundWarning,
    rounds,
    winner: await checkWinner(ctx)
  };
}

/**
 * Simulazione di un round singolo (`simulate:round`): stessa logica del full
 * su UN round, senza `startTournament` — se la riga `tournament_state` manca
 * la finestra di iscrizione viene aperta con `openRegistration` (crea anche
 * la riga, R3/D del briefing). La guardia R3 vale identica.
 */
export async function simulateRound(
  ctx: GameContext,
  round: number,
  opts: SimulateOptions = {}
): Promise<SimulationReport> {
  const { db, dataProvider, config } = ctx;
  const seed = opts.seed ?? 42;
  const players = opts.players ?? config.SIM_PLAYERS;

  assertSimulable(db, 'simulate:round');

  // Senza tournament:start la finestra di iscrizione va aperta esplicitamente
  // (RF-22): crea anche la riga tournament_state se assente.
  const hasState = db.prepare('SELECT 1 FROM tournament_state WHERE id = 1').get() !== undefined;
  if (!hasState) await openRegistration(ctx);

  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = computeDeadline(kickoff, config.DEADLINE_ADVANCE_MIN);
  ctx.now = new Date(deadline.getTime() - 2 * MINUTE_MS);
  const rng = mulberry32(seed);
  registerSimPlayers(ctx, players);

  const totalRounds = await dataProvider.getTotalRounds();
  const rounds = [await simulateOneRound(ctx, round, rng)];
  return {
    startRound: getStartRound(db),
    totalRounds,
    seed,
    playersRegistered: players,
    lastRoundWarning: false,
    rounds,
    winner: await checkWinner(ctx)
  };
}
