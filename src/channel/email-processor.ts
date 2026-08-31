/**
 * Wiring `channel:email:process` (LLD §1.3/§7.9 v0.5.0, piano Task 8;
 * briefing Fase 5-6 §5, D5/D7/D8/M; ADR-009).
 *
 * Ruolo: ORCHESTRATORE SOTTILE del flusso end-to-end delle email in ingresso:
 * fetch → Message Router (preparazione, D6/K) → Intent Classifier LLM
 * (intento + pick, UNA chiamata, ADR-009) → PlatformRegistry (subscribe/
 * unsubscribe a due passi) e moduli di gioco (dichiarazione/auto-join ADR-019, cascata pick) →
 * risposte email → flag \Seen (D7). NON contiene logica di gioco: ogni
 * decisione è delegata a registry/moduli (AGENTS.md §1.3).
 *
 * Flusso per messaggio:
 *   - `unknown` (corpo/mittente vuoto) → marcato letto, nessuna risposta;
 *   - intento `subscribe`: nuovo → `register` + `platform_registered`; già
 *     `active` → risposta "già iscritto" con tipo email DEDICATO
 *     `platform_already_registered` (decisione (f)/B6: niente riuso
 *     improprio di `pick_rejected`); da `pending_unsubscribe`/
 *     `unsubscribed` → riattiva `active` (stesso `registerID`, RF-P3);
 *   - intento `unsubscribe` (primo, da `active`) → `beginUnsubscribe`
 *     (`pending_unsubscribe`, NESSUNA soft-delete) + `platform_unsubscribe_confirm`;
 *     secondo messaggio (da `pending_unsubscribe`) con body nella lista
 *     `confermo`/`sì`/`si`/`yes` → `confirmUnsubscribe` (soft-delete) +
 *     `platform_unsubscribed` — BARRIERA INTENTO-AGNOSTICA (decisione (a)/B1),
 *     valutata PRIMA dei rami di intento: copre "confermo" classificato
 *     `other` dall'LLM reale (D1/D2); secondo messaggio con intento
 *     `unsubscribe` e body NON in lista → conferma ripetuta, resta pending;
 *     da `unsubscribed`/sconosciuto → **log silenzioso**, marcato letto (RF-P2);
 *   - intento `join` (ADR-019, `PARTECIPO` = partecipazione al torneo, NON
 *     registration): da sconosciuto/`unsubscribed` → log interno, marcato
 *     letto, NESSUNA risposta (anti-spam, RF-P4 — mai una registration);
 *     da `pending_unsubscribe` → riattiva `active` (come pick); poi
 *     `declareParticipation` → `tournament_join_confirmed` /
 *     `tournament_already_joined` / `tournament_join_rejected`;
 *   - intento `pick`: da sconosciuto/`unsubscribed` → **log interno, nessuna
 *     risposta** (anti-spam, RF-P4); da `pending_unsubscribe` → riattiva
 *     `active` e prosegue; da `active` con profilo → cascata attuale
 *     (`pick_confirmed`/`pick_rejected`); da `active` SENZA profilo →
 *     NESSUNA auto-join (ADR-019): nel TT1 `tournament_join_rejected` reason
 *     `not_in_tournament` (testo "per partecipare invia PARTECIPO") o rifiuto
 *     "torneo iniziato" dal TT2;
 *   - intento `other`: da account `active` → chiarimento; da sconosciuto o
 *     da account NON `active` (`unsubscribed`/`pending_unsubscribe`) → log
 *     silenzioso, marcato letto, NESSUNA risposta (decisione 7/ADR-009,
 *     decisione (e)/B5, istanza D3).
 *   - ORDINE (ADR-009): subscribe/unsubscribe/join gestiti PRIMA del gate
 *     `round_not_open` (indipendenti dai round); il ramo pick richiede un
 *     round aperto (CL3). Le risposte dei rami subscribe/unsubscribe/join
 *     partono SEMPRE (flussi di conferma RF-P1/P2 e di partecipazione
 *     ADR-019); le notifiche di torneo (round/broadcast/riepilogo) sono
 *     filtrate altrove su account `active`.
 *   - MITTENTI ATTIVI RIVALUTATI PER MESSAGGIO (HIGH-2): nessuno snapshot di
 *     inizio batch — lo stato dell'account è riletto dal registry a ogni
 *     messaggio, così un `subscribe` seguito da un `pick` dello stesso
 *     mittente nello stesso batch vede il pick accettato.
 *
 * Errori (RNF9/D7): `LLMError`/errore di rete → warn, messaggio NON marcato
 * letto, STOP del batch (retry al tick successivo); altri errori → warn,
 * messaggio non marcato, si continua (best-effort). Nessun crash del comando.
 */
import type { Logger } from 'pino';

import type { IncomingMessage } from './adapter.js';
import type { GameContext } from '../game/context.js';
import { declareParticipation } from '../game/registration.js';
import { registerPick } from '../game/pick-processor.js';
import { formatRemaining } from '../game/round-time.js';
import { getStartRound, turnFor } from '../game/turn.js';
import { assertModeConsistent } from '../game/mode.js';
import { classify, type MessageKind } from './email-adapter/message-router.js';
import { subjectFor, type EmailContext } from '../llm/generator.js';
import { UNSUBSCRIBE_CONFIRM_WORDS } from '../llm/templates.js';
import { LLMError } from '../llm/errors.js';
import type { IntentClassification } from '../llm/intent-classifier.js';
import { shiftReceivedAt } from '../clock.js';

/** Dipendenze del wiring, costruite dal comando CLI (mai getConfig() qui). */
export interface EmailProcessDeps {
  /** Lista canonica delle squadre da `getTeams()` (letta UNA volta per batch). */
  teams: string[];
  /** Contenuto di `team-aliases.md` (letto UNA volta per batch, E). */
  aliases: string;
  /** Flag \Seen a messaggio processato con successo (D7); fornito dall'adapter concreto. */
  markSeen: (message: IncomingMessage) => Promise<void>;
  /** Logger strutturato (pino) del comando CLI. */
  logger: Logger;
  /**
   * Test mode (D7): inoltrato al classificatore perché scelga il contesto
   * lega e inietti la risorsa alias sintetica. Default assente = produzione.
   */
  testMode?: boolean;
}

/** Azione di esito per un messaggio (diagnostica/output JSON del comando). */
export type ProcessedAction =
  | 'subscribed' // subscribe: account creato/riattivato (RF-P1/P3)
  | 'already_subscribed' // subscribe da account già active
  | 'unsubscribe_pending' // primo unsubscribe → pending (RF-P2)
  | 'unsubscribe_confirmed' // secondo unsubscribe → soft-delete (RF-P2)
  | 'unsubscribe_silent' // unsubscribe da unsubscribed/sconosciuto (RF-P2)
  | 'pick_registered'
  | 'pick_rejected'
  | 'clarification' // formato non riconosciuto / other da account active (B5)
  | 'join_confirmed' // dichiarazione PARTECIPO riuscita (ADR-019)
  | 'join_rejected' // dichiarazione rifiutata (nessun torneo / torneo iniziato)
  | 'already_joined' // dichiarazione da account già in gara (idempotenza D8)
  | 'rejected_tt2' // iscritto senza profilo dal TT2
  | 'silent_pick' // pick da sconosciuto/disiscritto (RF-P4)
  | 'silent_other' // other da sconosciuto o account non active (RF-P4, decisione (e)/B5)
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

/**
 * Formula del pick nelle risposte di rifiuto/chiarimento (ADR-016): in
 * modalità `win_only` il giocatore sceglie SOLO la squadra che vincerà, quindi
 * il testo chiede "solo il nome della squadra che vincerà"; in modalità
 * classica resta "squadra + esito (win, draw, lose)".
 */
function pickFormula(winOnly: boolean): string {
  return winOnly ? 'solo il nome della squadra che vincerà' : 'squadra + esito (win, draw, lose)';
}

/**
 * Motivi di rifiuto jolly in forma UMANA (feature JOLLY, D11): i motivi
 * `no_jollies_left` e `jolly_not_allowed` sono tradotti in italiano per le
 * risposte `pick_rejected` (la chiave del renderer è
 * "PICK NON REGISTRATO: <motivo>"). Gli altri motivi restano invariati (null
 * → il chiamante usa il motivo grezzo).
 */
function jollyReasonText(reason: string): string | null {
  if (reason === 'no_jollies_left') return 'non hai più jolly disponibili';
  if (reason === 'jolly_not_allowed') return 'il jolly non è ammesso in questa modalità';
  return null;
}

/** Motivo di rifiuto leggibile: testo umano jolly se presente, altrimenti il motivo grezzo. */
function readableReason(reason: string): string {
  return jollyReasonText(reason) ?? reason;
}

/**
 * "Round corrente" del wiring (D8): il PRIMO `round_state` con status 'open'
 * (le righe esistono solo sulla finestra `[start_round..N]`, stessa semantica
 * di `tournament:status`). Nessun round aperto → null (rifiuto CL3 per il ramo
 * pick).
 */
export function currentOpenRound(db: GameContext['db']): number | null {
  const row = db
    .prepare("SELECT round FROM round_state WHERE status = 'open' ORDER BY round LIMIT 1")
    .get() as { round: number } | undefined;
  return row?.round ?? null;
}

/**
 * Contesto di round per le risposte del wiring (ADR-011): coppia umana
 * (round/championshipRound), deadline registrata e countdown verso la
 * deadline calcolato col clock iniettato (`formatRemaining`, RNF1: mai
 * `new Date()` qui). La deadline è presente solo a round APERTO con
 * deadline registrata; senza round aperto il contesto è vuoto.
 */
function roundEmailContext(
  ctx: GameContext,
  round: number
): Pick<EmailContext, 'round' | 'championshipRound' | 'deadline' | 'deadlineRemaining'> {
  const { tt, tc } = turnFor(ctx.db, round);
  const rs = ctx.db
    .prepare('SELECT deadline FROM round_state WHERE round = ?')
    .get(round) as { deadline: string | null } | undefined;
  const deadline = rs?.deadline != null ? new Date(rs.deadline) : undefined;
  // LOW-3: il countdown "Mancano circa…" ha senso SOLO prima della deadline;
  // oltre la scadenza il renderer mostra la data nel box ma omette il
  // countdown (fuorviante). `formatRemaining` resta puro e invariato.
  return {
    round: tt,
    championshipRound: tc,
    ...(deadline !== undefined
      ? { deadline, ...(ctx.now < deadline ? { deadlineRemaining: formatRemaining(ctx.now, deadline) } : {}) }
      : {})
  };
}

/**
 * Body di conferma della disiscrizione (RF-P2): normalizzato (trim, minuscolo)
 * e confrontato ESATTO. La lista deriva dalla costante UNICA
 * `UNSUBSCRIBE_CONFIRM_WORDS` (src/llm/templates.ts), condivisa con il
 * template di richiesta conferma e col prompt del classificatore: niente
 * copie divergenti sulla barriera (decisione (a)/B1).
 */
const UNSUBSCRIBE_CONFIRM_BODIES: Set<string> = new Set(UNSUBSCRIBE_CONFIRM_WORDS);

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

/**
 * Testo del rifiuto "torneo iniziato" (ADR-019, dal TT2). Il TC può mancare
 * quando non esiste un round aperto: in tal caso il messaggio omette la coppia.
 */
function startedRejectionReason(tc: number | null | undefined): string {
  return tc === null || tc === undefined
    ? 'torneo iniziato: la partecipazione è chiusa (deadline del TT 1 superata)'
    : `torneo iniziato al TT 1, TC ${tc}: la partecipazione è chiusa (deadline del TT 1 superata)`;
}

/**
 * Il corpo conferma la disiscrizione (RF-P2): confronto ESATTO sul corpo
 * normalizzato (trim, minuscolo) con la lista `confermo`/`sì`/`si`/`yes`.
 */
function isUnsubscribeConfirmation(body: string): boolean {
  return UNSUBSCRIBE_CONFIRM_BODIES.has(body.trim().toLowerCase());
}

/**
 * Processa un SINGOLO messaggio: router → classificatore LLM → barriera
 * unsubscribe intento-agnostica (pending + body di conferma, decisione (a))
 * → rami subscribe/unsubscribe (PRIMA del gate round) / pick / other →
 * risposta → markSeen. Le eccezioni di trasporto (LLMError) escono: le
 * gestisce il batch (stop, retry al tick successivo — D7).
 */
async function processOne(
  ctx: GameContext,
  message: IncomingMessage,
  deps: EmailProcessDeps,
  round: number | null
): Promise<ProcessedMessage> {
  const { db } = ctx;
  const platform = ctx.platform;
  const classifier = ctx.classifier;
  if (platform === undefined || classifier === undefined) {
    throw new Error(
      'channel:email:process richiede il PlatformRegistry e il classificatore nel contesto (ADR-009)'
    );
  }
  const routed = classify(message);
  const { identity, kind } = routed;

  if (kind === 'unknown') {
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'unknown', seen: true };
  }

  const clazz: IntentClassification = await classifier.classify(routed.body, {
    teams: deps.teams,
    aliases: deps.aliases,
    testMode: deps.testMode,
    subject: routed.subject,
    winOnly: ctx.config.WIN_ONLY,
    // Feature JOLLY (D4): riconoscere la keyword "jolly" solo quando i jolly
    // sono attivi (win_only && JOLLIES_PER_PLAYER >= 1).
    jollyEnabled: ctx.config.WIN_ONLY && ctx.config.JOLLIES_PER_PLAYER >= 1
  });

  // Stato dell'account RIletto a ogni messaggio (HIGH-2: nessuno snapshot di
  // inizio batch — un subscribe precedente nello stesso batch è già visibile).
  const account = platform.find(identity.identifier);

  // --- BARRIERA UNSUBSCRIBE (decisione (a), B1): il completamento della
  // soft-delete è INTENTO-AGNOSTICO. Se l'account è `pending_unsubscribe` e
  // il body è una conferma ESATTA della lista (`confermo`/`sì`/`si`/`yes`,
  // normalizzato), la disiscrizione si completa QUALUNQUE sia l'intento
  // classificato: l'LLM reale classifica la risposta "confermo" come `other`
  // (D1/D2) e senza questa barriera l'utente resterebbe in deadlock nel ramo
  // chiarimento. Valutata PRIMA di tutti i rami di intento; il ramo
  // `unsubscribe` più sotto resta invariato per gli altri casi. ---
  if (account?.status === 'pending_unsubscribe' && isUnsubscribeConfirmation(routed.body)) {
    platform.confirmUnsubscribe(identity.identifier, ctx.now);
    await sendReply(ctx, identity.identifier, { type: 'platform_unsubscribed' });
    await deps.markSeen(message);
    deps.logger.info(
      { email: identity.identifier, intent: clazz.intent },
      'email:process: unsubscribe confirmed via barrier (confirmation body, intent-agnostic)'
    );
    return { from: message.from, kind, action: 'unsubscribe_confirmed', seen: true };
  }

  // --- Subscribe/unsubscribe: PRIMA del gate round_not_open (indipendenti dai
  // round, ADR-009). Le risposte di questo ramo partono SEMPRE: sono il flusso
  // di conferma di RF-P1/P2 (il filtro `active` vale per le notifiche di
  // torneo, non per queste conferme). ---
  if (clazz.intent === 'subscribe') {
    // ADR-011: il nome dedotto dalla mail di registrazione (classificatore)
    // è salvato sull'account alla creazione; null → il sistema userà l'email.
    const registered =
      account === null
        ? platform.register(identity.identifier, clazz.name, ctx.now)
        : account;
    if (account !== null && account.status !== 'active') {
      platform.reactivate(identity.identifier, ctx.now);
    }
    // Già `active` → tipo email dedicato "già iscritto" (decisione (f)/B6):
    // il soggetto deterministico è "Già iscritto alla piattaforma" (D1);
    // il riuso di `pick_rejected` ("Pick non registrato") era UX fuorviante
    // (report §3). Reason e action `already_subscribed` INVARIATI.
    const reply: EmailContext =
      account !== null && account.status === 'active'
        ? {
            type: 'platform_already_registered',
            playerName: account.name ?? account.email,
            reason: 'sei già iscritto alla piattaforma (email_already_registered)'
          }
        : {
            type: 'platform_registered',
            playerName: registered.name ?? registered.email
          };
    await sendReply(ctx, identity.identifier, reply);
    await deps.markSeen(message);
    deps.logger.info(
      { email: identity.identifier, registerId: registered.registerId, intent: 'subscribe' },
      'email:process: subscribe elaborato'
    );
    return {
      from: message.from,
      kind,
      action: account !== null && account.status === 'active' ? 'already_subscribed' : 'subscribed',
      seen: true
    };
  }

  if (clazz.intent === 'unsubscribe') {
    if (account === null || account.status === 'unsubscribed') {
      // RF-P2: da unsubscribed/sconosciuto → log SILENZIOSO (nessuna risposta).
      deps.logger.info(
        { email: identity.identifier, intent: 'unsubscribe' },
        'email:process: unsubscribe ignorato (account unsubscribed o sconosciuto)'
      );
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'unsubscribe_silent', seen: true };
    }
    if (account.status === 'active') {
      // Primo messaggio: NESSUNA soft-delete → pending + conferma (RF-P2).
      platform.beginUnsubscribe(identity.identifier, ctx.now);
      await sendReply(ctx, identity.identifier, { type: 'platform_unsubscribe_confirm' });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'unsubscribe_pending', seen: true };
    }
    // pending_unsubscribe con intento unsubscribe: il completamento della
    // soft-delete avviene SOLO nella barriera intento-agnostica sopra (B1,
    // decisione (a)) — arrivare qui con un body di conferma è impossibile
    // (la barriera lo intercetta PRIMA dei rami di intento). Resta quindi il
    // solo caso raggiungibile: body NON in lista → si ripete la richiesta di
    // conferma e lo stato resta pending (la barriera resta a due passi, RF-P2).
    await sendReply(ctx, identity.identifier, { type: 'platform_unsubscribe_confirm' });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'unsubscribe_pending', seen: true };
  }

  // --- Ramo join (ADR-019): PARTECIPO = partecipazione al torneo (NON
  // registration). Da sconosciuto/unsubscribed → log silenzioso, marcato
  // letto (RF-P4: un join non è mai una registration); da pending →
  // riattiva active (come pick); poi declareParticipation. Il ramo è PRIMA
  // del gate round_not_open: la dichiarazione è ammessa anche con round 1
  // `pending` (finestra TT1, simmetrica all'auto-join). ---
  if (clazz.intent === 'join') {
    if (account === null || account.status === 'unsubscribed') {
      deps.logger.info(
        { email: identity.identifier, intent: 'join' },
        'email:process: join da mittente non iscritto — log interno, nessuna risposta (RF-P4)'
      );
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'silent_other', seen: true };
    }
    if (account.status === 'pending_unsubscribe') {
      // RF-P2: una dichiarazione mentre pending riporta l'account ad active.
      platform.reactivate(identity.identifier, ctx.now);
    }

    const joined = declareParticipation(ctx, identity, {});
    if (joined.ok) {
      await sendReply(ctx, identity.identifier, {
        type: 'tournament_join_confirmed',
        // ADR-011: box deadline presente SOLO se un round è aperto (la
        // dichiarazione può arrivare con round 1 ancora `pending`).
        ...(round === null ? {} : roundEmailContext(ctx, round)),
        playerName: account.name ?? account.email
      });
      await deps.markSeen(message);
      deps.logger.info(
        { email: identity.identifier, profileId: joined.profileId, intent: 'join' },
        'email:process: join confermato'
      );
      return { from: message.from, kind, action: 'join_confirmed', seen: true };
    }
    if (joined.reason === 'already_joined') {
      await sendReply(ctx, identity.identifier, {
        type: 'tournament_already_joined',
        playerName: account.name ?? account.email
      });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'already_joined', seen: true };
    }
    if (joined.reason === 'no_tournament') {
      await sendReply(ctx, identity.identifier, {
        type: 'tournament_join_rejected',
        playerName: account.name ?? account.email,
        reason: 'no_tournament'
      });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'join_rejected', detail: 'no_tournament', seen: true };
    }
    // late_requires_reason: il torneo è iniziato, partecipazione chiusa — il
    // testo al giocatore è "il torneo è iniziato" (mai il motivo di override,
    // che è SOLO CLI, D10). Il reason dell'email è `tournament_started`.
    await sendReply(ctx, identity.identifier, {
      type: 'tournament_join_rejected',
      playerName: account.name ?? account.email,
      reason: 'tournament_started'
    });
    await deps.markSeen(message);
    return {
      from: message.from,
      kind,
      action: 'join_rejected',
      detail: 'tournament_started',
      seen: true
    };
  }

  // --- Ramo pick: richiede un round aperto (CL3); da sconosciuto/unsubscribed
  // → log interno SENZA risposta (anti-spam, RF-P4); da pending → riattiva. ---
  if (clazz.intent === 'pick') {
    if (account === null || account.status === 'unsubscribed') {
      deps.logger.info(
        { email: identity.identifier, intent: 'pick' },
        'email:process: pick da mittente non iscritto — log interno, nessuna risposta (RF-P4)'
      );
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'silent_pick', seen: true };
    }
    if (account.status === 'pending_unsubscribe') {
      // RF-P2: un pick mentre pending riporta l'account ad active.
      platform.reactivate(identity.identifier, ctx.now);
    }

    if (round === null) {
      await sendReply(ctx, identity.identifier, {
        type: 'pick_rejected',
        reason: 'nessun turno è aperto in questo momento (round_not_open)'
      });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'round_not_open', seen: true };
    }

    // ADR-011: coppia umana + deadline + countdown nelle risposte di pick
    // (box deadline del renderer quando il round è aperto).
    const roundCtx = roundEmailContext(ctx, round);

    const profile = db
      .prepare(
        `SELECT p.id FROM profile p JOIN player pl ON pl.id = p.player_id
         WHERE pl.email = ? ORDER BY p.id LIMIT 1`
      )
      .get(identity.identifier) as { id: number } | undefined;

    if (profile === undefined) {
      // Iscritto SENZA profilo (ADR-019): il pick NON crea più profili
      // (rimosso l'auto-join al primo pick, RF-P5 di ADR-009). Se il pick non
      // è riconoscibile → chiarimento che insegna la formula di join; dal TT2
      // → rifiuto "torneo iniziato" (invariato); nel TT1 con pick valido →
      // guida alla dichiarazione (PARTECIPO).
      if (clazz.pick === null) {
        await sendReply(ctx, identity.identifier, {
          type: 'clarification',
          ...roundCtx,
          reason: `non ho riconosciuto la tua richiesta: per partecipare al torneo invia PARTECIPO`
        });
        await deps.markSeen(message);
        return { from: message.from, kind, action: 'clarification', seen: true };
      }
      if (round !== getStartRound(db)) {
        await sendReply(ctx, identity.identifier, {
          type: 'pick_rejected',
          ...roundCtx,
          reason: startedRejectionReason(roundCtx.championshipRound)
        });
        await deps.markSeen(message);
        return { from: message.from, kind, action: 'rejected_tt2', seen: true };
      }
      // TT1 + pick valido ma SENZA profilo: non si può ancora inviare un pick
      // (nessuna auto-join) → guida alla dichiarazione (join).
      await sendReply(ctx, identity.identifier, {
        type: 'tournament_join_rejected',
        ...roundCtx,
        playerName: account.name ?? account.email,
        reason: 'not_in_tournament'
      });
      await deps.markSeen(message);
      return {
        from: message.from,
        kind,
        action: 'join_rejected',
        detail: 'not_in_tournament',
        seen: true
      };
    }

    // Iscritto CON profilo: cascata attuale (CL5/CS7 su pick non estratto).
    if (clazz.pick === null) {
      await sendReply(ctx, identity.identifier, {
        type: 'pick_rejected',
        ...roundCtx,
        reason: `formato non riconosciuto: invia ${pickFormula(ctx.config.WIN_ONLY)}`
      });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'clarification', detail: 'unrecognized_format', seen: true };
    }
    const result = await registerPick(ctx, {
      profileId: profile.id,
      round,
      team: clazz.pick.team,
      outcome: clazz.pick.outcome,
      jolly: clazz.pick.jolly === true,
      receivedAt: message.receivedAt
    });
    if (result.ok) {
      // Feature JOLLY: conferma con jolly dichiarato + contatore aggiornato.
      const jolliesRemaining = (
        db.prepare('SELECT jollies_remaining FROM profile WHERE id = ?').get(profile.id) as {
          jollies_remaining: number;
        }
      ).jollies_remaining;
      await sendReply(ctx, identity.identifier, {
        type: 'pick_confirmed',
        ...roundCtx,
        team: clazz.pick.team,
        outcome: clazz.pick.outcome,
        jollyUsed: clazz.pick.jolly === true,
        jolliesRemaining
      });
      await deps.markSeen(message);
      return { from: message.from, kind, action: 'pick_registered', seen: true };
    }
    await sendReply(ctx, identity.identifier, {
      type: 'pick_rejected',
      ...roundCtx,
      team: clazz.pick.team,
      outcome: clazz.pick.outcome,
      // Feature JOLLY (D11): i motivi jolly in italiano, gli altri invariati.
      reason: readableReason(result.reason)
    });
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'pick_rejected', detail: result.reason, seen: true };
  }

  // --- Other: da sconosciuto → log silenzioso (anti-spam, RF-P4); da account
  // NON `active` (`unsubscribed`/`pending_unsubscribe`) → log interno, marcato
  // letto, NESSUNA risposta (decisione 7/ADR-009, decisione (e)/B5 — istanza
  // non dichiarata D3: il filtro "nessuna email a non active" vale anche qui).
  // Il chiarimento parte SOLO per account `active`; la barriera B1 sopra resta
  // PRIMA di questo ramo (pending + "confermo" completa comunque la
  // soft-delete). ---
  if (account === null) {
    deps.logger.info(
      { email: identity.identifier, intent: 'other' },
      'email:process: other da mittente sconosciuto — log interno, nessuna risposta (RF-P4)'
    );
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'silent_other', seen: true };
  }
  if (account.status !== 'active') {
    deps.logger.info(
      { email: identity.identifier, intent: 'other', accountStatus: account.status },
      'email:process: other from non-active account — internal log, no reply (decision 7 / ADR-009)'
    );
    await deps.markSeen(message);
    return { from: message.from, kind, action: 'silent_other', seen: true };
  }
  // ADR-011 (Task 7): il chiarimento usa il tipo DEDICATO `clarification`
  // (soggetto "Non ho capito", CTA con le 3 opzioni + formula iscrizione col
  // nome — convenzione 7); box deadline incluso se un round è aperto.
  await sendReply(ctx, identity.identifier, {
    type: 'clarification',
    ...(round === null ? {} : roundEmailContext(ctx, round)),
    reason: `non ho capito la tua richiesta: puoi iscriverti ("voglio iscrivermi"), disiscriverti ("voglio disiscrivermi"), partecipare al torneo ("PARTECIPO") o inviare un pick (${pickFormula(ctx.config.WIN_ONLY)})`
  });
  await deps.markSeen(message);
  return { from: message.from, kind, action: 'clarification', seen: true };
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
  if (
    ctx.channel === undefined ||
    ctx.generator === undefined ||
    ctx.classifier === undefined ||
    ctx.platform === undefined
  ) {
    throw new Error(
      'channel:email:process richiede channel, generator, classificatore e platform nel contesto'
    );
  }

  // ADR-016: guardia fatal PRIMA del loop messaggi (fuori dal try/catch
  // per-messaggio): un cambio di modalità a torneo aperto aborta il batch
  // SENZA processare né inviare nulla. Il throw propaga al comando CLI.
  assertModeConsistent(ctx);

  const round = currentOpenRound(ctx.db);
  const results: ProcessedMessage[] = [];
  let stopped = false;

  // Offset test-only unificato (D9): il receivedAt di ogni messaggio è
  // shiftato UNA SOLA volta all'ingresso del batch, PRIMA della cascata
  // registerPick (che usa message.receivedAt come
  // evidenza anti-frode). Shift monotono: stesso delta a tutti i messaggi →
  // ordine di arrivo preservato. MAI applicare anche nel comando channel.ts
  // (doppio shift).
  const incoming = messages.map((message) => ({
    ...message,
    receivedAt: shiftReceivedAt(message.receivedAt, ctx.config)
  }));

  for (const message of incoming) {
    try {
      const outcome = await processOne(ctx, message, deps, round);
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
