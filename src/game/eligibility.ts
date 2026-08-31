/**
 * Seam di eligibilità (ADR-008 n. 8 + ADR-009, LLD §6.5; piano Task 7).
 *
 * Ruolo: gate PRE-partecipazione: ogni ingresso nel torneo (auto-join a
 * `tournament:start` o dichiarazione esplicita, ADR-019) passa da
 * `checkEligibility(ctx, identity)`. L'identità è normalizzata
 * dal canale (`ExternalIdentity {channel, identifier}` — per l'email:
 * `{channel:'email', identifier: <indirizzo>}`, mai più "email = identificativo"
 * come identità grezza).
 *
 * Implementazione POC (ADR-009): **account piattaforma `active`** — il gate
 * legge lo stato dal PlatformRegistry iniettato nel contesto (SOLA LETTURA,
 * nessuna scrittura cross-DB):
 *   - account `active` → `{ eligible: true }`;
 *   - account `pending_unsubscribe`/`unsubscribed` o mai iscritto →
 *     `{ eligible: false, reason: 'account_not_active' }`;
 *   - registry assente nel contesto (comando puramente di torneo) →
 *     `{ eligible: false, reason: 'platform_unavailable' }` (nessun bypass
 *     silenzioso: il chiamante deve iniettare la piattaforma).
 * In Fase 1 l'impl diventerà "attivo + quota pagata" (`ENTRY_FEE_EUR`) senza
 * cambiare il contratto.
 *
 * Override US10 (ADR-008): l'iscrizione manuale del commissioner a finestra
 * chiusa passa per la STESSA funzione con `forceEligible` + motivo auditato —
 * mai un bypass fuori dal modulo.
 */
import type { GameContext } from './context.js';

/** Identità normalizzata di un mittente sul canale (ADR-008 n. 8). */
export interface ExternalIdentity {
  /** Canale di provenienza (es. 'email'). */
  channel: string;
  /** Identificativo sul canale (es. indirizzo email). */
  identifier: string;
}

/** Esito del gate di eligibilità. */
export interface EligibilityResult {
  eligible: boolean;
  /** Motivo del rifiuto o dell'override (assente per l'esito POC positivo). */
  reason?: string;
}

/** Opzioni del gate: override US10 con motivo auditato. */
export interface EligibilityOptions {
  /**
   * Override US10 (iscrizione manuale a finestra chiusa): forza l'esito
   * eligible. Richiede `reason` (audit obbligatorio).
   */
  forceEligible?: boolean;
  /** Motivo auditato dell'override (obbligatorio quando forceEligible=true). */
  reason?: string;
}

/**
 * Gate di eligibilità pre-partecipazione (ADR-008/009, LLD §6.5): account
 * piattaforma `active` (lettura dal registry iniettato). Con forceEligible
 * richiede il motivo e lo restituisce come reason (il chiamante lo logga);
 * senza registry nel contesto → rifiuto esplicito `platform_unavailable`
 * (nessun bypass: il chiamante inietta la piattaforma quando serve il gate).
 */
export function checkEligibility(
  ctx: GameContext,
  identity: ExternalIdentity,
  opts: EligibilityOptions = {}
): EligibilityResult {
  if (opts.forceEligible === true) {
    if (opts.reason === undefined || opts.reason.trim() === '') {
      return { eligible: false, reason: 'override_requires_reason' };
    }
    return { eligible: true, reason: opts.reason };
  }
  // Gate piattaforma (ADR-009): nessun registry iniettato → rifiuto esplicito.
  if (ctx.platform === undefined) {
    return { eligible: false, reason: 'platform_unavailable' };
  }
  const account = ctx.platform.find(identity.identifier);
  if (account === null || account.status !== 'active') {
    return { eligible: false, reason: 'account_not_active' };
  }
  return { eligible: true };
}
