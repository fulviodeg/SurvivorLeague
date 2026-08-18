/**
 * Elimination Engine (LLD §7.6, PRD §5.2/CS4; piano Task 3.3).
 *
 * Ruolo: logica di eliminazione di un profilo con `eliminated_at`/
 * `eliminated_reason` (decisione 10 del piano). Due cause:
 *   - `missing_pick` — il profilo attivo non ha registrato un pick al close del
 *     round (chiamata dal Round Manager in `round:close`);
 *   - `wrong_pick`   — il pick è stato contabilizzato come sbagliato (chiamata
 *     dal Round Manager in `round:score`).
 *
 * Idempotenza (PRD §5.4: "se il profilo è già eliminato … non ha effetto"):
 * eliminate() su un profilo già eliminato è un NO-OP — conserva il motivo e
 * l'istante della PRIMA eliminazione (un profilo eliminato per wrong_pick non
 * va ri-eliminato come missing_pick nel TT successivo).
 *
 * Nessuna colonna "round di eliminazione" nel modello (briefing §4.4): il
 * Winner Engine deduce "stessa ondata / stesso TT" da `eliminated_at` condiviso
 * (decisione 2: i profili eliminati nello stesso round:score/round:close, con lo
 * stesso clock, hanno `eliminated_at` identico).
 *
 * Il timestamp deriva SOLO dal clock iniettato (`now`), mai da `new Date()`
 * diretto (decisione A: determinismo RNF1/CS4).
 *
 * Interazioni: chiamato dal Round Manager (Task 3.5); i comandi CLI
 * `elimination:check`/`elimination:list` (src/cli/commands/elimination.ts) ne
 * espongono lo stato in sola lettura. Il Pick Processor rifiuta i pick di un
 * profilo eliminato con `profile_eliminated` (LLD §3.1).
 */
import type Database from 'better-sqlite3';

/** Motivi di eliminazione (vincolati dal CHECK del DB, LLD §3). */
export type EliminationReason = 'missing_pick' | 'wrong_pick';

/** Stato di eliminazione di un profilo (lettura). */
export interface EliminationStatus {
  eliminated: boolean;
  /** Motivo dell'eliminazione (presente solo se eliminated). */
  reason?: EliminationReason;
  /** Istante dell'eliminazione ISO-8601 (presente solo se eliminated). */
  eliminatedAt?: string;
}

interface ProfileRow {
  eliminated: number;
  eliminated_at: string | null;
  eliminated_reason: string | null;
}

/**
 * Elimina un profilo (idempotente). Se il profilo è già eliminato è un no-op e
 * restituisce lo stato esistente; su un profilo inesistente non fa nulla
 * (eliminated: false). Il timestamp è `now.toISOString()` dal clock iniettato.
 */
export function eliminate(
  db: Database.Database,
  profileId: number,
  reason: EliminationReason,
  now: Date
): EliminationStatus {
  const profile = db
    .prepare('SELECT eliminated, eliminated_at, eliminated_reason FROM profile WHERE id = ?')
    .get(profileId) as ProfileRow | undefined;
  if (profile === undefined) return { eliminated: false };
  if (profile.eliminated === 1) {
    // No-op: conserva motivo e istante della prima eliminazione.
    return {
      eliminated: true,
      reason: profile.eliminated_reason as EliminationReason,
      eliminatedAt: profile.eliminated_at ?? undefined
    };
  }
  const at = now.toISOString();
  db.prepare(
    'UPDATE profile SET eliminated = 1, eliminated_at = ?, eliminated_reason = ? WHERE id = ?'
  ).run(at, reason, profileId);
  return { eliminated: true, reason, eliminatedAt: at };
}

/** Stato di eliminazione di un profilo (sola lettura, idempotente). */
export function checkElimination(
  db: Database.Database,
  profileId: number
): EliminationStatus {
  const profile = db
    .prepare('SELECT eliminated, eliminated_at, eliminated_reason FROM profile WHERE id = ?')
    .get(profileId) as ProfileRow | undefined;
  if (profile === undefined || profile.eliminated !== 1) return { eliminated: false };
  return {
    eliminated: true,
    reason: profile.eliminated_reason as EliminationReason,
    eliminatedAt: profile.eliminated_at ?? undefined
  };
}

/** Riga di `elimination:list`: profilo eliminato con email, motivo e istante. */
export interface EliminatedRecord {
  profileId: number;
  email: string;
  reason: EliminationReason;
  eliminatedAt: string;
}

/** Lista dei profili eliminati (sola lettura), ordinati per istante di eliminazione. */
export function listEliminated(db: Database.Database): EliminatedRecord[] {
  const rows = db
    .prepare(
      `SELECT p.id AS profileId, COALESCE(pl.email, '') AS email,
              p.eliminated_reason AS reason, p.eliminated_at AS eliminatedAt
       FROM profile p
       LEFT JOIN player pl ON pl.id = p.player_id
       WHERE p.eliminated = 1
       ORDER BY p.eliminated_at, p.id`
    )
    .all() as unknown as Array<{
    profileId: number;
    email: string;
    reason: string;
    eliminatedAt: string;
  }>;
  return rows.map((r) => ({
    profileId: r.profileId,
    email: r.email,
    reason: r.reason as EliminationReason,
    eliminatedAt: r.eliminatedAt
  }));
}
