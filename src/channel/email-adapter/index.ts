/**
 * EmailAdapter (LLD §6.4, piano Task 6.1; briefing Fase 5-6 §4, D7).
 *
 * Ruolo: implementazione POC dell'interfaccia `ChannelAdapter` sul canale
 * email (IMAP per ricevere, SMTP per inviare). È un ADAPTER SOTTILE: non
 * contiene logica di gioco né classificazione (Message Router a parte); la
 * connessione IMAP (factory) e il transport SMTP sono iniettati dal chiamante
 * (src/cli/email-wiring.ts) — seam per i test: niente rete nei test, oggetti
 * fake che imitano il sottoinsieme usato (LLD §8).
 *
 * Contratto (D7): `fetchMessages` NON marca nulla (sola lettura, idempotente);
 * `markSeen(message)` imposta il flag \Seen (UID) ed è invocato dal wiring
 * SOLO a messaggio processato con successo, con retry limitato su errori di
 * connessione transitori (vedi metodo). Errori di connessione/invio →
 * `EmailAdapterError` (messaggio chiaro, senza crash CLI — RNF9).
 */
import type { ChannelAdapter, IncomingMessage } from '../adapter.js';
import { fetchUnseen, markSeen, type ImapConnection } from './imap-client.js';
import { sendMail, type SmtpTransport } from './smtp-client.js';

/** Errore chiaro del canale email (connessione/invio): contratto CLI (RNF9). */
export class EmailAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailAdapterError';
  }
}

/** Tentativi massimi di `markSeen` (stress test 2026-08-16: ETIMEDOUT transitori di Gmail sotto churn). */
const MARK_SEEN_ATTEMPTS = 3;
/** Pausa (ms) tra i tentativi di `markSeen` (una nuova connessione per tentativo). */
const MARK_SEEN_RETRY_DELAY_MS = 1_000;

/** Pausa in millisecondi (promise resolvable, testabile con fake timers). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dipendenze dell'adapter, iniettate dal chiamante (nessuna rete nei test). */
export interface EmailAdapterParams {
  /** Mittente delle email in uscita (SMTP_USER). */
  from: string;
  /** Transport SMTP (nodemailer), costruito dal chiamante. */
  transport: SmtpTransport;
  /**
   * Factory della connessione IMAP: crea UNA NUOVA connessione a ogni
   * fetch/markSeen (il chiamante la costruisce da config, mai qui).
   */
  createImap: () => Promise<ImapConnection>;
  /**
   * Test mode (D2/D3 del piano UAT): quando `true`, ogni email INVIATA riceve
   * il banner "TEST MODE" anteposto al corpo a livello di invio (seam unico,
   * mai nei template LLM). Default `false` = nessuna modifica.
   */
  testMode?: boolean;
}

/** Banner anteposto al corpo delle email inviate in test mode (D2). */
const TEST_MODE_EMAIL_BANNER = '[TEST MODE] This email was sent by a test instance of Survivor League.\n\n';

/**
 * Implementazione email di `ChannelAdapter`: fetch via IMAP (internaldate,
 * ADR-001; nessun flag in lettura, D7), invio via SMTP con soggetto opzionale
 * (D1). Espone inoltre `markSeen` (concreto, fuori dall'interfaccia) per il
 * flag \Seen a processamento riuscito.
 */
export class EmailAdapter implements ChannelAdapter {
  private readonly from: string;
  private readonly transport: SmtpTransport;
  private readonly createImap: () => Promise<ImapConnection>;
  private readonly testMode: boolean;

  constructor(params: EmailAdapterParams) {
    this.from = params.from;
    this.transport = params.transport;
    this.createImap = params.createImap;
    this.testMode = params.testMode ?? false;
  }

  /**
   * Recupera i messaggi NON LETTI dalla casella: apre una connessione IMAP
   * (factory iniettata), scarica, chiude la connessione. NON marca nulla
   * (D7). Errore di connessione → EmailAdapterError (mai crash CLI).
   */
  async fetchMessages(): Promise<IncomingMessage[]> {
    const conn = await this.createImap();
    try {
      await conn.connect();
      return await fetchUnseen(conn);
    } catch (error) {
      throw new EmailAdapterError(
        `Connessione IMAP fallita: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await conn.logout().catch(() => undefined);
    }
  }

  /**
   * Invia un'email via SMTP (soggetto opzionale, D1). In test mode (D2) il
   * banner "TEST MODE" è anteposto al corpo QUI — punto unico del canale di
   * invio, mai nei template LLM. Errore di invio → EmailAdapterError con
   * destinatario nel messaggio.
   */
  async sendMessage(to: string, body: string, subject?: string): Promise<void> {
    const finalBody = this.testMode ? TEST_MODE_EMAIL_BANNER + body : body;
    try {
      await sendMail(this.transport, { from: this.from, to, subject, text: finalBody });
    } catch (error) {
      throw new EmailAdapterError(
        `Invio email a ${to} fallito: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Marca un messaggio come letto (flag \Seen) tramite il suo UID (`id`).
   * D7: il wiring lo invoca SOLO a messaggio processato con successo; su
   * errore rifiuta (il messaggio resta non letto, retry al tick successivo).
   * Resilienza (stress test 2026-08-16): sotto churn di connessioni rapide
   * Gmail risponde con ETIMEDOUT transitori in fase di CONNECT; l'operazione
   * è quindi ritentata fino a `MARK_SEEN_ATTEMPTS` volte con una connessione
   * NUOVA a ogni tentativo (dopo un timeout la connessione è morta), con
   * pausa `MARK_SEEN_RETRY_DELAY_MS`. Il flag è idempotente: ritentare è
   * sempre sicuro. Solo dopo l'esaurimento dei tentativi lancia
   * `EmailAdapterError` (D7 invariato: messaggio non letto → reprocessato al
   * prossimo tick).
   */
  async markSeen(message: IncomingMessage): Promise<void> {
    if (message.id === undefined) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < MARK_SEEN_ATTEMPTS; attempt++) {
      try {
        const conn = await this.createImap();
        try {
          await conn.connect();
          await markSeen(conn, message.id);
          return;
        } finally {
          await conn.logout().catch(() => undefined);
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < MARK_SEEN_ATTEMPTS - 1) {
        await delay(MARK_SEEN_RETRY_DELAY_MS);
      }
    }
    throw new EmailAdapterError(
      `Flag \\Seen fallito per il messaggio ${message.id} (${MARK_SEEN_ATTEMPTS} tentativi): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }
}
