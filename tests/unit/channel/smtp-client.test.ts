/**
 * Unit test del SMTP client (piano Task 6.1, LLD §6.4; briefing Fase 5-6 §4.4,
 * D1).
 *
 * Transport FAKE (nessuna rete, LLD §8): registra la chiamata `sendMail`.
 * Verificano: soggetto passato dal chiamante (D1), default soggetto vuoto,
 * from/to/text, propagazione degli errori del transport.
 */
import { describe, expect, it } from 'vitest';

import { sendMail, type SmtpTransport } from '../../../src/channel/email-adapter/smtp-client.js';

/** Transport nodemailer fake: registra le invocazioni. */
function fakeTransport(): {
  transport: SmtpTransport;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    transport: {
      sendMail: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return { messageId: 'm1' };
      }
    } as unknown as SmtpTransport,
    calls
  };
}

describe('sendMail (D1)', () => {
  it('invia from/to/subject/text con soggetto dal chiamante', async () => {
    const { transport, calls } = fakeTransport();
    await sendMail(transport, {
      from: 'league@x.it',
      to: 'a@test.it',
      subject: 'Survivor League — Benvenuto TT1TC1',
      text: 'Ciao!'
    });
    expect(calls[0]).toEqual({
      from: 'league@x.it',
      to: 'a@test.it',
      subject: 'Survivor League — Benvenuto TT1TC1',
      text: 'Ciao!'
    });
  });

  it('soggetto assente → stringa vuota (mai undefined)', async () => {
    const { transport, calls } = fakeTransport();
    await sendMail(transport, { from: 'f@x.it', to: 'a@test.it', text: 'corpo' });
    expect(calls[0]?.subject).toBe('');
  });

  it('errori del transport sono rilanciati', async () => {
    const transport = {
      sendMail: async () => {
        throw new Error('SMTP 550');
      }
    } as unknown as SmtpTransport;
    await expect(
      sendMail(transport, { from: 'f@x.it', to: 'a@test.it', text: 'corpo' })
    ).rejects.toThrow('SMTP 550');
  });
});
