/**
 * Test dei derivatori di tempo puri (piano Task 3.5, briefing Fase 3 §8/§1-C).
 *
 * Funzioni pure sui dati (nessun DB, nessun clock): computeDeadline (RF-14) e
 * computeTcClose (PRD §5.4: fine prevista UPP + skew, indipendente dal punteggio).
 */
import { describe, expect, it } from 'vitest';

import type { Match } from '../../../src/data/provider.js';
import { computeDeadline, computeTcClose, formatRemaining } from '../../../src/game/round-time.js';

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

describe('formatRemaining (countdown del box deadline, determinismo RNF1)', () => {
  const from = new Date('2026-09-12T10:00:00.000Z');

  it('differenza ≤ 0 → "meno di un minuto"', () => {
    expect(formatRemaining(from, new Date('2026-09-12T10:00:00.000Z'))).toBe('meno di un minuto');
    expect(formatRemaining(from, new Date('2026-09-12T09:59:00.000Z'))).toBe('meno di un minuto');
  });

  it('< 60 minuti → "meno di un\'ora"', () => {
    expect(formatRemaining(from, new Date('2026-09-12T10:01:00.000Z'))).toBe("meno di un'ora");
    expect(formatRemaining(from, new Date('2026-09-12T10:59:00.000Z'))).toBe("meno di un'ora");
  });

  it('< 24 ore → "X ore e Y minuti" con singolare/plurale e omissione dei minuti a zero', () => {
    expect(formatRemaining(from, new Date('2026-09-12T11:00:00.000Z'))).toBe('1 ora');
    expect(formatRemaining(from, new Date('2026-09-12T11:15:00.000Z'))).toBe('1 ora e 15 minuti');
    expect(formatRemaining(from, new Date('2026-09-12T11:01:00.000Z'))).toBe('1 ora e 1 minuto');
    expect(formatRemaining(from, new Date('2026-09-12T20:00:00.000Z'))).toBe('10 ore');
    expect(formatRemaining(from, new Date('2026-09-13T06:15:00.000Z'))).toBe('20 ore e 15 minuti');
    expect(formatRemaining(from, new Date('2026-09-13T09:59:00.000Z'))).toBe('23 ore e 59 minuti');
  });

  it('≥ 24 ore → "X giorni e Y ore" (minuti scartati, approssimazione "circa")', () => {
    expect(formatRemaining(from, new Date('2026-09-13T10:00:00.000Z'))).toBe('1 giorno');
    expect(formatRemaining(from, new Date('2026-09-14T10:00:00.000Z'))).toBe('2 giorni');
    expect(formatRemaining(from, new Date('2026-09-14T15:00:00.000Z'))).toBe('2 giorni e 5 ore');
    expect(formatRemaining(from, new Date('2026-09-13T11:00:00.000Z'))).toBe('1 giorno e 1 ora');
    // I minuti oltre le 24 ore sono scartati: "circa".
    expect(formatRemaining(from, new Date('2026-09-14T15:30:00.000Z'))).toBe('2 giorni e 5 ore');
  });
});
