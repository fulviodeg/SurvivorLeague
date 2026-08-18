/**
 * Registrazione e auto-iscrizione (LLD §7.10, PRD US7/US8; piano Task 4.2).
 *
 * Ruolo: fase di iscrizione del torneo e auto-iscrizione RF-27.
 *
 * - `tournament:register` (manuale, US8): registra un giocatore con univocità
 *   email/profilo (UNIQUE player.email e profile.player_id, RNF2); invoca il
 *   gate `checkEligibility` (ADR-008 n. 8, esito loggato dal chiamante). A
 *   finestra CHIUSA è l'unico ingresso e richiede `--reason` (override US10,
 *   audit obbligatorio). Un nuovo iscritto parte dal round corrente con pool
 *   intatto (fairness dichiarata, ADR-008 n. 1).
 * - `tournament:register:open` (US7): apre la finestra (`registration_open=1`);
 *   con `--contacts` invia la notifica best-effort UNA SOLA volta
 *   (`registration_notified`, template `registration_open_invite`).
 * - `tournament:register:close` (RF-28): chiude la finestra; senza `--reason`
 *   = chiusura automatica alla deadline del TT 1 (RF-22) o di sicurezza; con
 *   `--reason` = chiusura forzata anticipata, auditata. NON chiude la finestra
 *   di pick del TT 1 (finestre indipendenti, LLD §7.10).
 * - auto-iscrizione RF-27 (mittente sconosciuto, TT 1): un pick interpretabile
 *   crea profilo + pick in un'unica operazione ATOMICA; contenuto non
 *   interpretabile → nessun profilo (CL5); dal TT 2 → rifiuto senza
 *   registrazione (RF-24).
 *
 * Atomicità: profilo+pick con BEGIN/COMMIT/ROLLBACK manuale (la validazione
 * del pick è async e deve vedere il nuovo profilo). Su pick rifiutato o errore
 * → ROLLBACK: nessun profilo orfano.
 */
import type Database from 'better-sqlite3';

import { subjectFor, type EmailContext } from '../llm/generator.js';
import type { PickExtraction } from '../llm/parser.js';
import type { GameContext } from './context.js';
import { checkEligibility, type EligibilityResult, type ExternalIdentity } from './eligibility.js';
import { insertPendingPick, validatePick } from './pick-processor.js';
import { getStartRound } from './turn.js';

/** Opzioni della registrazione manuale (`tournament:register`). */
export interface RegisterPlayerOptions {
  /** Indirizzo email del giocatore (univoco, RNF2). */
  email: string;
  /** Nome del giocatore (opzionale, per le email). */
  name?: string;
  /**
   * Motivo auditato dell'override US10: OBBLIGATORIO a finestra chiusa
   * (unico ingresso manuale); opzionale a finestra aperta.
   */
  reason?: string;
  /** Identità normalizzata dal canale (default: `{channel:'email', identifier: email}`). */
  identity?: ExternalIdentity;
}

/** Esito della registrazione manuale. */
export type RegisterPlayerResult =
  | { ok: true; profileId: number; eligibility: EligibilityResult }
  | {
      ok: false;
      reason: 'not_eligible' | 'email_already_registered' | 'registration_closed';
      eligibility: EligibilityResult;
    };

/** Esito di `tournament:register:open`. */
export interface OpenRegistrationResult {
  opened: boolean;
  /** Contatti notificati con l'invito (0 se nessuna lista o già notificati). */
  notified: number;
}

/** Esito di `tournament:register:close`. */
export interface CloseRegistrationResult {
  closed: boolean;
  /** true se chiusura forzata con motivo auditato (RF-28). */
  forced: boolean;
  reason?: string;
}

/**
 * Contenuto interpretato di un pick dal mittente sconosciuto (RF-27).
 * Ri-export del tipo unico `PickExtraction` (src/llm/parser.ts, D2): il tipo
 * è definito UNA volta nel confine LLM e riusato qui (nessun duplicato).
 */
export type ParsedPickContent = PickExtraction;

/** Esito dell'auto-iscrizione (RF-27). */
export type AutoRegisterResult =
  | { ok: true; profileId: number; pickId: number }
  | {
      ok: false;
      reason:
        | 'not_interpretable' // CL5: nessun profilo creato
        | 'not_tt1' // RF-24: dal TT 2 nessuna registrazione
        | 'window_closed' // finestra chiusa
        | 'not_eligible' // gate eligibilità
        | 'already_registered' // il mittente ha già un profilo (router errato)
        | 'pick_rejected'; // il pick non passa la cascata (nessun profilo)
      /** Motivo della cascata quando reason = 'pick_rejected'. */
      pickReason?: string;
    };

/** Stato registrato del torneo (finestra e aggancio). */
function getTournamentState(db: Database.Database): {
  season_started: number;
  registration_open: number;
  registration_notified: number;
  start_round: number | null;
} | undefined {
  return db
    .prepare(
      `SELECT season_started, registration_open, registration_notified, start_round
       FROM tournament_state WHERE id = 1`
    )
    .get() as
    | {
        season_started: number;
        registration_open: number;
        registration_notified: number;
        start_round: number | null;
      }
    | undefined;
}

/** Il giocatore esiste già (univocità email, RNF2). */
function playerExists(db: Database.Database, email: string): boolean {
  return db.prepare('SELECT 1 FROM player WHERE email = ?').get(email) !== undefined;
}

/**
 * Registra manualmente un giocatore (US8): eligibilità → gate finestra (override
 * US10 con `--reason` a finestra chiusa) → univocità → inserimento atomico
 * player+profile. L'esito di eligibilità è esposto perché il chiamante lo logga.
 */
export function registerPlayer(
  ctx: GameContext,
  opts: RegisterPlayerOptions
): RegisterPlayerResult {
  const { db, now } = ctx;
  const identity: ExternalIdentity =
    opts.identity ?? { channel: 'email', identifier: opts.email };

  const state = getTournamentState(db);
  const windowOpen = state?.registration_open === 1;

  // Gate finestra: a finestra chiusa serve l'override US10 (motivo obbligatorio).
  if (!windowOpen && (opts.reason === undefined || opts.reason.trim() === '')) {
    return {
      ok: false,
      reason: 'registration_closed',
      eligibility: { eligible: false, reason: 'window_closed: serve --reason (override US10)' }
    };
  }

  const eligibility = checkEligibility(identity, {
    forceEligible: !windowOpen,
    reason: opts.reason
  });
  if (!eligibility.eligible) {
    return { ok: false, reason: 'not_eligible', eligibility };
  }

  if (playerExists(db, opts.email)) {
    return {
      ok: false,
      reason: 'email_already_registered',
      eligibility
    };
  }

  // created_at esplicito dal clock iniettato (Decisione A, RNF1): mai il
  // default datetime('now') di SQLite, che romperebbe il determinismo.
  const profileId = db.transaction(() => {
    const playerId = db
      .prepare('INSERT INTO player (email, name, created_at) VALUES (?, ?, ?)')
      .run(opts.email, opts.name ?? null, now.toISOString()).lastInsertRowid as number;
    return db
      .prepare('INSERT INTO profile (player_id, created_at) VALUES (?, ?)')
      .run(playerId, now.toISOString()).lastInsertRowid as number;
  })();

  return { ok: true, profileId, eligibility };
}

/**
 * Apre la finestra di iscrizione (US7): `registration_open=1`; con `--contacts`
 * invia l'invito best-effort UNA SOLA volta (`registration_notified`).
 */
export async function openRegistration(
  ctx: GameContext,
  opts: { contacts?: string[] } = {}
): Promise<OpenRegistrationResult> {
  const { db, channel, generator } = ctx;
  const state = getTournamentState(db);

  const wasOpen = state?.registration_open === 1;
  const alreadyNotified = state?.registration_notified === 1;

  db.prepare(
    `INSERT INTO tournament_state (id, registration_open, registration_notified)
     VALUES (1, 1, 0)
     ON CONFLICT(id) DO UPDATE SET registration_open = 1`
  ).run();

  let notified = 0;
  const contacts = opts.contacts ?? [];
  if (!alreadyNotified && contacts.length > 0 && channel !== undefined && generator !== undefined) {
    for (const to of contacts) {
      const emailCtx: EmailContext = { type: 'registration_open_invite' };
      const body = await generator.generate(emailCtx);
      // Soggetto deterministico (D1): etichetta + forma compatta TT2TC7 (RF-25).
      await channel.sendMessage(to, body, subjectFor(emailCtx));
      notified += 1;
    }
    db.prepare('UPDATE tournament_state SET registration_notified = 1 WHERE id = 1').run();
  }

  return { opened: !wasOpen, notified };
}

/**
 * Chiude la finestra di iscrizione (RF-28): `registration_open=0`. Senza
 * `--reason` = chiusura automatica (RF-22, deadline TT 1 / sicurezza); con
 * `--reason` = chiusura forzata auditata. Non tocca la finestra di pick del
 * TT 1 (finestre indipendenti). Idempotente.
 */
export function closeRegistration(
  ctx: GameContext,
  opts: { reason?: string } = {}
): CloseRegistrationResult {
  const { db } = ctx;
  const state = getTournamentState(db);
  const wasOpen = state?.registration_open === 1;

  db.prepare('UPDATE tournament_state SET registration_open = 0 WHERE id = 1').run();

  return {
    closed: wasOpen,
    forced: opts.reason !== undefined && opts.reason.trim() !== '',
    reason: opts.reason
  };
}

/**
 * Auto-iscrizione RF-27 (mittente sconosciuto nel TT 1): pick interpretabile →
 * profilo + pick ATOMICI (BEGIN/COMMIT/ROLLBACK: la validazione del pick vede
 * il nuovo profilo; su rifiuto o errore nessun profilo orfano). Non
 * interpretabile → nessun profilo (CL5). Dal TT 2 → rifiuto senza registrazione
 * (RF-24). Il mittente già registrato è un errore del router (difensivo).
 */
export async function autoRegisterFromPick(
  ctx: GameContext,
  identity: ExternalIdentity,
  parsed: ParsedPickContent | null,
  round: number,
  receivedAt: Date
): Promise<AutoRegisterResult> {
  const { db, now } = ctx;

  // CL5: contenuto non interpretabile → chiarimento senza registrazione.
  if (parsed === null) return { ok: false, reason: 'not_interpretable' };

  // RF-24: l'auto-iscrizione vale SOLO nel TT 1 (TC = start_round).
  const startRound = getStartRound(db);
  if (round !== startRound) return { ok: false, reason: 'not_tt1' };

  const state = getTournamentState(db);
  if (state?.registration_open !== 1) return { ok: false, reason: 'window_closed' };

  const eligibility = checkEligibility(identity);
  if (!eligibility.eligible) return { ok: false, reason: 'not_eligible' };

  if (playerExists(db, identity.identifier)) {
    return { ok: false, reason: 'already_registered' };
  }

  // Profilo + pick atomici: BEGIN ... COMMIT / ROLLBACK (validazione async).
  // created_at esplicito dal clock iniettato (Decisione A, RNF1).
  db.prepare('BEGIN').run();
  try {
    const playerId = db
      .prepare('INSERT INTO player (email, name, created_at) VALUES (?, ?, ?)')
      .run(identity.identifier, null, now.toISOString()).lastInsertRowid as number;
    const profileId = db
      .prepare('INSERT INTO profile (player_id, created_at) VALUES (?, ?)')
      .run(playerId, now.toISOString()).lastInsertRowid as number;

    const validation = await validatePick(ctx, {
      profileId,
      round,
      team: parsed.team,
      outcome: parsed.outcome,
      receivedAt
    });
    if (!validation.valid) {
      db.prepare('ROLLBACK').run();
      return { ok: false, reason: 'pick_rejected', pickReason: validation.reason };
    }

    let pickId: number;
    try {
      pickId = insertPendingPick(
        db,
        profileId,
        round,
        parsed.team,
        parsed.outcome,
        now.toISOString()
      );
    } catch {
      db.prepare('ROLLBACK').run();
      return { ok: false, reason: 'pick_rejected', pickReason: 'pick_already_exists' };
    }

    db.prepare('COMMIT').run();
    return { ok: true, profileId, pickId };
  } catch (error) {
    db.prepare('ROLLBACK').run();
    throw error;
  }
}
