/**
 * LLM Generator (ADR-011 "Email v2"; già LLD §6.3, piano Task 5.2).
 *
 * Ruolo: produce il CORPO email in italiano per ogni `EmailType`. Il Game
 * Engine compone un `EmailContext` DETERMINISTICO (solo dati, nessuna
 * presentazione) e delega all'LLM SOLO il testo narrativo (2-4 frasi,
 * ADR-004: l'LLM è confinato all'I/O, non decide nulla); il renderer
 * deterministico di canale `src/llm/email-renderer.ts` compone poi header,
 * box (esito/deadline/bruciate/partite/stato aggregato) e CTA attorno alla
 * narrativa — la RESA appartiene al canale, i DATI di `EmailContext` sono
 * canale-agnostici (un futuro WebAdapter riusa gli stessi dati con un
 * renderer dedicato).
 *
 *  Questo file definisce:
 *   - i TIPI condivisi (`EmailType`, `EmailContext`, `LLMGenerator`), usati
 *     dal Game Engine e mockati nei suoi test;
 *   - l'helper puro `subjectFor(ctx)` (D1): soggetto deterministico in forma
 *     "⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - etichetta" (TC
 *     assente → senza prefisso di turno; il subject porta il SOLO turno di
 *     campionato, la coppia TT/TC resta nel corpo). MAI dall'LLM, MAI sigle
 *     TT/TC (RF-25, convenzione 1/4 approvata: soggetti neutri per gli esiti);
 *   - la guardia anti-degenerazione `deterministicNarrative` (+ costante
 *     `MAX_NARRATIVE_CHARS`): l'output LLM è validato (lunghezza, non vuoto)
 *     e, se degenerato/vuoto, sostituito dalla narrativa deterministica per
 *     tipo (`DETERMINISTIC_NARRATIVES`, src/llm/templates.ts) — MAI spazzatura;
 *   - l'implementazione POC `OpenAIGenerator` (API OpenAI-compatibile):
 *     template di sistema (src/llm/templates.ts) + contesto serializzato →
 *     chiamata al client condiviso → guardia → composizione `renderEmailV2(ctx,
 *     narrative, timeZone)`. I numeri di turno NON entrano MAI nel prompt
 *     (ADR-004/RF-25): la coppia è scritta dal renderer dai dati.
 *
 * Nessun accesso a DB/stato/config: client e fuso sono iniettati dal
 * chiamante (CLI/wiring); errori di trasporto → `LLMError` rilanciata (D3,
 * mai silenziosa: il chiamante decide se notificare).
 */
import { narrativeFor, serializeEmailContext, templateFor } from './templates.js';
import { renderEmailV2 } from './email-renderer.js';
import { OpenAIClient } from './openai-client.js';
import type { GameMode } from '../game/mode.js';
import { modeFor } from '../game/mode.js';

/** Tutti i tipi di email previsti dal POC, nell'ordine di enum. */
export const EMAIL_TYPES = [
  'platform_registered', // conferma iscrizione piattaforma (RF-P1, ADR-009)
  'platform_unsubscribe_confirm', // barriera due passi: primo unsubscribe → pending (RF-P2)
  'platform_unsubscribed', // soft-delete confermata (RF-P2)
  'platform_already_registered', // re-iscrizione da account già active (ADR-009, decisione (f)/B6)
  'tournament_open', // apertura torneo a tutti gli iscritti attivi (RF-P6): SOLO annuncio
  'pick_instructions', // apertura round: istruzioni + squadre disponibili
  'pick_confirmed', // conferma di registrazione pick; per l'auto-join è l'UNICO messaggio (RF-P5, D5)
  'pick_rejected', // rifiuto pick con motivo
  'pick_missing_elimination', // eliminazione per pick mancante
  'pick_auto_assigned', // auto-pick assegnato a chiusura (feature AUTOPICK): conferma a posteriori
  'round_result_correct', // esito pick corretto
  'round_result_wrong', // esito pick sbagliato (eliminazione)
  'pick_postponed', // notifica passaggio in Freeze (rinvio)
  'round_closed_survived', // riepilogo chiusura round ai SOLI sopravvissuti (RF-P6)
  'tournament_won', // vittoria del torneo
  'tournament_shared_win', // vittoria condivisa
  'clarification', // chiarimento su messaggio non interpretabile (ADR-011, Task 7)
  'tournament_closed' // chiusura torneo con storico per-round (ADR-015, email v4)
] as const;

/** Tipi di email previsti dal POC. */
export type EmailType = (typeof EMAIL_TYPES)[number];

/** Partita nel contesto email (sezione partite/risultati del renderer). */
export interface EmailMatchContext {
  /** Squadra di casa (nome canonico). */
  home: string;
  /** Squadra in trasferta (nome canonico). */
  away: string;
  /** Punteggio (presente solo a partita conclusa). */
  score?: { home: number; away: number };
  /** true se la partita è rinviata/sospesa (senza punteggio). */
  postponed?: boolean;
}

/** Squadra bruciata nel box dedicato (convenzione 3): usata in un round passato. */
export interface EmailBurnedTeam {
  /** Nome canonico della squadra. */
  team: string;
  /** Round del torneo (TT) in cui è stata usata. */
  round: number;
}

/**
 * Giocatore in un elenco nominativo retrospettivo (ADR-015 email v4): usato
 * dal riepilogo `round_closed_survived` e dallo storico `tournament_closed`.
 * Dati SOLO LETTI dal Game Engine (pick/profile/player), mai generati.
 */
export interface EmailPlayerResult {
  /** Nome del giocatore (fallback sull'email quando il nome è assente). */
  name: string;
  /** Squadra del pick nel round (assente = nessun pick). */
  team?: string;
  /** Esito previsto del pick (win|draw|lose; assente = nessun pick). */
  outcome?: string;
  /** true = eliminato IN QUESTO round; false = ancora in gara. */
  eliminated: boolean;
  /**
   * Feature AUTOPICK (D9): true = pick assegnato in automatico alla chiusura
   * (il renderer aggiunge il marcatore "🤖 Auto-assegnato" alla riga).
   */
  autoPick?: boolean;
  /**
   * Feature JOLLY (D9): true = pick dichiarato con jolly (il renderer aggiunge
   * il marcatore "🎯 Jolly" alla riga). Valido per `round_closed_survived` e
   * `tournament_closed` (riusano entrambe playerResultRow).
   */
  jolly?: boolean;
}

/** Storico per-round del torneo per `tournament_closed` (ADR-015 email v4). */
export interface EmailTournamentRound {
  /** Round del TORNEO (TT). */
  round: number;
  /** Turno di CAMPIONATO (TC). */
  championshipRound: number;
  /** Partecipanti del round (stesso formato di `EmailPlayerResult`). */
  players: EmailPlayerResult[];
}

/**
 * Contesto determinista per la generazione di un'email. Tutti i dati
 * variabili (squadre, esiti, motivi, turni, conteggi) arrivano dal Game
 * Engine; il generatore li impagina tramite il renderer di canale. I campi
 * sono OPZIONALI e omessi quando assenti ("se un dato è assente, non
 * inventarlo: ometti la frase"): il renderer salta i blocchi senza dati.
 */
export interface EmailContext {
  /** Tipo di email da generare. */
  type: EmailType;
  /** Nome del giocatore (se noto; assente → il renderer omette l'intestazione). */
  playerName?: string;
  /** Round del TORNEO (TT) — iniettato, mai generato (RF-25); il renderer lo mostra come "Round N". */
  round?: number;
  /** Turno di CAMPIONATO (TC) — iniettato, mai generato; il renderer lo mostra come "Turno di campionato M". */
  championshipRound?: number;
  /** Inizio del round (kickoff della prima partita, istante assoluto): contesto per la narrativa. */
  roundStart?: Date;
  /** Deadline pick del round (istante assoluto): box deadline del renderer. */
  deadline?: Date;
  /**
   * Countdown verso la deadline già calcolato dal Game Engine con
   * `formatRemaining(now, deadline)` (RNF1: il renderer NON usa il clock):
   * mostrato nel box deadline, mai calcolato dall'LLM.
   */
  deadlineRemaining?: string;
  /** Squadra del pick (per conferme/esiti). */
  team?: string;
  /** Esito previsto del pick (win|draw|lose). */
  outcome?: string;
  /** Motivo di rifiuto/eliminazione (dai motivi del Game Engine). */
  reason?: string;
  /** Squadre disponibili per il profilo nel round (decisione 12 del piano). */
  availableTeams?: string[];
  /** Squadre già usate dal giocatore (box bruciate, con il round di utilizzo). */
  burnedTeams?: EmailBurnedTeam[];
  /** Partite del round (sezione partite/risultati). */
  matches?: EmailMatchContext[];
  /** Giocatori ancora in gara (conteggio aggregato, MAI elenchi nominativi). */
  inGameCount?: number;
  /** Eliminati in questo round per pick sbagliato (conteggio aggregato). */
  eliminatedWrong?: number;
  /** Eliminati in questo round per pick mancante (conteggio aggregato). */
  eliminatedMissing?: number;
  /** Iscritti alla piattaforma (per l'annuncio di apertura torneo). */
  platformCount?: number;
  /** Esito del pick per le mail di esito round (correct/wrong/missing). */
  playerResult?: 'correct' | 'wrong' | 'missing';
  /**
   * Elenco nominativo dei giocatori del round (ADR-015 email v4, carve-out
   * della convenzione 6): SOLO per `round_closed_survived` e `tournament_closed`
   * (retrospettive informative). Assente → il renderer omette la sezione e le
   * mail restano sui soli conteggi aggregati.
   */
  players?: EmailPlayerResult[];
  /**
   * Nomi degli ALTRI vincitori (escluso il destinatario) per
   * `tournament_shared_win` (ADR-015 email v4). Assente → sezione omessa;
   * `tournament_won` (vittoria unica) non la imposta.
   */
  coWinners?: string[];
  /**
   * Storico per-round del torneo per `tournament_closed` (ADR-015 email v4):
   * il renderer produce la sezione `📜 STORICO DEL TORNEO`. Assente → omessa.
   */
  tournamentHistory?: EmailTournamentRound[];
  /**
   * Feature JOLLY (D9): true = il pick di QUESTA mail è stato dichiarato con
   * un jolly (flag runtime iniettato dal Game Engine da `pick.jolly_used`,
   * mai ricostruito nei renderer). Usato dalle mail di esito
   * (`round_result_correct`/`round_result_wrong`) e di conferma
   * (`pick_confirmed`).
   */
  jollyUsed?: boolean;
  /**
   * Feature JOLLY (D1/D9): true = il giocatore è stato SALVATO dall'eliminazione
   * dal jolly (pick sbagliato su un pareggio della squadra scelta, trasformato
   * in `correct` dallo scoring). Valido SOLO per `round_result_correct`; dato
   * runtime iniettato dal Game Engine, mai ricostruito.
   */
  savedByJolly?: boolean;
  /**
   * Feature JOLLY (D9): jolly RIMASTI al destinatario
   * (`profile.jollies_remaining`, letto dal Game Engine al momento della
   * notifica). Mostrato nelle mail con istruzioni/conferme/riepiloghi;
   * assente → riga omessa (es. registrati senza profilo).
   */
  jolliesRemaining?: number;
  /**
   * Oggetto esplicito opzionale (D1): se presente, `subjectFor(ctx)` lo usa
   * al posto dell'etichetta composta; chi non lo imposta ottiene il soggetto
   * deterministico standard.
   */
  subject?: string;
}

/** Generatore di testi email: produce il corpo (italiano) dal contesto. */
export interface LLMGenerator {
  /** Genera il testo dell'email per il contesto dato. Mai eccezioni su input ambiguo. */
  generate(ctx: EmailContext): Promise<string>;
}

/**
 * Etichetta del soggetto per ogni tipo di email (deterministica, D1).
 * Convenzione 4 (approvata): i soggetti delle mail di ESITO round sono
 * NEUTRI — non rivelano se il giocatore è ancora in gara o eliminato:
 * `round_closed_survived` usa "Riepilogo Round", gli esiti
 * (`round_result_correct`/`round_result_wrong`/`pick_missing_elimination`)
 * usano "Esito Round". Etichette iper-condensate, senza articoli/preposizioni
 * (email v3).
 */
const SUBJECT_LABELS: Record<EmailType, string> = {
  platform_registered: 'Iscrizione Confermata',
  platform_unsubscribe_confirm: 'Richiesta conferma disiscrizione',
  platform_unsubscribed: 'Disiscrizione Confermata',
  platform_already_registered: 'Già Iscritto',
  tournament_open: 'Torneo Aperto',
  pick_instructions: 'Round Aperto',
  pick_confirmed: 'Pick Registrato',
  pick_rejected: 'Pick Rifiutato',
  pick_missing_elimination: 'Esito Round',
  pick_auto_assigned: 'Pick Auto Assegnato',
  round_result_correct: 'Esito Round',
  round_result_wrong: 'Esito Round',
  pick_postponed: 'Partita Rinviata',
  round_closed_survived: 'Riepilogo Round',
  tournament_won: 'Hai Vinto',
  tournament_shared_win: 'Vittoria Condivisa',
  clarification: 'Non Ho Capito',
  tournament_closed: 'Chiusura Torneo'
};

/**
 * Compone il soggetto dell'email in modo DETERMINISTICO (D1, RF-25) in forma
 * "⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - {etichetta}"; TC
 * assente → "⚽🏆SURVIVOR LEAGUE🏆⚽ - {etichetta}". Il subject porta il SOLO
 * turno di campionato (TC): la coppia "Round N · Turno di campionato M" resta
 * nel corpo (renderer). Mai dall'LLM, mai numeri inventati. `ctx.subject`
 * esplicito ha priorità.
 */
export function subjectFor(ctx: EmailContext): string {
  if (ctx.subject !== undefined && ctx.subject.trim() !== '') return ctx.subject;
  const label = SUBJECT_LABELS[ctx.type];
  const turno =
    ctx.championshipRound !== undefined
      ? `Turno ${ctx.championshipRound} di Campionato - `
      : '';
  return `⚽🏆SURVIVOR LEAGUE🏆⚽ - ${turno}${label}`;
}

/**
 * Limite massimo (caratteri) della narrativa LLM accettata (guardia
 * anti-degenerazione, ADR-004: il testo atteso è di 2-4 frasi BREVI).
 * VERIFICATO con la stagione reale 2025/26 (tests/unit/llm/narrative-guard-real-season.test.ts):
 * una narrativa legittima di 4 frasi arriva a ~600 caratteri (~200 token) anche
 * con contesti ricchi di partite, quindi un limite a 600 produrrebbe FALSI
 * POSITIVI (fallback su testo valido). 1000 caratteri lasciano margine senza
 * far passare i dump degenerati (echo del prompt di sistema / "thinking loop",
 * es. corpi da 239 KB osservati in UAT).
 */
export const MAX_NARRATIVE_CHARS = 1000;

/**
 * Guardia sull'output dell'LLM (pura): accetta SOLO narrativa non vuota e
 * entro `MAX_NARRATIVE_CHARS`; in ogni altro caso (vuoto, whitespace, dump
 * enormi o illeggibili) ripiega sul testo NARRATIVO DETERMINISTICO per tipo
 * (`DETERMINISTIC_NARRATIVES`): mai spedire spazzatura al giocatore. Il
 * fallback è DETERMINISTICO (nessuna chiamata LLM di ripiego, nessuna
 * invenzione: il renderer compone comunque sezioni/CTA dai dati iniettati).
 */
export function deterministicNarrative(ctx: EmailContext, raw: string, mode: GameMode = { winOnly: false, jollyEnabled: false }): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_NARRATIVE_CHARS) {
    // Feature JOLLY: il flag runtime savedByJolly evita la narrativa
    // contraddittoria "hai indovinato" sul pick salvato dal pareggio.
    return narrativeFor(ctx.type, mode, ctx.savedByJolly === true);
  }
  return trimmed;
}

/**
 * Implementazione POC del Generator (API OpenAI-compatibile). Nessun accesso
 * a DB/stato/config: client e fuso orario sono iniettati dal chiamante
 * (CLI/wiring). Il fuso (`TIMEZONE` della configurazione) conta SOLO per la
 * formattazione delle date nel renderer: il sistema di gioco lavora su
 * istanti UTC assoluti. Default `Europe/Rome` = comportamento storico
 * (determinismo RNF1 dei test esistenti).
 */
export class OpenAIGenerator implements LLMGenerator {
  private readonly client: OpenAIClient;
  private readonly timeZone: string;
  private readonly mode: GameMode;

  constructor(client: OpenAIClient, timeZone = 'Europe/Rome', mode: GameMode = modeFor(false, 0)) {
    this.client = client;
    this.timeZone = timeZone;
    this.mode = mode;
  }

  /**
   * Genera il corpo dell'email: template di sistema per il tipo (win_only-aware
   * via `templateFor`, ADR-016) + contesto serializzato (senza numeri di turno
   * — ADR-004/RF-25) → chiamata API per il SOLO testo narrativo → guardia
   * `deterministicNarrative` (output degenerato/vuoto → fallback fisso per
   * tipo, mai spazzatura) → composizione deterministica del renderer di canale
   * `renderEmailV2` (header, box, sezioni dati, CTA; date nel fuso iniettato).
   * Errori di trasporto/HTTP → LLMError rilanciata (D3).
   */
  async generate(ctx: EmailContext): Promise<string> {
    const template = templateFor(ctx.type, this.mode);
    const userMessage = serializeEmailContext(ctx, this.timeZone);
    const raw = await this.client.chatCompletion(
      { system: template, user: userMessage },
      'text'
    );
    const narrative = deterministicNarrative(ctx, raw, this.mode);
    return renderEmailV2(ctx, narrative, this.timeZone, this.mode);
  }
}
