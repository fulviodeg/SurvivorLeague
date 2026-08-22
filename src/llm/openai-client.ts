/**
 * Client HTTP condiviso per l'API LLM OpenAI-compatibile (briefing Fase 5-6 §2.2/§3.2, D3;
 * piano failover multi-modello, D1-D9).
 *
 * Ruolo: unico punto di accesso all'API di chat completions usato SIA dal
 * Parser (Task 5.1, src/llm/parser.ts) SIA dal Generator (Task 5.2,
 * src/llm/generator.ts) — la chiamata è identica, cambiano solo il prompt e
 * il formato di risposta richiesto. Il client è un confine I/O puro (ADR-004):
 * non accede mai a DB/stato di gioco e non usa getConfig()/process.env —
 * baseUrl, apiKey e modelli sono parametri espliciti iniettati dal chiamante
 * (pattern "la CLI inietta", briefing Fase 3 §1-I).
 *
 * Determinismo (RNF1/RNF7): `temperature: 0` su ogni richiesta. Il formato di
 * risposta è configurabile per chiamata:
 *   - `json_object` (Parser): response_format supportato dalla stragrande
 *     maggioranza degli endpoint OpenAI-compatibili; NIENTE json_schema (non
 *     ovunque supportato: la validazione zod del Parser basta); nessun
 *     `max_tokens` (il JSON non va troncato);
 *   - `text` (Generator): le email sono testo libero, non JSON; `max_tokens`
 *     è impostato a `TEXT_MAX_TOKENS` (200) come cap anti-dump dei modelli
 *     `:free` (output degenerati tipo echo del prompt vengono fermati alla
 *     fonte e la guardia del Generator ripiega sul fallback deterministico).
 *
 * Failover e retry (D2-D5): `models` è una lista in ordine di priorità (il
 * primo è il primario). Per ogni modello si tenta fino a `retries` volte
 * (default 3 = 1 richiesta + 2 ritentativi) SOLO su errori RITENTABILI
 * (status 429, status >= 500, timeout, errore di rete, body malformato —
 * status assente), con delay fisso `RETRY_DELAY_MS` (1s) tra i tentativi;
 * gli errori 4xx deterministici (400/401/403/404) NON vengono ritentati e
 * fanno passare subito al modello successivo (failover). Il failover scatta
 * SOLO su `LLMError` (D3): mai su `null`, che per il Parser è una risposta
 * VALIDA ("pick ambiguo") e non deve cambiare modello. Esauriti tutti i
 * modelli/tentativi il client rilancia un `LLMError` AGGREGATO che elenca i
 * modelli con i rispettivi esiti (D5, con l'ultimo errore specifico in coda
 * per la diagnosi operativa): semantica D7 invariata — il wiring/processor
 * ferma il batch e ritenta al tick successivo.
 *
 * Worst case latenza per messaggio (2.4 del piano): Σ sui modelli di
 * (tentativi × timeout), con 3 modelli × 3 tentativi × 15s ≈ 135 s (+ delay
 * 1s × tentativi); in pratica i fallimenti reali sono rapidi (429/5xx
 * immediati), quindi l'impatto tipico è di pochi secondi.
 *
 * Contratto d'errore (D3): ogni problema di trasporto/HTTP/timeout/body
 * malformato lancia `LLMError` (con status HTTP quando disponibile). Il
 * timeout è configurabile dal chiamante (`LLM_TIMEOUT_MS`, default 15s).
 */
import { LLMError } from './errors.js';

/** Tipo di response_format richiesto alla API (vedi header del modulo). */
export type LlmResponseFormat = 'text' | 'json_object';

/** Parametri espliciti del client, iniettati dal chiamante (CLI/wiring). */
export interface OpenAIClientParams {
  /** Origine dell'API senza path (es. https://api.openai.com/v1), da LLM_API_BASE_URL. */
  baseUrl: string;
  /** Chiave API (header Authorization: Bearer), da LLM_API_KEY. */
  apiKey: string;
  /**
   * Lista dei modelli in ordine di PRIORITÀ (primo = primario), da LLM_MODEL:
   * il client tenta il primo con i suoi retry e, a errori ritentabili
   * esauriti o 4xx deterministico, passa al successivo (failover D2/D4).
   */
  models: string[];
  /** fetch iniettabile per i test (default: fetch nativo di Node ≥20). */
  fetchImpl?: typeof fetch;
  /** Timeout massimo per una singola richiesta in ms (default 15000, da LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Tentativi TOTALI per modello (default 3 = 1 richiesta + 2 ritentativi,
   * da LLM_RETRIES): 1 = nessun ritentativo. Vale solo per errori ritentabili.
   */
  retries?: number;
  /**
   * Diagnostica (D7): callback invocata per OGNI tentativo, con modello,
   * esito e status HTTP (assente per timeout/errore di rete/body malformato).
   * Il wiring la collega a un logger pino; senza callback è no-op.
   */
  onModelTried?: (model: string, ok: boolean, status?: number) => void;
}

/** Timeout di default per richiesta: 15s (costante allineata a LLM_TIMEOUT_MS, D6). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Tentativi di default per modello (D4): 3 = 1 richiesta + 2 ritentativi. */
const DEFAULT_RETRIES = 3;

/** Delay fisso (ms) tra i tentativi dello stesso modello (D4: costante interna, non env var). */
const RETRY_DELAY_MS = 1_000;

/**
 * Token massimi per il formato di risposta `text` (Generator): la narrativa
 * attesa è di 2-4 frasi BREVI in italiano (~150 token bastano), quindi un cap
 * basso limita ALLA FONTE i dump degenerati dei modelli `:free` di OpenRouter
 * (echo del prompt di sistema / "thinking loop", es. corpi da 239 KB osservati
 * in UAT): la risposta viene troncata lato API e la guardia del Generator
 * ripiega sul fallback deterministico. NON si applica a `json_object`
 * (Parser): il JSON di classificazione non va troncato.
 */
export const TEXT_MAX_TOKENS = 200;

/** Chat completion: messaggio di sistema + messaggio utente. */
export interface ChatCompletionMessages {
  /** Prompt di sistema (ruolo/istruzioni/template). */
  system: string;
  /** Messaggio utente (testo email da analizzare, dati di contesto). */
  user: string;
}

/** Pausa tra i tentativi di retry (promise resolvable, testabile con fake timers). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client HTTP verso `/chat/completions` di un endpoint OpenAI-compatibile.
 * Espone UNA operazione (`chatCompletion`); Parser e Generator la usano con
 * prompt e responseFormat diversi. Failover multi-modello + retry limitati
 * per modello (vedi header del modulo).
 */
export class OpenAIClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onModelTried?: (model: string, ok: boolean, status?: number) => void;

  constructor(params: OpenAIClientParams) {
    this.baseUrl = params.baseUrl;
    this.apiKey = params.apiKey;
    this.models = params.models;
    this.fetchImpl = params.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = params.retries ?? DEFAULT_RETRIES;
    this.onModelTried = params.onModelTried;
  }

  /**
   * Invoca una chat completion e restituisce il TESTO del primo choice.
   * - `responseFormat`: 'json_object' per il Parser, 'text' per il Generator.
   * - Failover/retry (D2-D5): per ogni modello fino a `retries` tentativi
   *   (delay `RETRY_DELAY_MS` tra i tentativi) sugli errori ritentabili;
   *   4xx deterministici → failover diretto al modello successivo; lista
   *   esaurita → `LLMError` aggregato con modelli ed esiti.
   * - Errori: HTTP non-2xx → LLMError(status); timeout/errore di rete →
   *   LLMError; body senza choices[0].message.content → LLMError.
   */
  async chatCompletion(messages: ChatCompletionMessages, responseFormat: LlmResponseFormat): Promise<string> {
    const failures: Array<{ model: string; statuses: Array<number | undefined> }> = [];
    let lastStatus: number | undefined;
    let lastError: LLMError | undefined;
    for (const model of this.models) {
      const statuses: Array<number | undefined> = [];
      for (let attempt = 0; attempt < this.retries; attempt++) {
        try {
          const content = await this.requestOnce(model, messages, responseFormat);
          this.onModelTried?.(model, true);
          return content;
        } catch (error) {
          if (!(error instanceof LLMError)) throw error;
          lastError = error;
          statuses.push(error.status);
          // D5: status dell'aggregato = ultimo status CON VALORE in ordine
          // cronologico (timeout/rete/body malformato non hanno status).
          if (error.status !== undefined) lastStatus = error.status;
          this.onModelTried?.(model, false, error.status);
          // Retry solo su errori RITENTABILI (D4): 429, 5xx e status assente
          // (timeout, rete, body malformato). Tutto il resto (400/401/403/404)
          // è deterministico: failover immediato al modello successivo.
          const retryable = error.status === undefined || error.status === 429 || error.status >= 500;
          if (retryable && attempt < this.retries - 1) {
            await delay(RETRY_DELAY_MS);
            continue;
          }
          break;
        }
      }
      failures.push({ model, statuses });
    }
    // D5: errore aggregato che elenca modelli ed esiti; status = ultimo status
    // con valore (nessuno → undefined, come oggi). L'ultimo errore specifico è
    // incluso in coda per la diagnosi operativa (es. body malformato vs rete).
    // Semantica D7 invariata: il batch si ferma e il retry avviene al tick successivo.
    const detail = failures
      .map((f) => `${f.model}: ${f.statuses.length} tentativo/i (${f.statuses.map((s) => s ?? 'rete').join(', ')})`)
      .join('; ');
    const lastDetail = lastError !== undefined ? `; ultimo errore: ${lastError.message}` : '';
    throw new LLMError(`Tutti i modelli LLM hanno fallito: ${detail}${lastDetail}`, lastStatus);
  }

  /**
   * Una singola richiesta HTTP a `/chat/completions` per il modello indicato:
   * costruisce body/header (model, temperature 0, response_format, messages),
   * applica il timeout via AbortController e traduce ogni problema in
   * `LLMError` (status HTTP quando disponibile).
   */
  private async requestOnce(
    model: string,
    messages: ChatCompletionMessages,
    responseFormat: LlmResponseFormat
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format:
            responseFormat === 'json_object' ? { type: 'json_object' as const } : undefined,
          // Cap anti-dump per la narrativa (formato text, Generator):
          // `max_tokens` non è un vincolo ma un limite duro (se il modello
          // "pensa a loop", la risposta si ferma a TEXT_MAX_TOKENS).
          max_tokens: responseFormat === 'text' ? TEXT_MAX_TOKENS : undefined,
          messages: [
            { role: 'system', content: messages.system },
            { role: 'user', content: messages.user }
          ]
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LLMError(`Timeout (${this.timeoutMs}ms) nella richiesta all'API LLM`);
      }
      throw new LLMError(`Errore di rete verso l'API LLM: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const statusText = res.statusText ? ` ${res.statusText}` : '';
      throw new LLMError(
        `Risposta inattesa ${res.status}${statusText} dall'API LLM (modello ${model})`,
        res.status
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new LLMError('Body JSON malformato nella risposta dell\'API LLM');
    }
    const content = (data as {
      choices?: Array<{ message?: { content?: unknown } }>;
    })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LLMError('Risposta dell\'API LLM senza choices[0].message.content testuale');
    }
    return content;
  }
}
