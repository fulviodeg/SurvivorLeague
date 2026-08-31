/**
 * Copertura esaustiva della rosa sintetica (Task 1b del piano
 * `.kilo/plans/1788161325462-abbreviated-name-never-fail.md`, decisione D8).
 *
 * Dimostra "il nome abbreviato non deve MAI fallire" su TUTTI i nomi della
 * rosa sintetica — ogni nome canonico di `SYNTHETIC_TEAMS` E ogni alias della
 * tabella `team-aliases-synthetic.md` — con ENTRAMBI i parser (richiesta del
 * PO) e in tutti i percorsi del flusso reale:
 *
 *   1. parser deterministico (squadra nuda in win_only → `{team, win}`);
 *   2. filtro del classificatore LLM: l'LLM emette l'alias come campo `team`
 *      → risolto al nome canonico (soluzione B);
 *   3. cross-check del `FallbackIntentClassifier`: l'LLM risponde `other`
 *      con successo → il deterministico vince (soluzione A, caso reale UAT);
 *   4. cross-check con l'LLM che risponde `pick:null` (falso negativo).
 *
 * Il test è DATA-DRIVEN: cicla sui dati reali (costante + file markdown),
 * nessun fixture hardcoded — se in futuro una squadra nuova resta senza
 * alias, il test fallisce. L'univocità (nessun alias su due canonici) è
 * verificata in coda. Lo stato atteso: parti 1 e 5 verdi da subito (net di
 * regressione), parti 2–4 rosse finché B/A non sono implementate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SYNTHETIC_TEAMS } from '../../../src/data/synthetic-season.js';
import {
  DeterministicIntentClassifier,
  FallbackIntentClassifier
} from '../../../src/llm/deterministic-parser.js';
import { OpenAIIntentClassifier } from '../../../src/llm/intent-classifier.js';
import { OpenAIClient } from '../../../src/llm/openai-client.js';
import type { IntentClassification } from '../../../src/llm/intent-classifier.js';
import type { PickParseOptions } from '../../../src/llm/parser.js';
import { normalize } from '../../../src/llm/team-terms.js';

/** Percorso assoluto della risorsa alias sintetica (vive in src/llm/). */
const ALIASES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/llm/team-aliases-synthetic.md'
);
const ALIASES = readFileSync(ALIASES_PATH, 'utf8');

/** Stessa configurazione del flusso reale UAT: win_only + jolly attivi. */
function opts(): PickParseOptions {
  return { teams: [...SYNTHETIC_TEAMS], aliases: ALIASES, winOnly: true, jollyEnabled: true };
}

/** Estrae le righe dati della tabella alias: lista alias + nome canonico. */
function aliasRows(): Array<{ aliases: string[]; canonical: string }> {
  const section = ALIASES.split('## Alias → nome canonico')[1] ?? '';
  const rows: Array<{ aliases: string[]; canonical: string }> = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const aliasCell = cells[1];
    const canonical = cells[2];
    if (
      aliasCell === undefined ||
      canonical === undefined ||
      canonical === 'Nome canonico' ||
      /^-+$/.test(canonical)
    ) {
      continue;
    }
    rows.push({
      aliases: aliasCell
        .split(',')
        .map((alias) => alias.trim())
        .filter((alias) => alias !== ''),
      canonical
    });
  }
  return rows;
}

/** Classificatore LLM che restituisce un pick con il `team` indicato (fetch mockato). */
function classifyAsLlmPick(teamValue: string, o: PickParseOptions): Promise<IntentClassification> {
  const content = JSON.stringify({ intent: 'pick', pick: { team: teamValue, outcome: 'win' } });
  const fetchImpl = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  const client = new OpenAIClient({
    baseUrl: 'https://llm.test.example/v1',
    apiKey: 'k',
    models: ['m'],
    retries: 1,
    fetchImpl
  });
  return new OpenAIIntentClassifier(client).classify(teamValue, o);
}

/** Fallback con LLM scriptato (esito fisso) e logger che registra i warn. */
function fallbackWith(llmResult: IntentClassification): {
  fallback: FallbackIntentClassifier;
  warnings: Array<{ obj: object }>;
} {
  const llm = { classify: async () => llmResult };
  const warnings: Array<{ obj: object }> = [];
  const logger = { warn: (obj: object) => { warnings.push({ obj }); } };
  return {
    fallback: new FallbackIntentClassifier(llm, new DeterministicIntentClassifier(), logger),
    warnings
  };
}

const OTHER: IntentClassification = { intent: 'other', pick: null, name: null };
const PICK_NULL: IntentClassification = { intent: 'pick', pick: null, name: null };

describe('Copertura esaustiva — parser deterministico (win_only + jolly)', () => {
  it('ogni nome canonico della rosa → pick col canonico', async () => {
    const det = new DeterministicIntentClassifier();
    for (const team of SYNTHETIC_TEAMS) {
      const result = await det.classify(team, opts());
      expect(result, team).toMatchObject({ intent: 'pick', pick: { team, outcome: 'win' } });
    }
  });

  it('ogni alias della tabella → pick col canonico mappato', async () => {
    const det = new DeterministicIntentClassifier();
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const result = await det.classify(alias, opts());
        expect(result, `${alias} → ${canonical}`).toMatchObject({
          intent: 'pick',
          pick: { team: canonical, outcome: 'win' }
        });
      }
    }
  });
});

describe('Copertura esaustiva — filtro classificatore LLM (soluzione B)', () => {
  it('ogni nome canonico emesso dall\'LLM come team → accettato col canonico', async () => {
    for (const team of SYNTHETIC_TEAMS) {
      const result = await classifyAsLlmPick(team, opts());
      expect(result, team).toMatchObject({ intent: 'pick', pick: { team, outcome: 'win' } });
    }
  });

  it('ogni alias emesso dall\'LLM come team → risolto al canonico mappato', async () => {
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const result = await classifyAsLlmPick(alias, opts());
        expect(result, `${alias} → ${canonical}`).toMatchObject({
          intent: 'pick',
          pick: { team: canonical, outcome: 'win' }
        });
      }
    }
  });
});

describe('Copertura esaustiva — cross-check FallbackIntentClassifier (soluzione A)', () => {
  it('LLM other: ogni nome canonico → pick col canonico (warn llm_false_negative)', async () => {
    for (const team of SYNTHETIC_TEAMS) {
      const { fallback, warnings } = fallbackWith(OTHER);
      const result = await fallback.classify(team, opts());
      expect(result, team).toMatchObject({ intent: 'pick', pick: { team, outcome: 'win' } });
      expect(warnings, team).toHaveLength(1);
      expect(warnings[0]?.obj, team).toMatchObject({ reason: 'llm_false_negative' });
    }
  });

  it('LLM other: ogni alias → pick col canonico mappato', async () => {
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const { fallback } = fallbackWith(OTHER);
        const result = await fallback.classify(alias, opts());
        expect(result, `${alias} → ${canonical}`).toMatchObject({
          intent: 'pick',
          pick: { team: canonical, outcome: 'win' }
        });
      }
    }
  });

  it('LLM pick:null: ogni nome canonico → pick col canonico', async () => {
    for (const team of SYNTHETIC_TEAMS) {
      const { fallback } = fallbackWith(PICK_NULL);
      const result = await fallback.classify(team, opts());
      expect(result, team).toMatchObject({ intent: 'pick', pick: { team, outcome: 'win' } });
    }
  });

  it('LLM pick:null: ogni alias → pick col canonico mappato', async () => {
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const { fallback } = fallbackWith(PICK_NULL);
        const result = await fallback.classify(alias, opts());
        expect(result, `${alias} → ${canonical}`).toMatchObject({
          intent: 'pick',
          pick: { team: canonical, outcome: 'win' }
        });
      }
    }
  });
});

describe('Copertura esaustiva — univocità della tabella alias', () => {
  it('nessun alias mappa su due canonici diversi', () => {
    const seen = new Map<string, string>();
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const previous = seen.get(alias);
        expect(previous === undefined || previous === canonical, alias).toBe(true);
        seen.set(alias, canonical);
      }
    }
  });

  it('nessun alias collide col nome canonico NORMALIZZATO di un\'altra squadra', () => {
    // In `resolveTeamField` il confronto è esatto sul valore normalizzato e i
    // canonici precedono gli alias nell'ordine stabile: un alias uguale al
    // canonico di un'ALTRA squadra risolverebbe silenziosamente alla squadra
    // sbagliata. Guardia latente: l'aggiunta futura di un alias collisionante
    // fa fallire questo test (review 2026-08-31).
    const canonicalNorm = new Map<string, string>();
    for (const team of SYNTHETIC_TEAMS) canonicalNorm.set(normalize(team), team);
    for (const { aliases, canonical } of aliasRows()) {
      for (const alias of aliases) {
        const owner = canonicalNorm.get(normalize(alias));
        expect(owner === undefined || owner === canonical, `${alias} → ${canonical}`).toBe(true);
      }
    }
  });
});
