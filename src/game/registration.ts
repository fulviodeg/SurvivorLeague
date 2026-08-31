/**
 * Partecipazione al torneo: creazione profilo, auto-join e dichiarazione
 * (ADR-019 — partecipazione opt-in; sostituisce l'auto-join al primo pick
 * RF-P5 di ADR-009).
 *
 * Ruolo: UNICA fonte della nascita dei profili (`createProfileForAccount`) e
 * dei DUE ingressi al torneo previsti dal modello opt-in (ADR-019):
 *   1. **auto-join a `tournament:start`** (`autoJoinProfilesAtStart`): gli
 *      account piattaforma `active` con `tournament_auto_join = ON` vengono
 *      auto-iscritti (snapshot D5/D6/D11);
 *   2. **dichiarazione esplicita** (`declareParticipation`): via email
 *      `PARTECIPO` o CLI `tournament:join`, nella finestra del TT 1 (round 1
 *      `pending` o `open`), per chi ha `tournament_auto_join = OFF` o è
 *      diventato `active` dopo `tournament:start`.
 *
 * Il gate di eligibilità è "account piattaforma `active`" (ADR-009, lettura
 * dal registry iniettato); `register_id` è replicato su player/profile
 * (RF-P7). Dopo la chiusura del TT 1 la lista partecipanti è blindata:
 * dichiarazione → rifiuto; unico escape = override CLI con `--reason`
 * (ADR-008 §6, US10).
 *
 * Dati legacy (decisione 2 "nessuna migrazione", ADR-009): un `player`
 * preesistente SENZA `profile` (es. riga legacy con `register_id` NULL) NON
 * blocca la creazione — `createProfileForAccount` RIUSA il `player_id`
 * esistente (UNIQUE email mai violato), fa backfill di `register_id` se NULL
 * e crea SOLO il profilo (decisione (g)/B7).
 *
 * RIMOSSO (ADR-019): `autoJoinFromPick` (RF-P5) — non esiste più l'ingresso
 * "primo pick valido nel TT 1": il pick NON crea più profili. I profili
 * nascono solo per auto-join a start o per dichiarazione esplicita.
 */
import type Database from 'better-sqlite3';

import type { PlatformAccount } from '../platform/registry.js';
import type { GameContext } from './context.js';
import { checkEligibility, type ExternalIdentity } from './eligibility.js';
import { getStartRound } from './turn.js';

/** Esito della dichiarazione di partecipazione (join, ADR-019). */
export type DeclareResult =
  | { ok: true; profileId: number }
  | {
      ok: false;
      reason:
        | 'not_active' // gate eligibilità: account non active/inesistente (ADR-009)
        | 'no_tournament' // nessun torneo avviato o round 1 assente
        | 'already_joined' // profilo già esistente (idempotenza D8)
        | 'late_requires_reason'; // TT 1 chiuso e --reason assente (override richiesto, D10)
    };

/**
 * UNICA fonte della creazione di un profilo (AGENTS.md §1.3): crea (o riusa)
 * il `player` con backfill di `register_id` legacy e crea il `profile` con
 * `jollies_remaining` inizializzato a `jolliesPerPlayer` (feature JOLLY, D3).
 * `created_at` è scritto esplicitamente dal clock iniettato (Decisione A,
 * RNF1). Restituisce il `profileId` creato. NON è idempotente da sola: il
 * chiamante verifica PRIMA che il profilo non esista già (idempotenza dei due
 * ingressi, D8).
 *
 * Dati legacy (decisione (g)/B7): se per l'email esiste GIÀ una riga `player`
 * senza `profile` (es. riga legacy con `register_id` NULL), si RIUSA il
 * `player_id` esistente (UNIQUE email mai violato: nessun INSERT su player),
 * si fa BACKFILL di `register_id` con `account.registerId` se NULL e si crea
 * SOLO il profilo; altrimenti INSERT storico (player + profile).
 */
export function createProfileForAccount(
  db: Database.Database,
  account: PlatformAccount,
  now: Date,
  jolliesPerPlayer: number
): number {
  const existingPlayer = db
    .prepare('SELECT id, register_id FROM player WHERE email = ?')
    .get(account.email) as { id: number; register_id: number | null } | undefined;

  let playerId: number;
  if (existingPlayer !== undefined) {
    playerId = existingPlayer.id;
    if (existingPlayer.register_id === null) {
      db.prepare('UPDATE player SET register_id = ? WHERE id = ?').run(account.registerId, playerId);
    }
  } else {
    // ADR-011 (RF-P1): il nome del player nasce dal nome dell'account
    // piattaforma (dedotto dalla mail di registrazione); assente → email.
    const playerName = account.name ?? account.email;
    playerId = db
      .prepare('INSERT INTO player (email, name, register_id, created_at) VALUES (?, ?, ?, ?)')
      .run(account.email, playerName, account.registerId, now.toISOString())
      .lastInsertRowid as number;
  }

  return db
    .prepare(
      'INSERT INTO profile (player_id, register_id, created_at, jollies_remaining) VALUES (?, ?, ?, ?)'
    )
    .run(playerId, account.registerId, now.toISOString(), jolliesPerPlayer)
    .lastInsertRowid as number;
}

/**
 * Auto-join bulk a `tournament:start` (ADR-019, D6/D11): per ogni account
 * piattaforma `active` con `tournament_auto_join === true`, crea il profilo
 * SE non già presente (idempotente). Snapshot unico: un account diventato
 * `active` DOPO `tournament:start` NON viene auto-joinato (D11) — deve
 * dichiarare. Con `ctx.platform === undefined` è un no-op (coerente col guard
 * del broadcast). Restituisce i `profileId` creati (ordinati per register_id,
 * determinismo RNF1). Nessuna transazione cross-DB: sola lettura della
 * piattaforma, scrittura sul DB torneo.
 */
export function autoJoinProfilesAtStart(ctx: GameContext): number[] {
  const { db, now, config } = ctx;
  if (ctx.platform === undefined) return [];
  const created: number[] = [];
  for (const account of ctx.platform.activeAccounts()) {
    if (!account.tournamentAutoJoin) continue;
    const existing = db
      .prepare(
        'SELECT 1 FROM profile p JOIN player pl ON pl.id = p.player_id WHERE pl.email = ?'
      )
      .get(account.email);
    if (existing !== undefined) continue;
    created.push(createProfileForAccount(db, account, now, config.JOLLIES_PER_PLAYER));
  }
  return created;
}

/**
 * Dichiarazione di partecipazione (join, ADR-019): il percorso di ingresso
 * ESPLICITO al torneo (email `PARTECIPO` o CLI `tournament:join`). NON crea
 * account (registration-pure: l'account deve già esistere). Gate e finestra:
 *
 *  1. `checkEligibility` (ADR-009): account `active` — con `opts.reason`
 *     presente usa `forceEligible` (override US10/ADR-008 §6: l'iscrizione
 *     manuale del commissioner a finestra chiusa bypassa il gate di stato).
 *  2. `season_started !== 1` ⇒ `no_tournament` ("nessun torneo aperto").
 *  3. `round_state[startRound]` assente ⇒ `no_tournament`.
 *  4. profilo già esistente ⇒ `already_joined` (idempotenza D8 INCONDIZIONATA:
 *     chi è già in gara lo è a qualunque stato del TT 1, anche dopo la
 *     chiusura — il check precede la finestra).
 *  5. finestra TT 1: `pending`/`open` ⇒ aperta (consente il join anche PRIMA
 *     di `round:open`, simmetrico all'auto-join); `closed`/`scored` ⇒ chiusa —
 *     senza `reason` ⇒ `late_requires_reason` (override richiesto, D10), con
 *     `reason` ⇒ override late (crea profilo, pool intatto, ADR-008 §6).
 *  6. altrimenti `createProfileForAccount` ⇒ `{ ok: true, profileId }`.
 *
 * Il percorso EMAIL non passa MAI `reason` (l'override è SOLO CLI, D10/D12):
 * in tal caso la chiusura del TT 1 è rifiutata con `late_requires_reason` e
 * il wiring la traduce nel testo "il torneo è iniziato".
 */
export function declareParticipation(
  ctx: GameContext,
  identity: ExternalIdentity,
  opts: { reason?: string } = {}
): DeclareResult {
  const { db, now, config } = ctx;

  // 1. Gate eligibilità (ADR-009); forceEligible SOLO con `reason` (override).
  const eligibility = checkEligibility(
    ctx,
    identity,
    opts.reason !== undefined ? { forceEligible: true, reason: opts.reason } : {}
  );
  if (!eligibility.eligible) return { ok: false, reason: 'not_active' };

  // 2. Nessun torneo avviato.
  const state = db
    .prepare('SELECT season_started FROM tournament_state WHERE id = 1')
    .get() as { season_started: number } | undefined;
  if (state?.season_started !== 1) return { ok: false, reason: 'no_tournament' };

  // 3. Round di avvio presente (round_state[startRound]).
  const startRound = getStartRound(db);
  const rs = db
    .prepare('SELECT status FROM round_state WHERE round = ?')
    .get(startRound) as { status: string } | undefined;
  if (rs === undefined) return { ok: false, reason: 'no_tournament' };

  // 4. Idempotenza D8 INCONDIZIONATA: profilo già esistente ⇒ già in gara, a
  //    qualunque stato del TT 1 (il check precede la finestra).
  const existing = db
    .prepare(
      'SELECT 1 FROM profile p JOIN player pl ON pl.id = p.player_id WHERE pl.email = ?'
    )
    .get(identity.identifier);
  if (existing !== undefined) return { ok: false, reason: 'already_joined' };

  // 5. Finestra TT 1 (stato del round di avvio).
  const windowOpen = rs.status === 'pending' || rs.status === 'open';
  const hasReason = opts.reason !== undefined && opts.reason.trim() !== '';
  if (!windowOpen && !hasReason) {
    return { ok: false, reason: 'late_requires_reason' };
  }

  // L'account deve ESISTERE per replicarne register_id (RF-P7): con
  // forceEligible un account inesistente resta non raggiungibile (difensivo).
  const account = ctx.platform?.find(identity.identifier) ?? null;
  if (account === null) return { ok: false, reason: 'not_active' };

  // 6. Creazione del profilo (unica fonte).
  const profileId = createProfileForAccount(db, account, now, config.JOLLIES_PER_PLAYER);
  return { ok: true, profileId };
}
