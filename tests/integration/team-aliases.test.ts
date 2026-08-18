/**
 * Test della risorsa prompt `src/llm/team-aliases.md` (piano Task 2.4, LLD §6.2).
 *
 * Verificano la coerenza della risorsa (niente logica nel file, solo Markdown
 * editoriale — briefing §5-B):
 *   - la lista canonica copre TUTTI e 20 i club della Serie A 2025/26;
 *   - ogni alias mappa su un nome canonico della lista e ogni nome canonico ha
 *     almeno un alias (nessuna squadra scoperta);
 *   - COINCIDENZA con i dati: i nomi canonici del file devono coincidere con i
 *     nomi `name` dell'API che `data:import` stora e che `getTeams()` legge —
 *     altrimenti a UAT dei pick validi verrebbero rifiutati dal check esatto
 *     post-parse (briefing Fase 2 §5-A). Il test usa le fixture (Task 2.5) con
 *     4 nomi reali per esercitare la coincidenza su `getTeams()`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../fixtures/season.js';

/** Percorso assoluto della risorsa (il file vive in src/llm/, non in tests/). */
const ALIASES_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/llm/team-aliases.md');

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

describe('team-aliases.md — coerenza della risorsa (Task 2.4 §5-A/B)', () => {
  it('la lista canonica copre tutti e 20 i club della Serie A 2025/26, senza duplicati', () => {
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
});

describe('team-aliases.md — coincidenza con getTeams() (briefing §5-A)', () => {
  it('i nomi della mini-stagione fixture coincidono con la lista canonica della risorsa', () => {
    const canonical = new Set(canonicalList(readAliases()));
    for (const team of FIXTURE_TEAMS) {
      expect(canonical.has(team)).toBe(true);
    }
  });

  it('le squadre lette da getTeams() su un DB importato con le fixture sono tutte coperte dalla lista canonica', async () => {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);

    const provider = new DbSeasonDataProvider(db);
    const stored = await provider.getTeams();
    const canonical = new Set(canonicalList(readAliases()));

    expect(stored).toHaveLength(4);
    for (const name of stored) {
      expect(canonical.has(name)).toBe(true);
    }
    db.close();
  });
});
