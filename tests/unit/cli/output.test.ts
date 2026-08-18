/**
 * Test unitari dell'helper di output CLI del test mode (src/cli/output.ts,
 * piano UAT Task 0.2, D3).
 *
 * Verificano il contratto della segnalazione "TEST MODE" negli output CLI:
 * con testMode=false l'output è IDENTICO a oggi (regressione); con
 * testMode=true il testo porta il banner e l'output --json include il campo
 * `testMode: true` (fuso negli oggetti, avvolto in { result } per array).
 */
import { describe, expect, it, vi } from 'vitest';

import { jsonWithTestMode, printTestModeBanner, TEST_MODE_BANNER } from '../../../src/cli/output.js';
import { parseConfig } from '../../../src/config.js';

/** Config valida con testMode disattivato. */
const off = parseConfig({
  IMAP_USER: 'u',
  IMAP_PASS: 'p',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  LLM_API_KEY: 'k',
  FOOTBALL_DATA_TOKEN: 't'
});
/** Config valida con testMode attivo. */
const on = parseConfig({
  IMAP_USER: 'u',
  IMAP_PASS: 'p',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  LLM_API_KEY: 'k',
  FOOTBALL_DATA_TOKEN: 't',
  TEST_MODE: 'true'
});

describe('jsonWithTestMode (D3)', () => {
  it('testMode=false → JSON identico a oggi, nessun campo testMode', () => {
    expect(jsonWithTestMode(off, { a: 1 })).toBe('{"a":1}');
    expect(jsonWithTestMode(off, [1, 2])).toBe('[1,2]');
    expect(JSON.parse(jsonWithTestMode(off, { a: 1 }))).not.toHaveProperty('testMode');
  });

  it('testMode=true → oggetto: campo testMode: true FUSO nel payload', () => {
    const parsed = JSON.parse(jsonWithTestMode(on, { a: 1 })) as Record<string, unknown>;
    expect(parsed.testMode).toBe(true);
    expect(parsed.a).toBe(1);
  });

  it('testMode=true → array: avvolto in { testMode: true, result } (un array non porta campi)', () => {
    const parsed = JSON.parse(jsonWithTestMode(on, [1, 2])) as Record<string, unknown>;
    expect(parsed.testMode).toBe(true);
    expect(parsed.result).toEqual([1, 2]);
  });
});

describe('printTestModeBanner (D3)', () => {
  it('testMode=true stampa il banner TEST MODE', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTestModeBanner(on);
    expect(spy).toHaveBeenCalledWith(TEST_MODE_BANNER);
    spy.mockRestore();
  });

  it('testMode=false non stampa nulla (regressione)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTestModeBanner(off);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
