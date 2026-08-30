/**
 * Contract test del LLM Intent Classifier (piano Task 6, ADR-009, LLD §6.2).
 *
 * HTTP mockato (fetch iniettato, LLD §8). Coprono: UNA chiamata LLM per
 * messaggio con lista canonica + alias iniettati nel prompt; intento per
 * classe di messaggi (subscribe/unsubscribe/pick/other); filtro deterministico
 * esatto sul pick (squadra fuori lista → pick null, doppia barriera D2/C);
 * contenuto ambiguo/malformato → other/pick:null senza crash (CS7); intento
 * non-pick → pick forzato a null; trasporto/HTTP → LLMError (D3); lista vuota
 * → l'intento è COMUNQUE classificato (subscribe/unsubscribe indipendenti dai
 * dati stagione), pick azzerato dal filtro esatto; prompt test mode (D7).
 */
import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../src/llm/errors.js';
import {
  buildClassifySystemPrompt,
  OpenAIIntentClassifier
} from '../../../src/llm/intent-classifier.js';
import { OpenAIClient } from '../../../src/llm/openai-client.js';

const TEAMS = ['Juventus FC', 'FC Internazionale Milano', 'AC Milan', 'AS Roma'];
const ALIASES = '## Alias\n- juve, bianconeri → Juventus FC\n- inter, nerazzurri → FC Internazionale Milano';
const opts = { teams: TEAMS, aliases: ALIASES };

/** Classificatore con fetch iniettato che registra il body della richiesta. */
function makeClassifier(fetchImpl: typeof fetch): {
  classifier: OpenAIIntentClassifier;
  requests: string[];
} {
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
  return { classifier: new OpenAIIntentClassifier(client), requests };
}

/** Risposta 200 con il testo JSON dell'LLM. */
function jsonText(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('Intent Classifier — intento per classe di messaggi (ADR-009, RF-P1/P2)', () => {
  it('messaggio di iscrizione → subscribe (pick null)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "subscribe", "pick": null}'))
    );
    const result = await classifier.classify('vorrei iscrivermi al torneo!', opts);
    expect(result).toEqual({ intent: 'subscribe', pick: null, name: null });
  });

  it('messaggio di disiscrizione → unsubscribe (pick null)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "unsubscribe", "pick": null}'))
    );
    const result = await classifier.classify('non voglio più giocare, disiscrivetemi', opts);
    expect(result).toEqual({ intent: 'unsubscribe', pick: null, name: null });
  });

  it('messaggio di pick → pick con estrazione canonica (UNA chiamata)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "win"}}')
      )
    );
    const { classifier, requests } = makeClassifier(fetchImpl);
    const result = await classifier.classify('Ciao, per questo turno scelgo la Juve vincente!', opts);

    expect(result).toEqual({ intent: 'pick', pick: { team: 'Juventus FC', outcome: 'win' }, name: null });
    // UNA SOLA chiamata LLM (intento + estrazione insieme, ADR-009).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(requests[0] ?? '{}') as {
      response_format?: { type: string };
      messages: Array<{ content: string }>;
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    const system = body.messages[0]?.content ?? '';
    const user = body.messages[1]?.content ?? '';
    // Lista canonica e aliases iniettati per chiamata (D2/E).
    for (const t of TEAMS) expect(system).toContain(t);
    expect(system).toContain('juve, bianconeri → Juventus FC');
    expect(user).toContain('Ciao, per questo turno scelgo la Juve vincente!');
  });

  it('messaggio non riconducibile → other (pick null)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "other", "pick": null}'))
    );
    expect(await classifier.classify('che bella giornata!', opts)).toEqual({
      intent: 'other',
      pick: null,
      name: null
    });
  });

  it('nome del giocatore dedotto SOLO dall\'iscrizione (ADR-011, RF-P1)', async () => {
    // "mi chiamo Mario e voglio iscrivermi" → name: "Mario".
    const withName = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "subscribe", "pick": null, "name": "Mario"}'))
    );
    expect(await withName.classifier.classify('mi chiamo Mario e voglio iscrivermi', opts)).toEqual({
      intent: 'subscribe',
      pick: null,
      name: 'Mario'
    });
    // Iscrizione senza nome → name null (il sistema userà l'email).
    const noName = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "subscribe", "pick": null, "name": null}'))
    );
    expect(await noName.classifier.classify('voglio iscrivermi', opts)).toEqual({
      intent: 'subscribe',
      pick: null,
      name: null
    });
    // name su intento diverso da subscribe → forzato a null.
    const pickWithName = makeClassifier(() =>
      Promise.resolve(
        jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "win"}, "name": "Mario"}')
      )
    );
    expect(await pickWithName.classifier.classify('juve vincente', opts)).toEqual({
      intent: 'pick',
      pick: { team: 'Juventus FC', outcome: 'win' },
      name: null
    });
  });
});

describe('Intent Classifier — barriera deterministica esatta (D2/C) e contenuto (CS7)', () => {
  it('intento pick con squadra fuori lista → pick azzerato a null (l\'LLM propone, il check dispone)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(
        jsonText('{"intent": "pick", "pick": {"team": "Juve Inventata FC", "outcome": "win"}}')
      )
    );
    expect(await classifier.classify('scelgo Juve Inventata FC', opts)).toEqual({
      intent: 'pick',
      pick: null,
      name: null
    });
  });

  it('intento pick con esito invalido → other (violazione schema = errore di contenuto, CS7)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(
        jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "vittoria"}}')
      )
    );
    expect(await classifier.classify('juve vittoria', opts)).toEqual({ intent: 'other', pick: null, name: null });
  });

  it('intento pick con pick null (ambiguo) → resta pick null', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "pick", "pick": null}'))
    );
    expect(await classifier.classify('forse la roma', opts)).toEqual({ intent: 'pick', pick: null, name: null });
  });

  it('intento non-pick con pick valorizzato → pick forzato a null', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(
        jsonText('{"intent": "subscribe", "pick": {"team": "Juventus FC", "outcome": "win"}}')
      )
    );
    expect(await classifier.classify('mi iscrivo', opts)).toEqual({
      intent: 'subscribe',
      pick: null,
      name: null
    });
  });

  it('output non-JSON → other senza crash (CS7)', async () => {
    const { classifier } = makeClassifier(() => Promise.resolve(jsonText('Ciao! non sono JSON')));
    expect(await classifier.classify('ciao', opts)).toEqual({ intent: 'other', pick: null, name: null });
  });

  it('output malformato (campi di tipo errato) → other senza crash (CS7)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": 42, "pick": "sbagliato"}'))
    );
    expect(await classifier.classify('42', opts)).toEqual({ intent: 'other', pick: null, name: null });
  });

  it('lista vuota (DB senza dati) → intento COMUNQUE classificato, pick azzerato dal filtro esatto', async () => {
    // Nessuno short-circuit: con lista vuota l'LLM viene comunque chiamato
    // (subscribe/unsubscribe restano indipendenti dai dati stagione, ADR-009);
    // il pick non può matchare nessun nome della lista → azzerato a null.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonText('{"intent": "subscribe", "pick": {"team": "Juventus FC", "outcome": "win"}}')
      )
    );
    const { classifier } = makeClassifier(fetchImpl);
    expect(await classifier.classify('mi iscrivo', { teams: [], aliases: ALIASES })).toEqual({
      intent: 'subscribe',
      pick: null,
      name: null
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Intent Classifier — contratto d\'errore (D3)', () => {
  it('401 → LLMError rilanciata (trasporto, non contenuto)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))
    );
    await expect(classifier.classify('ciao', opts)).rejects.toMatchObject({
      name: 'LLMError',
      status: 401
    });
  });

  it('429 → LLMError (retry al tick successivo, mai qui)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(new Response('rate limit', { status: 429 }))
    );
    await expect(classifier.classify('ciao', opts)).rejects.toBeInstanceOf(LLMError);
  });
});

describe('buildClassifySystemPrompt — contesto lega in test mode (D7)', () => {
  it('testMode=false → prompt di produzione (Serie A, invariato)', () => {
    const prompt = buildClassifySystemPrompt(opts);
    expect(prompt).toContain('Serie A');
    expect(prompt).not.toContain('Serie B');
    expect(prompt).not.toContain('campionato sintetico');
    // Il formato di output copre tutti gli intenti (ADR-009).
    expect(prompt).toContain('subscribe');
    expect(prompt).toContain('unsubscribe');
    expect(prompt).toContain('"pick"');
  });

  it('testMode=true → prompt chiarisce la lega sintetica (rosa Serie A, stagione fittizia)', () => {
    const prompt = buildClassifySystemPrompt({ ...opts, testMode: true });
    expect(prompt).toContain('campionato sintetico');
    expect(prompt).toContain('rosa di Serie A 2026/27');
    expect(prompt).toContain('stagione fittizia di test, NON la stagione reale');
    expect(prompt).not.toContain('pronostici sulla Serie A.');
  });

  it('gli esempi di unsubscribe citano le conferme "confermo"/"sì"/"si" come segnali (B1, D1/D2)', () => {
    const prompt = buildClassifySystemPrompt(opts);
    // Le risposte secche alla richiesta di conferma del sistema devono essere
    // elencate tra gli esempi dell'intento `unsubscribe` (B1): oggi il prompt
    // cita solo "voglio disiscrivermi"/"non voglio più giocare"/"rimuovetemi".
    expect(prompt).toContain('"confermo", "sì", "si"');
  });
});

describe('Intent Classifier — win_only (ADR-016)', () => {
  it('winOnly=true → il prompt istruisce la modalità (sola squadra, outcome sempre win)', () => {
    const prompt = buildClassifySystemPrompt({ ...opts, winOnly: true });
    expect(prompt).toContain('MODALITÀ WIN_ONLY');
    expect(prompt).toContain('l\'outcome è SEMPRE "win"');
    // Senza winOnly il prompt non contiene le istruzioni dedicate.
    expect(buildClassifySystemPrompt(opts)).not.toContain('MODALITÀ WIN_ONLY');
  });

  it('win_only: outcome null (squadra nuda) → normalizzato a win', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": null}}'))
    );
    expect(await classifier.classify('juve', { ...opts, winOnly: true })).toEqual({
      intent: 'pick',
      pick: { team: 'Juventus FC', outcome: 'win' },
      name: null
    });
  });

  it('win_only: outcome win → conservato win', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "win"}}'))
    );
    expect(await classifier.classify('juve vince', { ...opts, winOnly: true })).toEqual({
      intent: 'pick',
      pick: { team: 'Juventus FC', outcome: 'win' },
      name: null
    });
  });

  it('win_only: outcome draw esplicito → pick azzerato a null (pareggio = pick non valido)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "draw"}}'))
    );
    expect(await classifier.classify('juve pareggia', { ...opts, winOnly: true })).toEqual({
      intent: 'pick',
      pick: null,
      name: null
    });
  });

  it('win_only: outcome lose esplicito → pick azzerato a null (sconfitta = pick non valido)', async () => {
    const { classifier } = makeClassifier(() =>
      Promise.resolve(jsonText('{"intent": "pick", "pick": {"team": "Juventus FC", "outcome": "lose"}}'))
    );
    expect(await classifier.classify('juve perde', { ...opts, winOnly: true })).toEqual({
      intent: 'pick',
      pick: null,
      name: null
    });
  });
});
