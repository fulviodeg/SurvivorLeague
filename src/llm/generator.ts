/**
 * LLM Generator (LLD §6.3, piano Task 5.2; briefing Fase 5-6 §3, D1/D4/D9).
 *
 * Ruolo: produce il testo email in italiano per ogni `EmailType`. Il Game
 * Engine (Round Manager, Task 3.5) compone un `EmailContext` DETERMINISTICO e
 * delega la produzione del testo all'LLM tramite l'interfaccia (ADR-004: l'LLM
 * è confinato all'I/O, non decide nulla). Questo file definisce:
 *   - i TIPI condivisi (`EmailType`, `EmailContext`, `LLMGenerator`), usati
 *     dal Game Engine e mockati nei suoi test;
 *   - l'helper puro `subjectFor(ctx)` (D1): soggetto dell'email composto
 *     deterministicamente (etichetta per tipo + forma compatta `TT2TC7`,
 *     RF-25) — MAI dall'LLM, mai numeri inventati;
 *   - l'implementazione POC `OpenAIGenerator` (API OpenAI-compatibile):
 *     template di sistema (src/llm/templates.ts) + contesto serializzato →
 *     chiamata al client condiviso → sostituzione post-generazione del
 *     segnaposto `{{TT_TC}}`/`{{TTTC}}` con `turnExtended/turnCompact`
 *     (D4): i numeri TT/TC non entrano MAI nel prompt (ADR-004/RF-25).
 *
 * Nessun accesso a DB/stato/config: il client è iniettato dal chiamante
 * (CLI/wiring); errori di trasporto → `LLMError` rilanciata (D3, mai
 * silenziosa: il chiamante decide se notificare).
 */
import { EMAIL_TEMPLATES, serializeEmailContext } from './templates.js';
import { turnCompact, turnExtended } from '../game/turn.js';
import { OpenAIClient } from './openai-client.js';
import { TURN_PLACEHOLDER_COMPACT, TURN_PLACEHOLDER_EXTENDED } from './templates.js';

/** Tutti i tipi di email previsti dal POC (LLD §6.3 v0.5.0), nell'ordine di enum. */
export const EMAIL_TYPES = [
  'platform_registered', // conferma iscrizione piattaforma (RF-P1, ADR-009)
  'platform_unsubscribe_confirm', // barriera due passi: primo unsubscribe → pending (RF-P2)
  'platform_unsubscribed', // soft-delete confermata (RF-P2)
  'platform_already_registered', // re-iscrizione da account già active (ADR-009, decisione (f)/B6)
  'tournament_open', // apertura torneo a tutti gli iscritti attivi (RF-P6)
  'pick_instructions', // apertura round: istruzioni + squadre disponibili
  'pick_confirmed', // conferma di registrazione pick; per l'auto-join è l'UNICO messaggio (RF-P5, D5)
  'pick_rejected', // rifiuto pick con motivo
  'pick_missing_elimination', // eliminazione per pick mancante
  'round_result_correct', // esito pick corretto
  'round_result_wrong', // esito pick sbagliato (eliminazione)
  'pick_postponed', // notifica passaggio in Freeze (rinvio)
  'round_closed_survived', // riepilogo chiusura round ai SOLI sopravvissuti (RF-P6)
  'tournament_won', // vittoria del torneo
  'tournament_shared_win' // vittoria condivisa
] as const;

/** Tipi di email previsti dal POC (LLD §6.3). */
export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Contesto determinista per la generazione di un'email. Tutti i dati variabili
 * (squadre disponibili, esiti, motivi, TT/TC) arrivano dal Game Engine; il
 * generatore li impagina in italiano.
 */
export interface EmailContext {
  /** Tipo di email da generare. */
  type: EmailType;
  /** Nome del giocatore (se noto). */
  playerName?: string;
  /** Turno di campionato (TC) e di torneo (TT) — iniettati, mai generati (RF-25). */
  tc?: number;
  tt?: number;
  /**
   * Oggetto esplicito opzionale (D1): se presente, `subjectFor(ctx)` lo usa
   * al posto dell'etichetta composta; chi non lo imposta ottiene il soggetto
   * deterministico standard.
   */
  subject?: string;
  /** Squadra del pick (per conferme/esiti). */
  team?: string;
  /** Esito del pick (win|draw|lose) o esito della partita. */
  outcome?: string;
  /** Motivo di rifiuto/eliminazione (dai motivi del Game Engine). */
  reason?: string;
  /** Squadre disponibili per il profilo nel round (decisione 12 del piano). */
  availableTeams?: string[];
  /** Deadline del round (per le istruzioni di invio pick). */
  deadline?: Date;
}

/** Generatore di testi email: produce il corpo (italiano) dal contesto. */
export interface LLMGenerator {
  /** Genera il testo dell'email per il contesto dato. Mai eccezioni su input ambiguo. */
  generate(ctx: EmailContext): Promise<string>;
}

/** Etichetta del soggetto per ogni tipo di email (deterministica, D1). */
const SUBJECT_LABELS: Record<EmailType, string> = {
  platform_registered: 'Iscrizione confermata',
  platform_unsubscribe_confirm: 'Conferma la disiscrizione',
  platform_unsubscribed: 'Disiscrizione confermata',
  platform_already_registered: 'Già iscritto alla piattaforma',
  tournament_open: 'Il torneo è aperto',
  pick_instructions: 'Invia il tuo pick',
  pick_confirmed: 'Pick registrato',
  pick_rejected: 'Pick non registrato',
  pick_missing_elimination: 'Eliminazione: pick mancante',
  round_result_correct: 'Pick corretto',
  round_result_wrong: 'Pick sbagliato',
  pick_postponed: 'Partita rinviata',
  round_closed_survived: 'Riepilogo turno',
  tournament_won: 'Hai vinto il torneo',
  tournament_shared_win: 'Vittoria condivisa'
};

/**
 * Compone il soggetto dell'email in modo DETERMINISTICO (D1, RF-25):
 * "Survivor League — {etichetta tipo} {TT2TC7}" (forma compatta). Mai dall'LLM,
 * mai numeri inventati. `ctx.subject` esplicito ha priorità; senza coppia
 * TT/TC il soggetto è solo "Survivor League — {etichetta}".
 */
export function subjectFor(ctx: EmailContext): string {
  if (ctx.subject !== undefined && ctx.subject.trim() !== '') return ctx.subject;
  const label = SUBJECT_LABELS[ctx.type];
  const pair = ctx.tt !== undefined && ctx.tc !== undefined ? ` ${turnCompact(ctx.tt, ctx.tc)}` : '';
  return `Survivor League — ${label}${pair}`;
}

/**
 * Implementazione POC del Generator (API OpenAI-compatibile). Nessun accesso
 * a DB/stato/config: il client è iniettato dal chiamante (CLI/wiring).
 */
export class OpenAIGenerator implements LLMGenerator {
  private readonly client: OpenAIClient;

  constructor(client: OpenAIClient) {
    this.client = client;
  }

  /**
   * Genera il corpo dell'email: template di sistema per il tipo + contesto
   * serializzato (senza tt/tc) → chiamata API → sostituzione deterministica
   * del segnaposto `{{TT_TC}}`/`{{TTTC}}` con la coppia da ctx (D4): il testo
   * contiene ESATTAMENTE la coppia iniettata (RF-25); coppia assente →
   * stringa vuota. Errori di trasporto/HTTP → LLMError rilanciata (D3).
   */
  async generate(ctx: EmailContext): Promise<string> {
    const template = EMAIL_TEMPLATES[ctx.type];
    const userMessage = serializeEmailContext(ctx);
    const text = await this.client.chatCompletion({ system: template, user: userMessage }, 'text');

    const extended =
      ctx.tt !== undefined && ctx.tc !== undefined ? turnExtended(ctx.tt, ctx.tc) : '';
    const compact =
      ctx.tt !== undefined && ctx.tc !== undefined ? turnCompact(ctx.tt, ctx.tc) : '';
    return text
      .replaceAll(TURN_PLACEHOLDER_EXTENDED, extended)
      .replaceAll(TURN_PLACEHOLDER_COMPACT, compact);
  }
}
