/**
 * Verifica della guardia anti-degenerazione (`deterministicNarrative`,
 * MAX_NARRATIVE_CHARS) con la STAGIONE REALE 2025/26 (girone di andata).
 *
 * Complemento ermetico del test live tests/integration/real-season-narrative-guard.test.ts:
 * qui i dati sono la fixture reale del round 1 (10 partite giocate,
 * nomi/punteggi veri da football-data.org) e il test gira SENZA rete. Scopo:
 * fissare la relazione tra i dati reali e i limiti della guardia —
 *  1. il contesto email (partite del round, squadre disponibili/bruciate,
 *     conteggi) è INPUT del prompt e NON è limitato da MAX_NARRATIVE_CHARS:
 *     resta comunque contenuto (~1 KB anche nel peggior caso reale);
 *  2. una narrativa LEGITTIMA lunga (4 frasi, ~600 caratteri, ~200 token)
 *     non deve essere scambiata per output degenerato (nessun falso positivo)
 *     e non deve essere troncata da `max_tokens` (TEXT_MAX_TOKENS);
 *  3. un dump degenerato (echo del prompt) resta SEMPRE sostituito dal
 *     fallback deterministico per tipo, anche con un contesto ricco di partite.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_NARRATIVE_CHARS,
  deterministicNarrative,
  type EmailContext
} from '../../../src/llm/generator.js';
import { FALLBACK_NARRATIVES, serializeEmailContext } from '../../../src/llm/templates.js';
import { TEXT_MAX_TOKENS } from '../../../src/llm/openai-client.js';
import {
  LONG_LEGITIMATE_NARRATIVE,
  REAL_SEASON_2025_ROUND_1,
  estimateTokens
} from '../../fixtures/real-season-2025.js';

const ROME = 'Europe/Rome';

/** Contesto email realistico su un round reale (10 partite, dati completi). */
function realRoundContext(type: EmailContext['type']): EmailContext {
  const teams = [...new Set(REAL_SEASON_2025_ROUND_1.flatMap((m) => [m.home, m.away]))].sort();
  return {
    type,
    playerName: 'Aldo',
    round: 1,
    championshipRound: 1,
    matches: REAL_SEASON_2025_ROUND_1,
    availableTeams: teams,
    burnedTeams: [
      { team: 'AC Milan', round: 1 },
      { team: 'FC Internazionale Milano', round: 2 }
    ],
    deadline: new Date('2025-08-22T20:45:00.000Z'),
    deadlineRemaining: '20 ore e 15 minuti',
    inGameCount: 20,
    eliminatedWrong: 1,
    eliminatedMissing: 1,
    platformCount: 48
  };
}

describe('guardia narrativa con la stagione reale 2025/26 (girone di andata)', () => {
  it('il contesto email con le 10 partite REALI del round è contenuto (è INPUT, non limitato dalla guardia)', () => {
    const ctx = realRoundContext('pick_instructions');
    const serialized = serializeEmailContext(ctx, ROME);
    // Il calendario (10 partite) è nel messaggio utente al modello, NON nella
    // narrativa: nessun vincolo MAX_NARRATIVE_CHARS su questo lato. Anche nel
    // peggior caso reale resta ~1 KB (≈250 token di input).
    expect(serialized).toContain('FC Internazionale Milano');
    expect(serialized).toContain('Partite:');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('una narrativa legittima LUNGA (4 frasi, ~600 caratteri) NON è degenerata: passa la guardia', () => {
    const ctx = realRoundContext('round_closed_survived');
    const narrative = LONG_LEGITIMATE_NARRATIVE;
    // È davvero una narrativa lunga: se il limite fosse ~400-600 caratteri,
    // questo testo valido verrebbe scambiato per spazzatura (falso positivo).
    expect(narrative.length).toBeGreaterThan(400);
    expect(narrative.length).toBeLessThanOrEqual(MAX_NARRATIVE_CHARS);
    expect(deterministicNarrative(ctx, narrative)).toBe(narrative);
  });

  it('la narrativa lunga rientra in TEXT_MAX_TOKENS: max_tokens non tronca testo valido', () => {
    expect(estimateTokens(LONG_LEGITIMATE_NARRATIVE)).toBeLessThanOrEqual(TEXT_MAX_TOKENS);
  });

  it('un dump degenerato (echo del prompt) col contesto REALE → fallback deterministico per tipo', () => {
    const ctx = realRoundContext('round_closed_survived');
    const echo =
      'We need to produce a short narrative text (2-4 short sentences) in Italian, enthusiastic and friendly... ';
    const degenerate = echo.repeat(200); // ≫ MAX_NARRATIVE_CHARS
    expect(deterministicNarrative(ctx, degenerate)).toBe(FALLBACK_NARRATIVES.round_closed_survived);
  });
});
