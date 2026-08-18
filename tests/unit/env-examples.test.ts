/**
 * Test che gli esempi di configurazione VERSIONATI (.env.example,
 * .env.uat.example, .env.uat-replay.example) NON contengano segreti reali
 * (piano UAT Task 5).
 *
 * Verificano che i campi credenziali siano segnaposto VUOTI (come richiesto
 * dagli header dei file) e che nessuna riga contenga stringhe sospette di
 * segreti reali: chiavi API in stile OpenAI (sk-…) o App Password Gmail
 * (16+ lettere minuscole come valore intero). I file .env/.env.uat/
 * .env.uat-replay reali sono esclusi da git e NON sono letti da questo test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Radice del repository (tests/unit/ → ../../ = root). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Gli esempi versionati: SOLO questi (mai i file reali con credenziali). */
const EXAMPLE_FILES = ['.env.example', '.env.uat.example', '.env.uat-replay.example'] as const;

/**
 * Campi credenziali che negli esempi DEVONO restare vuoti: usernames/email,
 * password (App Password Gmail) e chiavi API/token.
 */
const CREDENTIAL_KEYS = [
  'IMAP_USER',
  'IMAP_PASS',
  'SMTP_USER',
  'SMTP_PASS',
  'LLM_API_KEY',
  'FOOTBALL_DATA_TOKEN'
] as const;

/** Lista failover multi-modello attesa negli esempi UAT (piano LLM dedicato). */
const FAILOVER_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-20b:free'
] as const;

/** Legge il contenuto di un file di esempio (root-relative). */
function readExample(name: string): string {
  return readFileSync(join(ROOT, name), 'utf8');
}

/**
 * Valore assegnato a una chiave KEY=… in un file env, o undefined se la riga
 * non esiste. Il valore è trim: un segnaposto vuoto (KEY=) dà ''.
 */
function assignedValue(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
}

describe('esempi .env* — nessun segreto versionato (piano UAT Task 5)', () => {
  for (const file of EXAMPLE_FILES) {
    describe(file, () => {
      it('lascia VUOTI tutti i campi credenziali (segnaposto degli header)', () => {
        const content = readExample(file);
        for (const key of CREDENTIAL_KEYS) {
          expect(content).toContain(`${key}=`);
          expect(assignedValue(content, key)).toBe('');
        }
      });

      it('non contiene chiavi API in stile OpenAI (sk-…)', () => {
        expect(readExample(file)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
      });

      it('non contiene App Password Gmail (16+ lettere minuscole come valore intero)', () => {
        expect(readExample(file)).not.toMatch(/^[A-Z_]+=[a-z]{16,}\s*$/m);
      });
    });
  }

  describe('LLM_MODEL degli esempi UAT = lista failover multi-modello (non placeholder)', () => {
    for (const file of ['.env.uat.example', '.env.uat-replay.example'] as const) {
      it(`${file} usa la lista failover (non un singolo placeholder)`, () => {
        const content = readExample(file);
        const models = assignedValue(content, 'LLM_MODEL');
        expect(models).toBeDefined();
        const list = (models ?? '').split(',').map((m) => m.trim());
        expect(list).toEqual([...FAILOVER_MODELS]);
        expect(models).not.toContain('gpt-4o-mini');
      });
    }
  });
});
