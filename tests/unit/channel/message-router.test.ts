/**
 * Unit test del Message Router (piano Task 8, LLD §1.3/§6.4 v0.5.0; briefing
 * Fase 5-6 §4.5, D6/K; ADR-009).
 *
 * Verificano il nuovo contratto di PREPARAZIONE (ADR-009): il router NON usa
 * più keyword (`REGISTRATION_KEYWORDS` rimossa) né l'insieme dei mittenti
 * noti — la decisione di intento è dell'LLM. Ogni messaggio processabile
 * produce `{ kind: 'classified', identity, body }`; corpo/mittente vuoto →
 * `{ kind: 'unknown' }` (nessuna chiamata LLM). Verificano inoltre la
 * normalizzazione dell'identità (trim, minuscolo, rimozione del nome
 * visualizzato — K/RNF2) e il vincolo "il router NON decide nulla di gioco".
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

describe('classify (ADR-009) — preparazione senza decisione di intento', () => {
  it('qualsiasi messaggio con corpo e mittente → classified con identità normalizzata (anche display name)', () => {
    const routed = classify(msg('Aldo <A@test.it>', 'scelgo la Juve win'));
    expect(routed).toMatchObject({
      kind: 'classified',
      identity: { channel: 'email', identifier: 'a@test.it' },
      body: 'scelgo la Juve win'
    });
  });

  it('le keyword di iscrizione NON classificano più (ADR-009): la decisione è dell\'LLM', () => {
    for (const body of [
      'vorrei iscrivermi al torneo',
      'MI ISCRIVO al torneo!',
      'partecipo alla Survivor League',
      'vorrei giocare, come funziona?',
      'registrami al torneo',
      'Juventus win'
    ]) {
      const routed = classify(msg('new@test.it', body));
      expect(routed.kind, `body: ${body}`).toBe('classified');
      expect(routed.identity.identifier).toBe('new@test.it');
    }
  });

  it('corpo vuoto o mittente vuoto → unknown (nessuna chiamata LLM)', () => {
    expect(classify(msg('a@test.it', '   ')).kind).toBe('unknown');
    expect(classify(msg('', 'Juventus win')).kind).toBe('unknown');
  });

  it('corpo trimmato per il classificatore', () => {
    const routed = classify(msg('a@test.it', '  Roma vince  '));
    expect(routed.body).toBe('Roma vince');
  });

  it('non decide nulla di gioco: esito = {kind, identity, body} (nessun altro campo)', () => {
    const routed = classify(msg('x@test.it', 'iscrivimi'));
    expect(Object.keys(routed).sort()).toEqual(['body', 'identity', 'kind']);
  });
});
