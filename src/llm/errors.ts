/**
 * Errore del confine LLM (briefing Fase 5-6, D3).
 *
 * Ruolo: contratto d'errore dei moduli LLM (Parser/Generator/client). Distingue
 * i problemi di TRASPORTO/HTTP/timeout/body malformato (→ `LLMError`, rilanciata
 * al chiamante: il wiring la tratta come "non processato, resta non letto,
 * retry al tick successivo") dalle ambiguità di CONTENUTO (→ `null`, mai
 * eccezioni: CS7). Nessuna eccezione per il contenuto esce mai dal confine LLM.
 */
export class LLMError extends Error {
  /** Status HTTP della risposta problematica (assente per timeout/errore di rete). */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}
