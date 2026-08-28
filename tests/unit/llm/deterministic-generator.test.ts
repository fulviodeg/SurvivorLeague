/**
 * Test del generatore deterministico e del fallback LLM (email v3, Task 4).
 *
 * `DeterministicGenerator`: produce il corpo con la narrativa FISSA per tipo
 * (`DETERMINISTIC_NARRATIVES`) e il renderer di canale — zero chiamate di
 * rete (nessun client iniettato). `FallbackGenerator`: avvolge un generatore
 * LLM e su `LLMError` ripiega sul corpo deterministico loggando un warn pino
 * `{reason, type}` — il giocatore riceve comunque l'email, il batch non si
 * ferma (criterio di accettazione Task 4).
 */
import { describe, expect, it, vi } from 'vitest';

import { DeterministicGenerator, FallbackGenerator } from '../../../src/llm/deterministic-generator.js';
import { EMAIL_TYPES, type EmailContext, type LLMGenerator } from '../../../src/llm/generator.js';
import { DETERMINISTIC_NARRATIVES } from '../../../src/llm/templates.js';
import { LLMError } from '../../../src/llm/errors.js';

const ROME = 'Europe/Rome';

/** Fake logger che registra le chiamate warn. */
function fakeLogger(): { warn: ReturnType<typeof vi.fn>; calls: Array<{ obj: object; msg: string }> } {
  const calls: Array<{ obj: object; msg: string }> = [];
  const warn = vi.fn((obj: object, msg: string) => {
    calls.push({ obj, msg });
  });
  return { warn, calls };
}

describe('DeterministicGenerator (email v3)', () => {
  it('produce il corpo deterministico con la narrativa fissa per tipo', async () => {
    const gen = new DeterministicGenerator(ROME);
    const body = await gen.generate({ type: 'platform_registered', playerName: 'Mario' });
    expect(body).toContain('ISCRIZIONE CONFERMATA: SEI IN PIATTAFORMA!');
    expect(body).toContain(DETERMINISTIC_NARRATIVES.platform_registered);
  });

  it('narrativa vuota (round_closed_survived) → blocco narrativa omesso', async () => {
    const gen = new DeterministicGenerator(ROME);
    expect(DETERMINISTIC_NARRATIVES.round_closed_survived).toBe('');
    const body = await gen.generate({
      type: 'round_closed_survived',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      inGameCount: 13,
      eliminatedWrong: 3,
      eliminatedMissing: 1
    });
    expect(body).toContain('ROUND CHIUSO: SEI ANCORA IN GARA!');
    expect(body).not.toContain(DETERMINISTIC_NARRATIVES.tournament_open);
  });

  it('deterministico: stesso input → stesso output (nessun clock/LLM)', async () => {
    const gen = new DeterministicGenerator(ROME);
    const ctx: EmailContext = { type: 'tournament_open', playerName: 'Mario', platformCount: 18 };
    expect(await gen.generate(ctx)).toBe(await gen.generate(ctx));
  });

  it('narrativa deterministica presente per OGNI EmailType (Record completo)', () => {
    for (const type of EMAIL_TYPES) {
      expect(DETERMINISTIC_NARRATIVES[type], `narrativa per ${type}`).toBeDefined();
    }
  });
});

describe('DeterministicGenerator — win_only (ADR-016)', () => {
  it('pick_instructions usa la narrativa win_only (solo la squadra che vincerà)', async () => {
    const gen = new DeterministicGenerator(ROME, true);
    const body = await gen.generate({ type: 'pick_instructions', playerName: 'Mario' });
    expect(body).toContain('Scegli la squadra che vincerà.');
    expect(body).not.toContain('Scegli una squadra e l\'esito');
  });

  it('deterministico win_only: stesso input → stesso output (nessun clock/LLM)', async () => {
    const gen = new DeterministicGenerator(ROME, true);
    const ctx: EmailContext = { type: 'pick_instructions', playerName: 'Mario' };
    expect(await gen.generate(ctx)).toBe(await gen.generate(ctx));
  });
});

describe('FallbackGenerator (modalità llm, email v3)', () => {
  it('su LLMError → corpo deterministico + warn pino {reason, type}', async () => {
    const llm: LLMGenerator = {
      generate: async () => {
        throw new LLMError('API giù', 500);
      }
    };
    const logger = fakeLogger();
    const fallback = new FallbackGenerator(llm, new DeterministicGenerator(ROME), logger);

    const body = await fallback.generate({ type: 'platform_registered', playerName: 'Mario' });

    expect(body).toContain('ISCRIZIONE CONFERMATA: SEI IN PIATTAFORMA!');
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.obj).toMatchObject({ reason: 'llm_error', type: 'platform_registered' });
  });

  it('su risposta valida → usa il corpo LLM senza fallback né warn', async () => {
    const llm: LLMGenerator = { generate: async () => 'corpo LLM' };
    const logger = fakeLogger();
    const fallback = new FallbackGenerator(llm, new DeterministicGenerator(ROME), logger);

    const body = await fallback.generate({ type: 'pick_instructions', playerName: 'Mario' });

    expect(body).toBe('corpo LLM');
    expect(logger.calls).toHaveLength(0);
  });

  it('su errore NON-LLM → rilanciato (nessun fallback)', async () => {
    const llm: LLMGenerator = {
      generate: async () => {
        throw new Error('errore inatteso');
      }
    };
    const logger = fakeLogger();
    const fallback = new FallbackGenerator(llm, new DeterministicGenerator(ROME), logger);

    await expect(fallback.generate({ type: 'pick_instructions' })).rejects.toThrow('errore inatteso');
    expect(logger.calls).toHaveLength(0);
  });
});
