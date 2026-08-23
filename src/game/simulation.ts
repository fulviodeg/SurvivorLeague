/**
 * Simulazione full-season e per-round (LLD §7.12 v0.5.0, piano Task 7.1/10;
 * decisioni R1–R4 del briefing Fase 7; ADR-009).
 *
 * Ruolo: riproduce l'intero flusso di gioco su dati storici con attori
 * sintetici, per la verifica CS3 (contabilizzazione corretta su tutta la
 * stagione) e RNF1 (determinismo: due run con stessa seed, stesso clock e DB
 * piattaforma PULITO → `tournament:export` identici). È un ORCHESTRATORE:
 * invoca esclusivamente i moduli del Game Engine esistenti
 * (`startTournament` con la seam, `openRound`, `registerPick`/`autoJoinFromPick`,
 * `closeRound`, `scoreRound`, `getAvailableTeams`, `checkWinner`) — nessuna
 * logica di gioco duplicata (AGENTS.md §1.3, ADR-004, briefing §1-B).
 *
 * Modello a due livelli (ADR-009, piano Task 10): il seed crea gli **account
 * PIATTAFORMA** sintetici (`sim-XX@survivor.test`) via `PlatformRegistry`
 * (connessione DEDICATA su `PLATFORM_DB_PATH`, mai il valore di produzione);
 * i **profili** nascono via **auto-join al primo pick** del round di avvio
 * (TT1) in `simulateOneRound`, NON più dal seed. Il determinismo di
 * `register_id` (RNF1) richiede un DB piattaforma PULITO tra due run: la
 * simulazione lo verifica e rifiuta con errore esplicito.
 *
 * Determinismo (R2/R4/RNF1): il clock di ogni fase è DERIVATO dai dati —
 * `open` a deadline − 1min, `receivedAt` dei pick = deadline − 1min, `close`
 * a deadline + 1min, `score` a tcClose + 1min — mai dall'orologio reale; la
 * registrazione degli account sim usa un istante derivato (kickoff TT1 −
 * anticipo − 2min) così anche `created_at` piattaforma è deterministico
 * (RF-P8). Il RNG è `mulberry32` (funzione pura, seed default 42);
 * l'iterazione è stabile (account ordinati per email, ORDER BY id/round).
 *
 * Il contesto NON ha channel/generator (R1): le notifiche dei moduli di
 * gioco sono no-op (round-manager.ts) — nessuna email reale in simulazione.
 */
import type Database from 'better-sqlite3';

import type { GameContext } from './context.js';
import { autoJoinFromPick } from './registration.js';
import { registerPick } from './pick-processor.js';
import { getAvailableTeams } from './rules.js';
import { closeRound, openRound, scoreRound } from './round-manager.js';
import { computeDeadline, computeTcClose } from './round-time.js';
import { startTournament } from './tournament.js';
import { getStartRound, turnFor } from './turn.js';
import { checkWinner } from './winner.js';

const MINUTE_MS = 60_000;

/** Esiti validi generati dai pick simulati (stessi valori della cascata). */
const OUTCOMES = ['win', 'draw', 'lose'] as const;

/** Email dei profili sintetici (deterministiche, ordinate per numero). */
function simEmail(index: number): string {
  return `sim-${String(index).padStart(2, '0')}@survivor.test`;
}

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

/** Opzioni di una simulazione (seed e numero di account sim opzionali). */
export interface SimulateOptions {
  /** Seed del RNG mulberry32 (default 42, R4). */
  seed?: number;
  /** Numero di account sintetici da registrare (default `config.SIM_PLAYERS`). */
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
  /** Partecipanti per cui è stato registrato un pick (auto-join inclusi). */
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

/**
 * Guardia DB piattaforma pulito (ADR-009, RNF1): la simulazione richiede un
 * DB piattaforma SENZA account — i `register_id` devono essere deterministici
 * (sequenza 1..N) e un DB sporco li farebbe slittare. Rifiuta con errore
 * esplicito (nessuna cancellazione automatica: il cleanup è un comando
 * esplicito dell'operatore).
 */
function assertPlatformClean(ctx: GameContext, command: string): void {
  if (ctx.platform === undefined) {
    throw new Error(
      `${command}: manca il PlatformRegistry nel contesto — inietta un DB piattaforma DEDICATO (PLATFORM_DB_PATH distinto dal valore di produzione)`
    );
  }
  const accounts = ctx.platform.list();
  if (accounts.length > 0) {
    throw new Error(
      `${command}: il DB piattaforma non è pulito (${accounts.length} account) — la simulazione richiede un DB piattaforma vuoto per il determinismo di register_id (RNF1); cancellalo esplicitamente tra due run`
    );
  }
}

/**
 * Registra gli ACCOUNT sintetici sulla PIATTAFORMA (`sim-XX@survivor.test`)
 * via PlatformRegistry (ADR-009): NESSUN profilo torneo — i profili nascono
 * per auto-join al primo pick del round di avvio (RF-P5). Restituisce le
 * email in ordine deterministico. `now` è il clock derivato (kickoff TT1 −
 * anticipo − 2min, R2) così `created_at` piattaforma è deterministico (RF-P8).
 */
function registerSimAccounts(ctx: GameContext, count: number, now: Date): string[] {
  const platform = ctx.platform;
  if (platform === undefined) {
    throw new Error('Simulazione impossibile: PlatformRegistry assente dal contesto (ADR-009)');
  }
  const emails: string[] = [];
  for (let i = 1; i <= count; i++) {
    const email = simEmail(i);
    // Nome sintetico deterministico (ADR-011): "Sim <N>" → "Sim-01", ecc.
    platform.register(email, `Sim-${String(i).padStart(2, '0')}`, now);
    emails.push(email);
  }
  return emails;
}

/**
 * Simula un round completo (open → pick → close → score) con il clock
 * derivato dai dati (R2): open a deadline − 1min, `receivedAt` dei pick =
 * deadline − 1min (entro l'accettazione, RF-31), close a deadline + 1min,
 * score a tcClose + 1min.
 *
 * Pick fase (ADR-009): nel round di AVVIO (TT1, round = start_round) i
 * profili non esistono ancora — ogni account sim senza profilo fa AUTO-JOIN
 * (profilo + pick atomici, RF-P5); nei round successivi iterano i profili
 * attivi come prima. Un rifiuto inatteso è un errore (mai silenzioso,
 * briefing §1-B).
 */
async function simulateOneRound(
  ctx: GameContext,
  round: number,
  rng: () => number,
  simEmails: string[]
): Promise<SimulatedRoundReport> {
  const { db, dataProvider, config } = ctx;
  const startRound = getStartRound(db);

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

  // Fase 2 — pick: `receivedAt` = deadline − 1min per ogni partecipante.
  ctx.now = new Date(deadlineDate.getTime() - MINUTE_MS);
  let picks = 0;

  if (round === startRound) {
    // TT1: auto-join per ogni account sim (profilo + pick atomici, RF-P5).
    const matches = await dataProvider.getMatchesForRound(round);
    const roundTeams = [...new Set(matches.flatMap((m) => [m.homeTeam, m.awayTeam]))].sort();
    if (roundTeams.length === 0) {
      throw new Error(`Simulazione impossibile: nessuna squadra in calendario per il round ${round}`);
    }
    for (const email of simEmails) {
      const hasProfile = db
        .prepare(
          `SELECT 1 FROM profile p JOIN player pl ON pl.id = p.player_id WHERE pl.email = ?`
        )
        .get(email);
      if (hasProfile !== undefined) continue;
      const team = roundTeams[Math.floor(rng() * roundTeams.length)]!;
      const outcome = OUTCOMES[Math.floor(rng() * OUTCOMES.length)]!;
      const joined = await autoJoinFromPick(
        ctx,
        { channel: 'email', identifier: email },
        { team, outcome },
        round,
        ctx.now
      );
      if (!joined.ok) {
        throw new Error(
          `Auto-join simulato rifiutato (round ${round}, ${email}, ${team}/${outcome}): ${joined.reason}${
            joined.reason === 'pick_rejected' ? ` (${joined.pickReason ?? '?'})` : ''
          }`
        );
      }
      picks += 1;
    }
  } else {
    // Dal TT2: cascata attuale sui profili attivi.
    const active = db
      .prepare('SELECT id FROM profile WHERE eliminated = 0 ORDER BY id')
      .all() as Array<{ id: number }>;
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
  }

  // Fase 3 — close a deadline + 1min (consolida: elimina i mancanti).
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
 * Simulazione full-season (`simulate:full`, LLD §7.12): guardie R3 + DB
 * piattaforma pulito → `startTournament` con la SEAM `allowPastDeadline`
 * (solo qui; RF-21 su dati storici richiederebbe la deadline TT1 futura) →
 * registrazione degli ACCOUNT piattaforma sim (clock derivato, R2/RF-P8) →
 * per ogni round della finestra `simulateOneRound` (auto-join al TT1) →
 * report con esito del Winner Engine.
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
  assertPlatformClean(ctx, 'simulate:full');

  // Dry-run (R1, ADR-011 §5.5): la simulazione riproduce l'intera stagione
  // SENZA la chiusura automatica del torneo (nessun winner_notified/export/
  // inibizione scheduler): il vincitore è riportato a fine run da
  // `checkWinner` (sola lettura). Con l'auto-close attivo un caso-1 precoce
  // fermerebbe la stagione simulata (e `round:open` rifiuterebbe i round
  // successivi), vanificando CS3 ("contabilizzazione su tutta la stagione").
  ctx.autoClose = false;

  // Seam di simulazione: salta RF-21 (deadline del TT 1 non futura). Mai
  // usata dai flussi reali (tournament:start CLI la lascia attiva).
  const started = await startTournament(ctx, { startRound, allowPastDeadline: true });

  // Registrazione account a clock derivato dai dati per il determinismo di
  // created_at (RF-P8) — kickoff TT1 − anticipo − 2min.
  const kickoffTT1 = await dataProvider.getFirstMatchDateTime(startRound);
  const deadlineTT1 = computeDeadline(kickoffTT1, config.DEADLINE_ADVANCE_MIN);
  ctx.now = new Date(deadlineTT1.getTime() - 2 * MINUTE_MS);
  const rng = mulberry32(seed);
  const simEmails = registerSimAccounts(ctx, players, ctx.now);

  const totalRounds = await dataProvider.getTotalRounds();
  const rounds: SimulatedRoundReport[] = [];
  for (let r = startRound; r <= totalRounds; r++) {
    rounds.push(await simulateOneRound(ctx, r, rng, simEmails));
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
 * su UN round, senza `startTournament` — la riga `tournament_state` viene
 * creata/allineata con `start_round = round` (l'auto-join richiede che il
 * round simulato SIA il TT1, RF-P5). Le guardie R3 e DB piattaforma pulito
 * valgono identiche.
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
  assertPlatformClean(ctx, 'simulate:round');

  // Dry-run (R1, ADR-011 §5.5): nessuna chiusura automatica (vedi
  // simulateSeason) — il vincitore è riportato da `checkWinner` a fine run.
  ctx.autoClose = false;

  // Allinea start_round al round simulato (RF-P5: auto-join = TT1); crea la
  // riga tournament_state se assente (pattern storico openRegistration, R3/D).
  db.prepare(
    `INSERT INTO tournament_state (id, start_round) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET start_round = excluded.start_round`
  ).run(round);

  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = computeDeadline(kickoff, config.DEADLINE_ADVANCE_MIN);
  ctx.now = new Date(deadline.getTime() - 2 * MINUTE_MS);
  const rng = mulberry32(seed);
  const simEmails = registerSimAccounts(ctx, players, ctx.now);

  const totalRounds = await dataProvider.getTotalRounds();
  const rounds = [await simulateOneRound(ctx, round, rng, simEmails)];
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
