/**
 * Test del modulo condiviso dei termini squadra (Task 2 del piano
 * `.kilo/plans/1788161325462-abbreviated-name-never-fail.md`, fondamento di B).
 *
 * `src/llm/team-terms.ts` è l'UNICA fonte della costruzione dei termini
 * confrontabili (nomi canonici + alias della tabella markdown) e della
 * risoluzione squadra, riusata da:
 *   - `DeterministicIntentClassifier` (src/llm/deterministic-parser.ts):
 *     ricerca per SOTTOSTRINGA nel testo (`resolveTeam`);
 *   - filtro del classificatore LLM (`OpenAIIntentClassifier.parseClassification`,
 *     soluzione B): confronto ESATTO sul campo strutturato `team`
 *     (`resolveTeamField`).
 *
 * Coprono: normalizzazione (minuscolo/trim/accenti), parsing della tabella
 * alias (intestazione/separatore scartati, canonici non in lista scartati),
 * ordinamento per lunghezza decrescente (longest-match), risoluzione
 * sottostringa e risoluzione esatta sul campo.
 */
import { describe, expect, it } from 'vitest';

import {
  buildTeamTerms,
  normalize,
  resolveTeam,
  resolveTeamField
} from '../../../src/llm/team-terms.js';

const TEAMS = ['Parma Calcio 1913', 'FC Internazionale Milano', 'AC Milan'];
const ALIASES = [
  '| Alias | Nome canonico |',
  '|---|---|',
  '| parma, crociati, ducali | Parma Calcio 1913 |',
  '| inter, l\'inter, nerazzurri, milano | FC Internazionale Milano |',
  '| milan, rossoneri, diavolo | AC Milan |',
  '| alias di squadra inesistente | Squadra Fantasma |'
].join('\n');

describe('normalize — minuscolo, trim, accenti rimossi', () => {
  it('minuscolo, trim e strip degli accenti (vincerà → vincera, Catanzaro → catanzaro)', () => {
    expect(normalize('  Vincerà  ')).toBe('vincera');
    expect(normalize('Catanzaro')).toBe('catanzaro');
    expect(normalize("L'Inter")).toBe("l'inter");
  });
});

describe('buildTeamTerms — costruzione dei termini confrontabili', () => {
  it('include i nomi canonici e gli alias, scarta intestazione/separatore/canonici fuori lista', () => {
    const terms = buildTeamTerms(TEAMS, ALIASES);
    const termStrings = terms.map((t) => t.term);
    for (const team of TEAMS) expect(termStrings).toContain(normalize(team));
    expect(termStrings).toContain('parma');
    expect(termStrings).toContain('l\'inter');
    expect(termStrings).not.toContain('alias di squadra inesistente');
    expect(termStrings).not.toContain('squadra fantasma');
  });

  it('ordinati per lunghezza DECRESCENTE (longest-match: milano prima di milan)', () => {
    const terms = buildTeamTerms(TEAMS, ALIASES);
    const indexes = new Map(terms.map((t, i) => [t.term, i]));
    expect(indexes.get('milano')! < indexes.get('milan')!).toBe(true);
    expect(indexes.get('l\'inter')! < indexes.get('inter')!).toBe(true);
  });

  it('lista vuota o alias vuoti → nessun termine spurio', () => {
    expect(buildTeamTerms([], '')).toEqual([]);
    expect(buildTeamTerms(['AC Milan'], '')).toHaveLength(1);
  });
});

describe('resolveTeam — risoluzione per SOTTOSTRINGA (parser deterministico)', () => {
  const terms = buildTeamTerms(TEAMS, ALIASES);

  it('alias → canonico', () => {
    expect(resolveTeam('Parma', terms)).toBe('Parma Calcio 1913');
    expect(resolveTeam('parma vince', terms)).toBe('Parma Calcio 1913');
  });

  it('longest-match: milano → Inter (non AC Milan)', () => {
    expect(resolveTeam('milano', terms)).toBe('FC Internazionale Milano');
  });

  it('canonico multi-parola → se stesso', () => {
    expect(resolveTeam('FC Internazionale Milano vince', terms)).toBe('FC Internazionale Milano');
  });

  it('nessun termine → null', () => {
    expect(resolveTeam('qualcosa di totalmente diverso', terms)).toBeNull();
  });
});

describe('resolveTeamField — risoluzione ESATTA sul campo strutturato (filtro LLM, soluzione B)', () => {
  const terms = buildTeamTerms(TEAMS, ALIASES);

  it('alias esatto → canonico', () => {
    expect(resolveTeamField('Parma', terms)).toBe('Parma Calcio 1913');
    expect(resolveTeamField('milan', terms)).toBe('AC Milan');
  });

  it('case/accenti-insensibile (l\'Inter, PARMA) → canonico', () => {
    expect(resolveTeamField('l\'Inter', terms)).toBe('FC Internazionale Milano');
    expect(resolveTeamField('PARMA', terms)).toBe('Parma Calcio 1913');
  });

  it('nome canonico esatto → se stesso', () => {
    expect(resolveTeamField('Parma Calcio 1913', terms)).toBe('Parma Calcio 1913');
  });

  it('variante NON esatta del campo → null (niente substring sul campo strutturato)', () => {
    // "Parma Calcio" non è né canonico né alias: il campo va risolto ESATTO.
    expect(resolveTeamField('Parma Calcio', terms)).toBeNull();
    expect(resolveTeamField('', terms)).toBeNull();
    expect(resolveTeamField('Squadra Inventata', terms)).toBeNull();
  });
});
