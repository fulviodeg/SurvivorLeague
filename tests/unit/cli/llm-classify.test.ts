/**
 * Contract test del comando `llm:classify` (A9/B8c, finding D7 del report
 * 2026-08-21; piano Task 6, ADR-009, LLD §7.8).
 *
 * Chiude il GAP di copertura D7: prima di questo file nessun test esercitava
 * il comando (0 occorrenze di `classifyInputBody`/`llm:classify` in tests/).
 * Il handler del comando è SOLO wiring (config → DB → provider → client →
 * classificatore → output console): il suo punto testabile è la coppia
 * `classifyInputBody` (funzione esportata del comando) + `OpenAIIntentClassifier`
 * con fetch MOCKATO (stesso pattern di tests/unit/llm/intent-classifier.test.ts,
 * LLD §8) — si invoca il wiring con lo STESSO flusso del handler, non il
 * binario (che aprirebbe config/DB reali).
 *
 * Coprono: input JSON `{"body": "..."}` → corpo estratto e classificato;
 * testo libero → usato come corpo; output `{intent, pick}` coerente con
 * l'input; contenuto ambiguo/malformato → `{intent:'other', pick:null}` senza
 * crash (CS7); errore di trasporto → `LLMError` (D3, mai silenziosa).
 * Nessun fetch reale, nessun DB, nessun file.
 */
import { describe, expect, it } from 'vitest';

import { classifyInputBody } from '../../../src/cli/commands/llm.js';
import { LLMError } from '../../../src/llm/errors.js';
import { OpenAIIntentClassifier } from '../../../src/llm/intent-classifier.js';
import { OpenAIClient } from '../../../src/llm/openai-client.js';

const TEAMS = ['Juventus FC', 'FC Internazionale Milano', 'AC Milan', 'AS Roma'];
const ALIASES = '## Alias\n- juve, bianconeri → Juventus FC\n- inter, nerazzurri → FC Internazionale Milano';

/** Risposta 200 con il testo JSON dell'LLM (stesso helper di intent-classifier.test.ts). */
function jsonText(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Classificatore con fetch iniettato: lo stesso wiring del handler del comando. */
function makeClassifier(fetchImpl: typeof fetch): OpenAIIntentClassifier {
  const client = new OpenAIClient({
    baseUrl: 'https://llm.test.example/v1',
    apiKey: 'k',
    models: ['m'],
    retries: 1,
    fetchImpl
  });
  return new OpenAIIntentClassifier(client);
}

describe('llm:classify — classifyInputBody (funzione esportata del comando, A9/B8c, D7)', () => {
  it('input JSON con campo body → restituisce SOLO il body', () => {
    expect(classifyInputBody('{"body": "vorrei iscrivermi al torneo!"}')).toBe(
      'vorrei iscrivermi al torneo!'
    );
  });

  it('testo libero (non-JSON) → usato come corpo del messaggio', () => {
    expect(classifyInputBody('mi iscrivo')).toBe('mi iscrivo');
  });

  it('JSON senza campo body → trattato come testo libero (nessun crash)', () => {
    const raw = '{"intent": "subscribe", "pick": null}';
    expect(classifyInputBody(raw)).toBe(raw);
  });
});

describe('llm:classify — wiring input→classify→output (fetch mockato, A9/B8c, D7)', () => {
  it('input JSON di iscrizione → output {intent: "subscribe", pick: null}', async () => {
    const classifier = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "subscribe", "pick": null}'))
    );
    const body = classifyInputBody('{"body": "vorrei iscrivermi al torneo!"}');
    const result = await classifier.classify(body, { teams: TEAMS, aliases: ALIASES });
    expect(result).toEqual({ intent: 'subscribe', pick: null, name: null });
  });

  it('input JSON di pick → output {intent: "pick", pick} coerente con l\'input', async () => {
    const classifier = makeClassifier(() =>
      Promise.resolve(
        jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "win"}}')
      )
    );
    const body = classifyInputBody('{"body": "per questo turno scelgo la Juve vincente"}');
    const result = await classifier.classify(body, { teams: TEAMS, aliases: ALIASES });
    expect(result).toEqual({ intent: 'pick', pick: { team: 'Juventus FC', outcome: 'win' }, name: null });
  });

  it('contenuto ambiguo (output LLM non interpretabile) → {intent: "other", pick: null} senza crash', async () => {
    const classifier = makeClassifier(() => Promise.resolve(jsonText('Ciao! non sono JSON')));
    const body = classifyInputBody('{"body": "che bella giornata!"}');
    expect(await classifier.classify(body, { teams: TEAMS, aliases: ALIASES })).toEqual({
      intent: 'other',
      pick: null,
      name: null
    });
  });

  it('errore di trasporto (401) → LLMError rilanciata (D3, mai silenziosa)', async () => {
    const classifier = makeClassifier(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))
    );
    const body = classifyInputBody('{"body": "vorrei iscrivermi"}');
    await expect(
      classifier.classify(body, { teams: TEAMS, aliases: ALIASES })
    ).rejects.toBeInstanceOf(LLMError);
    await expect(
      classifier.classify(body, { teams: TEAMS, aliases: ALIASES })
    ).rejects.toMatchObject({ name: 'LLMError', status: 401 });
  });
});
