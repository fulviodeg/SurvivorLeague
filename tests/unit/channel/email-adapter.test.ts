/**
 * Unit test dell'EmailAdapter (piano Task 6.1, LLD §6.4; briefing Fase 5-6 §4,
 * D7/RNF9).
 *
 * Conn/transport FAKE (nessuna rete, LLD §8): l'adapter riceve la factory
 * della connessione IMAP e il transport SMTP come dipendenze iniettate.
 * Verificano: fetch → connect/logout + messaggi; errore di connessione →
 * EmailAdapterError (mai crash CLI); sendMessage → transport con soggetto
 * (D1); errore di invio → EmailAdapterError; markSeen → flag \Seen per UID
 * (D7); markSeen senza id → no-op.
 */
import { describe, expect, it } from 'vitest';

import { EmailAdapter, EmailAdapterError } from '../../../src/channel/email-adapter/index.js';
import type { ImapConnection } from '../../../src/channel/email-adapter/imap-client.js';
import type { SmtpTransport } from '../../../src/channel/email-adapter/smtp-client.js';

/** Connessione IMAP fake con registrazione delle chiamate. */
function fakeImap(): {
  conn: ImapConnection;
  log: string[];
  state: { failConnect: boolean; failConnectTimes: number };
} {
  const log: string[] = [];
  const state = { failConnect: false, failConnectTimes: 0 };
  const conn: ImapConnection = {
    connect: async () => {
      if (state.failConnectTimes > 0) {
        state.failConnectTimes--;
        throw new Error('ECONNREFUSED');
      }
      if (state.failConnect) throw new Error('ECONNREFUSED');
      log.push('connect');
    },
    logout: async () => {
      log.push('logout');
    },
    mailboxOpen: async () => {
      log.push('open');
      return {} as never;
    },
    search: async () => [7],
    fetchOne: async () => ({
      uid: 7,
      seq: 7,
      internalDate: new Date('2026-09-12T09:41:00.000Z'),
      source: Buffer.from('From: a@test.it\r\n\r\nscelgo la Juve win')
    }),
    messageFlagsSet: async (range: unknown, flags: string[]) => {
      log.push(`flags:${String(range)}:${flags.join(',')}`);
      return true;
    }
  };
  return { conn, log, state };
}

/** Transport SMTP fake con registrazione delle chiamate. */
function fakeSmtp(): {
  transport: SmtpTransport;
  calls: Array<Record<string, unknown>>;
  state: { fail: boolean };
} {
  const calls: Array<Record<string, unknown>> = [];
  const state = { fail: false };
  return {
    transport: {
      sendMail: async (opts: Record<string, unknown>) => {
        if (state.fail) throw new Error('SMTP 550');
        calls.push(opts);
        return { messageId: 'm1' };
      }
    } as unknown as SmtpTransport,
    calls,
    state
  };
}

function makeAdapter(): {
  adapter: EmailAdapter;
  imap: ReturnType<typeof fakeImap>;
  smtp: ReturnType<typeof fakeSmtp>;
} {
  const imap = fakeImap();
  const smtp = fakeSmtp();
  const adapter = new EmailAdapter({
    from: 'league@x.it',
    transport: smtp.transport,
    createImap: () => Promise.resolve(imap.conn)
  });
  return { adapter, imap, smtp };
}

describe('EmailAdapter.fetchMessages (D7)', () => {
  it('apre e chiude la connessione, restituisce i messaggi (internaldate)', async () => {
    const { adapter, imap } = makeAdapter();
    const messages = await adapter.fetchMessages();
    // fetchUnseen apre la mailbox (mailboxOpen) prima della search.
    expect(imap.log).toEqual(['connect', 'open', 'logout']);
    expect(messages[0]).toMatchObject({
      id: '7',
      from: 'a@test.it',
      channel: 'email',
      body: 'scelgo la Juve win'
    });
    expect(messages[0]?.receivedAt.toISOString()).toBe('2026-09-12T09:41:00.000Z');
    // D7: nessun flag impostato dal fetch.
    expect(imap.log).not.toContain(expect.stringContaining('flags:'));
  });

  it('errore di connessione → EmailAdapterError (mai crash CLI, RNF9)', async () => {
    const imap = fakeImap();
    imap.state.failConnect = true;
    const adapter = new EmailAdapter({
      from: 'league@x.it',
      transport: fakeSmtp().transport,
      createImap: () => Promise.resolve(imap.conn)
    });
    await expect(adapter.fetchMessages()).rejects.toBeInstanceOf(EmailAdapterError);
    await expect(adapter.fetchMessages()).rejects.toThrow(/Connessione IMAP fallita/);
  });
});

describe('EmailAdapter.sendMessage (D1)', () => {
  it('passa soggetto dal chiamante al transport', async () => {
    const { adapter, smtp } = makeAdapter();
    await adapter.sendMessage('a@test.it', 'corpo', 'Survivor League — Benvenuto TT1TC1');
    expect(smtp.calls[0]).toEqual({
      from: 'league@x.it',
      to: 'a@test.it',
      subject: 'Survivor League — Benvenuto TT1TC1',
      text: 'corpo'
    });
  });

  it('errore di invio → EmailAdapterError con destinatario', async () => {
    const { adapter, smtp } = makeAdapter();
    smtp.state.fail = true;
    await expect(adapter.sendMessage('a@test.it', 'corpo')).rejects.toMatchObject({
      name: 'EmailAdapterError',
      message: expect.stringContaining('a@test.it')
    });
  });
});

describe('EmailAdapter.sendMessage — banner TEST MODE (piano UAT, D2)', () => {
  it('con testMode=true antepone il banner al corpo (seam unico di invio, mai nei template LLM)', async () => {
    const imap = fakeImap();
    const smtp = fakeSmtp();
    const adapter = new EmailAdapter({
      from: 'league@x.it',
      transport: smtp.transport,
      createImap: () => Promise.resolve(imap.conn),
      testMode: true
    });
    await adapter.sendMessage('a@test.it', 'corpo', 'Soggetto');
    const text = smtp.calls[0]?.text as string;
    expect(text).toContain('TEST MODE');
    // Il banner è ANTEposto: il corpo originale resta in coda.
    expect(text.endsWith('corpo')).toBe(true);
    // Il soggetto NON viene toccato (il banner è solo sul corpo, D2).
    expect(smtp.calls[0]?.subject).toBe('Soggetto');
  });

  it('con testMode=false (default) il corpo resta identico, senza banner (regressione)', async () => {
    const { adapter, smtp } = makeAdapter();
    await adapter.sendMessage('a@test.it', 'corpo');
    expect(smtp.calls[0]?.text).toBe('corpo');
    expect(smtp.calls[0]?.text).not.toContain('TEST MODE');
  });
});

describe('EmailAdapter.markSeen (D7, bug fix Task 6)', () => {
  it('apre la mailbox PRIMA di imporre il flag \\Seen per UID del messaggio', async () => {
    const { adapter, imap } = makeAdapter();
    await adapter.markSeen({ id: '7', from: 'a@test.it', channel: 'email', body: 'x', receivedAt: new Date() });
    // Regressione bug critico: la sequenza deve essere connect → mailboxOpen
    // (dove il STORE è valido) → flag → logout, mai STORE senza SELECT.
    expect(imap.log).toEqual(['connect', 'open', 'flags:7:\\Seen', 'logout']);
  });

  it('messaggio senza id → no-op (nessuna connessione)', async () => {
    const { adapter, imap } = makeAdapter();
    await adapter.markSeen({ from: 'a@test.it', channel: 'email', body: 'x', receivedAt: new Date() });
    expect(imap.log).toEqual([]);
  });

  it('connessione transitoriamente fallita → RETRY con nuova connessione, poi successo (fix ETIMEDOUT Gmail)', async () => {
    const imap = fakeImap();
    imap.state.failConnectTimes = 2; // 2 CONNECT falliti, il 3° riesce
    const adapter = new EmailAdapter({
      from: 'league@x.it',
      transport: fakeSmtp().transport,
      createImap: () => Promise.resolve(imap.conn)
    });

    await adapter.markSeen({ id: '7', from: 'a@test.it', channel: 'email', body: 'x', receivedAt: new Date() });

    // 3 tentativi: 2 falliti (connect), il 3° completa open → flag → logout.
    expect(imap.log).toEqual([
      'logout', // tentativo 1 fallito al connect
      'logout', // tentativo 2 fallito al connect
      'connect',
      'open',
      'flags:7:\\Seen',
      'logout'
    ]);
  });

  it('connessione sempre fallita → EmailAdapterError dopo 3 tentativi (messaggio resta non letto, D7)', async () => {
    const imap = fakeImap();
    imap.state.failConnect = true;
    const adapter = new EmailAdapter({
      from: 'league@x.it',
      transport: fakeSmtp().transport,
      createImap: () => Promise.resolve(imap.conn)
    });

    await expect(
      adapter.markSeen({ id: '7', from: 'a@test.it', channel: 'email', body: 'x', receivedAt: new Date() })
    ).rejects.toMatchObject({
      name: 'EmailAdapterError',
      message: expect.stringContaining('3 tentativi')
    });
    // 3 tentativi di connect, nessun flag impostato.
    expect(imap.log.filter((l) => l.startsWith('flags:'))).toEqual([]);
  });
});
