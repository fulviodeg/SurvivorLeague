/**
 * Contract test del LLM Generator — email v2 (ADR-011; già piano Task 5.2,
 * LLD §6.3; briefing Fase 5-6 §3, D1/D4/D9).
 *
 * HTTP mockato (fetch iniettato, LLD §8). Coprono: un contract test per OGNI
 * tipo di email (17, inclusa `clarification` e `tournament_closed`): corpo = renderer deterministico
 * (header con coppia umana, box, CTA) + narrativa LLM; soggetto `subjectFor`
 * in forma "⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - etichetta"
 * (RF-25/D1, mai sigle TT/TC, il subject porta il SOLO turno di campionato);
 * template senza numeri di turno letterali (D4/ADR-004: mai nel prompt);
 * soggetto neutro per le mail di esito (convenzione 4); TC assente → soggetto
 * senza prefisso di turno; priorità di `ctx.subject`; date it-IT nel fuso
 * iniettato (D9/ADR-011); LLMError propagata (D3).
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
import { EMAIL_TEMPLATES, DETERMINISTIC_NARRATIVES, serializeEmailContext, templateFor } from '../../../src/llm/templates.js';
import { LLMError } from '../../../src/llm/errors.js';
import { modeFor } from '../../../src/game/mode.js';

/** Generatore con fetch iniettato che registra i prompt (test ermetici). */
function makeGenerator(fetchImpl: typeof fetch, timeZone?: string, winOnly = false): {
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
  return { generator: new OpenAIGenerator(client, timeZone, modeFor(winOnly, 0)), requests };
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
      expect(body).toContain('Round del torneo 2 · Turno di Campionato 7');
      expect(body).toContain('Narrativa di prova');
      expect(body).toContain('Ciao Aldo!');
      expect(body).not.toContain('TT 2');
      expect(body).not.toContain('TC 7');
      // D1: soggetto in forma umana (mai TT2TC7).
      expect(subject).toMatch(/^⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 7 di Campionato - .+$/);
      expect(subject).not.toContain('TT2TC7');
      expect(subject).not.toContain('Round 2');

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
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 7 di Campionato - Riepilogo Round'
    );
    expect(subjectFor({ type: 'round_result_correct', ...pair })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 7 di Campionato - Esito Round'
    );
    expect(subjectFor({ type: 'round_result_wrong', ...pair })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 7 di Campionato - Esito Round'
    );
    expect(subjectFor({ type: 'pick_missing_elimination', ...pair })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 7 di Campionato - Esito Round'
    );
  });

  it('senza TC il soggetto non ha prefisso di turno (D1)', () => {
    expect(subjectFor({ type: 'pick_instructions' })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Round Aperto'
    );
    expect(subjectFor({ type: 'clarification' })).toBe('⚽🏆SURVIVOR LEAGUE🏆⚽ - Non Ho Capito');
    // ADR-015 email v4: la mail di chiusura torneo NON porta il turno.
    expect(subjectFor({ type: 'tournament_closed' })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Chiusura Torneo'
    );
  });

  it('soggetti dei tipi di partecipazione opt-in (ADR-019)', () => {
    expect(subjectFor({ type: 'tournament_join_confirmed' })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Partecipazione Confermata'
    );
    expect(subjectFor({ type: 'tournament_already_joined' })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Già in Gara'
    );
    expect(subjectFor({ type: 'tournament_join_rejected' })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Partecipazione Non Confermata'
    );
  });

  it('tournament_won/tournament_shared_win includono il turno quando TC noto (D1)', () => {
    const pair = { round: 3, championshipRound: 5 };
    expect(subjectFor({ type: 'tournament_won', ...pair })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 5 di Campionato - Hai Vinto'
    );
    expect(subjectFor({ type: 'tournament_shared_win', ...pair })).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 5 di Campionato - Vittoria Condivisa'
    );
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
    expect(body).toContain(DETERMINISTIC_NARRATIVES.platform_already_registered);
    expect(body.length).toBeLessThan(5_000);
  });

  it('narrativa valida entro MAX_NARRATIVE_CHARS → passata invariata (nessun fallback)', async () => {
    const { generator } = makeGenerator(() => Promise.resolve(chatOk('Narrativa valida e breve')));
    const body = await generator.generate({ type: 'pick_instructions', playerName: 'Aldo' });
    expect(body).toContain('Narrativa valida e breve');
    expect(body).not.toContain(DETERMINISTIC_NARRATIVES.pick_instructions);
  });
});

describe('deterministicNarrative — guardia pura sull\'output LLM', () => {
  it('narrativa vuota o whitespace → fallback deterministico per tipo', () => {
    expect(deterministicNarrative({ type: 'tournament_open' }, '   ')).toBe(
      DETERMINISTIC_NARRATIVES.tournament_open
    );
  });

  it('lunghezza al limite MAX → passata; oltre MAX → fallback', () => {
    const atLimit = 'x'.repeat(MAX_NARRATIVE_CHARS);
    const over = 'y'.repeat(MAX_NARRATIVE_CHARS + 1);
    expect(deterministicNarrative({ type: 'pick_confirmed' }, atLimit)).toBe(atLimit);
    expect(deterministicNarrative({ type: 'pick_confirmed' }, over)).toBe(
      DETERMINISTIC_NARRATIVES.pick_confirmed
    );
  });

  it('narrativa deterministica presente per OGNI EmailType (Record completo, anche vuota)', () => {
    for (const type of EMAIL_TYPES) {
      expect(DETERMINISTIC_NARRATIVES[type], `narrativa per ${type}`).toBeDefined();
    }
  });
});

describe('LLM Generator — win_only (ADR-016)', () => {
  it('winOnly=true → il prompt usa l\'overlay (chiede solo la squadra che vincerà)', async () => {
    const { generator, requests } = makeGenerator(
      () => Promise.resolve(chatOk('ok')),
      undefined,
      true
    );
    await generator.generate(ctxFor('pick_instructions'));
    expect(requests[0]?.system ?? '').toContain('vincerà la sua partita');
    expect(requests[0]?.system ?? '').not.toContain('vittoria, pareggio o sconfitta');
  });

  it('winOnly=false → il prompt resta quello base (nessun overlay)', async () => {
    const { generator, requests } = makeGenerator(() => Promise.resolve(chatOk('ok')));
    await generator.generate(ctxFor('pick_instructions'));
    expect(requests[0]?.system ?? '').toContain('vittoria, pareggio o sconfitta');
  });

  it('deterministicNarrative con winOnly → fallback all\'overlay win_only', () => {
    const ctx: EmailContext = { type: 'pick_rejected' };
    expect(deterministicNarrative(ctx, '   ', modeFor(true, 0))).toBe(
      'Riprova rispondendo con il nome della squadra che vincerà.'
    );
    expect(deterministicNarrative(ctx, '   ', modeFor(false, 0))).toBe(
      'Riprova rispondendo con squadra + esito (win, draw, lose).'
    );
  });
});

describe('LLM Generator — jolly (feature JOLLY, D8/D9)', () => {
  it('deterministicNarrative salvato dal jolly → narrativa dedicata (mai "hai indovinato")', () => {
    const ctx: EmailContext = {
      type: 'round_result_correct',
      savedByJolly: true,
      jollyUsed: true
    };
    expect(deterministicNarrative(ctx, '   ', modeFor(true, 1))).toBe(
      'La tua squadra ha pareggiato, ma il tuo jolly ti ha salvato: resti in gara!'
    );
  });

  it('deterministicNarrative con jolly disattivato → nessuna narrativa speciale', () => {
    const ctx: EmailContext = { type: 'round_result_correct', savedByJolly: true };
    expect(deterministicNarrative(ctx, '   ', modeFor(true, 0))).toBe(
      'Hai indovinato: hai centrato l\'esito previsto.'
    );
  });

  it('templateFor con jolly attivo → overlay jolly (istruzioni «SQUADRA Jolly») per pick_instructions', () => {
    const jollyPrompt = templateFor('pick_instructions', modeFor(true, 1));
    expect(jollyPrompt).toContain('«SQUADRA Jolly»');
    // Con jolly disattivato prevale l'overlay win_only (senza jolly).
    expect(templateFor('pick_instructions', modeFor(true, 0))).not.toContain('«SQUADRA Jolly»');
    // In classica resta il template base (esito esplicito win/draw/lose).
    expect(templateFor('pick_instructions', modeFor(false, 0))).toContain(
      'vittoria, pareggio o sconfitta'
    );
  });

  it('templateFor overlay jolly: round_result_correct cita il salvataggio dal pareggio', () => {
    const prompt = templateFor('round_result_correct', modeFor(true, 1));
    expect(prompt).toContain('Jolly: ha salvato dal pareggio');
    expect(prompt).toContain('non dire che ha "indovinato"');
  });

  it('serializeEmailContext: jolly usato/salvato/rimasti serializzati per l\'LLM', () => {
    const serialized = serializeEmailContext(
      {
        type: 'round_result_correct',
        playerName: 'Mario',
        team: 'Roma',
        outcome: 'win',
        jollyUsed: true,
        savedByJolly: true,
        jolliesRemaining: 2
      },
      'Europe/Rome'
    );
    expect(serialized).toContain('- Jolly usato: sì');
    expect(serialized).toContain('- Jolly: ha salvato dal pareggio');
    expect(serialized).toContain('- Jolly rimasti: 2');
  });

  it('serializeEmailContext: senza flag jolly nessuna riga jolly', () => {
    const serialized = serializeEmailContext(
      { type: 'pick_confirmed', playerName: 'Mario', team: 'Roma' },
      'Europe/Rome'
    );
    expect(serialized).not.toContain('Jolly');
  });
});
