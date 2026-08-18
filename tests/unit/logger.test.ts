/**
 * Test unitari del logger (src/logger.ts).
 * Verificano il contratto del modulo: livello da LOG_LEVEL rispettato e
 * output JSON strutturato (una riga JSON per evento, come atteso da pino).
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/logger.js';

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
