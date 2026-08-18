/**
 * Contratto dei motivi di rifiuto del Game Engine (briefing Fase 3 §1-F, PRD US2).
 *
 * Ruolo: enum UNICO e condiviso dei motivi con cui il Pick Processor (Task 3.2)
 * e il Round Manager (Task 3.5) rifiutano/classificano un pick. Ogni rifiuto ha
 * un motivo dedicato e stabile, usato nei messaggi di risposta al giocatore,
 * negli output JSON della CLI e nei log. Vive qui — e non nel pick-processor —
 * perché la cascata di validazione (LLD §3.1), i comandi `pick:*` e i test lo
 * condividono senza duplicare la stringa.
 *
 * Ordine della cascata (LLD §3.1, briefing §1-F): registrazione/attivo →
 * squadra canonica → squadra nel TC → non bruciata → esito valido → non già
 * pick → accettazione temporale (round aperto, deadline, guard anti-frode RF-31).
 */
/** Motivi di rifiuto di un pick, in ordine di applicazione nella cascata. */
export const PICK_REJECT_REASONS = [
  'profile_not_registered', // il profilo non esiste (non iscritto)
  'profile_eliminated', // profilo eliminato: non può inviare pick (LLD §3.1)
  'unknown_team', // squadra NON nella lista canonica (check esatto post-parse, CL5)
  'team_not_in_round', // squadra canonica ma che NON gioca nel TC (CL4)
  'team_already_used', // squadra già bruciata nel girone (RF-10, CS5)
  'invalid_outcome', // esito fuori win|draw|lose
  'pick_already_exists', // già esiste un pick per profilo+round (CL6, RF-08)
  'round_not_open', // il round non è aperto o round_state assente (CL3)
  'after_acceptance', // receivedAt > deadline registrata (CL3, CS4)
  'after_kickoff' // guard anti-frode: receivedAt > kickoff effettivo (RF-31, CL17/CL18)
] as const;

/** Motivo di rifiuto di un pick (unione dei valori dell'enum). */
export type PickRejectReason = (typeof PICK_REJECT_REASONS)[number];

/**
 * Esito della validazione di un pick (LLD §7.4, output `pick:validate`):
 * `{valid, reason}` — valid=false richiede SEMPRE un motivo esplicito.
 */
export interface PickValidation {
  valid: boolean;
  /** Motivo del rifiuto quando valid=false (obbligatorio in quel caso). */
  reason?: PickRejectReason;
}
