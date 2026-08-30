/**
 * Registrazione e auto-join (LLD §7.10-7.11 v0.5.0, PRD US1/US7/US8/RF-P5;
 * piano Task 7/10, ADR-009).
 *
 * Ruolo: `autoJoinFromPick` (RF-P5) è l'UNICO ingresso nel torneo — un
 * iscritto SENZA profilo che invia un pick valido nel TT 1 (round =
 * start_round, round aperto, pick che passa l'accettazione RF-31) crea
 * profilo + pick in un'unica operazione ATOMICA; pick invalido → rollback,
 * nessun profilo; la risposta è `pick_confirmed` (nessuna conferma di
 * iscrizione separata). Il gate di eligibilità è "account piattaforma
 * `active`" (ADR-009, lettura dal registry iniettato). `register_id` è
 * replicato su player/profile.
 *
 * Dati legacy (decisione 2 "nessuna migrazione"): un `player` preesistente
 * SENZA `profile` (es. riga legacy con `register_id` NULL) NON blocca
 * l'auto-join — la transazione RIUSA il `player_id` esistente (UNIQUE email
 * mai violato), fa backfill di `register_id` se NULL e crea SOLO il profilo
 * (decisione (g)/B7).
 *
 * RIMOSSI nel Task 10 (ADR-009): `registerPlayer`/`openRegistration`/
 * `closeRegistration`/`autoRegisterFromPick` — non esiste più alcuna finestra
 * di iscrizione da aprire/chiudere e `platform:register` è l'unico comando di
 * creazione account (NON crea profili); i profili nascono solo per auto-join.
 *
 * Atomicità: profilo+pick con BEGIN/COMMIT/ROLLBACK manuale (la validazione
 * del pick è async e deve vedere il nuovo profilo). Su pick rifiutato o errore
 * → ROLLBACK: nessun profilo orfano.
 */
import type { PickExtraction } from '../llm/parser.js';
import type { GameContext } from './context.js';
import { checkEligibility, type ExternalIdentity } from './eligibility.js';
import { insertPendingPick, validatePick } from './pick-processor.js';
import { getStartRound } from './turn.js';

/**
 * Contenuto interpretato di un pick dall'iscritto senza profilo (RF-P5).
 * Ri-export del tipo unico `PickExtraction` (src/llm/parser.ts, D2): il tipo
 * è definito UNA volta nel confine LLM e riusato qui (nessun duplicato).
 */
export type ParsedPickContent = PickExtraction;

/** Esito dell'auto-join (RF-P5, ADR-009). */
export type AutoJoinResult =
  | { ok: true; profileId: number; pickId: number }
  | {
      ok: false;
      reason:
        | 'not_interpretable' // CL5: nessun profilo creato
        | 'not_tt1' // RF-P5: l'auto-join vale SOLO nel TT 1
        | 'round_not_open' // RF-P5: serve un round aperto
        | 'not_eligible' // gate eligibilità: account non active (ADR-009)
        | 'already_registered' // profilo già esistente (solo caso difensivo, corsa concorrente: il wiring instrada il profilo esistente altrove)
        | 'pick_rejected'; // il pick non passa la cascata (nessun profilo)
      /** Motivo della cascata quando reason = 'pick_rejected'. */
      pickReason?: string;
    };

/**
 * Auto-join RF-P5 (ADR-009, piano Task 7): un ISCRITTO alla piattaforma
 * (`active`) SENZA profilo che invia un pick valido nel TT 1 (round =
 * start_round, round APERTO, pick che passa la cascata RF-31) crea profilo +
 * pick in un'unica transazione sul DB torneo, con `register_id` REPLICATO
 * dall'account (RF-P7). Pick invalido → ROLLBACK, nessun profilo orfano. Non
 * esiste più il gate `registration_open`: la partecipazione è gated dalla
 * deadline del TT1 via cascata. La risposta (nel wiring) è `pick_confirmed`.
 *
 * Dati legacy (decisione (g)/B7, decisione 2 "nessuna migrazione"): se per
 * l'email esiste GIÀ una riga `player` senza `profile` (es. riga legacy con
 * `register_id` NULL), la transazione RIUSA il `player_id` esistente
 * (UNIQUE email mai violato: nessun INSERT su player), fa BACKFILL di
 * `register_id` con `account.registerId` se NULL e crea SOLO il profilo; se
 * il player non esiste, comportamento storico (INSERT player + profile).
 * `already_registered` resta solo per il caso difensivo di profilo GIÀ
 * esistente (raggiungibile solo in corsa concorrente: il wiring instrada il
 * profilo esistente altrove e qui non arriva).
 */
export async function autoJoinFromPick(
  ctx: GameContext,
  identity: ExternalIdentity,
  parsed: ParsedPickContent | null,
  round: number,
  receivedAt: Date
): Promise<AutoJoinResult> {
  const { db, now, config } = ctx;

  // CL5: contenuto non interpretabile → chiarimento senza profilo.
  if (parsed === null) return { ok: false, reason: 'not_interpretable' };

  // RF-P5: l'auto-join vale SOLO nel TT 1 (TC = start_round).
  const startRound = getStartRound(db);
  if (round !== startRound) return { ok: false, reason: 'not_tt1' };

  // RF-P5: serve un round APERTO (il pick verrebbe comunque rifiutato dalla
  // cascata, ma decidiamo PRIMA di creare il profilo).
  const roundState = db
    .prepare('SELECT status FROM round_state WHERE round = ?')
    .get(round) as { status: string } | undefined;
  if (roundState === undefined || roundState.status !== 'open') {
    return { ok: false, reason: 'round_not_open' };
  }

  // Gate eligibilità (ADR-009): account piattaforma `active` (SOLA LETTURA
  // dal registry iniettato, nessuna scrittura cross-DB).
  const eligibility = checkEligibility(ctx, identity);
  if (!eligibility.eligible) return { ok: false, reason: 'not_eligible' };
  const account = ctx.platform?.find(identity.identifier) ?? null;
  if (account === null) return { ok: false, reason: 'not_eligible' };

    // Profilo + pick atomici: BEGIN ... COMMIT / ROLLBACK (validazione async).
    // created_at esplicito dal clock iniettato (Decisione A, RNF1);
    // register_id replicato dall'account piattaforma (RF-P7).
    // Feature JOLLY: `jollies_remaining` è inizializzato a
    // config.JOLLIES_PER_PLAYER alla CREAZIONE del profilo (D3) — il motore
    // poi legge SOLO il contatore per decidere no_jollies_left.
    db.prepare('BEGIN').run();
  try {
    // Riuso di player legacy (decisione (g)/B7): se per l'email esiste già
    // una riga player SENZA profile, si RIUSA il player_id (UNIQUE email mai
    // violato) e si fa backfill di register_id se NULL (dato legacy,
    // decisione 2 "nessuna migrazione"); altrimenti INSERT storico.
    const existingPlayer = db
      .prepare('SELECT id, register_id FROM player WHERE email = ?')
      .get(identity.identifier) as { id: number; register_id: number | null } | undefined;

    let playerId: number;
    if (existingPlayer !== undefined) {
      playerId = existingPlayer.id;
      if (existingPlayer.register_id === null) {
        db.prepare('UPDATE player SET register_id = ? WHERE id = ?').run(account.registerId, playerId);
      }
    } else {
      // ADR-011 (RF-P1): il nome del player nasce dal nome dell'account
      // piattaforma (dedotto dalla mail di registrazione); assente → email.
      const playerName = account.name ?? identity.identifier;
      playerId = db
        .prepare('INSERT INTO player (email, name, register_id, created_at) VALUES (?, ?, ?, ?)')
        .run(identity.identifier, playerName, account.registerId, now.toISOString())
        .lastInsertRowid as number;
    }

    // Caso difensivo: profilo GIÀ esistente per questo player (raggiungibile
    // solo in corsa concorrente — il wiring instrada il profilo esistente
    // altrove): rollback e already_registered, nessuna scrittura residua.
    const existingProfile = db
      .prepare('SELECT 1 FROM profile WHERE player_id = ?')
      .get(playerId) as { 1: number } | undefined;
    if (existingProfile !== undefined) {
      db.prepare('ROLLBACK').run();
      return { ok: false, reason: 'already_registered' };
    }

    const profileId = db
      .prepare(
        'INSERT INTO profile (player_id, register_id, created_at, jollies_remaining) VALUES (?, ?, ?, ?)'
      )
      .run(playerId, account.registerId, now.toISOString(), config.JOLLIES_PER_PLAYER)
      .lastInsertRowid as number;

    const validation = await validatePick(ctx, {
      profileId,
      round,
      team: parsed.team,
      outcome: parsed.outcome,
      jolly: parsed.jolly === true,
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
        now.toISOString(),
        0,
        parsed.jolly === true ? 1 : 0
      );
      // Feature JOLLY (D6): il decremento del contatore avviene nella STESSA
      // transazione dell'inserimento del pick (atomicità come registerPick).
      if (parsed.jolly === true) {
        db.prepare('UPDATE profile SET jollies_remaining = jollies_remaining - 1 WHERE id = ?').run(
          profileId
        );
      }
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
