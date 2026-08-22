/**
 * Contract test del LLM Generator — email v2 (ADR-011; già piano Task 5.2,
 * LLD §6.3; briefing Fase 5-6 §3, D1/D4/D9).
 *
 * HTTP mockato (fetch iniettato, LLD §8). Coprono: un contract test per OGNI
 * tipo di email (16, inclusa `clarification`): corpo = renderer deterministico
 * (header con coppia umana, box, CTA) + narrativa LLM; soggetto `subjectFor`
 * in forma UMANA "Survivor League — Round N · Turno di campionato M:
 * etichetta" (RF-25/D1, mai sigle TT/TC); template senza numeri di turno
 * letterali (D4/ADR-004: mai nel prompt); soggetto neutro per le mail di
 * esito (convenzione 4); coppia assente → soggetto senza prefisso; priorità
 * di `ctx.subject`; date it-IT nel fuso iniettato (D9/ADR-011); LLMError
 * propagata (D3).
 */
import { describe, expect, it, vi } from 'vitest';

import { OpenAIClient } from '../../../src/llm/openai-client.js';
import {
  EMAIL_TYPES,
  MAX_NARRATIVE_CHARS,
  OpenAIGenerator,
  deterministicNarrative,
  subjectFor,
  type EmailContext,
  type EmailType
} from '../../../src/llm/generator.js';
import { EMAIL_TEMPLATES, FALLBACK_NARRATIVES } from '../../../src/llm/templates.js';
import { LLMError } from '../../../src/llm/errors.js';

/** Generatore con fetch iniettato che registra i prompt (test ermetici). */
function makeGenerator(fetchImpl: typeof fetch, timeZone?: string): {
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
  return { generator: new OpenAIGenerator(client, timeZone), requests };
}

/** Risposta 200 con un testo dell'LLM. */
function chatOk(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Contesto minimo per il contract test di ogni tipo (coppia umana iniettata). */
function ctxFor(type: EmailType): EmailContext {
  return {
    type,
    playerName: 'Aldo',
    round: 2,
    championshipRound: 7,
    team: 'Juventus FC',
    outcome: 'win',
    playerResult: type.startsWith('round_result') ? (type === 'round_result_correct' ? 'correct' : 'wrong') : undefined,
    reason: 'team_already_used',
    availableTeams: ['AC Milan', 'AS Roma'],
    burnedTeams: [{ team: 'AC Milan', round: 2 }],
    deadline: new Date('2026-12-12T15:30:00.000Z'),
    deadlineRemaining: '20 ore e 15 minuti'
  };
}

describe('LLM Generator v2 — contract test per ogni tipo (ADR-011)', () => {
  for (const type of EMAIL_TYPES) {
    it(`[${type}] corpo composto dal renderer (header umano) + narrativa; soggetto umano (RF-25/D1)`, async () => {
      const { generator, requests } = makeGenerator(() => Promise.resolve(chatOk('Narrativa di prova')));
      const ctx = ctxFor(type);
      const body = await generator.generate(ctx);
      const subject = subjectFor(ctx);

      // Il corpo è il renderer deterministico: header con coppia UMANA
      // (mai sigle TT/TC, convenzione 1) + narrativa dell'LLM.
      expect(body).toContain('Round 2 · Turno di campionato 7');
      expect(body).toContain('Narrativa di prova');
      expect(body).toContain('Ciao Aldo!');
      expect(body).not.toContain('TT 2');
      expect(body).not.toContain('TC 7');
      // D1: soggetto in forma umana (mai TT2TC7).
      expect(subject).toMatch(/^Survivor League — Round 2 · Turno di campionato 7: .+$/);
      expect(subject).not.toContain('TT2TC7');

      // Il prompt (system/user) NON contiene numeri di turno (D4/ADR-004).
      const prompt = requests[0]?.system ?? '';
      const user = requests[0]?.user ?? '';
      expect(prompt).not.toMatch(/TT\s*\d|TC\s*\d/);
      expect(user).not.toMatch(/Round \d|Turno di campionato \d/);
      // Dati di contesto serializzati (giocatore, squadra, disponibili).
      expect(user).toContain('Aldo');
      expect(user).toContain('Juventus FC');
      expect(user).toContain('AC Milan, AS Roma');
    });
  }

  it('nessun template contiene numeri di turno letterali (D4/ADR-004)', () => {
    for (const type of EMAIL_TYPES) {
      const tpl = EMAIL_TEMPLATES[type];
      expect(tpl, `template ${type}`).not.toMatch(/TT\s*\d|TC\s*\d/);
      expect(tpl, `template ${type}`).not.toMatch(/Round \d|Turno di campionato \d/);
    }
  });

  it('soggetti NEUTRI per le mail di esito round (convenzione 4)', () => {
    const pair = { round: 2, championshipRound: 7 };
    expect(subjectFor({ type: 'round_closed_survived', ...pair })).toBe(
      'Survivor League — Round 2 · Turno di campionato 7: Riepilogo del round'
    );
    expect(subjectFor({ type: 'round_result_correct', ...pair })).toBe(
      'Survivor League — Round 2 · Turno di campionato 7: Esito del round'
    );
    expect(subjectFor({ type: 'round_result_wrong', ...pair })).toBe(
      'Survivor League — Round 2 · Turno di campionato 7: Esito del round'
    );
    expect(subjectFor({ type: 'pick_missing_elimination', ...pair })).toBe(
      'Survivor League — Round 2 · Turno di campionato 7: Esito del round'
    );
  });

  it('senza coppia round/campionato il soggetto non ha prefisso (D1)', () => {
    expect(subjectFor({ type: 'pick_instructions' })).toBe('Survivor League — Invia il tuo pick');
    expect(subjectFor({ type: 'clarification' })).toBe('Survivor League — Non ho capito');
  });

  it('ctx.subject esplicito ha priorità in subjectFor (D1)', () => {
    const ctx: EmailContext = { type: 'platform_registered', subject: 'Oggetto custom' };
    expect(subjectFor(ctx)).toBe('Oggetto custom');
  });

  it('la deadline è formattata in it-IT nel FUSO INIETTATO (D9/ADR-011)', async () => {
    // Europe/Rome (default): 2026-12-12T15:30 UTC → 16:30 a Roma (CET, inverno).
    const rome = makeGenerator(() => Promise.resolve(chatOk('ok')));
    await rome.generator.generate(ctxFor('pick_instructions'));
    expect(rome.requests[0]?.user ?? '').toContain('16:30');
    expect(rome.requests[0]?.user ?? '').toContain('dicembre');

    // America/New_York: 15:30 UTC → 10:30 a New York (EST, inverno).
    const ny = makeGenerator(() => Promise.resolve(chatOk('ok')), 'America/New_York');
    await ny.generator.generate(ctxFor('pick_instructions'));
    expect(ny.requests[0]?.user ?? '').toContain('10:30');
  });

  it('errore di trasporto → LLMError rilanciata (D3, mai silenziosa)', async () => {
    const { generator } = makeGenerator(() =>
      Promise.resolve(new Response('boom', { status: 500 }))
    );
    await expect(generator.generate(ctxFor('platform_registered'))).rejects.toBeInstanceOf(LLMError);
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
    const body = await generator.generate(ctxFor('platform_registered'));
    expect(body).toContain('testo valido');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LLM Generator — guardia anti-degenerazione dell\'output (narrativa)', () => {
  it('output ENORME (echo del prompt di sistema, oltre MAX_NARRATIVE_CHARS) → fallback deterministico, MAI la spazzatura', async () => {
    // Caso reale osservato in produzione-UAT (email "Già iscritto alla
    // piattaforma", corpo da 239.575 caratteri): il modello risputa il prompt
    // di sistema invece della narrativa. Il fetch iniettato simula la
    // risposta degenerata; la guardia deve ripiegare sul testo fisso.
    const promptEcho =
      'We need to produce a short narrative text (2-4 short sentences) in Italian, enthusiastic and friendly...';
    const degenerate = (promptEcho + ' ').repeat(400);
    const { generator } = makeGenerator(() => Promise.resolve(chatOk(degenerate)));
    const body = await generator.generate({
      type: 'platform_already_registered',
      playerName: 'Sara'
    });
    expect(body).not.toContain('We need to produce a short narrative text');
    expect(body).toContain(FALLBACK_NARRATIVES.platform_already_registered);
    expect(body.length).toBeLessThan(5_000);
  });

  it('narrativa valida entro MAX_NARRATIVE_CHARS → passata invariata (nessun fallback)', async () => {
    const { generator } = makeGenerator(() => Promise.resolve(chatOk('Narrativa valida e breve')));
    const body = await generator.generate({ type: 'pick_instructions', playerName: 'Aldo' });
    expect(body).toContain('Narrativa valida e breve');
    expect(body).not.toContain(FALLBACK_NARRATIVES.pick_instructions);
  });
});

describe('deterministicNarrative — guardia pura sull\'output LLM', () => {
  it('narrativa vuota o whitespace → fallback deterministico per tipo', () => {
    expect(deterministicNarrative({ type: 'tournament_open' }, '   ')).toBe(
      FALLBACK_NARRATIVES.tournament_open
    );
  });

  it('lunghezza al limite MAX → passata; oltre MAX → fallback', () => {
    const atLimit = 'x'.repeat(MAX_NARRATIVE_CHARS);
    const over = 'y'.repeat(MAX_NARRATIVE_CHARS + 1);
    expect(deterministicNarrative({ type: 'pick_confirmed' }, atLimit)).toBe(atLimit);
    expect(deterministicNarrative({ type: 'pick_confirmed' }, over)).toBe(
      FALLBACK_NARRATIVES.pick_confirmed
    );
  });

  it('fallback narrativo presente per OGNI EmailType (Record completo)', () => {
    for (const type of EMAIL_TYPES) {
      expect(FALLBACK_NARRATIVES[type], `fallback per ${type}`).toBeTruthy();
    }
  });
});
