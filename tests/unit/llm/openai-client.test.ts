/**
 * Contract test del client LLM condiviso (piano Task 5.1/5.2, LLD §6.2/§6.3;
 * briefing Fase 5-6 §2.2/§3.2, D3; piano failover multi-modello D2-D5/D7).
 *
 * Verificano il contratto verso l'API OpenAI-compatibile SENZA rete: il
 * `fetch` è iniettato (mock in memoria, LLD §8). Coprono: URL/header/body
 * della richiesta (model, temperature 0, response_format json_object solo
 * quando richiesto, messages system+user), successo, errori HTTP (401/429/5xx
 * → LLMError con status), errore di rete e timeout (→ LLMError), body
 * malformato (non-JSON, senza choices, content vuoto → LLMError) e il
 * failover multi-modello + retry per modello (D2-D5): retry solo su errori
 * ritentabili, 4xx deterministici → failover diretto, lista esaurita →
 * LLMError aggregato, callback `onModelTried` per ogni tentativo (D7).
 */
import { describe, expect, it } from 'vitest';

import { OpenAIClient, type LlmResponseFormat } from '../../../src/llm/openai-client.js';
import { LLMError } from '../../../src/llm/errors.js';

/** Opzioni del client per i test (default: modello singolo, nessun retry). */
interface MakeClientOptions {
  /** Lista modelli in ordine di priorità (default: ['test-model']). */
  models?: string[];
  /** Tentativi totali per modello (default: 1 = nessun ritentativo). */
  retries?: number;
  /** Timeout per richiesta in ms (default: 1000). */
  timeoutMs?: number;
  /** Callback di diagnostica da registrare sul client (D7). */
  onModelTried?: (model: string, ok: boolean, status?: number) => void;
}

/** Client con fetch iniettato (test ermetici, nessuna rete). */
function makeClient(fetchImpl: typeof fetch, opts: MakeClientOptions = {}): OpenAIClient {
  return new OpenAIClient({
    baseUrl: 'https://llm.test.example/v1',
    apiKey: 'test-key',
    models: opts.models ?? ['test-model'],
    retries: opts.retries ?? 1,
    timeoutMs: opts.timeoutMs ?? 1000,
    fetchImpl,
    onModelTried: opts.onModelTried
  });
}

/**
 * Fetch fake che registra l'ordine dei modelli richiesti e serve risposte in
 * sequenza (l'ultima ripetuta): utile per verificare retry e failover.
 */
function sequenceFetch(
  responses: Array<Response | (() => Promise<Response>)>
): { fetchImpl: typeof fetch; modelsSeen: string[] } {
  const modelsSeen: string[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = ((_url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { model: string };
    modelsSeen.push(body.model);
    const r = responses[Math.min(i++, responses.length - 1)];
    return typeof r === 'function' ? r() : Promise.resolve(r);
  }) as typeof fetch;
  return { fetchImpl, modelsSeen };
}

/** Risposta JSON 200 standard di una chat completion. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('OpenAIClient — richiesta (config-driven, D2/E)', () => {
  it('POST su {baseUrl}/chat/completions con Bearer, model, temperature 0 e messages', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = ((url: unknown, init?: unknown) => {
      captured = { url: String(url), init: (init ?? {}) as RequestInit };
      return Promise.resolve(chatResponse('esito'));
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const text = await client.chatCompletion(
      { system: 'sistema', user: 'utente' },
      'text'
    );

    expect(text).toBe('esito');
    expect(captured?.url).toBe('https://llm.test.example/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(String(captured?.init.body)) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
      response_format?: { type: string };
    };
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sistema' },
      { role: 'user', content: 'utente' }
    ]);
    // Formato 'text': nessun response_format imposto.
    expect(body.response_format).toBeUndefined();
  });

  it('response_format json_object SOLO quando richiesto (Parser)', async () => {
    const fetchImpl: typeof fetch = ((_url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        response_format?: { type: string };
      };
      expect(body.response_format).toEqual({ type: 'json_object' });
      return Promise.resolve(chatResponse('{"team": null}'));
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.chatCompletion({ system: 's', user: 'u' }, 'json_object' as LlmResponseFormat);
  });
});

describe('OpenAIClient — failover e retry (D2-D5)', () => {
  it('il primo modello risponde al 1° tentativo: UN SOLO fetch con body.model = primo', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([chatResponse('esito')]);
    const client = makeClient(fetchImpl, { models: ['m1', 'm2'], retries: 3 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('esito');
    expect(modelsSeen).toEqual(['m1']);
  });

  it('429 → retry dello STESSO modello (fetch 2 con model invariato) → successo al 2° tentativo', async () => {
    const tried: Array<[string, boolean, number | undefined]> = [];
    const { fetchImpl, modelsSeen } = sequenceFetch([
      new Response('rate limited', { status: 429 }),
      chatResponse('ok')
    ]);
    const client = makeClient(fetchImpl, {
      models: ['m1', 'm2'],
      retries: 3,
      onModelTried: (model, ok, status) => tried.push([model, ok, status])
    });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('ok');
    expect(modelsSeen).toEqual(['m1', 'm1']);
    expect(tried).toEqual([
      ['m1', false, 429],
      ['m1', true, undefined]
    ]);
  });

  it('429 persistente per `retries` tentativi → failover al secondo modello', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      chatResponse('dal secondo')
    ]);
    const client = makeClient(fetchImpl, { models: ['m1', 'm2'], retries: 3 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('dal secondo');
    // m1: 3 tentativi (2 retry) tutti 429; poi failover a m2.
    expect(modelsSeen).toEqual(['m1', 'm1', 'm1', 'm2']);
  });

  it('errore di rete al 1° tentativo → retry stesso modello → successo', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([
      () => Promise.reject(new Error('ECONNREFUSED')),
      chatResponse('ok')
    ]);
    const client = makeClient(fetchImpl, { models: ['m1'], retries: 3 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('ok');
    expect(modelsSeen).toEqual(['m1', 'm1']);
  });

  it('timeout al 1° tentativo → retry stesso modello', async () => {
    const modelsSeen: string[] = [];
    let attempts = 0;
    const fetchImpl: typeof fetch = ((_url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { model: string };
      modelsSeen.push(body.model);
      attempts++;
      if (attempts === 1) {
        // Prima chiamata: pende fino all'abort del timeout (mai risolta).
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      }
      return Promise.resolve(chatResponse('ok'));
    }) as typeof fetch;
    const client = makeClient(fetchImpl, { models: ['m1'], retries: 3, timeoutMs: 10 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('ok');
    expect(modelsSeen).toEqual(['m1', 'm1']);
  });

  it('body non-JSON (200, status assente) → retry stesso modello', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([
      new Response('non-json', { status: 200 }),
      chatResponse('ok')
    ]);
    const client = makeClient(fetchImpl, { models: ['m1'], retries: 3 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('ok');
    expect(modelsSeen).toEqual(['m1', 'm1']);
  });

  it('401 (4xx deterministico) → NESSUN retry per m1, failover diretto a m2', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([
      new Response('unauthorized', { status: 401 }),
      chatResponse('da m2')
    ]);
    const client = makeClient(fetchImpl, { models: ['m1', 'm2'], retries: 3 });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('da m2');
    expect(modelsSeen).toEqual(['m1', 'm2']);
  });

  it('tutti i modelli esauriti (2 modelli, retries 2) → LLMError aggregato con modelli/esiti e status', async () => {
    const { fetchImpl } = sequenceFetch([
      new Response('rate limited', { status: 429 }),
      new Response('rate limited', { status: 429 }),
      new Response('server error', { status: 500 }),
      () => Promise.reject(new Error('ECONNREFUSED'))
    ]);
    const client = makeClient(fetchImpl, { models: ['m1', 'm2'], retries: 2 });

    const error = await client
      .chatCompletion({ system: 's', user: 'u' }, 'text')
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).message).toContain('m1');
    expect((error as LLMError).message).toContain('m2');
    expect((error as LLMError).message).toContain('429, 429');
    expect((error as LLMError).message).toContain('500, rete');
    // D5: status = ultimo status con valore (rete non ha status → resta 500).
    expect((error as LLMError).status).toBe(500);
  });

  it('retries: 1 → un solo tentativo per modello (comportamento di oggi)', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([new Response('rate limited', { status: 429 })]);
    const client = makeClient(fetchImpl, { models: ['m1', 'm2'], retries: 1 });

    const error = await client
      .chatCompletion({ system: 's', user: 'u' }, 'text')
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    // Nessun retry: un solo tentativo per modello, poi failover e lista esaurita.
    expect(modelsSeen).toEqual(['m1', 'm2']);
  });

  it('lista di 1 modello → nessun failover: 3 tentativi sull\'unico modello, poi LLMError', async () => {
    const { fetchImpl, modelsSeen } = sequenceFetch([new Response('rate limited', { status: 429 })]);
    const client = makeClient(fetchImpl, { models: ['solo'], retries: 3 });

    const error = await client
      .chatCompletion({ system: 's', user: 'u' }, 'text')
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(modelsSeen).toEqual(['solo', 'solo', 'solo']);
  });

  it('onModelTried: sequenza completa multi-modello (401 → failover, 429 → retry → successo)', async () => {
    const tried: Array<[string, boolean, number | undefined]> = [];
    const { fetchImpl } = sequenceFetch([
      new Response('unauthorized', { status: 401 }),
      new Response('rate limited', { status: 429 }),
      chatResponse('ok')
    ]);
    const client = makeClient(fetchImpl, {
      models: ['m1', 'm2', 'm3'],
      retries: 3,
      onModelTried: (model, ok, status) => tried.push([model, ok, status])
    });

    const text = await client.chatCompletion({ system: 's', user: 'u' }, 'text');

    expect(text).toBe('ok');
    expect(tried).toEqual([
      ['m1', false, 401],
      ['m2', false, 429],
      ['m2', true, undefined]
    ]);
  });
});

describe('OpenAIClient — contratto d\'errore (D3, retries: 1)', () => {
  it('401 → LLMError con status (4xx deterministico, nessun retry)', async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))
    );
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toMatchObject({
      name: 'LLMError',
      status: 401
    });
  });

  it('429 → LLMError con status 429 (retries 1 = nessun ritentativo)', async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response('rate limited', { status: 429 }))
    );
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toMatchObject({
      name: 'LLMError',
      status: 429
    });
  });

  it('5xx → LLMError con status', async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response('boom', { status: 500 }))
    );
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toMatchObject({
      name: 'LLMError',
      status: 500
    });
  });

  it('errore di rete → LLMError senza status', async () => {
    const client = makeClient(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    );
    const error = await client
      .chatCompletion({ system: 's', user: 'u' }, 'text')
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).status).toBeUndefined();
    expect((error as LLMError).message).toContain('Errore di rete');
  });

  it('timeout → LLMError con messaggio di timeout', async () => {
    const fetchImpl: typeof fetch = ((_url: unknown, init?: unknown) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      })) as typeof fetch;
    const client = makeClient(fetchImpl, { timeoutMs: 10 });
    const error = await client
      .chatCompletion({ system: 's', user: 'u' }, 'text')
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).message).toContain('Timeout');
  });

  it('body non-JSON → LLMError', async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response('non-json', { status: 200 }))
    );
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toMatchObject({
      name: 'LLMError'
    });
  });

  it('body senza choices[0].message.content → LLMError', async () => {
    const client = makeClient(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    );
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toThrow(
      /content/
    );
  });

  it('content vuoto → LLMError', async () => {
    const client = makeClient(() => Promise.resolve(chatResponse('  ')));
    await expect(client.chatCompletion({ system: 's', user: 'u' }, 'text')).rejects.toThrow(
      /content/
    );
  });
});
