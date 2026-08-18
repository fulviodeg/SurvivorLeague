/**
 * IMAP Client (LLD §6.4, piano Task 6.1; briefing Fase 5-6 §4.3, ADR-001/D7).
 *
 * Ruolo: ricezione email via imapflow. Il modulo è un SEAM per i test: le
 * funzioni ricevono la CONNESSIONE come parametro (`ImapConnection`, un
 * `Pick<ImapFlow, …>` sul sottoinsieme usato) — la connessione è costruita dal
 * chiamante (CLI/wiring, src/cli/email-wiring.ts), mai dentro il modulo; i
 * test passano oggetti fake che imitano il sottoinsieme (nessuna rete, LLD §8).
 *
 * Vincoli:
 *   - `receivedAt` = `internalDate` IMAP (arrivo in casella registrato dal
 *     server), MAI l'header `Date` del mittente (ADR-001, HIGH-02);
 *   - il corpo è decodificato dal SORGENTE grezzo con `mailparser.simpleParser`
 *     (testo text/plain; fallback: soggetto se body vuoto);
 *   - il fetch NON marca nulla (D7): il flag \Seen è impostato solo dal
 *     processing a messaggio processato con successo (`markSeen`).
 */
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

import type { IncomingMessage } from '../adapter.js';

/**
 * Sottoinsieme di ImapFlow usato dal client email (seam type-level: i test
 * passano oggetti fake che implementano solo questi metodi).
 */
export type ImapConnection = Pick<
  ImapFlow,
  'connect' | 'logout' | 'mailboxOpen' | 'search' | 'fetchOne' | 'messageFlagsSet'
>;

/** Opzioni del fetch: mailbox da leggere (default INBOX). */
export interface FetchUnseenOptions {
  /** Percorso della casella IMAP (default: 'INBOX'). */
  mailbox?: string;
}

/** Legge il corpo grezzo (Buffer) e lo restituisce come Buffer completo. */
function toBuffer(source: Buffer | undefined): Buffer {
  return source ?? Buffer.alloc(0);
}

/**
 * Recupera i messaggi NON LETTI (`seen: false`) della casella: apre la
 * mailbox, cerca i UID senza flag \Seen, scarica sorgente+internaldate e
 * decodifica il corpo (text/plain, fallback soggetto). `receivedAt` =
 * internaldate (ADR-001); NON marca nulla (D7). Idempotente.
 */
export async function fetchUnseen(
  conn: ImapConnection,
  opts: FetchUnseenOptions = {}
): Promise<IncomingMessage[]> {
  await conn.mailboxOpen(opts.mailbox ?? 'INBOX');
  const uids = (await conn.search({ seen: false }, { uid: true })) ?? [];
  if (uids === false) return [];

  const messages: IncomingMessage[] = [];
  for (const uid of uids) {
    const fetched = await conn.fetchOne(uid, { uid: true, source: true, internalDate: true }, { uid: true });
    if (fetched === false) continue;
    const parsed = await simpleParser(toBuffer(fetched.source));
    const body = parsed.text !== undefined && parsed.text.trim() !== '' ? parsed.text : (parsed.subject ?? '');
    const receivedAt = fetched.internalDate === undefined ? new Date(0) : new Date(fetched.internalDate);
    messages.push({
      id: String(fetched.uid),
      from: parsed.from?.text ?? '',
      channel: 'email',
      body,
      receivedAt
    });
  }
  return messages;
}

/**
 * Marca un messaggio come LETTO (flag \Seen) tramite UID — D7: chiamato dal
 * wiring SOLO a messaggio processato con successo (tutte le risposte inviate).
 * Apre la mailbox PRIMA del STORE (stesso pattern di `fetchUnseen`): il
 * handler STORE di imapflow con state ≠ SELECTED ritorna `false` silenziosamente
 * e il flag non viene mai persistito (bug critico fixato — risposte duplicate
 * a ogni tick). Rifiuta (lancia) se il STORE ritorna `false`: il chiamante
 * (EmailAdapter) vede il fallimento e può ritentare con una nuova connessione.
 * Su errore rifiuta: il messaggio resta non letto (retry al tick successivo).
 */
export async function markSeen(conn: ImapConnection, uid: string): Promise<void> {
  await conn.mailboxOpen('INBOX');
  const stored = await conn.messageFlagsSet(Number(uid), ['\\Seen'], { uid: true });
  if (stored === false) {
    throw new Error(`STORE del flag \\Seen rifiutato per il messaggio ${uid}`);
  }
}
