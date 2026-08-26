/**
 * Unit test del IMAP client (piano Task 6.1, LLD §6.4; briefing Fase 5-6 §4.3,
 * ADR-001/D7).
 *
 * Connessione FAKE (nessuna rete, LLD §8): il fake implementa solo il
 * sottoinsieme usato (`ImapConnection`). Verificano: `receivedAt` =
 * internaldate e MAI l'header Date (ADR-001/HIGH-02); corpo decodificato dal
 * sorgente MIME (text/plain, fallback soggetto); from = testo del mittente;
 * id = UID; il fetch NON marca nulla (D7).
 */
import { describe, expect, it } from 'vitest';

import {
  fetchUnseen,
  markSeen,
  type ImapConnection
} from '../../../src/channel/email-adapter/imap-client.js';

/**
 * Connessione IMAP fake: casella con 2 messaggi non letti (sorgente MIME
 * grezzo). L'header Date del primo è DIVERSO dall'internaldate: il test
 * verifica che vinca l'internaldate (ADR-001). Registra in `log` la sequenza
 * delle chiamate (mailboxOpen → flag): i test di markSeen verificano l'ordine.
 */
function fakeConn(messages: Array<{ internalDate: Date; source: Buffer }>): {
  conn: ImapConnection;
  flagCalls: Array<{ range: unknown; flags: string[] }>;
  log: string[];
} {
  const flagCalls: Array<{ range: unknown; flags: string[] }> = [];
  const log: string[] = [];
  const conn: ImapConnection = {
    connect: async () => undefined,
    logout: async () => undefined,
    mailboxOpen: async () => {
      log.push('open');
      return {} as never;
    },
    search: async () => messages.map((_, i) => i + 1),
    fetchOne: async (uid: unknown) => {
      const index = Number(uid) - 1;
      const m = messages[index];
      if (m === undefined) return false;
      return { uid: Number(uid), seq: Number(uid), internalDate: m.internalDate, source: m.source };
    },
    messageFlagsSet: async (range: unknown, flags: string[]) => {
      log.push(`flags:${String(range)}:${flags.join(',')}`);
      flagCalls.push({ range, flags });
      return true;
    }
  };
  return { conn, flagCalls, log };
}

/** Sorgente MIME minimale: header Date + mittente + corpo text/plain. */
function mime(dateHeader: string, from: string, text: string, subject?: string): Buffer {
  const subjectHeader = subject !== undefined ? `Subject: ${subject}\r\n` : '';
  return Buffer.from(
    `Date: ${dateHeader}\r\nFrom: ${from}\r\n${subjectHeader}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`
  );
}

describe('fetchUnseen — internaldate, corpo e id (ADR-001/D7)', () => {
  it('receivedAt = internaldate (MAI l\'header Date); corpo dal text/plain; id = UID', async () => {
    const headerDate = new Date('2024-01-01T10:00:00.000Z'); // header Date FALSO (anno scorso)
    const internalDate = new Date('2026-09-12T09:41:00.000Z'); // arrivo in casella
    const { conn, flagCalls } = fakeConn([
      {
        internalDate,
        source: mime(headerDate.toUTCString(), 'Mario Rossi <mario@x.it>', 'Scelgo la Juve win')
      },
      {
        internalDate: new Date('2026-09-12T09:42:00.000Z'),
        source: mime('Fri, 01 Jan 2021 08:00:00 +0000', 'beppe@x.it', 'Inter pareggio')
      }
    ]);

    const messages = await fetchUnseen(conn);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.receivedAt).toEqual(internalDate); // internaldate vince, non il Date header
    expect(messages[0]?.body).toBe('Scelgo la Juve win');
    // from = testo grezzo del mittente (mailparser cita il display name); la
    // normalizzazione (trim/minuscolo/rimozione nome) è del router (K).
    expect(messages[0]?.from).toBe('"Mario Rossi" <mario@x.it>');
    expect(messages[0]?.id).toBe('1');
    expect(messages[1]?.body).toBe('Inter pareggio');
    // D7: il fetch NON marca nulla.
    expect(flagCalls).toEqual([]);
  });

  it('body vuoto → fallback sul soggetto', async () => {
    const { conn } = fakeConn([
      {
        internalDate: new Date('2026-09-12T09:43:00.000Z'),
        source: mime('Fri, 01 Jan 2021 08:00:00 +0000', 'x@y.z', '', 'Solo oggetto')
      }
    ]);
    const [message] = await fetchUnseen(conn);
    expect(message?.body).toBe('Solo oggetto');
    expect(message?.subject).toBe('Solo oggetto');
  });

  it('email v3 Parte B: subject popolato da parsed.subject (indipendente dal corpo)', async () => {
    const { conn } = fakeConn([
      {
        internalDate: new Date('2026-09-12T09:44:00.000Z'),
        source: mime('Fri, 01 Jan 2021 08:00:00 +0000', 'm@x.it', 'Roma vince', 'ISCRIZIONE Mario')
      }
    ]);
    const [message] = await fetchUnseen(conn);
    expect(message?.body).toBe('Roma vince');
    expect(message?.subject).toBe('ISCRIZIONE Mario');
  });

  it('mailbox vuota → nessun messaggio', async () => {
    const { conn } = fakeConn([]);
    expect(await fetchUnseen(conn)).toEqual([]);
  });
});

describe('markSeen (D7, bug fix Task 6)', () => {
  it('apre la mailbox PRIMA di impostare il flag \\Seen per UID (sequenza mailboxOpen → messageFlagsSet)', async () => {
    const { conn, flagCalls, log } = fakeConn([]);
    await markSeen(conn, '42');
    // Regressione bug critico: senza mailboxOpen il STORE di imapflow ritorna
    // false silenziosamente e il flag non viene persistito (risposte duplicate).
    expect(log).toEqual(['open', 'flags:42:\\Seen']);
    expect(flagCalls).toEqual([{ range: 42, flags: ['\\Seen'] }]);
  });

  it('STORE rifiutato (messageFlagsSet → false) → errore esplicito (mai fallimento silenzioso)', async () => {
    const conn: ImapConnection = {
      connect: async () => undefined,
      logout: async () => undefined,
      mailboxOpen: async () => ({}) as never,
      search: async () => [],
      fetchOne: async () => false,
      messageFlagsSet: async () => false
    };
    await expect(markSeen(conn, '42')).rejects.toThrow(/\\Seen.*42|42.*\\Seen/);
  });
});
