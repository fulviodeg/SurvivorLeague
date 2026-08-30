/**
 * Wiring email della CLI (briefing Fase 5-6, problema M; LLD §5).
 *
 * Ruolo: helper condiviso che costruisce le IMPLEMENTAZIONI REALI dei confini
 * I/O delle Fasi 5–6 — `EmailAdapter` (IMAP/SMTP), `OpenAIGenerator` e
 * `OpenAIParser` (API LLM OpenAI-compatibile) — dai valori della
 * configurazione, e le INIETTA nel `GameContext`. È l'unico punto dove i
 * moduli vedono la configurazione: i moduli stessi non chiamano MAI
 * `getConfig()` (AGENTS.md §1.3, briefing Fase 3 §1-I).
 *
 * La costruzione non fa rete: il transport SMTP è creato ma connesso solo
 * all'invio; la connessione IMAP è una factory lazy (una connessione per
 * fetch/markSeen); il client LLM chiama l'API solo al primo parse/generate.
 *
 * Usato da: comandi `round:*` e `tournament:register:*` (notifiche reali) e
 * dai nuovi comandi `channel:email:*`/`llm:*` (Task 5.1/5.2/6.1/6.2).
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import type { AppConfig } from '../config.js';
import { EmailAdapter } from '../channel/email-adapter/index.js';
import { createConnection } from '../db/connection.js';
import { migratePlatform } from '../db/platform-schema.js';
import { DbPlatformRegistry } from '../platform/registry.js';
import type { GameContext } from '../game/context.js';
import { modeFor } from '../game/mode.js';
import { OpenAIClient } from '../llm/openai-client.js';
import { OpenAIIntentClassifier, type LLMIntentClassifier } from '../llm/intent-classifier.js';
import { OpenAIParser } from '../llm/parser.js';
import { OpenAIGenerator, type LLMGenerator } from '../llm/generator.js';
import { DeterministicGenerator, FallbackGenerator } from '../llm/deterministic-generator.js';
import { DeterministicIntentClassifier, FallbackIntentClassifier } from '../llm/deterministic-parser.js';
import { createLogger } from '../logger.js';

/** Componenti I/O reali delle Fasi 5–6/8, pronti da iniettare. */
export interface EmailComponents {
  /** Canale email concreto (IMAP fetch / SMTP send, flag \Seen via markSeen). */
  channel: EmailAdapter;
  /**
   * Generatore dei testi email: deterministico (default) o LLM con fallback
   * deterministico, selezionato da `AI_EMAIL_GENERATOR` (email v3).
   */
  generator: LLMGenerator;
  /** Parser LLM delle email in ingresso (lista+alias iniettati per chiamata, D2). */
  parser: OpenAIParser;
  /**
   * Classificatore di intento (ADR-009): deterministico (default) o LLM con
   * fallback deterministico, selezionato da `AI_EMAIL_PARSER` (email v3 Parte B).
   */
  classifier: LLMIntentClassifier;
}

/**
 * Costruisce le componenti email reali dalla configurazione (mai getConfig()
 * qui: i valori arrivano come parametro). Transport SMTP: host/port da
 * config, `secure: false` = STARTTLS (default nodemailer su 587). Connessione
 * IMAP: `secure: true` su porta 993, auth user/pass (App Password Gmail).
 */
export function buildEmailComponents(config: AppConfig): EmailComponents {
  // Il logger porta il binding testMode quando il test mode è attivo (D3) e
  // il timestamp nel fuso di sistema (ADR-011): ogni riga pino emessa dal
  // canale/LLM reca il campo strutturato testMode e l'orario locale.
  const logger = createLogger(config.LOG_LEVEL, undefined, config.testMode, config.TIMEZONE, config.LOG_FILE);
  const client = new OpenAIClient({
    baseUrl: config.LLM_API_BASE_URL,
    apiKey: config.LLM_API_KEY,
    models: config.LLM_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    retries: config.LLM_RETRIES,
    // Diagnostica D7: ogni tentativo LLM (inclusi i retry dello stesso modello)
    // finisce nei log pino — modello/tentativo usato e status (messaggi in
    // inglese, regola progetto). Niente modifiche agli output CLI.
    onModelTried: (model: string, ok: boolean, status?: number) => {
      logger.info({ model, ok, status }, ok ? 'LLM attempt succeeded' : 'LLM attempt failed');
    }
  });
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: false,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS }
  });
  const channel = new EmailAdapter({
    from: config.SMTP_USER,
    transport,
    // Banner "TEST MODE" sulle email inviate (D2): seam unico nel canale di
    // invio, attivo solo quando config.testMode.
    testMode: config.testMode,
    createImap: () =>
      Promise.resolve(
        new ImapFlow({
          host: config.IMAP_HOST,
          port: config.IMAP_PORT,
          secure: true,
          auth: { user: config.IMAP_USER, pass: config.IMAP_PASS }
        })
      )
  });
  return {
    channel,
    // Email v3: il generatore è deterministico di default (AI_EMAIL_GENERATOR
    // assente/false, MAI chiamate LLM per i testi email); con
    // AI_EMAIL_GENERATOR=true si usa l'LLM avvolto dal FallbackGenerator, che
    // su LLMError ripiega sul corpo deterministico (warn pino {reason, type}).
    // Il fuso di sistema è iniettato in entrambi i generatori (ADR-011).
    generator: config.AI_EMAIL_GENERATOR
      ? new FallbackGenerator(
          new OpenAIGenerator(client, config.TIMEZONE, modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER)),
          new DeterministicGenerator(config.TIMEZONE, modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER)),
          logger
        )
      : new DeterministicGenerator(config.TIMEZONE, modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER)),
    parser: new OpenAIParser(client),
    // Email v3 Parte B: il classificatore di intento è deterministico di
    // default (AI_EMAIL_PARSER assente/false, MAI chiamate LLM per la
    // classificazione); con AI_EMAIL_PARSER=true si usa l'LLM avvolto dal
    // FallbackIntentClassifier, che su LLMError classifica col deterministico
    // (warn pino {reason}) e il batch NON si ferma.
    classifier: config.AI_EMAIL_PARSER
      ? new FallbackIntentClassifier(
          new OpenAIIntentClassifier(client),
          new DeterministicIntentClassifier(),
          logger
        )
      : new DeterministicIntentClassifier()
  };
}

/**
 * Inietta le componenti email reali nel contesto di gioco (pattern
 * "la CLI inietta"): restituisce una copia del contesto con `channel`,
 * `generator`, `parser` e `classifier` impostati.
 */
export function attachEmailToContext(ctx: GameContext, config: AppConfig): GameContext {
  const { channel, generator, parser, classifier } = buildEmailComponents(config);
  return { ...ctx, channel, generator, parser, classifier };
}

/** Contesto con registry piattaforma + connessione da chiudere a fine comando. */
export interface PlatformWiring {
  ctx: GameContext;
  platformDb: ReturnType<typeof createConnection>;
}

/**
 * Wiring del PlatformRegistry (ADR-009, piano Task 10): apre e MIGRA il DB
 * piattaforma (`PLATFORM_DB_PATH`) e inietta `DbPlatformRegistry` nel
 * contesto di gioco — il gate `active` delle notifiche (RF-P6) e
 * dell'eligibilità legge da qui. La connessione va chiusa dal chiamante
 * (`platformDb.close()`): è una seconda connessione DISTINTA dal DB torneo
 * (nessuna transazione cross-DB).
 */
export function attachPlatformToContext(ctx: GameContext, config: AppConfig): PlatformWiring {
  const platformDb = createConnection(config.PLATFORM_DB_PATH);
  migratePlatform(platformDb);
  const platform = new DbPlatformRegistry(platformDb);
  return { ctx: { ...ctx, platform }, platformDb };
}
