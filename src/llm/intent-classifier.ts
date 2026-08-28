/**
 * LLM Intent Classifier (ADR-009, LLD §6.2; piano Task 6).
 *
 * Ruolo: classifica l'INTENTO di un messaggio email (`subscribe` /
 * `unsubscribe` / `pick` / `other`) ed estrae contestualmente il pick
 * `{team, outcome}` in UNA SOLA chiamata LLM (ADR-004/009, RF-P1/P2): le
 * keyword deterministiche del router (`REGISTRATION_KEYWORDS`) sono rimosse —
 * iscrizione/disiscrizione/pick sono classificati dall'LLM, con barriera
 * deterministica esatta sul pick (doppia barriera D2/C: filtro QUI al confine
 * I/O + check esatto del Pick Processor).
 *
 * Contratto d'errore (D3):
 *   - contenuto ambiguo/malformato (JSON non valido, schema violato, intento
 *     sconosciuto) → `{ intent: 'other', pick: null }` SENZA eccezioni (CS7);
 *   - pick presente ma squadra fuori lista canonica o esito invalido → `pick`
 *     azzerato a null (intento `pick` invariato: era un tentativo di pick,
 *     il chiamante chiede chiarimento);
 *   - trasporto/HTTP/timeout/body malformato → `LLMError` rilanciata (dal
 *     client condiviso): il wiring ferma il batch e ritenta al tick successivo.
 *
 * Confine I/O puro (ADR-004): nessun accesso a DB/stato/config — lista
 * canonica e alias sono INIETTATI per chiamata (`PickParseOptions`, D2/E);
 * `testMode` inietta il contesto lega sintetica (D7). Lista vuota → esito
 * deterministico `other` senza chiamare l'API.
 *
 * `OpenAIParser` (src/llm/parser.ts) resta per `llm:parse` e RIUSA questo
 * classificatore internamente (nessuna duplicazione della logica di
 * estrazione).
 */
import { z } from 'zod';

import type { PickExtraction, PickParseOptions } from './parser.js';
import { OpenAIClient } from './openai-client.js';
import { UNSUBSCRIBE_CONFIRM_WORDS } from './templates.js';

/** Intenti riconosciuti dal classificatore (ADR-009, LLD §6.2). */
export type MessageIntent = 'subscribe' | 'unsubscribe' | 'pick' | 'other';

/**
 * Esito della classificazione: intento + pick (valorizzato solo per `pick`)
 * + `name` (ADR-011, RF-P1): il nome del giocatore dedotto dalla mail di
 * REGISTRAZIONE (valorizzato solo per `subscribe`); null se non indicato —
 * in tal caso il sistema usa l'indirizzo email al posto del nome.
 */
export interface IntentClassification {
  intent: MessageIntent;
  pick: PickExtraction | null;
  name: string | null;
}

/** Contratto del classificatore (LLD §6.2): mai eccezioni per il contenuto. */
export interface LLMIntentClassifier {
  /** Classifica intento + pick del corpo; `other`/`pick:null` su contenuto non interpretabile. */
  classify(body: string, opts: PickParseOptions): Promise<IntentClassification>;
}

/** Schema zod dell'output LLM: intento enum + pick nullable + name (D3, ADR-011). */
const classificationSchema = z.object({
  intent: z.enum(['subscribe', 'unsubscribe', 'pick', 'other']).nullable(),
  pick: z
    .object({
      team: z.string().nullable(),
      outcome: z.enum(['win', 'draw', 'lose']).nullable()
    })
    .nullable(),
  name: z.string().nullable().optional()
});

/**
 * Compone il prompt di sistema del classificatore: ruolo, istruzioni sugli
 * intenti, formato di output vincolato, lista canonica iniettata, contenuto
 * aliases iniettato, vincoli (esatto nome della lista, mai inventare, null su
 * ambiguo). Gli esempi di `unsubscribe` citano anche le conferme
 * (interpolate dalla costante UNICA `UNSUBSCRIBE_CONFIRM_WORDS`, la stessa
 * della barriera e del template — risposte alla richiesta di conferma del
 * sistema, B1/D1/D2): danno più contesto all'LLM, anche se il completamento
 * della barriera resta ancorato al body deterministico (email-processor),
 * non all'intento. Funzione pura (testabile, D2/E/D7).
 */
export function buildClassifySystemPrompt(opts: PickParseOptions): string {
  const list = opts.teams.map((t, i) => `${i + 1}. ${t}`).join('\n');
  // Contesto lega (D7): in test mode la lista canonica è il calendario
  // sintetico (rosa di Serie A, stagione sintetica) — NON la stagione reale
  // importata — va dichiarato per non confondere l'LLM e preservare la
  // robustezza CS7 (mai mischiare i due domini).
  const league = opts.testMode
    ? 'un torneo privato di pronostici basato su un campionato sintetico (rosa di Serie A 2025/26, stagione fittizia di test, NON la stagione reale).'
    : 'un torneo privato di pronostici sulla Serie A.';
  // ADR-016 (win_only): istruzioni dedicate quando la modalità è attiva — il
  // giocatore sceglie SOLO la squadra vincente; una squadra nuda è sufficiente
  // (outcome 'win' implicito), un pareggio/sconfitta esplicito invalida il pick.
  const winOnlyRules =
    opts.winOnly === true
      ? [
          '',
          'MODALITÀ WIN_ONLY: il giocatore sceglie SOLO la squadra che vincerà;',
          'l\'outcome è SEMPRE "win". Se il testo nomina solo una squadra senza esito,',
          'imposta "outcome": "win".',
          'Se il testo esprime esplicitamente un pareggio o una sconfitta della squadra',
          '("pareggia"/"perde"), il pick NON è valido: rispondi con',
          '"pick": {"team": null, "outcome": null} (l\'intent resta "pick").'
        ]
      : [];
  return [
    `Sei il classificatore di Survivor League, ${league}`,
    'Il giocatore scrive un\'email in italiano. Classifica l\'intento del messaggio:',
    '- "subscribe": il giocatore vuole iscriversi (o re-iscriversi) alla piattaforma',
    '  (es. "voglio iscrivermi", "mi iscrivo", "partecipo");',
    '- "unsubscribe": il giocatore vuole disiscriversi dalla piattaforma',
    '  (es. "voglio disiscrivermi", "non voglio più giocare", "rimuovetemi",',
    `  "${UNSUBSCRIBE_CONFIRM_WORDS.join('", "')}" — risposte alla richiesta di conferma del sistema);`,
    '- "pick": il messaggio contiene un pronostico riconoscibile (squadra + esito),',
    '  anche insieme a un saluto o altro testo;',
    '- "other": qualunque altra cosa (chiarimenti, domande, saluti, testo non riconducibile).',
    '',
    'Rispondi SOLO con un oggetto JSON di questo formato esatto:',
    '{"intent": "subscribe"|"unsubscribe"|"pick"|"other", "pick": {"team": "<nome canonico o null>", "outcome": "win"|"draw"|"lose"|null} | null, "name": "<nome del giocatore o null>"}',
    'Se intent non è "pick", il campo "pick" DEVE essere null.',
    'Il campo "name" vale SOLO per "subscribe": è il NOME del giocatore dedotto dal testo',
    'di iscrizione (es. "mi chiamo Mario e voglio iscrivermi" → "name": "Mario").',
    'Se il testo di iscrizione non contiene un nome → "name": null. Per gli altri intenti → "name": null.',
    ...winOnlyRules,
    '',
    'Lista canonica delle squadre (il campo "team" DEVE essere esattamente uno di questi nomi,',
    'nessuna variante, abbreviazione o traduzione):',
    list,
    '',
    'Alias noti che il giocatore può usare (risolvili verso il nome canonico):',
    opts.aliases,
    '',
    'Regole:',
    '- Se il team è ambiguo o non riconducibile a UN SOLO nome della lista, rispondi {"intent": "pick", "pick": {"team": null, "outcome": null}}.',
    '- MAI inventare nomi di squadre: non esiste alcun nome fuori dalla lista.',
    '- L\'esito si riferisce alla squadra scelta: win = vince la squadra scelta,',
    '  draw = pareggio, lose = perde la squadra scelta.',
    '- Se il testo non contiene né iscrizione né disiscrizione né un pick, rispondi {"intent": "other", "pick": null}.'
  ].join('\n');
}

/**
 * Implementazione POC del classificatore via API OpenAI-compatibile (client
 * condiviso). Nessun accesso a DB/stato/config: il client è iniettato dal
 * chiamante (CLI/wiring).
 */
export class OpenAIIntentClassifier implements LLMIntentClassifier {
  private readonly client: OpenAIClient;

  constructor(client: OpenAIClient) {
    this.client = client;
  }

  /**
   * Classifica il corpo: prompt di sistema (lista+alias iniettati) + testo →
   * JSON validato con zod → filtro deterministico esatto sul pick. Contenuto
   * ambiguo/malformato → `other`/`pick:null` (mai eccezioni, CS7); errori di
   * trasporto/HTTP → `LLMError` rilanciata (D3). L'INTENTO è classificato
   * anche con lista squadre vuota (es. DB torneo senza dati stagione):
   * subscribe/unsubscribe restano indipendenti dai dati del torneo (ADR-009,
   * "indipendenti dai round"); il filtro esatto su `parseClassification`
   * azzera comunque il pick (nessun nome della lista vuota può matchare).
   */
  async classify(body: string, opts: PickParseOptions): Promise<IntentClassification> {
    const raw = await this.client.chatCompletion(
      { system: buildClassifySystemPrompt(opts), user: body },
      'json_object'
    );

    return this.parseClassification(raw, opts.teams, opts.winOnly === true);
  }

  /**
   * Valida il testo restituito dall'LLM: JSON → zod → filtro esatto sulla
   * lista canonica. Qualsiasi scostamento strutturale (JSON malformato,
   * intento sconosciuto) → `{intent:'other', pick:null}` senza eccezioni
   * (CS7); intento `pick` con squadra fuori lista o esito invalido → pick
   * azzerato a null (l'LLM propone, il check dispone — doppia barriera D2/C).
   */
  private parseClassification(raw: string, teams: string[], winOnly = false): IntentClassification {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { intent: 'other', pick: null, name: null };
    }
    const parsed = classificationSchema.safeParse(data);
    if (!parsed.success) return { intent: 'other', pick: null, name: null };
    const { intent, pick, name } = parsed.data;
    // `name` (ADR-011): vale SOLO per l'iscrizione; vuoto/non stringa → null.
    const playerName =
      intent === 'subscribe' && typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    if (intent === null || intent !== 'pick') {
      return { intent: intent ?? 'other', pick: null, name: playerName };
    }
    if (pick === null) return { intent: 'pick', pick: null, name: null };
    const { team, outcome } = pick;
    // Filtro deterministico esatto (D2): solo nomi canonici ed esiti validi.
    if (team === null) return { intent: 'pick', pick: null, name: null };
    if (!teams.includes(team)) return { intent: 'pick', pick: null, name: null };
    // ADR-016 (win_only): l'unico esito ammesso è 'win' — un outcome
    // draw/lose esplicito rende il pick non valido (→ pick null, chiarimento);
    // outcome null o 'win' → 'win' (il giocatore sceglie solo la squadra).
    if (winOnly) {
      if (outcome === 'draw' || outcome === 'lose') {
        return { intent: 'pick', pick: null, name: null };
      }
      return { intent: 'pick', pick: { team, outcome: 'win' }, name: null };
    }
    if (outcome === null) return { intent: 'pick', pick: null, name: null };
    return { intent: 'pick', pick: { team, outcome }, name: null };
  }
}
