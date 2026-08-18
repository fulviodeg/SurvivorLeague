/**
 * Helper di output CLI condivisi per il test mode (piano UAT, Task 0.2, D3).
 *
 * Ruolo: centralizza la segnalazione "TEST MODE" in tutti gli output dei
 * comandi CLI (dicitura del commissioner, D3):
 *   - output TESTUALE → banner "TEST MODE" anteposto una sola volta;
 *   - output `--json`  → campo `testMode: true` incluso nel payload.
 * I comandi applicano questi helper SOLO quando `config.testMode=true`; con
 * `testMode=false` (default, produzione) l'output è IDENTICO a oggi
 * (regressione: nessuna modifica a email/CLI/log).
 *
 * Interazioni: usato dai comandi in src/cli/commands/; non dipende da moduli
 * di gioco. Non confondere con il banner EMAIL (seam in EmailAdapter, D2) e
 * con il binding LOG (src/logger.ts): sono tre segnalazioni distinte.
 */
import type { AppConfig } from '../config.js';

/** Dicitura condivisa del test mode (banner testuale e campo JSON). */
export const TEST_MODE_BANNER = 'TEST MODE';

/**
 * Stampa il banner "TEST MODE" sullo stdout testuale. Va invocata dai comandi
 * SOLO nel ramo NON-`--json` (l'output JSON non deve contenere righe di testo:
 * porta il campo `testMode` tramite `jsonWithTestMode`).
 */
export function printTestModeBanner(config: AppConfig): void {
  if (config.testMode) console.log(TEST_MODE_BANNER);
}

/**
 * Serializza un output `--json` aggiungendo il campo `testMode: true` quando
 * il test mode è attivo (D3). Con `testMode=false` restituisce il JSON
 * IDENTICO a oggi (nessun campo aggiunto). Se il payload è già un oggetto il
 * campo viene FUSO (`{...payload, testMode: true}`); se è un array/primitivo
 * (es. `data:calendar`) viene avvolto in `{ testMode: true, result }` perché
 * un array non può portare campi.
 */
export function jsonWithTestMode(config: AppConfig, value: unknown): string {
  if (!config.testMode) return JSON.stringify(value);
  const payload =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), testMode: true }
      : { testMode: true, result: value };
  return JSON.stringify(payload);
}
