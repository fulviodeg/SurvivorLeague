/**
 * Contract test del LLM Generator (piano Task 5.2, LLD §6.3; briefing Fase 5-6
 * §3, D1/D4/D9).
 *
 * HTTP mockato (fetch iniettato, LLD §8). Coprono: un contract test per OGNI
 * tipo di email (12, incluso `auto_registered` — D5): testo in italiano con
 * la coppia TT/TC esatta (RF-25: iniezione deterministica post-generazione,
 * mai numeri nel prompt); soggetto `subjectFor` con forma compatta (D1);
 * template senza numeri letterali (D4); sostituzione a stringa vuota senza
 * coppia; priorità di `ctx.subject`; date it-IT/fuso Europe/Rome (D9);
 * LLMError propagata (D3).
 */
import { describe, expect, it, vi } from 'vitest';

import { OpenAIClient } from '../../../src/llm/openai-client.js';
import {
  EMAIL_TYPES,
  OpenAIGenerator,
  subjectFor,
  type EmailContext,
  type EmailType
} from '../../../src/llm/generator.js';
import { EMAIL_TEMPLATES, TURN_PLACEHOLDER_EXTENDED } from '../../../src/llm/templates.js';
import { LLMError } from '../../../src/llm/errors.js';

/** Generatore con fetch iniettato che registra i prompt (test ermetici). */
function makeGenerator(fetchImpl: typeof fetch): {
  generator: OpenAIGenerator;
  requests: Array<{ system: string; user: string }>;
} {
  const requests: Array<{ system: string; user: string }> = [];
  const wrapper: typeof fetch = ((url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: { type: string };
    };
    requests.push({ system: body.messages[0]?.content ?? '', user: body.messages[1]?.content ?? '' });
    return fetchImpl(url as string | URL | Request, init as RequestInit);
  }) as typeof fetch;
  const client = new OpenAIClient({
    baseUrl: 'https://llm.test.example/v1',
    apiKey: 'k',
    models: ['m'],
    retries: 1,
    fetchImpl: wrapper
  });
  return { generator: new OpenAIGenerator(client), requests };
}

/** Risposta 200 con un testo dell'LLM. */
function chatOk(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Contesto minimo per il contract test di ogni tipo (coppia TT/TC iniettata). */
function ctxFor(type: EmailType): EmailContext {
  return {
    type,
    playerName: 'Aldo',
    tt: 2,
    tc: 7,
    team: 'Juventus FC',
    outcome: 'win',
    reason: 'team_already_used',
    availableTeams: ['AC Milan', 'AS Roma'],
    deadline: new Date('2026-12-12T15:30:00.000Z')
  };
}

describe('LLM Generator — contract test per ogni tipo (LLD §6.3)', () => {
  for (const type of EMAIL_TYPES) {
    it(`[${type}] corpo in italiano con coppia TT/TC esatta e soggetto compatto (RF-25/D1)`, async () => {
      const { generator, requests } = makeGenerator(() =>
        Promise.resolve(chatOk(`Testo del messaggio ${TURN_PLACEHOLDER_EXTENDED}`))
      );

      const ctx = ctxFor(type);
      const body = await generator.generate(ctx);
      const subject = subjectFor(ctx);

      // RF-25: la coppia nel testo deriva dai dati (iniezione deterministica).
      expect(body).toContain('TT 2, TC 7');
      expect(body).not.toContain(TURN_PLACEHOLDER_EXTENDED);
      // D1: soggetto con forma compatta TT2TC7.
      expect(subject).toMatch(/^Survivor League — .+ TT2TC7$/);

      // Il prompt (system) usa il SEGNAPOSTO, mai i numeri di turno (D4/ADR-004).
      const prompt = requests[0]?.system ?? '';
      const user = requests[0]?.user ?? '';
      expect(prompt).toContain(TURN_PLACEHOLDER_EXTENDED);
      expect(prompt).not.toContain('TT2TC7');
      expect(prompt).not.toMatch(/TT\s*\d|TC\s*\d/);
      expect(user).not.toContain('{{TT_TC}}');
      // Dati di contesto serializzati (giocatore, squadra, esito, motivo, disponibili).
      expect(user).toContain('Aldo');
      expect(user).toContain('Juventus FC');
      expect(user).toContain('AC Milan, AS Roma');
    });
  }

  it('nessun template contiene numeri di turno letterali (D4)', () => {
    for (const type of EMAIL_TYPES) {
      const tpl = EMAIL_TEMPLATES[type];
      // Il segnaposto {{TT_TC}}/{{TTTC}} è l'unico riferimento alla coppia: mai TT<digit>/TC<digit>.
      expect(tpl, `template ${type}`).not.toMatch(/TT\s*\d|TC\s*\d/);
      expect(tpl, `template ${type}`).not.toContain('TT2TC7');
    }
  });

  it('senza coppia TT/TC il segnaposto è sostituito con stringa vuota e il soggetto non ha suffisso', async () => {
    const { generator } = makeGenerator(() =>
      Promise.resolve(chatOk(`Ciao ${TURN_PLACEHOLDER_EXTENDED} fine`))
    );
    const ctx: EmailContext = { type: 'pick_instructions' };
    const body = await generator.generate(ctx);
    expect(body).toBe('Ciao  fine');
    expect(subjectFor(ctx)).toBe('Survivor League — Invia il tuo pick');
  });

  it('ctx.subject esplicito ha priorità in subjectFor (D1)', () => {
    const ctx: EmailContext = { type: 'welcome', tt: 1, tc: 1, subject: 'Oggetto custom' };
    expect(subjectFor(ctx)).toBe('Oggetto custom');
  });

  it('la deadline è formattata in it-IT con fuso FISSO Europe/Rome (D9)', async () => {
    const { generator, requests } = makeGenerator(() => Promise.resolve(chatOk('ok')));
    // 2026-12-12T15:30 UTC → 16:30 a Roma (CET, inverno): fuso fisso = determinismo (RNF1).
    await generator.generate(ctxFor('pick_instructions'));
    const user = requests[0]?.user ?? '';
    expect(user).toContain('16:30');
    expect(user).toContain('dicembre');
  });

  it('errore di trasporto → LLMError rilanciata (D3, mai silenziosa)', async () => {
    const { generator } = makeGenerator(() =>
      Promise.resolve(new Response('boom', { status: 500 }))
    );
    await expect(generator.generate(ctxFor('welcome'))).rejects.toBeInstanceOf(LLMError);
  });
});

describe('LLM Generator — non-regressione failover (D3: mai failover su risposta valida)', () => {
  it('m1 risponde con testo valido → m2 NON viene mai chiamato', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(chatOk('testo valido')));
    const client = new OpenAIClient({
      baseUrl: 'https://llm.test.example/v1',
      apiKey: 'k',
      models: ['m1', 'm2'],
      retries: 1,
      fetchImpl
    });
    const generator = new OpenAIGenerator(client);
    const body = await generator.generate(ctxFor('welcome'));
    expect(body).toBe('testo valido');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
