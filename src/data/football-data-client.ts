/**
 * Client HTTP per l'API football-data.org v4 (ADR-007, piano Task 2.1).
 *
 * Ruolo: unico punto di accesso all'API dati stagione. Espone `getMatches()`
 * che restituisce la stagione come `Match[]` (tipo condiviso di
 * src/data/provider.ts). Viene usato SOLO dai comandi `data:*`
 * (`data:import`/`data:refresh`, LLD §7.2): il Game Engine legge solo dal DB
 * tramite `DbSeasonDataProvider` e non accede mai all'API (ADR-007).
 *
 * Config-driven (mai `SA`/`2025` hardcodati): URL, competizione e stagione
 * arrivano da parametri espliciti del costruttore, iniettati dal comando CLI
 * che legge `getConfig()` (pattern di src/cli/commands/db.ts). Il client NON
 * usa `getConfig()`/`process.env` all'interno (briefing Fase 2, 2.1-5/2.1-8).
 *
 * Testabilità: `fetchImpl` è iniettabile (fetch nativo di Node ≥20 nei test,
 * nessuna nuova dipendenza) e `sleep` è iniettabile per verificare il
 * throttling senza attese reali (LLD §8, plan.md "Mock e livelli di test").
 *
 * Throttling (documentazione ufficiale football-data.org v4):
 *   - header di risposta `X-RequestsAvailable`  → richieste residue prima del rate limit;
 *   - header di risposta `X-RequestCounter-Reset` → secondi alla reinizializzazione del contatore;
 *   - su 429 il client attende `X-RequestCounter-Reset` SECONDI (×1000 ms) prima di ritentare.
 *
 * Mappatura status API → dominio (briefing 2.1-3/2.1-4, LLD §6.1):
 *   - `matchday` → `round` (l'API v4 non espone un campo `round`);
 *   - `POSTPONED`/`SUSPENDED`/`CANCELLED` → `postponed = true`, senza punteggio;
 *   - `FINISHED`/`AWARDED` → punteggio da `score.fullTime` (il forfait AWARDED ha
 *     comunque un risultato assegnato, es. 3-0: va presentato, non lasciato `pending`);
 *   - `SCHEDULED`/`TIMED`/`IN_PLAY`/`PAUSED`/`EXTRA_TIME`/`PENALTY_SHOOTOUT`
 *     → `postponed = false`, senza punteggio (non ancora conclusa).
 *
 * Retry (briefing 2.1-6/2.1-7): si ritenta SOLO su 429 (aspettando il reset),
 * risposte 5xx transitorie ed errori di rete. MAI su 400/401/403/404 (token
 * invalido o risorsa assente: ritentare sprecherebbe il rate limit). Un
 * timeout (limite di tempo per richiesta) termina subito con `FootballDataError`,
 * per non bloccare `data:refresh` dello scheduler.
 */
import type { Match } from './provider.js';

type FetchImpl = typeof fetch;

/** Errore del client verso football-data.org: contratto chiaro per i comandi `data:*`. */
export class FootballDataError extends Error {
  /** Status HTTP della risposta problematica (assente per timeout/errore di rete). */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FootballDataError';
    this.status = status;
  }
}

/** Parametri espliciti del client, iniettati dal comando (2.1-8). */
export interface FootballDataClientParams {
  /** Origine dell'API (es. https://api.football-data.org), senza path. */
  baseUrl: string;
  /** Token API (header X-Auth-Token), fornito dal PO via env. */
  token: string;
  /** Codice competizione (es. SA = Serie A), da FOOTBALL_DATA_COMPETITION. */
  competition: string;
  /** Anno di inizio stagione (es. 2025 = 2025/26), da FOOTBALL_DATA_SEASON. */
  season: number;
  /** fetch iniettabile per i test (default: fetch nativo di Node ≥20). Nessuna dipendenza nuova. */
  fetchImpl?: FetchImpl;
  /** Numero MASSIMO di retry dopo il tentativo iniziale (default 3 → fino a 4 richieste). */
  maxRetries?: number;
  /** Timeout massimo per una singola richiesta, in ms (default 10000). */
  timeoutMs?: number;
  /** Funzione di attesa iniettabile per i test (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

// Valori di default documentati (briefing Fase 2, punti 2.1-2/2.1-6).
const MAX_RETRIES = 3;
const TIMEOUT_MS = 10_000;
/** Attesa cautelativa quando un 429 non riporta X-RequestCounter-Reset (≈ un ciclo di quota del free tier). */
const DEFAULT_RETRY_WAIT_MS = 60_000;
/** Attesa tra un retry per 5xx/errore di rete e il successivo. */
const NETWORK_BACKOFF_MS = 1_000;

/** Status che rendono la partita rinviata ai fini del gioco (ADR-002: sospese incluse). */
const POSTPONED_STATUSES = new Set(['POSTPONED', 'SUSPENDED', 'CANCELLED']);
/** Status con esito determinato: il punteggio di `score.fullTime` è definitivo. */
const SCORED_STATUSES = new Set(['FINISHED', 'AWARDED']);

/** Shape minimale di un match nella risposta dell'API (i campi sono `unknown` finché validati). */
interface ApiMatch {
  matchday?: unknown;
  utcDate?: unknown;
  status?: unknown;
  homeTeam?: { name?: unknown; shortName?: unknown };
  awayTeam?: { name?: unknown; shortName?: unknown };
  score?: { fullTime?: { home?: unknown; away?: unknown } };
}

export class FootballDataClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly competition: string;
  private readonly season: number;
  private readonly fetchImpl: FetchImpl;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(params: FootballDataClientParams) {
    if (!params.token) throw new FootballDataError('Token football-data.org mancante (FOOTBALL_DATA_TOKEN)');
    if (!Number.isFinite(params.season)) throw new FootballDataError('Season non valida (FOOTBALL_DATA_SEASON)');
    this.baseUrl = params.baseUrl;
    this.token = params.token;
    this.competition = params.competition;
    this.season = params.season;
    this.fetchImpl = params.fetchImpl ?? globalThis.fetch;
    this.maxRetries = params.maxRetries ?? MAX_RETRIES;
    this.timeoutMs = params.timeoutMs ?? TIMEOUT_MS;
    this.sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * URL dell'endpoint competizione/matches per la stagione configurata.
   * Costruito dai parametri (mai hardcodati): `GET /v4/competitions/{competition}/matches?season={season}`.
   */
  getMatchesUrl(): string {
    return `${this.baseUrl}/v4/competitions/${this.competition}/matches?season=${this.season}`;
  }

  /**
   * Scarica e mappa l'intera stagione in `Match[]`.
   * Gestisce throttling (429 → attesa del reset), retry su 5xx/errore di rete,
   * timeout e contratto d'errore `FootballDataError`.
   */
  async getMatches(): Promise<Match[]> {
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Timeout per singola richiesta: abort del fetch dopo timeoutMs.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(this.getMatchesUrl(), {
          headers: { 'X-Auth-Token': this.token },
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          // Timeout: richiesta annullata dal limite di tempo. Non si ritenta:
          // il timeout esiste per non bloccare lo scheduler (data:refresh a ogni tick).
          throw new FootballDataError(
            `Timeout (${this.timeoutMs}ms) nella richiesta a football-data.org`
          );
        }
        // Errore di rete: transitorio → si ritenta (se esaurito, errore chiaro).
        if (attempt >= maxAttempts) {
          throw new FootballDataError(
            `Errore di rete persistente verso football-data.org dopo ${maxAttempts} tentativi: ${(error as Error).message}`
          );
        }
        await this.sleep(NETWORK_BACKOFF_MS);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 200) {
        return this.parseResponse(res);
      }
      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          throw this.rateLimitError(res);
        }
        // Header X-RequestCounter-Reset espresso in secondi → attesa in millisecondi.
        await this.sleep(this.retryDelayMs(res));
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= maxAttempts) {
          throw new FootballDataError(
            `Risposta ${res.status} da football-data.org dopo ${maxAttempts} tentativi`,
            res.status
          );
        }
        await this.sleep(NETWORK_BACKOFF_MS);
        continue;
      }
      // 4xx e altri status: mai ritentare (token invalido, risorsa assente...).
      const statusText = res.statusText ? ` ${res.statusText}` : '';
      throw new FootballDataError(
        `Risposta inattesa ${res.status}${statusText} da football-data.org`,
        res.status
      );
    }
    // Raggiungibile solo se maxAttempts < 1 (mai nei default): difesa compilativa.
    throw new FootballDataError('Tentativi esauriti senza esito verso football-data.org');
  }

  /**
   * Attesa consigliata dopo un 429: `X-RequestCounter-Reset` (SECONDI) ×1000 ms;
   * se l'header manca, attesa cautelativa fissa.
   */
  private retryDelayMs(res: Response): number {
    const raw = res.headers.get('X-RequestCounter-Reset');
    const seconds = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    return DEFAULT_RETRY_WAIT_MS;
  }

  /** Errore di rate limit dopo l'esaurimento dei retry, con i dettagli header utili. */
  private rateLimitError(res: Response): FootballDataError {
    const available = res.headers.get('X-RequestsAvailable');
    const reset = res.headers.get('X-RequestCounter-Reset');
    const parts = [
      available !== null ? `X-RequestsAvailable=${available}` : null,
      reset !== null ? `X-RequestCounter-Reset=${reset}s` : null
    ].filter((p): p is string => p !== null);
    const details = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return new FootballDataError(
      `Rate limit football-data.org superato dopo ${this.maxRetries} retry${details}. Riprova più tardi.`,
      429
    );
  }

  /** Valida la risposta (JSON, chiave `matches`) e mappa ogni match. */
  private async parseResponse(res: Response): Promise<Match[]> {
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new FootballDataError('Body JSON malformato nella risposta football-data.org');
    }
    if (typeof data !== 'object' || data === null || !Array.isArray((data as { matches?: unknown }).matches)) {
      throw new FootballDataError("Risposta football-data.org senza la chiave 'matches'");
    }
    return ((data as { matches: unknown[] }).matches).map((match) => this.parseMatch(match));
  }

  /** Mappa un singolo match API → Match (matchday→round, utcDate→Date, name→team, status). */
  private parseMatch(raw: unknown): Match {
    if (typeof raw !== 'object' || raw === null) {
      throw new FootballDataError('Match API non valido (oggetto atteso)');
    }
    const m = raw as ApiMatch;
    const round = m.matchday;
    const utcDate = m.utcDate;
    const homeTeam = m.homeTeam?.name;
    const awayTeam = m.awayTeam?.name;
    const homeShort = m.homeTeam?.shortName;
    const awayShort = m.awayTeam?.shortName;
    if (
      typeof round !== 'number' ||
      typeof utcDate !== 'string' ||
      typeof homeTeam !== 'string' ||
      typeof awayTeam !== 'string' ||
      typeof homeShort !== 'string' ||
      typeof awayShort !== 'string'
    ) {
      throw new FootballDataError(
        'Match API malformato (matchday, utcDate o homeTeam.name/awayTeam.name/shortName mancanti)'
      );
    }

    const status = typeof m.status === 'string' ? m.status : '';
    const postponed = POSTPONED_STATUSES.has(status);
    const isScored = SCORED_STATUSES.has(status);
    const fullTime = m.score?.fullTime;
    const homeScore = isScored ? fullTime?.home : undefined;
    const awayScore = isScored ? fullTime?.away : undefined;

    return {
      round,
      matchDate: new Date(utcDate),
      homeTeam,
      awayTeam,
      homeTeamShort: homeShort,
      awayTeamShort: awayShort,
      homeScore: typeof homeScore === 'number' ? homeScore : undefined,
      awayScore: typeof awayScore === 'number' ? awayScore : undefined,
      postponed
    };
  }
}
