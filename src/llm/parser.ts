/**
 * LLM Parser (LLD §6.2, piano Task 5.1; briefing Fase 5-6 §2, D2/D3).
 *
 * Ruolo: estrae `{team, outcome}` dal testo libero di un'email (italiano).
 * È un confine I/O puro (ADR-004): NON accede mai a DB/stato di gioco e non
 * usa getConfig() — la lista canonica delle squadre e il contenuto della
 * risorsa alias sono INIETTATI PER CHIAMATA (`PickParseOptions`, D2/E):
 * l'import stagionale può cambiare le squadre a metà torneo e la risorsa
 * alias è editabile a mano senza ricompilare. In test mode (D7) la CLI
 * inietta la risorsa alias SINTETICA (rosa di Serie A 2026/27 del calendario
 * sintetico) e il flag `testMode`, che fa chiarire al prompt la lega
 * sintetica (mai mischiare calendario sintetico e stagione reale, CS7).
 *
 * Doppia barriera (D2/C): il filtro deterministico esatto (squadra non nella
 * lista → null) vive nel classificatore di intento (confine I/O: nessun nome
 * spurio esce dall'I/O); il check del Game Engine (Pick Processor, passo 2
 * della cascata → motivo `unknown_team`) resta come seconda barriera di
 * difesa in profondità.
 *
 * Contratto d'errore (D3): null SOLO per contenuto ambiguo/irriconoscibile/
 * malformato (mai eccezioni, CS7); `LLMError` (src/llm/errors.ts) per
 * trasporto/HTTP/timeout (rilanciata dal client). Lista vuota → null
 * deterministico senza chiamare l'API.
 *
 * ADR-009 (piano Task 6): l'estrazione è delegata al classificatore di
 * intento (`src/llm/intent-classifier.ts`) — intento + pick in UNA chiamata
 * LLM con output vincolato `json_object` e validazione zod — e il Parser
 * espone il solo contratto storico `extractPick` per `llm:parse`.
 */
import { readFile } from 'node:fs/promises';

import { OpenAIIntentClassifier } from './intent-classifier.js';
import { OpenAIClient } from './openai-client.js';

/** Esito dell'estrazione: nome CANONICO della squadra + esito previsto. */
export interface PickExtraction {
  team: string;
  outcome: 'win' | 'draw' | 'lose';
  /**
   * Jolly dichiarato (feature JOLLY, D4): true se il testo contiene la keyword
   * "jolly" e i jolly sono attivi (`PickParseOptions.jollyEnabled`). Emesso
   * dall'I/O (parser/classificatore) come DATO: la decisione
   * (jolly_not_allowed/no_jollies_left/salvataggio dal pareggio) vive SOLO nel
   * Game Engine. Assente/false = nessun jolly.
   */
  jolly?: boolean;
}

/** Dati iniettati per chiamata: lista canonica + risorsa alias (D2/E). */
export interface PickParseOptions {
  /** Lista canonica da `SeasonDataProvider.getTeams()` (mai letta dal DB qui). */
  teams: string[];
  /** Contenuto testuale della risorsa alias (team-aliases.md o sintetica, D7). */
  aliases: string;
  /**
    * Test mode (D7): quando `true` la lista canonica è il calendario sintetico
    * (rosa di Serie A 2026/27 del calendario sintetico) e il prompt chiarisce
   * la lega sintetica (non la stagione reale). Default assente = produzione.
   * Iniettato dalla CLI, mai letto da config qui.
   */
  testMode?: boolean;
  /**
   * Oggetto dell'email (opzionale, email v3 Parte B): usato SOLO dal parser
   * deterministico (`DeterministicIntentClassifier`) per riconoscere le
   * formule `ISCRIZIONE [NOME]`/`DISISCRIZIONE`/`<TEAM> <ESITO>` nel subject;
   * il classificatore LLM NON lo inietta nel prompt (comportamento invariato).
   */
  subject?: string;
  /**
   * Modalità `win_only` (ADR-016): quando `true` il giocatore sceglie SOLO la
   * squadra che vincerà (outcome sempre 'win'). Parser deterministico e
   * classificatore LLM sono consapevoli della modalità: una squadra nuda
   * registra `{team, 'win'}` (decisione P1), un esito esplicito draw/lose
   * rende il pick NON riconosciuto (→ chiarimento). Iniettato per chiamata
   * come `testMode`, mai letto da config qui.
   */
  winOnly?: boolean;
  /**
   * Jolly attivi (feature JOLLY, D4): quando `true` il parser riconosce la
   * keyword "jolly" (word boundary, case/accenti-insensibile) OVUNQUE nel
   * testo e la propaga come `PickExtraction.jolly = true`; la keyword viene
   * rimossa prima di risolvere squadra+esito (la risoluzione resta quella
   * win_only). Quando assente/false la keyword "jolly" è RUMORE ignorato
   * (pick normale, identico a oggi). Iniettato per chiamata, mai letto da
   * config qui.
   */
  jollyEnabled?: boolean;
}

/** Contratto del Parser (LLD §6.2): mai eccezioni per il contenuto, LLMError per il trasporto. */
export interface LLMParser {
  /** Estrae il pick dal testo; null su ambiguo/irriconoscibile (CS7). */
  extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null>;
}

/** Percorso della risorsa alias di PRODUZIONE (Serie A 2025/26, legata all'API). */
const PROD_ALIASES_URL = new URL('./team-aliases.md', import.meta.url);
/** Percorso della risorsa alias SINTETICA (rosa Serie A 2026/27, test-only). */
const SYNTHETIC_ALIASES_URL = new URL('./team-aliases-synthetic.md', import.meta.url);

/**
 * Carica la risorsa alias per il prompt in base al test mode (D7): in test
 * mode restituisce la risorsa sintetica (`team-aliases-synthetic.md`, rosa
 * Serie A 2026/27), altrimenti quella di produzione (`team-aliases.md`). Usa
 * `new URL(..., import.meta.url)`: indipendente dalla cwd del processo (il
 * build `tsc` non copia asset .md — in POC si gira via tsx dalla root, LLD §5).
 */
export async function loadTeamAliasesFor(testMode: boolean): Promise<string> {
  return readFile(testMode ? SYNTHETIC_ALIASES_URL : PROD_ALIASES_URL, 'utf8');
}

/**
 * Compone il prompt di sistema del Parser: ruolo, istruzioni sul formato,
 * lista canonica iniettata, contenuto aliases iniettato, vincoli (esatto nome
 * della lista, mai inventare, null su ambiguo). Funzione pura (testabile).
 *
 * Nota (ADR-009, piano Task 6): il prompt effettivamente usato dall'estrazione
 * è ora quello del classificatore di intento (`buildClassifySystemPrompt`,
 * src/llm/intent-classifier.ts — intento + pick in UNA chiamata LLM): il
 * Parser ne riusa l'implementazione e questa funzione resta SOLO come helper
 * documentale/di test del formato di estrazione storico.
 */
export function buildParseSystemPrompt(opts: PickParseOptions): string {
  const list = opts.teams.map((t, i) => `${i + 1}. ${t}`).join('\n');
  // Contesto lega (D7): in test mode la lista canonica è il calendario
  // sintetico (rosa di Serie A, stagione sintetica) — NON la stagione reale
  // importata — va dichiarato per non confondere l'LLM e preservare la
  // robustezza CS7 (mai mischiare i due domini).
  const league = opts.testMode
    ? 'un torneo privato di pronostici basato su un campionato sintetico (rosa di Serie A 2026/27, stagione fittizia di test, NON la stagione reale).'
    : 'un torneo privato di pronostici sulla Serie A.';
  return [
    `Sei il parser di Survivor League, ${league}`,
    'Il giocatore scrive un\'email in italiano indicando la squadra scelta e l\'esito previsto',
    '(vittoria, pareggio o sconfitta della squadra scelta).',
    '',
    'Rispondi SOLO con un oggetto JSON di questo formato esatto:',
    '{"team": "<nome canonico della squadra o null>", "outcome": "win"|"draw"|"lose"|null}',
    '',
    'Lista canonica delle squadre (il campo "team" DEVE essere esattamente uno di questi nomi,',
    'nessuna variante, abbreviazione o traduzione):',
    list,
    '',
    'Alias noti che il giocatore può usare (risolvili verso il nome canonico):',
    opts.aliases,
    '',
    'Regole:',
    '- Se il team è ambiguo o non riconducibile a UN SOLO nome della lista, rispondi {"team": null}.',
    '- Se l\'email non contiene un pick riconoscibile, rispondi {"team": null, "outcome": null}.',
    '- MAI inventare nomi di squadre: non esiste alcun nome fuori dalla lista.',
    '- L\'esito si riferisce alla squadra scelta: win = vince la squadra scelta,',
    '  draw = pareggio, lose = perde la squadra scelta.'
  ].join('\n');
}

/**
 * Implementazione POC del Parser via API OpenAI-compatibile (client condiviso).
 * Nessun accesso a DB/stato/config: il client è iniettato dal chiamante.
 *
 * RIUSA internamente il classificatore di intento (ADR-009, piano Task 6):
 * l'estrazione del pick è delegata a `OpenAIIntentClassifier` (intento + pick
 * in UNA chiamata LLM con filtro deterministico esatto) e qui viene esposto
 * solo il contratto storico `extractPick` per `llm:parse` e i chiamanti
 * esistenti — nessuna duplicazione della logica di estrazione.
 */
export class OpenAIParser implements LLMParser {
  private readonly classifier: OpenAIIntentClassifier;

  constructor(client: OpenAIClient) {
    this.classifier = new OpenAIIntentClassifier(client);
  }

  /**
   * Estrae il pick delegando al classificatore: contenuto ambiguo/malformato
   * → null (mai eccezioni, CS7); errori di trasporto/HTTP → LLMError
   * rilanciata (D3). Lista squadre vuota (es. DB senza dati stagione) → null
   * deterministico SENZA chiamare l'API: senza nomi canonici nessun pick è
   * estraibile, quindi la chiamata sarebbe inutile (contratto storico del
   * parser; la classificazione degli intenti di piattaforma — subscribe/
   * unsubscribe — vive nel classificatore, che invece chiama SEMPRE l'LLM
   * per non inghiottire quei flussi, vedi src/llm/intent-classifier.ts).
   */
  async extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null> {
    if (opts.teams.length === 0) return null;
    const result = await this.classifier.classify(emailBody, opts);
    return result.pick;
  }
}
