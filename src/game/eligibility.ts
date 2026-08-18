/**
 * Seam di eligibilità (ADR-008 n. 8, LLD §6.5; piano Task 4.2).
 *
 * Ruolo: gate PRE-registrazione: ogni iscrizione (automatica o manuale) passa
 * da `checkEligibility(ExternalIdentity)`. L'identità è normalizzata dal canale
 * (`ExternalIdentity {channel, identifier}` — per l'email: `{channel:'email',
 * identifier: <indirizzo>}`, mai più "email = identificativo" come identità
 * grezza).
 *
 * Implementazione POC: SEMPRE `eligible` + motivo assente (nessuna quota/lista
 * nera). L'esito è esposto nei risultati di registrazione perché il chiamante
 * lo LOGGHI (verifica del piano: "eligibilità loggata"); in Fase 1 l'impl
 * diventerà la quota (`ENTRY_FEE_EUR`) senza cambiare il contratto.
 *
 * Override US10 (ADR-008): l'iscrizione manuale del commissioner a finestra
 * chiusa passa per la STESSA funzione con `forceEligible` + motivo auditato —
 * mai un bypass fuori dal modulo.
 */

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
 * Gate di eligibilità pre-registrazione (ADR-008 n. 8). Impl POC: sempre
 * eligible; con forceEligible richiede il motivo e lo restituisce come reason
 * (il chiamante lo logga). Il rifiuto esplicito resta per Fase 1 (quota).
 */
export function checkEligibility(
  identity: ExternalIdentity,
  opts: EligibilityOptions = {}
): EligibilityResult {
  if (opts.forceEligible === true) {
    if (opts.reason === undefined || opts.reason.trim() === '') {
      return { eligible: false, reason: 'override_requires_reason' };
    }
    return { eligible: true, reason: opts.reason };
  }
  // Impl POC: nessuna quota/lista nera → sempre eligible (ADR-008 n. 8).
  return { eligible: true };
}
