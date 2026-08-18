/**
 * Contract test del LLM Parser (piano Task 5.1, LLD §6.2; briefing Fase 5-6
 * §2, D2/D3/C).
 *
 * HTTP mockato (fetch iniettato, LLD §8). Coprono: estrazione valida con nome
 * canonico; prompt con lista canonica + contenuto aliases iniettati (assert
 * sul body della richiesta, D2/E); squadra fuori lista → null (filtro
 * deterministico, doppia barriera D2/C); risposta ambigua → null; output
 * non-JSON/malformato → null senza crash (CS7); 401/429/timeout → LLMError
 * (D3); lista vuota → null deterministico senza chiamare l'API.
 */
import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../src/llm/errors.js';
import { OpenAIClient } from '../../../src/llm/openai-client.js';
import {
  buildParseSystemPrompt,
  loadTeamAliasesFor,
  OpenAIParser
} from '../../../src/llm/parser.js';

const TEAMS = ['Juventus FC', 'FC Internazionale Milano', 'AC Milan', 'AS Roma'];
const ALIASES = '## Alias\n- juve, bianconeri → Juventus FC\n- inter, nerazzurri → FC Internazionale Milano';

/** Parser con fetch iniettato (test ermetici, nessuna rete). */
function makeParser(fetchImpl: typeof fetch): { parser: OpenAIParser; requests: string[] } {
  const requests: string[] = [];
  const wrapper: typeof fetch = ((url: unknown, init?: unknown) => {
    requests.push(String((init as RequestInit).body));
    return fetchImpl(url as string | URL | Request, init as RequestInit);
  }) as typeof fetch;
  const client = new OpenAIClient({
    baseUrl: 'https://llm.test.example/v1',
    apiKey: 'k',
    models: ['m'],
    retries: 1,
    fetchImpl: wrapper
  });
  return { parser: new OpenAIParser(client), requests };
}

/** Risposta 200 con il testo JSON dell'LLM. */
function jsonText(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const opts = { teams: TEAMS, aliases: ALIASES };

describe('LLM Parser — estrazione (D2/E)', () => {
  it('estrae {team, outcome} con nome canonico e inietta lista + alias nel prompt', async () => {
    const { parser, requests } = makeParser(() =>
      Promise.resolve(jsonText('{"team": "Juventus FC", "outcome": "win"}'))
    );

    const result = await parser.extractPick('Ciao, per questo turno scelgo la Juve vincente!', opts);

    expect(result).toEqual({ team: 'Juventus FC', outcome: 'win' });
    const body = JSON.parse(requests[0] ?? '{}') as {
      response_format?: { type: string };
      messages: Array<{ content: string }>;
    };
    // Output vincolato a JSON (response_format json_object).
    expect(body.response_format).toEqual({ type: 'json_object' });
    const system = body.messages[0]?.content ?? '';
    const user = body.messages[1]?.content ?? '';
    // Lista canonica e aliases iniettati per chiamata (D2/E).
    for (const t of TEAMS) expect(system).toContain(t);
    expect(system).toContain('juve, bianconeri → Juventus FC');
    expect(user).toContain('Ciao, per questo turno scelgo la Juve vincente!');
    // Vincolo: mai inventare nomi / null su ambiguo.
    expect(system.toLowerCase()).toContain('null');
  });

  it('squadra fuori lista → null (filtro deterministico, doppia barriera D2/C)', async () => {
    const { parser } = makeParser(() =>
      Promise.resolve(jsonText('{"team": "Juve Inventata FC", "outcome": "win"}'))
    );
    const result = await parser.extractPick('scelgo Juve Inventata FC', opts);
    expect(result).toBeNull();
  });

  it('risposta ambigua (team null) → null', async () => {
    const { parser } = makeParser(() =>
      Promise.resolve(jsonText('{"team": null, "outcome": null}'))
    );
    expect(await parser.extractPick('non so', opts)).toBeNull();
  });

  it('output non-JSON → null senza crash (CS7)', async () => {
    const { parser } = makeParser(() => Promise.resolve(jsonText('Ciao! questa è un\'email')));
    expect(await parser.extractPick('ciao', opts)).toBeNull();
  });

  it('output malformato (campi di tipo errato) → null senza crash (CS7)', async () => {
    const { parser } = makeParser(() =>
      Promise.resolve(jsonText('{"team": 42, "outcome": ["win"]}'))
    );
    expect(await parser.extractPick('42', opts)).toBeNull();
  });

  it('esito invalido o assente → null', async () => {
    const bad = makeParser(() =>
      Promise.resolve(jsonText('{"team": "Juventus FC", "outcome": "vittoria"}'))
    );
    expect(await bad.parser.extractPick('juve vittoria', opts)).toBeNull();

    const missing = makeParser(() =>
      Promise.resolve(jsonText('{"team": "Juventus FC"}'))
    );
    expect(await missing.parser.extractPick('juve', opts)).toBeNull();
  });

  it('lista vuota (DB senza dati) → null deterministico SENZA chiamare l\'API', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonText('{"team": "x", "outcome": "win"}')));
    const { parser } = makeParser(fetchImpl);
    expect(await parser.extractPick('scelgo x', { teams: [], aliases: ALIASES })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('LLM Parser — non-regressione failover (D3: mai failover su risposta valida/null)', () => {
  it('m1 risponde con JSON valido → m2 NON viene mai chiamato', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonText('{"team": "Juventus FC", "outcome": "win"}')));
    const client = new OpenAIClient({
      baseUrl: 'https://llm.test.example/v1',
      apiKey: 'k',
      models: ['m1', 'm2'],
      retries: 1,
      fetchImpl
    });
    const parser = new OpenAIParser(client);
    const result = await parser.extractPick('scelgo la Juve', opts);
    expect(result).toEqual({ team: 'Juventus FC', outcome: 'win' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('m1 risponde null (pick ambiguo) → UN SOLO fetch, nessun secondo tentativo', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonText('{"team": null, "outcome": null}')));
    const client = new OpenAIClient({
      baseUrl: 'https://llm.test.example/v1',
      apiKey: 'k',
      models: ['m1', 'm2'],
      retries: 1,
      fetchImpl
    });
    const parser = new OpenAIParser(client);
    const result = await parser.extractPick('non so', opts);
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LLM Parser — contratto d\'errore (D3)', () => {
  it('401 → LLMError rilanciata (trasporto, non contenuto)', async () => {
    const { parser } = makeParser(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))
    );
    await expect(parser.extractPick('ciao', opts)).rejects.toMatchObject({
      name: 'LLMError',
      status: 401
    });
  });

  it('429 → LLMError (retry al tick successivo, mai qui)', async () => {
    const { parser } = makeParser(() =>
      Promise.resolve(new Response('rate limit', { status: 429 }))
    );
    await expect(parser.extractPick('ciao', opts)).rejects.toBeInstanceOf(LLMError);
  });

  it('timeout → LLMError', async () => {
    const fetchImpl: typeof fetch = ((_url: unknown, init?: unknown) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as typeof fetch;
    const client = new OpenAIClient({
      baseUrl: 'https://llm.test.example/v1',
      apiKey: 'k',
      models: ['m'],
      retries: 1,
      fetchImpl,
      timeoutMs: 10
    });
    const parser = new OpenAIParser(client);
    await expect(parser.extractPick('ciao', opts)).rejects.toBeInstanceOf(LLMError);
  });
});

describe('Selezione risorsa alias in base al test mode (Task 0.4, D7)', () => {
  it('loadTeamAliasesFor(false) → risorsa di produzione (Serie A, invariata)', async () => {
    const content = await loadTeamAliasesFor(false);
    expect(content).toContain('Juventus FC');
    expect(content).toContain('Serie A');
    expect(content).not.toContain('US Cremonese');
  });

  it('loadTeamAliasesFor(true) → risorsa sintetica (Serie B)', async () => {
    const content = await loadTeamAliasesFor(true);
    expect(content).toContain('US Cremonese');
    expect(content).toContain('Serie B');
    expect(content).not.toContain('Juventus FC');
  });
});

describe('buildParseSystemPrompt — contesto lega in test mode (Task 0.4, D7)', () => {
  const basicOpts = { teams: TEAMS, aliases: ALIASES };

  it('testMode=false → prompt di produzione (Serie A, invariato)', () => {
    const prompt = buildParseSystemPrompt(basicOpts);
    expect(prompt).toContain('Serie A');
    expect(prompt).not.toContain('Serie B');
    expect(prompt).not.toContain('campionato sintetico');
  });

  it('testMode=true → prompt chiarisce la lega sintetica (Serie B, NON Serie A)', () => {
    const prompt = buildParseSystemPrompt({ ...basicOpts, testMode: true });
    expect(prompt).toContain('Serie B');
    expect(prompt).toContain('campionato sintetico');
    expect(prompt).toContain('club cadetti, NON di Serie A');
    expect(prompt).not.toContain('pronostici sulla Serie A');
  });
});
