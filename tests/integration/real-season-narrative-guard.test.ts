/**
 * Verifica END-TO-END della guardia narrativa sulla STAGIONE REALE 2025/26
 * scaricata LIVE da football-data.org (ADR-007, client reale, nessun mock).
 *
 * NON è un test ermetico: usa rete e token (`FOOTBALL_DATA_TOKEN`, caricato da
 * .env come fa src/config.ts). Senza token (CI, ambienti spogli) il test è
 * SALTATO (`describe.skipIf`). Verifica per OGNI uno dei 38 round reali:
 *   - il contesto email serializzato (10 partite) resta contenuto (~1 KB) —
 *     è INPUT del prompt, non limitato da MAX_NARRATIVE_CHARS;
 *   - una narrativa legittima LUNGA passa la guardia senza falsi positivi e
 *     rientra in TEXT_MAX_TOKENS (max_tokens non tronca testo valido);
 *   - un dump degenerato (echo del prompt) viene sostituito dal fallback.
 */
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { FootballDataClient } from '../../src/data/football-data-client.js';
import {
  MAX_NARRATIVE_CHARS,
  deterministicNarrative,
  type EmailContext,
  type EmailMatchContext
} from '../../src/llm/generator.js';
import { FALLBACK_NARRATIVES, serializeEmailContext } from '../../src/llm/templates.js';
import { TEXT_MAX_TOKENS } from '../../src/llm/openai-client.js';
import { LONG_LEGITIMATE_NARRATIVE, estimateTokens } from '../fixtures/real-season-2025.js';

// Carica .env best-effort (stessa semantica di src/config.ts: senza override).
try {
  process.loadEnvFile('.env');
} catch {
  /* nessun .env: ci si affida all'ambiente del processo */
}
const TOKEN = process.env.FOOTBALL_DATA_TOKEN ?? '';

describe.skipIf(TOKEN.trim() === '')('guardia narrativa con la stagione reale 2025/26 (download live)', () => {
  it(
    'per OGNI round reale (38 × 10 partite) contesto contenuto, narrativa valida NON fallbackata, dump → fallback',
    async () => {
      const client = new FootballDataClient({
        baseUrl: process.env.FOOTBALL_DATA_BASE_URL ?? 'https://api.football-data.org',
        token: TOKEN,
        competition: process.env.FOOTBALL_DATA_COMPETITION ?? 'SA',
        season: Number(process.env.FOOTBALL_DATA_SEASON ?? 2025)
      });
      const season = await client.getMatches();

      // Sanity sui dati reali della stagione 2025/26 (SA): 380 partite, 38 giornate.
      expect(season).toHaveLength(380);
      const rounds = [...new Set(season.map((m) => m.round))].sort((a, b) => a - b);
      expect(rounds).toHaveLength(38);

      for (const round of rounds) {
        const matches: EmailMatchContext[] = season
          .filter((m) => m.round === round)
          .map((m) => ({
            home: m.homeTeam,
            away: m.awayTeam,
            ...(m.homeScore !== undefined && m.awayScore !== undefined
              ? { score: { home: m.homeScore, away: m.awayScore } }
              : {}),
            ...(m.postponed ? { postponed: true } : {})
          }));
        expect(matches).toHaveLength(10);

        const ctx: EmailContext = {
          type: 'round_closed_survived',
          playerName: 'Aldo',
          round,
          championshipRound: round,
          matches,
          inGameCount: 20
        };

        // 1. Input del prompt: contenuto e NON governato dalla guardia.
        const serialized = serializeEmailContext(ctx, 'Europe/Rome');
        expect(serialized.length).toBeLessThan(2_000);

        // 2. Narrativa legittima lunga: nessun falso positivo, nessuna troncatura.
        expect(LONG_LEGITIMATE_NARRATIVE.length).toBeLessThanOrEqual(MAX_NARRATIVE_CHARS);
        expect(estimateTokens(LONG_LEGITIMATE_NARRATIVE)).toBeLessThanOrEqual(TEXT_MAX_TOKENS);
        expect(deterministicNarrative(ctx, LONG_LEGITIMATE_NARRATIVE)).toBe(
          LONG_LEGITIMATE_NARRATIVE
        );

        // 3. Dump degenerato: il fallback deterministico scatta anche col contesto reale.
        const echo =
          'We need to produce a short narrative text (2-4 short sentences) in Italian, enthusiastic and friendly... ';
        expect(deterministicNarrative(ctx, echo.repeat(200))).toBe(
          FALLBACK_NARRATIVES.round_closed_survived
        );
      }
    },
    30_000
  );
});
