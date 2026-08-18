/**
 * Test unitari del clock helper test-only (src/clock.ts, piano UAT Task 0.3/D9).
 *
 * Verificano il contratto dell'offset orario unificato:
 *   - makeNow con testMode=false → new Date() reale (regressione);
 *   - makeNow con offset attivo → Date.now() − N giorni;
 *   - shiftReceivedAt con offset attivo → stesso delta del clock (D9);
 *   - shiftReceivedAt con offset 0 → timestamp originale intatto;
 *   - offsetMs: stesso valore usato da makeNow e shiftReceivedAt (coerenza).
 */
import { describe, expect, it } from 'vitest';

import { makeNow, offsetMs, shiftReceivedAt } from '../../src/clock.js';
import { parseConfig } from '../../src/config.js';

const requiredEnv = {
  IMAP_USER: 'u',
  IMAP_PASS: 'p',
  SMTP_USER: 'u',
  SMTP_PASS: 'p',
  LLM_API_KEY: 'k',
  FOOTBALL_DATA_TOKEN: 't'
};

/** Costanti temporali per test deterministici. */
const NOW_REAL = 1_700_000_000_000; // un timestamp fisso di riferimento
const MS_PER_DAY = 86_400_000;

/** Config con test mode disattivato (regressione). */
const off = parseConfig({ ...requiredEnv });

/** Config con test mode attivo e offset 7 giorni. */
const on = parseConfig({ ...requiredEnv, TEST_MODE: 'true', TEST_OFFSET_DAYS: '7' });

describe('offsetMs (§0.3: stesso delta per clock e receivedAt)', () => {
  it('testMode=false → offsetMs = 0 (nessun offset)', () => {
    expect(offsetMs(off)).toBe(0);
  });

  it('testMode=true + TEST_OFFSET_DAYS=7 → offsetMs = 7 × 86400000', () => {
    expect(offsetMs(on)).toBe(7 * MS_PER_DAY);
  });

  it('testMode=true + TEST_OFFSET_DAYS=0 → offsetMs = 0', () => {
    const cfg = parseConfig({ ...requiredEnv, TEST_MODE: 'true', TEST_OFFSET_DAYS: '0' });
    expect(offsetMs(cfg)).toBe(0);
  });
});

describe('makeNow (D9: orologio shiftato indietro di N giorni)', () => {
  it('testMode=false → new Date() reale (regressione)', () => {
    const before = Date.now();
    const n = makeNow(off).getTime();
    const after = Date.now();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });

  it('testMode=true + offset 7 → now reale − 7 giorni', () => {
    const before = Date.now() - 7 * MS_PER_DAY;
    const n = makeNow(on).getTime();
    const after = Date.now() - 7 * MS_PER_DAY;
    // Tolleranza di 100ms per l'esecuzione tra before e after.
    expect(n).toBeGreaterThanOrEqual(before - 100);
    expect(n).toBeLessThanOrEqual(after + 100);
  });

  it('testMode=true + offset 0 → stesso timestamp reale (non shiftato)', () => {
    const cfg = parseConfig({ ...requiredEnv, TEST_MODE: 'true', TEST_OFFSET_DAYS: '0' });
    const before = Date.now();
    const n = makeNow(cfg).getTime();
    const after = Date.now();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });
});

describe('shiftReceivedAt (D9: same delta, monotonic)', () => {
  const received = new Date(NOW_REAL);

  it('testMode=false → timestamp originale restituito (no shift)', () => {
    expect(shiftReceivedAt(received, off)).toBe(received);
  });

  it('testMode=true + offset 0 → timestamp originale restituito', () => {
    const cfg = parseConfig({ ...requiredEnv, TEST_MODE: 'true', TEST_OFFSET_DAYS: '0' });
    expect(shiftReceivedAt(received, cfg)).toBe(received);
  });

  it('testMode=true + offset 7 → receivedAt − 7 giorni esatti', () => {
    const shifted = shiftReceivedAt(received, on);
    const expected = NOW_REAL - 7 * MS_PER_DAY;
    expect(shifted.getTime()).toBe(expected);
  });

  it('shift monotono: due timestamp nell\'ordine restano nell\'ordine dopo lo shift', () => {
    const earlier = new Date(NOW_REAL);
    const later = new Date(NOW_REAL + 3600_000); // 1 ora dopo
    const s1 = shiftReceivedAt(earlier, on);
    const s2 = shiftReceivedAt(later, on);
    expect(s1.getTime()).toBeLessThan(s2.getTime());
  });
});