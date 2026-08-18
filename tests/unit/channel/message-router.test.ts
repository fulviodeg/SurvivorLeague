/**
 * Unit test del Message Router (piano Task 6.1, LLD §1.3/§6.4; briefing
 * Fase 5-6 §4.5, D6/K).
 *
 * Verificano la regola deterministica di classificazione (mittente noto →
 * pick; ignoto + keyword iscrizione → registration; ignoto → pick; corpo/
 * mittente vuoto → unknown), la normalizzazione dell'identità (trim,
 * minuscolo, rimozione del nome visualizzato — K/RNF2) e il vincolo "il
 * router NON decide nulla di gioco" (output = {kind, identity, body}).
 */
import { describe, expect, it } from 'vitest';

import type { IncomingMessage } from '../../../src/channel/adapter.js';
import { classify, normalizeEmail } from '../../../src/channel/email-adapter/message-router.js';

/** Messaggio di test con mittente grezzo (possibile display name). */
function msg(from: string, body: string): IncomingMessage {
  return { from, channel: 'email', body, receivedAt: new Date('2026-09-12T10:00:00.000Z') };
}

describe('normalizeEmail (K)', () => {
  it('rimuove il nome visualizzato e porta in minuscolo', () => {
    expect(normalizeEmail('Mario Rossi <Mario@X.IT>')).toBe('mario@x.it');
    expect(normalizeEmail('<a@b.c>')).toBe('a@b.c');
    expect(normalizeEmail('  MARIO@X.IT  ')).toBe('mario@x.it');
    expect(normalizeEmail('mario@x.it')).toBe('mario@x.it');
    expect(normalizeEmail('')).toBe('');
  });
});

describe('classify (D6) — mittente noto vs ignoto', () => {
  const known = new Set(['a@test.it']);

  it('mittente noto → pick (anche con display name)', () => {
    const routed = classify(msg('Aldo <A@test.it>', 'scelgo la Juve win'), known);
    expect(routed).toMatchObject({
      kind: 'pick',
      identity: { channel: 'email', identifier: 'a@test.it' },
      body: 'scelgo la Juve win'
    });
  });

  it('mittente ignoto + keyword di iscrizione → registration (case-insensitive)', () => {
    for (const body of [
      'vorrei iscrivermi al torneo',
      'MI ISCRIVO al torneo!',
      'partecipo alla Survivor League',
      'vorrei giocare, come funziona?',
      'registrami al torneo'
    ]) {
      const routed = classify(msg('new@test.it', body), known);
      expect(routed.kind, `body: ${body}`).toBe('registration');
    }
  });

  it('mittente ignoto SENZA keyword → pick (il wiring decide auto-iscrizione/chiarimento/rifiuto)', () => {
    const routed = classify(msg('new@test.it', 'Juventus win'), known);
    expect(routed.kind).toBe('pick');
    expect(routed.identity.identifier).toBe('new@test.it');
  });

  it('corpo vuoto o mittente vuoto → unknown (non processabile)', () => {
    expect(classify(msg('a@test.it', '   '), known).kind).toBe('unknown');
    expect(classify(msg('', 'Juventus win'), known).kind).toBe('unknown');
  });

  it('non decide nulla di gioco: esito = {kind, identity, body} (nessun altro campo)', () => {
    const routed = classify(msg('x@test.it', 'iscrivimi'), new Set());
    expect(Object.keys(routed).sort()).toEqual(['body', 'identity', 'kind']);
  });
});
