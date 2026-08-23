/**
 * Test unitari del logger (src/logger.ts).
 * Verificano il contratto del modulo: livello da LOG_LEVEL rispettato,
 * output JSON strutturato (una riga JSON per evento, come atteso da pino) e
 * timestamp nel FUSO di sistema quando `timeZone` è passata (ADR-011: il
 * default resta UTC, path di emergenza ConfigError).
 */
import { describe, expect, it } from 'vitest';

import { createLogger, formatTimestampInZone } from '../../src/logger.js';

describe('createLogger', () => {
  it('imposta il livello di log richiesto', () => {
    expect(createLogger('warn').level).toBe('warn');
    expect(createLogger('debug').level).toBe('debug');
  });

  it('produce output JSON strutturato con livello e messaggio', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('info', stream);

    logger.info('messaggio di prova');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { level: number; msg: string };
    expect(entry.msg).toBe('messaggio di prova');
    expect(entry.level).toBe(30); // livello pino per "info"
  });

  it('sopprime gli eventi sotto il livello configurato', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('error', stream);

    logger.warn('non deve apparire');

    expect(lines).toHaveLength(0);
  });

  it('con testMode=true ogni riga porta il campo strutturato testMode: true (D3)', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('info', stream, true);

    logger.info('messaggio in test mode');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { testMode?: boolean; msg: string };
    expect(entry.testMode).toBe(true);
    expect(entry.msg).toBe('messaggio in test mode');
  });

  it('con testMode=false (default) il campo testMode è assente (regressione)', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('info', stream);

    logger.info('messaggio normale');

    const entry = JSON.parse(lines[0]!) as { testMode?: boolean };
    expect(entry.testMode).toBeUndefined();
  });
});

describe('createLogger — timestamp nel fuso di sistema (ADR-011)', () => {
  it('formatTimestampInZone: ISO-like con offset esplicito nel fuso richiesto', () => {
    // 2026-08-21T16:30:00Z → 18:30 a Roma (CEST, +02:00) / 12:30 a New York (EDT, -04:00).
    const t = new Date('2026-08-21T16:30:00.000Z');
    expect(formatTimestampInZone(t, 'Europe/Rome')).toBe('2026-08-21T18:30:00+02:00');
    expect(formatTimestampInZone(t, 'America/New_York')).toBe('2026-08-21T12:30:00-04:00');
  });

  it('con timeZone il timestamp della riga è nel fuso (non UTC pino); default = UTC storico', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('info', stream, false, 'Europe/Rome');

    logger.info('messaggio col fuso');

    const entry = JSON.parse(lines[0]!) as { time: string; msg: string };
    expect(entry.msg).toBe('messaggio col fuso');
    // Formato ISO-like con offset esplicito (es. 2026-08-21T18:23:15+02:00);
    // l'offset di Roma è SEMPRE positivo (+01:00 inverno / +02:00 estate).
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
  });

  it('senza timeZone il timestamp resta quello di default di pino (epoch millis)', () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    const logger = createLogger('info', stream);

    logger.info('messaggio UTC');

    const entry = JSON.parse(lines[0]!) as { time: number };
    expect(typeof entry.time).toBe('number');
  });
});
