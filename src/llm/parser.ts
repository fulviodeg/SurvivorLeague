/**
 * LLM Parser (LLD §6.2, piano Task 5.1; briefing Fase 5-6 §2, D2/D3).
 *
 * Ruolo: estrae `{team, outcome}` dal testo libero di un'email (italiano).
 * È un confine I/O puro (ADR-004): NON accede mai a DB/stato di gioco e non
 * usa getConfig() — la lista canonica delle squadre e il contenuto della
 * risorsa alias sono INIETTATI PER CHIAMATA (`PickParseOptions`, D2/E):
 * l'import stagionale può cambiare le squadre a metà torneo e la risorsa
 * alias è editabile a mano senza ricompilare. In test mode (D7) la CLI
 * inietta la risorsa alias SINTETICA (Serie B) e il flag `testMode`, che fa
 * chiarire al prompt la lega sintetica (mai mischiare Serie A e B, CS7).
 *
 * Doppia barriera (D2/C): il filtro deterministico esatto (squadra non nella
 * lista → null) vive QUI (confine I/O: nessun nome spurio esce dall'I/O); il
 * check del Game Engine (Pick Processor, passo 2 della cascata → motivo
 * `unknown_team`) resta come seconda barriera di difesa in profondità.
 *
 * Contratto d'errore (D3): null SOLO per contenuto ambiguo/irriconoscibile/
 * malformato (mai eccezioni, CS7); `LLMError` (src/llm/errors.ts) per
 * trasporto/HTTP/timeout (rilanciata dal client). Lista vuota → null
 * deterministico senza chiamare l'API.
 *
 * Prompt di sistema: ruolo + lista canonica + contenuto aliases + istruzione
 * "team DEVE essere esattamente un nome della lista; se ambiguo/assente →
 * {"team": null}" + "mai inventare nomi". Output vincolato con `response_format
 * json_object` e validato con zod.
 */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { OpenAIClient } from './openai-client.js';

/** Esito dell'estrazione: nome CANONICO della squadra + esito previsto. */
export interface PickExtraction {
  team: string;
  outcome: 'win' | 'draw' | 'lose';
}

/** Dati iniettati per chiamata: lista canonica + risorsa alias (D2/E). */
export interface PickParseOptions {
  /** Lista canonica da `SeasonDataProvider.getTeams()` (mai letta dal DB qui). */
  teams: string[];
  /** Contenuto testuale della risorsa alias (team-aliases.md o sintetica, D7). */
  aliases: string;
  /**
   * Test mode (D7): quando `true` la lista canonica è il calendario sintetico
   * di Serie B e il prompt chiarisce la lega (NON Serie A). Default assente =
   * produzione (Serie A). Iniettato dalla CLI, mai letto da config qui.
   */
  testMode?: boolean;
}

/** Contratto del Parser (LLD §6.2): mai eccezioni per il contenuto, LLMError per il trasporto. */
export interface LLMParser {
  /** Estrae il pick dal testo; null su ambiguo/irriconoscibile (CS7). */
  extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null>;
}

/** Schema zod dell'output LLM: team/outcome nullable (l'assenza è "ambiguo"). */
const extractionSchema = z.object({
  team: z.string().nullable(),
  outcome: z.enum(['win', 'draw', 'lose']).nullable()
});

/** Percorso della risorsa alias di PRODUZIONE (Serie A 2025/26, legata all'API). */
const PROD_ALIASES_URL = new URL('./team-aliases.md', import.meta.url);
/** Percorso della risorsa alias SINTETICA (Serie B, test-only, NON legata all'API). */
const SYNTHETIC_ALIASES_URL = new URL('./team-aliases-synthetic.md', import.meta.url);

/**
 * Carica la risorsa alias per il prompt in base al test mode (D7): in test
 * mode restituisce la risorsa sintetica (`team-aliases-synthetic.md`, Serie B),
 * altrimenti quella di produzione (`team-aliases.md`, Serie A). Usa
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
 */
export function buildParseSystemPrompt(opts: PickParseOptions): string {
  const list = opts.teams.map((t, i) => `${i + 1}. ${t}`).join('\n');
  // Contesto lega (D7): in test mode la lista canonica è il calendario
  // sintetico di Serie B, NON la Serie A — va dichiarato per non confondere
  // l'LLM e preservare la robustezza CS7 (mai mischiare i due campionati).
  const league = opts.testMode
    ? 'un torneo privato di pronostici basato su un campionato sintetico di Serie B (nomi di club cadetti, NON di Serie A).'
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
 */
export class OpenAIParser implements LLMParser {
  private readonly client: OpenAIClient;

  constructor(client: OpenAIClient) {
    this.client = client;
  }

  /**
   * Estrae il pick: prompt di sistema (lista+alias iniettati) + testo email →
   * JSON validato con zod → filtro deterministico esatto. Contenuto ambiguo/
   * malformato → null (mai eccezioni, CS7); lista vuota → null senza chiamare
   * l'API; errori di trasporto/HTTP → LLMError rilanciata (D3).
   */
  async extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null> {
    // Lista vuota (es. DB senza dati stagione): esito null deterministico, nessuna chiamata API.
    if (opts.teams.length === 0) return null;

    const raw = await this.client.chatCompletion(
      { system: buildParseSystemPrompt(opts), user: emailBody },
      'json_object'
    );

    return this.parseExtraction(raw, opts.teams);
  }

  /**
   * Valida il testo restituito dall'LLM: JSON → zod → filtro esatto sulla
   * lista canonica. Qualsiasi scostamento (JSON malformato, campi mancanti,
   * nome fuori lista, esito invalido) → null senza eccezioni (CS7).
   */
  private parseExtraction(raw: string, teams: string[]): PickExtraction | null {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = extractionSchema.safeParse(data);
    if (!parsed.success) return null;
    const { team, outcome } = parsed.data;
    // Filtro deterministico esatto (D2): solo nomi canonici; l'LLM propone, il check dispone.
    if (team === null || outcome === null) return null;
    if (!teams.includes(team)) return null;
    return { team, outcome };
  }
}
