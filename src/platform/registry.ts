/**
 * PlatformRegistry (ADR-009, LLD §6.6) — archivio account della piattaforma.
 *
 * Ruolo: sorgente UNICA degli iscritti (account piattaforma) su storage
 * separato (`PLATFORM_DB_PATH`, RF-P7). I flussi di torneo lo leggono SOLO
 * (gate notifiche/pick, `activeEmails`): nessuna scrittura cross-DB (ADR-009).
 *
 * Contratto:
 *   - `register`: crea/riattiva l'account con lo STESSO `registerID` (RF-P1/P3);
 *     già `active` → invariato (idempotente);
 *   - `beginUnsubscribe`: primo unsubscribe via email (RF-P2) — SOLO da
 *     `active` → `pending_unsubscribe` (nessuna soft-delete); da `pending` →
 *     invariato (idempotente); da `unsubscribed`/sconosciuto → null (il
 *     chiamante logga in silenzio);
 *   - `confirmUnsubscribe`: secondo unsubscribe (RF-P2) — SOLO da
 *     `pending_unsubscribe` → `unsubscribed` con `unsubscribed_at` dal clock
 *     iniettato; da altri stati → null;
 *   - `reactivate`: `pending_unsubscribe`/`unsubscribed` → `active` con lo
 *     stesso `registerID` (RF-P3); sconosciuto → null;
 *   - `unregister`: soft-delete DIRETTO per la CLI (`platform:unregister`,
 *     US8): qualunque stato → `unsubscribed` con `unsubscribed_at` dal clock;
 *     sconosciuto → null;
 *   - `find`, `activeEmails` (solo status `active`, RF-P6), `list` (ordinata
 *     per `register_id`): sola lettura.
 *
 * Determinismo (RF-P8/RNF1): TUTTI i metodi di scrittura ricevono `now`
 * esplicito dal clock iniettato — mai `datetime('now')` di SQLite né
 * `new Date()`: due run della stessa simulazione producono date identiche.
 */
import type Database from 'better-sqlite3';

/** Stati dell'account piattaforma (soft-delete a due passi, RF-P2). */
export type PlatformAccountStatus = 'active' | 'pending_unsubscribe' | 'unsubscribed';

/** Riga account della piattaforma (lettura, LLD §6.6). */
export interface PlatformAccount {
  /** registerID interno STABILE, riusato alla re-iscrizione (RF-P3). */
  registerId: number;
  /** Email univoca (identità del canale, normalizzata a monte). */
  email: string;
  status: PlatformAccountStatus;
  /** Istante di creazione (ISO-8601) dal clock iniettato (RF-P8). */
  createdAt: string;
  /** Istante della soft-delete (ISO-8601), null finché non disiscritto. */
  unsubscribedAt: string | null;
}

/** Interfaccia astratta dell'archivio account (LLD §6.6, ADR-009). */
export interface PlatformRegistry {
  /** Crea/riattiva l'account (stesso registerID); già active → invariato. */
  register(email: string, now: Date): PlatformAccount;
  /** Primo unsubscribe via email: active → pending_unsubscribe (RF-P2); null se non applicabile. */
  beginUnsubscribe(email: string, now: Date): PlatformAccount | null;
  /** Secondo unsubscribe: pending_unsubscribe → unsubscribed (soft-delete, RF-P2); null se non applicabile. */
  confirmUnsubscribe(email: string, now: Date): PlatformAccount | null;
  /** pending_unsubscribe/unsubscribed → active con lo stesso registerID (RF-P3); null se sconosciuto. */
  reactivate(email: string, now: Date): PlatformAccount | null;
  /** Soft-delete DIRETTO per la CLI (platform:unregister, US8); null se sconosciuto. */
  unregister(email: string, now: Date): PlatformAccount | null;
  /** Lookup per email; null se mai iscritto. */
  find(email: string): PlatformAccount | null;
  /** Email degli account SOLO `active` (destinatari delle notifiche, RF-P6). */
  activeEmails(): string[];
  /** Tutti gli account, ordinati per register_id (vista CLI platform:list). */
  list(): PlatformAccount[];
}

/** Riga grezza della tabella platform_account. */
interface AccountRow {
  register_id: number;
  email: string;
  status: PlatformAccountStatus;
  created_at: string;
  unsubscribed_at: string | null;
}

/** Converte una riga DB nell'oggetto di dominio (camelCase, LLD §6.6). */
function toAccount(row: AccountRow): PlatformAccount {
  return {
    registerId: row.register_id,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    unsubscribedAt: row.unsubscribed_at
  };
}

/**
 * Implementazione SQLite del PlatformRegistry su una connessione DEDICATA al
 * DB piattaforma (PLATFORM_DB_PATH). Nessun accesso al DB torneo: la
 * separazione fisica impone per costruzione l'assenza di transazioni
 * cross-DB (ADR-009).
 */
export class DbPlatformRegistry implements PlatformRegistry {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Legge l'account per email (normalizzata dal chiamante, K). */
  find(email: string): PlatformAccount | null {
    const row = this.db
      .prepare('SELECT register_id, email, status, created_at, unsubscribed_at FROM platform_account WHERE email = ?')
      .get(email) as AccountRow | undefined;
    return row === undefined ? null : toAccount(row);
  }

  /**
   * Crea l'account se mai iscritto (registerID nuovo) o lo RIATTIVA con lo
   * stesso registerID se esiste in qualunque stato (RF-P1/P3). Già `active` →
   * invariato. `created_at` scritto dal clock iniettato SOLO alla prima
   * creazione (la data originale non cambia alle riattivazioni).
   */
  register(email: string, now: Date): PlatformAccount {
    const existing = this.find(email);
    if (existing === null) {
      this.db
        .prepare(
          "INSERT INTO platform_account (email, status, created_at) VALUES (?, 'active', ?)"
        )
        .run(email, now.toISOString());
      const created = this.find(email);
      if (created === null) {
        throw new Error('platform:register: inserimento account fallito (riga non trovata)');
      }
      return created;
    }
    if (existing.status !== 'active') {
      this.db
        .prepare("UPDATE platform_account SET status = 'active' WHERE email = ?")
        .run(email);
      return this.find(email) as PlatformAccount;
    }
    return existing;
  }

  /**
   * Primo unsubscribe via email (RF-P2): SOLO da `active` → `pending_unsubscribe`
   * (nessuna soft-delete); da `pending_unsubscribe` → invariato (idempotente);
   * da `unsubscribed`/sconosciuto → null (il chiamante logga in silenzio).
   * `now` è parte del contratto (tutti i metodi di scrittura lo ricevono,
   * RF-P8) ma qui non scrive timestamp: il passaggio a pending non ha data.
   */
  beginUnsubscribe(email: string, now: Date): PlatformAccount | null {
    // `now` è parte del contratto (RF-P8: tutti i metodi di scrittura lo
    // ricevono esplicito) ma il passaggio a pending_unsubscribe non scrive
    // alcun timestamp: nessuna data da registrare.
    void now;
    const existing = this.find(email);
    if (existing === null || existing.status === 'unsubscribed') return null;
    if (existing.status === 'active') {
      this.db
        .prepare("UPDATE platform_account SET status = 'pending_unsubscribe' WHERE email = ?")
        .run(email);
    }
    return this.find(email);
  }

  /**
   * Secondo unsubscribe (RF-P2): SOLO da `pending_unsubscribe` → `unsubscribed`
   * (soft-delete con `unsubscribed_at` dal clock iniettato, RF-P8); da
   * qualunque altro stato → null.
   */
  confirmUnsubscribe(email: string, now: Date): PlatformAccount | null {
    const existing = this.find(email);
    if (existing === null || existing.status !== 'pending_unsubscribe') return null;
    this.db
      .prepare("UPDATE platform_account SET status = 'unsubscribed', unsubscribed_at = ? WHERE email = ?")
      .run(now.toISOString(), email);
    return this.find(email);
  }

  /**
   * Riattivazione (RF-P3): `pending_unsubscribe`/`unsubscribed` → `active` con
   * lo STESSO registerID (lo storico torneo non è toccato); già `active` →
   * invariato; sconosciuto → null. `now` è parte del contratto (RF-P8) ma qui
   * non scrive timestamp: la riattivazione non ha una data propria.
   */
  reactivate(email: string, now: Date): PlatformAccount | null {
    // `now` è parte del contratto (RF-P8) ma la riattivazione non scrive
    // alcun timestamp: nessuna data da registrare.
    void now;
    const existing = this.find(email);
    if (existing === null) return null;
    if (existing.status !== 'active') {
      this.db
        .prepare("UPDATE platform_account SET status = 'active' WHERE email = ?")
        .run(email);
    }
    return this.find(email);
  }

  /**
   * Soft-delete DIRETTO per la CLI (`platform:unregister`, US8, RF-P2):
   * qualunque stato esistente → `unsubscribed` con `unsubscribed_at` dal
   * clock iniettato; sconosciuto → null. Il profilo torneo resta intatto
   * (RF-P3/P5: la disiscrizione ferma solo comunicazioni e pick).
   */
  unregister(email: string, now: Date): PlatformAccount | null {
    const existing = this.find(email);
    if (existing === null) return null;
    this.db
      .prepare("UPDATE platform_account SET status = 'unsubscribed', unsubscribed_at = ? WHERE email = ?")
      .run(now.toISOString(), email);
    return this.find(email);
  }

  /** Email degli account SOLO `active` (RF-P6): i destinatari delle notifiche. */
  activeEmails(): string[] {
    const rows = this.db
      .prepare("SELECT email FROM platform_account WHERE status = 'active' ORDER BY register_id")
      .all() as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  /** Tutti gli account in ordine di register_id (vista CLI `platform:list`). */
  list(): PlatformAccount[] {
    const rows = this.db
      .prepare('SELECT register_id, email, status, created_at, unsubscribed_at FROM platform_account ORDER BY register_id')
      .all() as unknown as AccountRow[];
    return rows.map(toAccount);
  }
}
