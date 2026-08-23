/**
 * Message Router (LLD §1.3/§6.4 v0.5.0, piano Task 6.1/8; briefing Fase 5-6
 * §4.5, D6/K; ADR-009).
 *
 * Ruolo: funzione PURA di PREPARAZIONE dei messaggi in ingresso +
 * normalizzazione dell'identità. La decisione di INTENTO è dell'LLM
 * (ADR-009): il router NON usa più keyword (`REGISTRATION_KEYWORDS` rimossa)
 * e NON conosce più l'insieme dei mittenti noti — produce per ogni messaggio
 * processabile `{ kind: 'classified', identity, body }`, che il wiring
 * (src/channel/email-processor.ts) passa all'Intent Classifier LLM.
 *
 * Preparazione del corpo (piano email-reply-quote-stripping, D1/D6): il body
 * passato al classificatore è la SOLA risposta del giocatore —
 * `extractPlayerReply` (reply-cleaner) rimuove la citazione della mail
 * precedente e limita a 5 righe non vuote (incidente UAT 2026-08-22: la
 * citazione confondeva l'LLM).
 *
 * Regola deterministica (D6/K):
 *   - corpo VUOTO o mittente vuoto → `{ kind: 'unknown' }` (non processabile,
 *     nessuna chiamata LLM, nessun taglio applicato);
 *   - altrimenti → `{ kind: 'classified' }` con identità normalizzata e corpo
 *     pulito dalla citazione.
 *
 * Il router NON decide NULLA di gioco (LLD §1.3): subscribe/unsubscribe/pick/
 * silenzio/auto-join sono decisi dal wiring sui moduli di gioco e sul
 * PlatformRegistry.
 *
 * Normalizzazione identità (K): `normalizeEmail` applica trim, minuscolo e
 * rimozione del nome visualizzato ("Mario Rossi <mario@x.it>" →
 * "mario@x.it"); Gmail non distingue maiuscole. La STESSA normalizzazione è
 * applicata dai comandi CLI (`platform:register`, `pick:register`) — identità
 * coerente su tutto il sistema (RNF2).
 */
import type { IncomingMessage } from '../adapter.js';
import type { ExternalIdentity } from '../../game/eligibility.js';
import { extractPlayerReply } from './reply-cleaner.js';

/**
 * Esito della preparazione del router (nessuna decisione di gioco, ADR-009):
 * `classified` = da passare all'Intent Classifier LLM; `unknown` = corpo/
 * mittente vuoto (nessuna chiamata LLM).
 */
export type MessageKind = 'classified' | 'unknown';

/** Messaggio preparato: identità normalizzata + corpo. */
export interface RoutedMessage {
  kind: MessageKind;
  /** Identità normalizzata del mittente (channel + indirizzo minuscolo, K). */
  identity: ExternalIdentity;
  /** Corpo del messaggio (trim); vuoto solo per kind 'unknown'. */
  body: string;
}

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
 * Prepara un messaggio in ingresso (D6/K): identità normalizzata + corpo
 * pulito dalla citazione della mail precedente (`extractPlayerReply`, piano
 * email-reply-quote-stripping D1: solo il testo del giocatore, max 5 righe non
 * vuote). La classificazione dell'INTENTO è demandata all'LLM (ADR-009): il
 * router distingue solo il caso non processabile (corpo/mittente vuoto →
 * `unknown`, nessuna chiamata LLM, taglio NON applicato) da quello
 * processabile (`classified`). Nessuna logica di gioco (LLD §1.3).
 */
export function classify(message: IncomingMessage): RoutedMessage {
  const identifier = normalizeEmail(message.from);
  const rawBody = message.body.trim();
  const identity: ExternalIdentity = { channel: message.channel, identifier };

  if (identifier === '' || rawBody === '') {
    return { kind: 'unknown', identity, body: rawBody };
  }
  return { kind: 'classified', identity, body: extractPlayerReply(message.body) };
}
