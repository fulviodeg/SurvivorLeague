/**
 * Wiring `channel:email:process` (LLD §1.3/§7.9, piano Task 6.2; briefing
 * Fase 5-6 §5, D5/D7/D8/M).
 *
 * Ruolo: ORCHESTRATORE SOTTILE del flusso end-to-end delle email in ingresso:
 * fetch → Message Router (classifica, D6) → "round corrente" (D8) → moduli di
 * gioco esistenti (registration, pick-processor, auto-iscrizione RF-27) →
 * risposte email → flag \Seen (D7). NON contiene logica di gioco: ogni
 * decisione è delegata ai moduli di gioco (AGENTS.md §1.3); il Parser LLM
 * (confine I/O) è mockato nei test del wiring.
 *
 * Flusso per messaggio (§5.2):
 *   - nessun round `open` → rifiuto `round_not_open` (CL3), messaggio marcato
 *     letto (non processabile: D7 esteso, niente rifiuti ripetuti a ogni tick);
 *   - `registration` (mittente ignoto + keyword): `registerPlayer` → `welcome`;
 *     finestra chiusa → rifiuto "torneo iniziato al TT 1 / TC n" (CL2/RF-03);
 *   - `pick` da mittente NOTO: Parser → `registerPick` (cascata completa,
 *     guard RF-31 con `receivedAt` = internaldate) → `pick_confirmed` o
 *     `pick_rejected` con motivo esplicito (RF-09: si può riprovare);
 *     non interpretabile → rifiuto "formato non riconosciuto" (CL5/CS7);
 *   - `pick` da mittente IGNOTO: nel TT1 (round = start_round e finestra
 *     aperta) → Parser: `null` → chiarimento senza profilo (CL5); esito →
 *     `autoRegisterFromPick` (profilo+pick atomici, RF-27) → email UNICA
 *     `auto_registered` (D5) o rifiuto senza profilo; dal TT2 → rifiuto senza
 *     registrazione (RF-24);
 *   - `unknown` (corpo/mittente vuoto) → nessuna risposta, marcato letto.
 *
 * Errori (RNF9/D7): `LLMError`/errore di rete → warn, messaggio NON marcato
 * letto, STOP del batch (retry al tick successivo); altri errori → warn,
 * messaggio non marcato, si continua (best-effort). Nessun crash del comando.
 */
import type { Logger } from 'pino';

import type { IncomingMessage } from './adapter.js';
import type { GameContext } from '../game/context.js';
import { autoRegisterFromPick, registerPlayer } from '../game/registration.js';
import { registerPick } from '../game/pick-processor.js';
import { getStartRound, turnFor } from '../game/turn.js';
import { classify, type MessageKind } from './email-adapter/message-router.js';
import { subjectFor, type EmailContext } from '../llm/generator.js';
import { LLMError } from '../llm/errors.js';
import type { LLMParser } from '../llm/parser.js';
import { shiftReceivedAt } from '../clock.js';

/** Dipendenze del wiring, costruite dal comando CLI (mai getConfig() qui). */
export interface EmailProcessDeps {
  /** Lista canonica delle squadre da `getTeams()` (letta UNA volta per batch). */
  teams: string[];
  /** Contenuto di `team-aliases.md` (letto UNA volta per batch, E). */
  aliases: string;
  /** Indirizzi normalizzati dei giocatori già registrati (mittenti noti, D6). */
  knownEmails: Set<string>;
  /** Flag \Seen a messaggio processato con successo (D7); fornito dall'adapter concreto. */
  markSeen: (message: IncomingMessage) => Promise<void>;
  /** Logger strutturato (pino) del comando CLI. */
  logger: Logger;
  /**
   * Test mode (D7): inoltrato al Parser perché scelga il contesto lega e
   * inietti la risorsa alias sintetica. Default assente = produzione.
   */
  testMode?: boolean;
}

/** Azione di esito per un messaggio (diagnostica/output JSON del comando). */
export type ProcessedAction =
  | 'registration'
  | 'registration_rejected'
  | 'already_registered'
  | 'pick_registered'
  | 'pick_rejected'
  | 'clarification'
  | 'auto_registered'
  | 'auto_rejected'
  | 'rejected_tt2'
  | 'round_not_open'
  | 'unknown'
  | 'error'
  | 'error_llm';

/** Esito del processamento di un singolo messaggio. */
export interface ProcessedMessage {
  from: string;
  kind: MessageKind;
  action: ProcessedAction;
  /** Dettaglio del motivo (reason della cascata, errore) quando presente. */
  detail?: string;
  /** true se il messaggio è stato marcato letto (D7). */
  seen: boolean;
}

/** Esito complessivo del batch. */
export interface ProcessBatchResult {
  processed: number;
  seen: number;
  /** true se il batch si è fermato su LLMError (retry al tick successivo). */
  stopped: boolean;
  messages: ProcessedMessage[];
}

/** Riga `tournament_state` letta per il gate della finestra di iscrizione. */
function registrationWindowOpen(db: GameContext['db']): boolean {
  const row = db
    .prepare('SELECT registration_open FROM tournament_state WHERE id = 1')
    .get() as { registration_open: number } | undefined;
  return row?.registration_open === 1;
}

/**
 * "Round corrente" del wiring (D8): il PRIMO `round_state` con status 'open'
 * (le righe esistono solo sulla finestra `[start_round..N]`, stessa semantica
 * di `tournament:status`). Nessun round aperto → null (rifiuto CL3).
 */
export function currentOpenRound(db: GameContext['db']): number | null {
  const row = db
    .prepare("SELECT round FROM round_state WHERE status = 'open' ORDER BY round LIMIT 1")
    .get() as { round: number } | undefined;
  return row?.round ?? null;
}

/** Invia una risposta email al mittente (canale+generatore dal contesto, soggetto D1). */
async function sendReply(
  ctx: GameContext,
  to: string,
  emailCtx: EmailContext
): Promise<void> {
  if (ctx.channel === undefined || ctx.generator === undefined) {
    throw new Error('channel:email:process richiede channel e generator nel contesto');
  }
  const body = await ctx.generator.generate(emailCtx);
  await ctx.channel.sendMessage(to, body, subjectFor(emailCtx));
}

/** Testo del rifiuto "torneo iniziato" (CL2/RF-03/RF-24): la coppia è iniettata dal ctx. */
function startedRejectionReason(tc: number): string {
  return `torneo iniziato al TT 1, TC ${tc}: la finestra di iscrizione è chiusa`;
}

/**
 * Processa un SINGOLO messaggio (flusso §5.2): classifica → round → moduli di
 * gioco → risposta → markSeen. Le eccezioni di trasporto (LLMError) escono:
 * le gestisce il batch (stop, retry al tick successivo — D7).
 */
async function processOne(
  ctx: GameContext,
  parser: LLMParser,
  message: IncomingMessage,
  deps: EmailProcessDeps,
  round: number | null
): Promise<ProcessedMessage> {
  const { db } = ctx;
  const routed = classify(message, deps.knownEmails);
  const { identity, kind } = routed;

  // D8/CL3: nessun round aperto → rifiuto e messaggio marcato letto (D7 esteso).
  if (round === null) {
    await sendReply(ctx, identity.identifier, {
      type: 'pick_rejected',
      reason: 'nessun turno è aperto in questo momento (round_not_open)'
    });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'round_not_open', seen: true };
  }

  const { tt, tc } = turnFor(db, round);

  // --- Iscrizione (mittente ignoto + keyword, D6) ---
  if (kind === 'registration') {
    const result = registerPlayer(ctx, { email: identity.identifier, identity });
    deps.logger.info(
      { email: identity.identifier, eligibility: result.eligibility, result: result.ok ? 'ok' : result.reason },
      'email:process: registrazione (eligibilità loggata)'
    );
    if (result.ok) {
      await sendReply(ctx, identity.identifier, { type: 'welcome', tt, tc });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'registration', seen: true };
    }
    if (result.reason === 'email_already_registered') {
      await sendReply(ctx, identity.identifier, {
        type: 'pick_rejected',
        tt,
        tc,
        reason: 'sei già registrato al torneo (email_already_registered)'
      });
    } else {
      // Finestra chiusa / non idoneo → rifiuto CL2 (RF-03).
      await sendReply(ctx, identity.identifier, {
        type: 'pick_rejected',
        tt,
        tc,
        reason: startedRejectionReason(tc)
      });
    }
    await deps.markSeen(message);
    return {
      from: message.from,
      kind,
      action: result.reason === 'email_already_registered' ? 'already_registered' : 'registration_rejected',
      detail: result.reason,
      seen: true
    };
  }

  // --- Pick ---
  const isKnown = deps.knownEmails.has(identity.identifier);
  if (isKnown) {
    const profile = db
      .prepare(
        `SELECT p.id FROM profile p JOIN player pl ON pl.id = p.player_id
         WHERE pl.email = ? ORDER BY p.id LIMIT 1`
      )
      .get(identity.identifier) as { id: number } | undefined;

    let action: ProcessedAction = 'pick_registered';
    let detail: string | undefined;

    if (profile === undefined) {
      // Difensivo: mittente noto senza profilo non dovrebbe accadere.
      await sendReply(ctx, identity.identifier, {
        type: 'pick_rejected',
        tt,
        tc,
        reason: 'profilo non registrato (profile_not_registered)'
      });
      action = 'pick_rejected';
      detail = 'profile_not_registered';
    } else {
      const parsed = await parser.extractPick(routed.body, {
        teams: deps.teams,
        aliases: deps.aliases,
        testMode: deps.testMode
      });
      if (parsed === null) {
        // CL5/CS7: formato non riconosciuto → rifiuto con istruzioni, si può riprovare.
        await sendReply(ctx, identity.identifier, {
          type: 'pick_rejected',
          tt,
          tc,
          reason: 'formato non riconosciuto: invia squadra + esito (win, draw, lose)'
        });
        action = 'pick_rejected';
        detail = 'unrecognized_format';
      } else {
        // Cascata completa + guard RF-31 (receivedAt = internaldate, ADR-001).
        const result = await registerPick(ctx, {
          profileId: profile.id,
          round,
          team: parsed.team,
          outcome: parsed.outcome,
          receivedAt: message.receivedAt
        });
        if (result.ok) {
          await sendReply(ctx, identity.identifier, {
            type: 'pick_confirmed',
            tt,
            tc,
            team: parsed.team,
            outcome: parsed.outcome
          });
        } else {
          await sendReply(ctx, identity.identifier, {
            type: 'pick_rejected',
            tt,
            tc,
            team: parsed.team,
            outcome: parsed.outcome,
            reason: result.reason
          });
          action = 'pick_rejected';
          detail = result.reason;
        }
      }
    }
    await deps.markSeen(message);
    return { from: message.from, kind, action, detail, seen: true };
  }

  // --- Pick da mittente IGNOTO (D5/D6): auto-iscrizione RF-27 nel TT1 ---
  const isTt1 = round === getStartRound(db) && registrationWindowOpen(db);
  if (!isTt1) {
    // RF-24: dal TT2 rifiuto SENZA registrazione (CL2).
    await sendReply(ctx, identity.identifier, {
      type: 'pick_rejected',
      tt,
      tc,
      reason: startedRejectionReason(tc)
    });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'rejected_tt2', seen: true };
  }

  const parsed = await parser.extractPick(routed.body, {
    teams: deps.teams,
    aliases: deps.aliases,
    testMode: deps.testMode
  });
  if (parsed === null) {
    // CL5: chiarimento SENZA registrazione (nessun profilo creato).
    await sendReply(ctx, identity.identifier, {
      type: 'pick_rejected',
      tt,
      tc,
      reason:
        'non ho riconosciuto la tua scelta: per iscriverti e registrare il tuo primo pick invia squadra + esito (win, draw, lose)'
    });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'clarification', seen: true };
  }

  const result = await autoRegisterFromPick(ctx, identity, parsed, round, message.receivedAt);
  if (result.ok) {
    // RF-27/D5: UN UNICO messaggio che unisce iscrizione ed esito del pick.
    await sendReply(ctx, identity.identifier, {
      type: 'auto_registered',
      tt,
      tc,
      team: parsed.team,
      outcome: parsed.outcome
    });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'auto_registered', seen: true };
  }
  const detail = result.reason === 'pick_rejected' ? (result.pickReason ?? 'pick_rejected') : result.reason;
  await sendReply(ctx, identity.identifier, {
    type: 'pick_rejected',
    tt,
    tc,
    team: parsed.team,
    outcome: parsed.outcome,
    reason: detail
  });
  await deps.markSeen(message);
  return { from: message.from, kind, action: 'auto_rejected', detail, seen: true };
}

/**
 * Processa un batch di messaggi in ingresso (fetch → process → risposte →
 * flag \Seen a successo). `stopped=true` su LLMError/errore di rete: il
 * messaggio resta non letto e il batch si ferma (retry al tick successivo,
 * D7); gli altri errori sono loggati e il batch continua (best-effort, RNF9).
 */
export async function processEmailBatch(
  ctx: GameContext,
  messages: IncomingMessage[],
  deps: EmailProcessDeps
): Promise<ProcessBatchResult> {
  if (ctx.channel === undefined || ctx.generator === undefined || ctx.parser === undefined) {
    throw new Error('channel:email:process richiede channel, generator e parser nel contesto');
  }

  const round = currentOpenRound(ctx.db);
  const results: ProcessedMessage[] = [];
  let stopped = false;
  const parser = ctx.parser;

  // Offset test-only unificato (D9): il receivedAt di ogni messaggio è
  // shiftato UNA SOLA volta all'ingresso del batch, PRIMA della cascata
  // registerPick/autoRegisterFromPick (che usano message.receivedAt come
  // evidenza anti-frode). Shift monotono: stesso delta a tutti i messaggi →
  // ordine di arrivo preservato. MAI applicare anche nel comando channel.ts
  // (doppio shift).
  const incoming = messages.map((message) => ({
    ...message,
    receivedAt: shiftReceivedAt(message.receivedAt, ctx.config)
  }));

  for (const message of incoming) {
    try {
      const outcome = await processOne(ctx, parser, message, deps, round);
      results.push(outcome);
    } catch (error) {
      if (error instanceof LLMError) {
        deps.logger.warn(
          { error: error.message, status: error.status },
          'email:process: errore LLM — messaggio NON marcato letto, batch fermato (retry al prossimo tick)'
        );
        results.push({
          from: message.from,
          kind: 'unknown',
          action: 'error_llm',
          detail: error.message,
          seen: false
        });
        stopped = true;
        break;
      }
      deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'email:process: errore di processo — messaggio NON marcato letto, si continua (best-effort)'
      );
      results.push({
        from: message.from,
        kind: 'unknown',
        action: 'error',
        detail: error instanceof Error ? error.message : String(error),
        seen: false
      });
    }
  }

  return {
    processed: results.length,
    seen: results.filter((r) => r.seen).length,
    stopped,
    messages: results
  };
}
