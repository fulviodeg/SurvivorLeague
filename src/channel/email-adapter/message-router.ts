/**
 * Message Router (LLD §1.3/§6.4, piano Task 6.1; briefing Fase 5-6 §4.5, D6/K).
 *
 * Ruolo: funzione PURA di classificazione dei messaggi in ingresso +
 * normalizzazione dell'identità. Regola deterministica (D6):
 *   - mittente NOTO (in `knownEmails`) → `pick`;
 *   - mittente IGNOTO con keyword di iscrizione nel corpo (lista costante
 *     documentata sotto) → `registration`;
 *   - mittente ignoto senza keyword → `pick` (il wiring decide
 *     auto-iscrizione/chiarimento/rifiuto, mai il router);
 *   - corpo vuoto o mittente vuoto → `unknown` (non processabile).
 *
 * Il router NON decide NULLA di gioco (LLD §1.3): produce
 * `{ kind, identity, body }`; auto-iscrizione e rifiuti sono del Game Engine.
 *
 * Normalizzazione identità (K): `normalizeEmail` applica trim, minuscolo e
 * rimozione del nome visualizzato ("Mario Rossi <mario@x.it>" →
 * "mario@x.it"); Gmail non distingue maiuscole. La STESSA normalizzazione è
 * applicata da `tournament:register` (CLI) — identità coerente su tutto il
 * sistema (RNF2).
 */
import type { IncomingMessage } from '../adapter.js';
import type { ExternalIdentity } from '../../game/eligibility.js';

/** Esito della classificazione del router (nessuna decisione di gioco). */
export type MessageKind = 'pick' | 'registration' | 'unknown';

/** Messaggio classificato: identità normalizzata + tipo di azione candidata. */
export interface RoutedMessage {
  kind: MessageKind;
  /** Identità normalizzata del mittente (channel + indirizzo minuscolo, K). */
  identity: ExternalIdentity;
  /** Corpo del messaggio (trim); vuoto solo per kind 'unknown'. */
  body: string;
}

/**
 * Keyword esplicite di intenzione di iscrizione (lista COSTANTE documentata,
 * D6): la presenza nel corpo di un mittente ignoto classifica il messaggio
 * come `registration`. Match case-insensitive su sottostringa.
 */
export const REGISTRATION_KEYWORDS = [
  'iscriv',
  'mi iscrivo',
  'partecipo',
  'vorrei giocare',
  'registr'
] as const;

/**
 * Normalizza un indirizzo email grezzo: rimuove il nome visualizzato
 * ("Mario Rossi <mario@x.it>" → "mario@x.it"), trim e minuscolo (K/RNF2).
 * Senza parte angolata resta il testo trimmato/minuscolo.
 */
export function normalizeEmail(raw: string): string {
  const bracketed = /<([^<>]+)>/.exec(raw);
  const address = bracketed !== null ? (bracketed[1] ?? '') : raw;
  return address.trim().toLowerCase();
}

/**
 * Classifica un messaggio in ingresso (regola deterministica D6) e ne
 * normalizza l'identità. Nessuna logica di gioco (LLD §1.3): il wiring
 * (src/channel/email-processor.ts) decide le azioni sui moduli di gioco.
 */
export function classify(message: IncomingMessage, knownEmails: Set<string>): RoutedMessage {
  const identifier = normalizeEmail(message.from);
  const body = message.body.trim();
  const identity: ExternalIdentity = { channel: message.channel, identifier };

  if (identifier === '' || body === '') {
    return { kind: 'unknown', identity, body };
  }
  if (knownEmails.has(identifier)) {
    return { kind: 'pick', identity, body };
  }
  const hasRegistrationIntent = REGISTRATION_KEYWORDS.some((keyword) =>
    body.toLowerCase().includes(keyword)
  );
  if (hasRegistrationIntent) {
    return { kind: 'registration', identity, body };
  }
  return { kind: 'pick', identity, body };
}
