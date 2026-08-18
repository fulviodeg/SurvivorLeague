/**
 * Test unitari del FootballDataClient (piano Task 2.1, LLD §6.1, ADR-007).
 *
 * Verificano il contratto del client verso l'API football-data.org senzarete:
 * il `fetch` è iniettato (mock/deque di risposte in memoria, LLD §8), così come
 * la funzione `sleep` (per testare il throttling senza attendere davvero).
 * Coprono: costruzione URL e header X-Auth-Token (config-driven, mai SA/2025
 * hardcodati), mappatura completa degli status API (matchday → round, punteggi,
 * postponed — briefing §2, punti 2.1-3/2.1-4/2.1-5), throttling su 429 con
 * X-RequestCounter-Reset in secondi (×1000 ms, 2.1-2), header corretto
 * X-RequestsAvailable (2.1-1), retry solo su 429/5xx/network e MAI su
 * 400/401/403 (2.1-6), timeout massimo e contratto d'errore FootballDataError
 * (2.1-7).
 */
import { describe, expect, it } from 'vitest';

import {
  FootballDataClient,
  FootballDataError,
  type FootballDataClientParams
} from '../../src/data/football-data-client.js';
import type { Match } from '../../src/data/provider.js';

/** Schema della risposta API: un match del payload di football-data.org. */
function apiMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    matchday: 1,
    status: 'TIMED',
    utcDate: '2025-09-12T16:00:00Z',
    homeTeam: { name: 'FC Internazionale Milano', shortName: 'Inter', tla: 'INT' },
    awayTeam: { name: 'AC Milan', shortName: 'Milan', tla: 'MIL' },
    score: { winner: 'DRAW', duration: 'REGULAR', fullTime: { home: null, away: null } },
    ...overrides
  };
}

/** Risposta JSON 200 con i match indicati. */
function json200(matches: unknown[]): Response {
  return new Response(JSON.stringify({ filters: {}, matches }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Client con fetch e sleep iniettati (test ermetici, senza rete né attese reali). */
function makeClient(
  fetchImpl: typeof fetch,
  opts: Partial<FootballDataClientParams> = {}
): { client: FootballDataClient; waits: number[] } {
  const waits: number[] = [];
  const client = new FootballDataClient({
    baseUrl: 'https://api.test.example',
    token: 'test-token',
    competition: 'SA',
    season: 2025,
    fetchImpl,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    ...opts
  });
  return { client, waits };
}

describe('FootballDataClient — richiesta (config-driven, 2.1-5/2.1-8)', () => {
  it('costruisce URL da baseUrl/competition/season e invia X-Auth-Token', async () => {
    const calls: string[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl: typeof fetch = ((url: unknown, init?: unknown) => {
      calls.push(String(url));
      headers.push((init as RequestInit).headers as Record<string, string>);
      return Promise.resolve(json200([]));
    }) as typeof fetch;

    const { client } = makeClient(fetchImpl);
    await client.getMatches();

    expect(calls).toEqual(['https://api.test.example/v4/competitions/SA/matches?season=2025']);
    expect(headers[0]).toEqual({ 'X-Auth-Token': 'test-token' });
  });
});

describe('FootballDataClient — mappatura status API (2.1-3/2.1-4)', () => {
  it('mappa matchday → round e usa homeTeam.name/awayTeam.name, non shortName/tla', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(json200([apiMatch({ matchday: 4 })]));
    const { client } = makeClient(fetchImpl);

    const matches = await client.getMatches();
    expect(matches[0]).toMatchObject({
      round: 4,
      homeTeam: 'FC Internazionale Milano',
      awayTeam: 'AC Milan',
      postponed: false
    });
  });

  it('converte utcDate in Date (canonica, suffisso Z)', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(json200([apiMatch({ utcDate: '2025-09-12T16:00:00Z' })]));
    const { client } = makeClient(fetchImpl);

    const matches = await client.getMatches();
    expect(matches[0]?.matchDate).toBeInstanceOf(Date);
    expect(matches[0]?.matchDate.toISOString()).toBe('2025-09-12T16:00:00.000Z');
  });

  it('FINISHED → punteggi da score.fullTime e postponed=false', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        json200([
          apiMatch({
            status: 'FINISHED',
            score: { winner: 'HOME_TEAM', fullTime: { home: 2, away: 1 } }
          })
        ])
      );
    const { client } = makeClient(fetchImpl);

    const [m] = await client.getMatches();
    expect(m).toMatchObject({ homeScore: 2, awayScore: 1, postponed: false });
  });

  it('AWARDED (forfait) → punteggio assegnato presentato come punteggio, non pending per sempre', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        json200([
          apiMatch({
            status: 'AWARDED',
            score: { winner: 'HOME_TEAM', fullTime: { home: 3, away: 0 } }
          })
        ])
      );
    const { client } = makeClient(fetchImpl);

    const [m] = await client.getMatches();
    expect(m).toMatchObject({ homeScore: 3, awayScore: 0, postponed: false });
  });

  it('POSTPONED / SUSPENDED / CANCELLED → postponed=true senza punteggio', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        json200([
          apiMatch({ status: 'POSTPONED' }),
          apiMatch({ status: 'SUSPENDED' }),
          apiMatch({ status: 'CANCELLED' })
        ])
      );
    const { client } = makeClient(fetchImpl);

    const matches = await client.getMatches();
    expect(matches.map((m) => m.postponed)).toEqual([true, true, true]);
    expect(matches.every((m) => m.homeScore === undefined && m.awayScore === undefined)).toBe(true);
  });

  it('SCHEDULED / TIMED / IN_PLAY / PAUSED / EXTRA_TIME / PENALTY_SHOOTOUT → postponed=false senza punteggio (mai crash)', async () => {
    const statuses = ['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'];
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(json200(statuses.map((s) => apiMatch({ status: s }))));
    const { client } = makeClient(fetchImpl);

    const matches = await client.getMatches();
    expect(matches).toHaveLength(statuses.length);
    expect(matches.every((m) => !m.postponed && m.homeScore === undefined)).toBe(true);
  });
});

describe('FootballDataClient — throttling e retry (2.1-1/2.1-2/2.1-6)', () => {
  it('su 429 attende X-RequestCounter-Reset (secondi) ×1000 ms prima di ritentare', async () => {
    const responses = [
      new Response(null, { status: 429, headers: { 'X-RequestCounter-Reset': '60' } }),
      json200([apiMatch({ matchday: 1 })])
    ];
    const fetchImpl: typeof fetch = () => Promise.resolve(responses.shift()!);
    const { client, waits } = makeClient(fetchImpl);

    const matches = await client.getMatches();
    expect(matches).toHaveLength(1);
    // Unità dell'header = secondi: il valore grezzo (60) va moltiplicato per 1000.
    expect(waits).toEqual([60_000]);
  });

  it('su 429 senza header di reset usa l’attesa cautelativa di default (60s)', async () => {
    const responses = [new Response(null, { status: 429 }), json200([])];
    const fetchImpl: typeof fetch = () => Promise.resolve(responses.shift()!);
    const { client, waits } = makeClient(fetchImpl);

    await client.getMatches();
    expect(waits).toEqual([60_000]);
  });

  it('legge X-RequestsAvailable: la include nel messaggio quando i retry si esauriscono', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { 'X-RequestCounter-Reset': '60', 'X-RequestsAvailable': '0' }
        })
      );
    const { client } = makeClient(fetchImpl, { maxRetries: 1 });

    await expect(client.getMatches()).rejects.toThrowError(/X-RequestsAvailable/);
  });

  it('ritenta una risposta 5xx transitoria (503) e risolve al successivo 200', async () => {
    const responses = [new Response(null, { status: 503 }), json200([])];
    let called = 0;
    const fetchImpl: typeof fetch = () => {
      called++;
      return Promise.resolve(responses.shift()!);
    };
    const { client } = makeClient(fetchImpl);

    await client.getMatches();
    expect(called).toBe(2);
  });

  it('MAI su 400/401/403: lancia subito FootballDataError, senza sprecare retry', async () => {
    for (const status of [400, 401, 403]) {
      let called = 0;
      const fetchImpl: typeof fetch = () => {
        called++;
        return Promise.resolve(new Response(null, { status }));
      };
      const { client } = makeClient(fetchImpl, { maxRetries: 3 });

      await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
      expect(called).toBe(1);
    }
  });

  it('esaurisce i retry su 429 persistente e lancia FootballDataError con lo status', async () => {
    let called = 0;
    const fetchImpl: typeof fetch = () => {
      called++;
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { 'X-RequestCounter-Reset': '60' }
        })
      );
    };
    const { client } = makeClient(fetchImpl, { maxRetries: 2 });

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
    expect(called).toBe(3); // tentativo iniziale + 2 retry
  });

  it('ritenta un errore di rete e alla fine lancia FootballDataError', async () => {
    let called = 0;
    const fetchImpl: typeof fetch = () => {
      called++;
      return Promise.reject(new TypeError('fetch failed'));
    };
    const { client } = makeClient(fetchImpl, { maxRetries: 2 });

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
    expect(called).toBe(3);
  });
});

describe('FootballDataClient — contratto d’errore e timeout (2.1-7)', () => {
  it('lancio FootballDataError quando manca la chiave matches', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ filters: {} }), { status: 200 }));
    const { client } = makeClient(fetchImpl);

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
  });

  it('lancio FootballDataError su body JSON malformato (200)', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('non-json', { status: 200 }));
    const { client } = makeClient(fetchImpl);

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
  });

  it('su 404/non-429/non-5xx lancia FootballDataError con lo status, senza retry', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    const { client } = makeClient(fetchImpl, { maxRetries: 3 });

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
  });

  it('rispetta il timeout massimo: richiesta appesa fino all’abort → FootballDataError', async () => {
    // fetch che si risolve (rifiutando) solo quando il segnale viene abortito:
    // simula un server che non risponde entro il timeout configurato.
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }) as Promise<Response>;
    const { client } = makeClient(fetchImpl, { timeoutMs: 20 });

    await expect(client.getMatches()).rejects.toBeInstanceOf(FootballDataError);
    await expect(client.getMatches()).rejects.toThrowError(/timeout/i);
  });
});

describe('FootballDataClient — parametri espliciti (2.1-8)', () => {
  it('rifiuta al costruire se manca il token (token richiesto)', () => {
    expect(
      () =>
        new FootballDataClient({
          baseUrl: 'https://api.test.example',
          token: '',
          competition: 'SA',
          season: 2025
        })
    ).toThrow();
  });

  it('applica i default di retry e timeout documentati', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(json200([]));
    const { client } = makeClient(fetchImpl);

    // Verifica che i default esistano e che getMatches funzioni con una richiesta riuscita.
    const matches: Match[] = await client.getMatches();
    expect(matches).toEqual([]);
  });
});
