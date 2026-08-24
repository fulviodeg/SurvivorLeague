/**
 * Interfaccia ChannelAdapter (LLD §6.4, briefing Fase 3 §1-D) — SOLO TIPI.
 *
 * Ruolo: contratto astratto del canale di comunicazione. Il Game Engine (Round
 * Manager, Task 3.5) dipende SOLO da questa interfaccia, mai da una
 * implementazione concreta: un nuovo canale = un nuovo adapter, senza toccare
 * la logica (AGENTS.md §1.2). L'unica implementazione POC è l'email
 * (IMAP/SMTP su Gmail), realizzata nella Fase 6 (EmailAdapter).
 *
 * In questa fase il file definisce soltanto i tipi: i test del Game Engine
 * iniettano adapter fake in-memory (LLD §8, mock solo ai confini esterni).
 */

/** Messaggio in ingresso dal canale (es. email di un giocatore). */
export interface IncomingMessage {
  /** Identificativo del mittente sul canale (es. indirizzo email). */
  from: string;
  /** Canale di provenienza (es. 'email'); base dell'ExternalIdentity (ADR-008). */
  channel: string;
  /** Corpo testuale del messaggio (da dare in pasto al Parser LLM). */
  body: string;
  /**
   * Oggetto del messaggio (opzionale): per l'email è il Subject. Usato dal
   * parser deterministico (email v3 Parte B) che riconosce le formule
   * `ISCRIZIONE [NOME]`/`DISISCRIZIONE`/`<TEAM> <ESITO>` nel subject O nel
   * corpo. Il classificatore LLM NON lo inietta nel prompt (invariato).
   */
  subject?: string;
  /**
   * Istante di RICEZIONE sul server (ADR-001): per l'email è l'`internaldate`
   * IMAP, MAI l'header `Date` del mittente. Fa fede per la deadline (CS4).
   */
  receivedAt: Date;
  /**
   * Identificativo del messaggio sul canale (opzionale): per l'email è il UID
   * IMAP. Serve a `EmailAdapter.markSeen` (flag \Seen a processamento
   * riuscito, D7); gli adapter che non supportano il flag lo omettono.
   */
  id?: string;
}

/** Canale astratto: fetch dei messaggi in ingresso + invio verso un destinatario. */
export interface ChannelAdapter {
  /** Recupera i messaggi in ingresso non ancora processati (mai marca nulla, D7). */
  fetchMessages(): Promise<IncomingMessage[]>;
  /**
   * Invia un messaggio testuale a un destinatario del canale. `subject` è
   * OPZIONALE (D1): per l'email è l'oggetto SMTP; chi compone i contesti
   * (Round Manager, Registration, wiring) calcola il soggetto con l'helper
   * deterministico `subjectFor(ctx)` (src/llm/generator.ts).
   */
  sendMessage(to: string, body: string, subject?: string): Promise<void>;
}
