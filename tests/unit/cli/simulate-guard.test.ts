/**
 * Test della guardia `simulate:*` sul PLATFORM_DB_PATH (piano Task 10,
 * ADR-009): la simulazione NON deve mai usare il DB piattaforma di
 * produzione — rifiuta se `PLATFORM_DB_PATH` coincide col valore di
 * produzione e accetta un percorso dedicato.
 *
 * A5/B4 (D8): il valore di produzione è la costante UNICA
 * `PLATFORM_DB_PATH_DEFAULT` esportata da `src/config.ts` (usata sia come
 * default zod sia dalla guardia): i test la importano da lì e verificano che
 * `simulate.ts` non dichiari più una costante locale duplicata.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertSimPlatformPath } from '../../../src/cli/commands/simulate.js';
import { parseConfig, PLATFORM_DB_PATH_DEFAULT } from '../../../src/config.js';

/** Config valida con PLATFORM_DB_PATH personalizzabile. */
function configWith(platformDbPath: string) {
  return parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    PLATFORM_DB_PATH: platformDbPath
  });
}

/** Config valida SENZA PLATFORM_DB_PATH: si applica il default zod. */
function configWithoutPlatformDbPath() {
  return parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't'
  });
}

describe('guardia simulate:* su PLATFORM_DB_PATH (ADR-009, piano Task 10)', () => {
  it('rifiuta se PLATFORM_DB_PATH coincide col valore di produzione', () => {
    expect(() => assertSimPlatformPath(configWith(PLATFORM_DB_PATH_DEFAULT))).toThrow(
      /valore di produzione/
    );
  });

  it('accetta un PLATFORM_DB_PATH dedicato (distinto dalla produzione)', () => {
    expect(() => assertSimPlatformPath(configWith('./data/sim-platform.db'))).not.toThrow();
    expect(() => assertSimPlatformPath(configWith('./data/uat-synthetic-platform.db'))).not.toThrow();
  });

  it('A5/B4 (D8): la guardia è ancorata al default reale esposto da config.ts (fonte unica, nessuna costante locale in simulate.ts)', () => {
    // Il default zod di PLATFORM_DB_PATH coincide col valore di produzione
    // esposto da config.ts: la guardia deve rifiutare una config costruita
    // SENZA la variabile (il default si applica), quindi ancorata alla
    // fonte unica e non a una costante duplicata locale.
    const config = configWithoutPlatformDbPath();
    expect(config.PLATFORM_DB_PATH).toBe(PLATFORM_DB_PATH_DEFAULT);
    expect(() => assertSimPlatformPath(config)).toThrow(/valore di produzione/);

    // Nessuna duplicazione del default in simulate.ts: la costante locale di
    // produzione non deve esistere più (il confronto usa PLATFORM_DB_PATH_DEFAULT
    // importata da config.ts).
    const simulateSource = readFileSync(
      new URL('../../../src/cli/commands/simulate.ts', import.meta.url),
      'utf8'
    );
    expect(simulateSource).not.toMatch(/PRODUCTION_PLATFORM_DB_PATH/);
  });
});
