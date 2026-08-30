/**
 * Test della risorsa prompt `src/llm/team-aliases-synthetic.md` (piano UAT
 * Task 0.4, D7).
 *
 * Verificano la coerenza della risorsa alias SINTETICA (Serie A 2026/27,
 * test-only): niente logica nel file (solo Markdown editoriale), lista
 * canonica di 20 club senza duplicati, ogni alias mappa su un nome canonico
 * della lista e ogni nome canonico ha almeno un alias (speculare a
 * `team-aliases.test.ts`). La COINCIDENZA con la costante `SYNTHETIC_TEAMS`
 * del generatore (Task 1) è verificata in fondo da un test dedicato
 * (Checkpoint B).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SYNTHETIC_TEAMS } from '../../src/data/synthetic-season.js';

/** Percorso assoluto della risorsa sintetica (vive in src/llm/). */
const ALIASES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/llm/team-aliases-synthetic.md'
);

/** Legge il file della risorsa una sola volta. */
function readAliases(): string {
  return readFileSync(ALIASES_PATH, 'utf8');
}

/** Estrae la lista canonica (voci "N. Nome" della sezione dedicata). */
function canonicalList(content: string): string[] {
  return [...content.matchAll(/^\d+\.\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim());
}

/** Estrae le righe dati della tabella alias (coppie [alias, nome canonico]). */
function aliasRows(content: string): Array<[string, string]> {
  const section = content.split('## Alias → nome canonico')[1] ?? '';
  return section
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '' && !/^-+$/.test(cell))
    )
    .filter((cells) => cells.length === 2 && cells[1] !== 'Nome canonico')
    .map((cells) => [cells[0]!, cells[1]!] as [string, string]);
}

describe('team-aliases-synthetic.md — coerenza della risorsa (Task 0.4, D7)', () => {
  it('la lista canonica copre i 20 club di Serie A, senza duplicati', () => {
    const canonical = canonicalList(readAliases());
    expect(canonical).toHaveLength(20);
    expect(new Set(canonical).size).toBe(20);
  });

  it('ogni alias mappa su un nome canonico della lista', () => {
    const md = readAliases();
    const canonical = new Set(canonicalList(md));
    for (const [, target] of aliasRows(md)) {
      expect(canonical.has(target)).toBe(true);
    }
  });

  it('ogni nome canonico ha almeno un alias (nessuna squadra scoperta)', () => {
    const md = readAliases();
    const targets = new Set(aliasRows(md).map(([, target]) => target));
    for (const name of canonicalList(md)) {
      expect(targets.has(name)).toBe(true);
    }
  });

  it('è una risorsa senza logica: nessuna riga di codice eseguibile TypeScript/JavaScript', () => {
    const md = readAliases();
    expect(md).not.toMatch(/function\s*\(|=>|require\(|import\s/);
  });

  it('è marcata come NON legata all\'API (Serie A sintetica, test-only)', () => {
    const md = readAliases();
    expect(md).toContain('NON legata all\'API');
    expect(md).toContain('Serie A');
  });
});

describe('coincidenza con SYNTHETIC_TEAMS (Checkpoint B, Task 1)', () => {
  it('la lista canonica della risorsa coincide con SYNTHETIC_TEAMS (ordine irrilevante)', () => {
    const canonical = canonicalList(readAliases());
    expect([...canonical].sort()).toEqual([...SYNTHETIC_TEAMS].sort());
  });
});
