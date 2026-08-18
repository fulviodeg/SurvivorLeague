/**
 * Test dei derivatori di tempo puri (piano Task 3.5, briefing Fase 3 §8/§1-C).
 *
 * Funzioni pure sui dati (nessun DB, nessun clock): computeDeadline (RF-14) e
 * computeTcClose (PRD §5.4: fine prevista UPP + skew, indipendente dal punteggio).
 */
import { describe, expect, it } from 'vitest';

import type { Match } from '../../../src/data/provider.js';
import { computeDeadline, computeTcClose } from '../../../src/game/round-time.js';

/** Match minimo per i test (solo matchDate rilevante per tcClose). */
function matchAt(iso: string): Match {
  return {
    round: 1,
    matchDate: new Date(iso),
    homeTeam: 'A',
    awayTeam: 'B',
    postponed: false
  };
}

describe('computeDeadline (RF-14)', () => {
  it('deadline = kickoff - advanceMin minuti', () => {
    const kickoff = new Date('2026-09-12T16:00:00.000Z');
    expect(computeDeadline(kickoff, 30)).toEqual(new Date('2026-09-12T15:30:00.000Z'));
    expect(computeDeadline(kickoff, 0)).toEqual(kickoff);
    expect(computeDeadline(kickoff, 90)).toEqual(new Date('2026-09-12T14:30:00.000Z'));
  });
});

describe('computeTcClose (PRD §5.4)', () => {
  it('tcClose = MAX(match_date) + durationMin + skewMin (fine prevista UPP + scarto)', () => {
    // UPP = ultima partita programmata del TC (18:00); fine prevista = 18:00 + 105'
    // (MATCH_DURATION_MIN); tcClose = fine prevista + 15' (TC_CLOSE_SKEW_MIN).
    const matches = [matchAt('2026-09-12T16:00:00.000Z'), matchAt('2026-09-12T18:00:00.000Z')];
    expect(computeTcClose(matches, 105, 15)).toEqual(new Date('2026-09-12T20:00:00.000Z'));
  });

  it('ignora i punteggi: la fine prevista dipende solo da match_date (PRD §5.4)', () => {
    const withScore: Match = { ...matchAt('2026-09-12T18:00:00.000Z'), homeScore: 2, awayScore: 1 };
    const withoutScore = matchAt('2026-09-12T18:00:00.000Z');
    expect(computeTcClose([withScore], 105, 15)).toEqual(computeTcClose([withoutScore], 105, 15));
  });

  it('round senza partite → null (chiusura non calcolabile, RF-30 la copre)', () => {
    expect(computeTcClose([], 105, 15)).toBeNull();
  });
});
