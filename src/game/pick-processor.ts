/**
 * Pick Processor (LLD §7.4, §3.1; piano Task 3.2) — validazione e registrazione pick.
 *
 * Ruolo: valida un pick con la CASCATA di regole (LLD §3.1) con motivo dedicato
 * e registra atomicamente sulla tabella `pick`. È il modulo a cui delegano il
 * Round Manager (Task 3.5) e l'auto-join (RF-P5, ADR-009): stesse regole per
 * pick automatici e manuali (decisione 9 del piano, US10).
 *
 * La cascata (ordine = base dei messaggi di risposta, briefing §1-F):
 *   1. registrazione/attivo  → profile_not_registered | profile_eliminated
 *   2. squadra canonica      → unknown_team (check esatto post-parse, CL5)
 *   3. squadra nel TC        → team_not_in_round (CL4)
 *   4. non bruciata nel girone → team_already_used (RF-10/CS5)
 *   5. esito valido          → invalid_outcome (win|draw|lose)
 *   6. non già pick          → pick_already_exists (CL6, RF-08)
 *   7. accettazione temporale → round_not_open (CL3) | after_acceptance (CS4)
 *                            | after_kickoff (guard anti-frode RF-31, CL17/CL18)
 *
 * Guard anti-frode RF-31 (briefing §1-B/§3.3): il Processor riceve ENTRAMBE le
 * sorgenti temporali — `round_state.deadline` (fissa, RF-14) e il kickoff
 * EFFETTIVO letto dai dati correnti dal provider (può anticipare, CL18).
 * Accettazione = min(deadline registrata ?? +∞, kickoff effettivo ?? +∞).
 * Con deadline NULL vale solo il kickoff (CL17); con calendario anticipato il
 * guard prevale su RF-14 (CL18). Non esiste un singolo "deadline" derivato.
 *
 * Override US10 (briefing §1-G/§3.4): `opts.reason` bypassa SOLO i check
 * temporali (after_acceptance/after_kickoff); squadra bruciata, squadra non in
 * giornata, esito errato e pick già esistente restano SEMPRE attivi.
 *
 * Atomicità al write (CS2/CL6/RNF2): il vincolo UNIQUE(profile_id, round)
 * dell'DB è il livello di scrittura — su violazione (invii concorrenti) il
 * processo traduce in motivo `pick_already_exists`, mai crash.
 */
import type Database from 'better-sqlite3';

import { isBurned } from './rules.js';
import type { PickRejectReason, PickValidation } from './errors.js';
import type { GameContext } from './context.js';

/** Esiti validi di un pick (LLD §7.4): win | draw | lose. */
const VALID_OUTCOMES = ['win', 'draw', 'lose'] as const;

/** Input di un pick da validare/registrare (briefing §3.1: receivedAt dal chiamante). */
export interface PickInput {
  /** ID del profilo del giocatore (deve esistere e non essere eliminato). */
  profileId: number;
  /** Turno di campionato (TC) per cui si invia il pick. */
  round: number;
  /** Nome canonico della squadra (exact-match sulla lista del provider). */
  team: string;
  /** Esito previsto: win | draw | lose. */
  outcome: string;
  /** Timestamp di RICEZIONE sul server (ADR-001) — mai l'header Date. */
  receivedAt: Date;
}

/** Opzioni di registro: `reason` = override US10 per i soli check temporali. */
export interface PickRegisterOptions {
  /**
   * Motivo auditato dell'override del commissioner (obbligatorio fuori
   * accettazione); bypassa SOLO after_acceptance/after_kickoff.
   */
  reason?: string;
}

/** Esito della registrazione: successo con id oppure rifiuto con motivo. */
export type RegisterPickResult =
  | { ok: true; id: number; status: string }
  | { ok: false; reason: PickRejectReason };

/** Il pick è ancora in attesa di risultato (stato iniziale alla registrazione). */
export const PICK_STATUS_PENDING = 'pending';

/**
 * Valida un pick secondo la cascata di LLD §3.1, SENZA scrivere nulla.
 * I dati stagione (squadre, partite, totale round) sono letti in parallelo; le
 * regole sono poi applicate in ordine e il primo motivo scattato è il risultato.
 */
export async function validatePick(
  ctx: GameContext,
  input: PickInput
): Promise<PickValidation> {
  const { db, dataProvider } = ctx;

  // 1. Registrazione/attivo: il profilo esiste ed è in gara.
  const profile = db
    .prepare('SELECT id, eliminated FROM profile WHERE id = ?')
    .get(input.profileId) as { id: number; eliminated: number } | undefined;
  if (profile === undefined) return { valid: false, reason: 'profile_not_registered' };
  if (profile.eliminated === 1) return { valid: false, reason: 'profile_eliminated' };

  const [teams, matches, totalRounds] = await Promise.all([
    dataProvider.getTeams(),
    dataProvider.getMatchesForRound(input.round),
    dataProvider.getTotalRounds()
  ]);

  // 2. Squadra canonica: exact-match sulla lista del provider (CL5, decisione 5).
  if (!teams.includes(input.team)) return { valid: false, reason: 'unknown_team' };

  // 3. Squadra in partita nel TC (CL4): deve giocare in questo round.
  const inRound = matches.some((m) => m.homeTeam === input.team || m.awayTeam === input.team);
  if (!inRound) return { valid: false, reason: 'team_not_in_round' };

  // 4. Non bruciata nel girone di `round` (RF-10/CS5; i frozen contano, LLD §1.1).
  if (isBurned(db, input.profileId, input.team, input.round, totalRounds)) {
    return { valid: false, reason: 'team_already_used' };
  }

  // 5. Esito valido (fuori win|draw|lose → rifiuto).
  if (!(VALID_OUTCOMES as readonly string[]).includes(input.outcome)) {
    return { valid: false, reason: 'invalid_outcome' };
  }

  // 6. Non esiste già un pick per profilo+round (RF-08). Il vincolo è anche al
  // write (CS2/CL6): qui il controllo è solo per la cascata/messaggio.
  const existing = db
    .prepare('SELECT id FROM pick WHERE profile_id = ? AND round = ?')
    .get(input.profileId, input.round);
  if (existing !== undefined) {
    return { valid: false, reason: 'pick_already_exists' };
  }

  // 7. Accettazione temporale (round aperto, deadline, guard RF-31).
  return checkAcceptance(ctx, input);
}

/**
 * Accettazione temporale (passo 7 della cascata): round_state aperto, poi
 * receivedAt <= min(deadline registrata ?? +∞, kickoff effettivo ?? +∞).
 * Rifiuti: round_not_open (CL3), after_acceptance (CS4), after_kickoff (RF-31).
 */
export async function checkAcceptance(
  ctx: GameContext,
  input: PickInput
): Promise<PickValidation> {
  const { db, dataProvider } = ctx;

  const roundState = db
    .prepare('SELECT status, deadline FROM round_state WHERE round = ?')
    .get(input.round) as { status: string; deadline: string | null } | undefined;
  if (roundState === undefined || roundState.status !== 'open') {
    return { valid: false, reason: 'round_not_open' };
  }

  // Guard anti-frode RF-31: kickoff EFFETTIVO dai dati correnti (può anticipare
  // rispetto alla deadline registrata, CL18). Se non calcolabile (round senza
  // partite) resta il solo gate deadline; il caso è coperto dalla chiusura di
  // sicurezza RF-30 nello scheduler.
  let kickoff: Date | null = null;
  try {
    kickoff = await dataProvider.getFirstMatchDateTime(input.round);
  } catch {
    kickoff = null;
  }
  const deadline = roundState.deadline === null ? null : new Date(roundState.deadline);
  const receivedAt = input.receivedAt;

  if (kickoff !== null && receivedAt > kickoff) return { valid: false, reason: 'after_kickoff' };
  if (deadline !== null && receivedAt > deadline) {
    return { valid: false, reason: 'after_acceptance' };
  }
  return { valid: true };
}

/**
 * Inserimento ATOMICO della riga pick (stato pending) — usato da registerPick e
 * dall'auto-join RF-P5 (profilo+pick in un'unica transazione, ADR-009).
 * Rilanciata la violazione UNIQUE: il chiamante decide la semantica (motivo).
 *
 * `createdAt` (ISO-8601) è scritto esplicitamente dal chiamante (= clock
 * iniettato del contesto, Decisione A del briefing Fase 7): mai il default
 * `datetime('now')` di SQLite, che renderebbe non deterministici due export
 * della stessa simulazione (RNF1).
 */
export function insertPendingPick(
  db: Database.Database,
  profileId: number,
  round: number,
  team: string,
  outcome: string,
  createdAt: string
): number {
  const info = db
    .prepare(
      'INSERT INTO pick (profile_id, round, team, outcome, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(profileId, round, team, outcome, PICK_STATUS_PENDING, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * Registra un pick: valida SEMPRE (stesse regole dei pick automatici, decisione
 * 9) e, se valido o coperto dall'override temporale, inserisce atomicamente.
 * Su violazione UNIQUE (invii concorrenti) → motivo pick_already_exists.
 */
export async function registerPick(
  ctx: GameContext,
  input: PickInput,
  opts: PickRegisterOptions = {}
): Promise<RegisterPickResult> {
  const { db, now } = ctx;

  const check = await validatePick(ctx, input);
  if (!check.valid && !overrideAllows(check.reason, opts.reason)) {
    return { ok: false, reason: check.reason as PickRejectReason };
  }

  try {
    const id = insertPendingPick(
      db,
      input.profileId,
      input.round,
      input.team,
      input.outcome,
      now.toISOString()
    );
    return { ok: true, id, status: PICK_STATUS_PENDING };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'pick_already_exists' };
    throw error;
  }
}

/**
 * L'override US10 con motivo bypassa SOLO i check temporali
 * (after_acceptance/after_kickoff); tutto il resto della cascata resta attivo.
 */
function overrideAllows(reason: PickRejectReason | undefined, overrideReason?: string): boolean {
  if (overrideReason === undefined) return false;
  return reason === 'after_acceptance' || reason === 'after_kickoff';
}

/** Rileva una violazione UNIQUE(profile_id, round) come motivo, mai crash. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE');
}

/** Una riga pick per l'output (pick:list, tournament:history). */
export interface PickRecord {
  id: number;
  profileId: number;
  round: number;
  team: string;
  outcome: string;
  status: string;
  createdAt: string;
  /** Email del giocatore (join su player) per l'output leggibile. */
  email: string;
}

/**
 * Lista pick (sola lettura, idempotente) con filtri opzionali `round`
 * e/o `profileId` (LLD §7.4). Ordinata per round e profilo (determinismo).
 */
export function listPicks(
  db: Database.Database,
  filters: { round?: number; profileId?: number } = {}
): PickRecord[] {
  const clauses: string[] = [];
  const params: Array<number> = [];
  if (filters.round !== undefined) {
    clauses.push('p.round = ?');
    params.push(filters.round);
  }
  if (filters.profileId !== undefined) {
    clauses.push('p.profile_id = ?');
    params.push(filters.profileId);
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT p.id, p.profile_id, p.round, p.team, p.outcome, p.status, p.created_at,
              COALESCE(pl.email, '') AS email
       FROM pick p
       LEFT JOIN profile pr ON pr.id = p.profile_id
       LEFT JOIN player pl ON pl.id = pr.player_id
       ${where}
       ORDER BY p.round, p.profile_id, p.id`
    )
    .all(...params) as unknown as Array<{
    id: number;
    profile_id: number;
    round: number;
    team: string;
    outcome: string;
    status: string;
    created_at: string;
    email: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    round: r.round,
    team: r.team,
    outcome: r.outcome,
    status: r.status,
    createdAt: r.created_at,
    email: r.email
  }));
}
