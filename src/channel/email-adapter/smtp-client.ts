/**
 * SMTP Client (LLD §6.4, piano Task 6.1; briefing Fase 5-6 §4.4, D1).
 *
 * Ruolo: invio email via nodemailer. Il modulo è un SEAM per i test: la
 * funzione riceve il TRANSPORT come parametro (`SmtpTransport`, un
 * `Pick<Transporter, 'sendMail'>`) — il transport è costruito dal chiamante
 * (CLI/wiring, src/cli/email-wiring.ts), mai dentro il modulo; i test passano
 * oggetti fake che registrano le chiamate (nessuna rete, LLD §8).
 *
 * Il mittente (`from`) è esplicitato dal chiamante (SMTP_USER): il client
 * non accede a config/DB (ADR-004). Il soggetto arriva dal chiamante (D1:
 * composto con `subjectFor(ctx)` dal Round Manager/Registration/wiring).
 */
import type { Transporter } from 'nodemailer';

/** Sottoinsieme di Transporter usato dal client (seam type-level per i fake). */
export type SmtpTransport = Pick<Transporter, 'sendMail'>;

/** Opzioni dell'invio: destinatario, oggetto (D1), corpo testuale, mittente. */
export interface SendMailOptions {
  /** Mittente (es. SMTP_USER): esplicitato dal chiamante. */
  from: string;
  /** Destinatario (indirizzo email). */
  to: string;
  /** Oggetto dell'email (composto deterministicamente dal chiamante, D1). */
  subject?: string;
  /** Corpo testuale (testo piano). */
  text: string;
}

/**
 * Invia un'email via SMTP: delega a `transport.sendMail` (nodemailer).
 * Errori del transport sono rilanciati al chiamante (il wiring/adapter li
 * traduce in un errore chiaro per la CLI, RNF9).
 */
export async function sendMail(
  transport: SmtpTransport,
  opts: SendMailOptions
): Promise<void> {
  await transport.sendMail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject ?? '',
    text: opts.text
  });
}
