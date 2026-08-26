/**
 * Test del parser deterministico (email v3 Parte B, piano
 * `.kilo/plans/1787519052097-email-v3-deterministic-parser.md`).
 *
 * `DeterministicIntentClassifier` implementa `LLMIntentClassifier` con
 * FORMULE UNIVOCHE: `ISCRIZIONE [NOME]`, `DISISCRIZIONE`, `<TEAM> <ESITO>`
 * (subject o corpo); qualunque altra cosa → `other`. Zero rete, mai eccezioni
 * di contenuto, lista squadre vuota → `other`. Coprono: estrazione del nome,
 * unsubscribe, pick con longest-match/alias/maiuscole/accenti/sinonimi esito,
 * i body reali UID 291/295, le formule libere NON riconosciute e l'ambiguità.
 */
import { describe, expect, it, vi } from 'vitest';

import { DeterministicIntentClassifier, FallbackIntentClassifier } from '../../../src/llm/deterministic-parser.js';
import { LLMError } from '../../../src/llm/errors.js';
import type { IntentClassification, LLMIntentClassifier } from '../../../src/llm/intent-classifier.js';

/** Tabella alias SINTETICA (rosa test mode) per i body reali UID. */
const SYNTH_TEAMS = ['US Cremonese', 'Brescia Calcio', 'SSC Bari', 'US Catanzaro'];
const SYNTH_ALIASES = [
  '| Alias | Nome canonico |',
  '|---|---|',
  '| cremonese, grigiorossi | US Cremonese |',
  '| brescia, rondinelle | Brescia Calcio |',
  '| bari, galletti | SSC Bari |',
  '| catanzaro, aquile | US Catanzaro |'
].join('\n');

/** Tabella alias di PRODUZIONE (Serie A) per i test pick. */
const PROD_TEAMS = ['AS Roma', 'Juventus FC', 'AC Milan', 'FC Internazionale Milano', 'AC Monza'];
const PROD_ALIASES = [
  '| Alias | Nome canonico |',
  '|---|---|',
  '| roma, giallorossi, capitolini | AS Roma |',
  '| juve, juventus, vecchia signora, bianconeri | Juventus FC |',
  '| milan, rossoneri, diavolo | AC Milan |',
  '| inter, nerazzurri | FC Internazionale Milano |',
  '| monza, biancorossi | AC Monza |'
].join('\n');

const classifier = new DeterministicIntentClassifier();

function classify(body: string, opts: Partial<Parameters<DeterministicIntentClassifier['classify']>[1]> = {}) {
  return classifier.classify(body, {
    teams: opts.teams ?? PROD_TEAMS,
    aliases: opts.aliases ?? PROD_ALIASES,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {})
  });
}

describe('DeterministicIntentClassifier — subscribe (ISCRIZIONE [NOME])', () => {
  it('formula nel corpo con nome', async () => {
    expect(await classify('ISCRIZIONE Marco')).toMatchObject({
      intent: 'subscribe',
      name: 'Marco'
    });
  });

  it('formula nel subject (corpo vuoto) con nome multi-parola e case preservato', async () => {
    expect(await classify('', { subject: 'Iscrizione Mario Rossi' })).toMatchObject({
      intent: 'subscribe',
      name: 'Mario Rossi'
    });
  });

  it('formula nel subject, il subject ha priorità sul corpo', async () => {
    expect(await classify('DISISCRIZIONE', { subject: 'ISCRIZIONE Aldo' })).toMatchObject({
      intent: 'subscribe',
      name: 'Aldo'
    });
  });

  it('nome vuoto dopo la keyword → name null (il sistema usa l\'email, RF-P1)', async () => {
    expect(await classify('ISCRIZIONE')).toMatchObject({ intent: 'subscribe', name: null });
  });

  it('nome limitato a fine riga', async () => {
    expect(await classify('ISCRIZIONE Mario\nRoma vince')).toMatchObject({
      intent: 'subscribe',
      name: 'Mario'
    });
  });

  it('formule libere NON riconosciute → other', async () => {
    for (const body of ['voglio iscrivermi', 'mi iscrivo', 'partecipo', 'vorrei giocare']) {
      expect(await classify(body), body).toMatchObject({ intent: 'other', name: null });
    }
  });
});

describe('DeterministicIntentClassifier — unsubscribe (DISISCRIZIONE)', () => {
  it('formula nel corpo', async () => {
    expect(await classify('DISISCRIZIONE')).toMatchObject({ intent: 'unsubscribe' });
  });

  it('formula nel subject (corpo vuoto)', async () => {
    expect(await classify('', { subject: 'Disiscrizione' })).toMatchObject({ intent: 'unsubscribe' });
  });

  it('"voglio disiscrivermi" NON è una formula → other', async () => {
    expect(await classify('voglio disiscrivermi')).toMatchObject({ intent: 'other' });
  });

  it('"disiscrizione" vince su "iscrizione" (la prima contiene la seconda)', async () => {
    expect(await classify('DISISCRIZIONE')).toMatchObject({ intent: 'unsubscribe' });
  });
});

describe('DeterministicIntentClassifier — pick (<TEAM> <ESITO>)', () => {
  it('alias + esito: "roma vince" → AS Roma win', async () => {
    expect(await classify('roma vince')).toMatchObject({
      intent: 'pick',
      pick: { team: 'AS Roma', outcome: 'win' }
    });
  });

  it('longest-match: "as roma" vince su "roma"', async () => {
    expect(await classify('as roma pareggia')).toMatchObject({
      intent: 'pick',
      pick: { team: 'AS Roma', outcome: 'draw' }
    });
  });

  it('maiuscole e spazi: "ROMA PERDE" → AS Roma lose', async () => {
    expect(await classify('  ROMA  PERDE  ')).toMatchObject({
      intent: 'pick',
      pick: { team: 'AS Roma', outcome: 'lose' }
    });
  });

  it('accenti: "juve vincerà" → Juventus FC win', async () => {
    expect(await classify('juve vincerà')).toMatchObject({
      intent: 'pick',
      pick: { team: 'Juventus FC', outcome: 'win' }
    });
  });

  it('sinonimi esito: win/draw/lose inglese e italiano', async () => {
    expect(await classify('milan win')).toMatchObject({ pick: { team: 'AC Milan', outcome: 'win' } });
    expect(await classify('milan pareggio')).toMatchObject({ pick: { team: 'AC Milan', outcome: 'draw' } });
    expect(await classify('milan sconfitta')).toMatchObject({ pick: { team: 'AC Milan', outcome: 'lose' } });
  });

  it('squadra canonica multi-parola: "FC Internazionale Milano vince"', async () => {
    expect(await classify('FC Internazionale Milano vince')).toMatchObject({
      pick: { team: 'FC Internazionale Milano', outcome: 'win' }
    });
  });

  it('esito senza squadra → other (grammatica team-prima)', async () => {
    expect(await classify('vince Roma')).toMatchObject({ intent: 'other' });
  });

  it('squadra senza esito → other', async () => {
    expect(await classify('Roma')).toMatchObject({ intent: 'other' });
  });
});

describe('DeterministicIntentClassifier — regressione body reali UID (rosa sintetica)', () => {
  const synth = { teams: SYNTH_TEAMS, aliases: SYNTH_ALIASES };

  it('UID 291 "cremonese pareggia" → US Cremonese draw', async () => {
    expect(await classify('cremonese pareggia', synth)).toMatchObject({
      intent: 'pick',
      pick: { team: 'US Cremonese', outcome: 'draw' }
    });
  });

  it('UID 295 "Catanzaro pareggia" → US Catanzaro draw', async () => {
    expect(await classify('Catanzaro pareggia', synth)).toMatchObject({
      intent: 'pick',
      pick: { team: 'US Catanzaro', outcome: 'draw' }
    });
  });

  it('UID 293 "catanzaro" (squadra senza esito) → other (grammatica stretta)', async () => {
    expect(await classify('catanzaro', synth)).toMatchObject({ intent: 'other', pick: null });
  });
});

describe('DeterministicIntentClassifier — ambiguità e casi limite', () => {
  it('testo sconosciuto → other senza eccezioni', async () => {
    expect(await classify('come funziona?')).toMatchObject({ intent: 'other', pick: null });
  });

  it('lista squadre vuota → other deterministico senza chiamate', async () => {
    expect(await classify('Roma vince', { teams: [], aliases: '' })).toMatchObject({
      intent: 'other',
      pick: null
    });
  });

  it('corpo vuoto e subject vuoto → other', async () => {
    expect(await classify('', { subject: '' })).toMatchObject({ intent: 'other' });
  });
});

describe('FallbackIntentClassifier (modalità AI_EMAIL_PARSER=true)', () => {
  function fakeLogger(): { warn: ReturnType<typeof vi.fn>; calls: Array<{ obj: object; msg: string }> } {
    const calls: Array<{ obj: object; msg: string }> = [];
    const warn = vi.fn((obj: object, msg: string) => {
      calls.push({ obj, msg });
    });
    return { warn, calls };
  }

  const opts = { teams: PROD_TEAMS, aliases: PROD_ALIASES };

  it('su LLMError → classifica col deterministico + warn {reason} (batch non si ferma)', async () => {
    const llm: LLMIntentClassifier = {
      classify: async () => {
        throw new LLMError('API giù', 500);
      }
    };
    const logger = fakeLogger();
    const fallback = new FallbackIntentClassifier(llm, new DeterministicIntentClassifier(), logger);

    const result = await fallback.classify('ISCRIZIONE Mario', opts);

    expect(result).toMatchObject({ intent: 'subscribe', name: 'Mario' });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.obj).toMatchObject({ reason: 'llm_error' });
  });

  it('su risposta valida → usa il risultato LLM senza fallback né warn', async () => {
    const llmResult: IntentClassification = { intent: 'other', pick: null, name: null };
    const llm: LLMIntentClassifier = { classify: async () => llmResult };
    const logger = fakeLogger();
    const fallback = new FallbackIntentClassifier(llm, new DeterministicIntentClassifier(), logger);

    const result = await fallback.classify('qualunque testo', opts);

    expect(result).toBe(llmResult);
    expect(logger.calls).toHaveLength(0);
  });

  it('su errore NON-LLM → rilanciato (nessun fallback)', async () => {
    const llm: LLMIntentClassifier = {
      classify: async () => {
        throw new Error('errore inatteso');
      }
    };
    const logger = fakeLogger();
    const fallback = new FallbackIntentClassifier(llm, new DeterministicIntentClassifier(), logger);

    await expect(fallback.classify('x', opts)).rejects.toThrow('errore inatteso');
    expect(logger.calls).toHaveLength(0);
  });
});
