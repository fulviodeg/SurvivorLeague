/**
 * DbSeasonDataProvider — unica implementazione POC di `SeasonDataProvider`
 * (LLD §6.1, ADR-007, piano Task 2.2).
 *
 * Ruolo: legge calendario e risultati SOLO dalla tabella `match` del DB. Il
 * Game Engine dialoga esclusivamente con questa implementazione e non accede
 * mai all'API football-data.org: l'API è popolata dal comando `data:import`
 * (Task 2.3), il provider la consuma. Questo è il motivo per cui i test del
 * provider NON mockano nulla: girano sul provider reale su SQLite in-memory
 * popolato dalle fixture sintetiche (LLD §8).
 *
 * Convenzioni (fissate in Fase 2, briefing §1):
 *   - `match_date` è canonica ISO-8601 UTC → parsing deterministico (`new Date`);
 *   - `getFirstMatchDateTime` = MIN(match_date) tra i match NON rinviati del
 *     round (kickoff effettivo per RF-31), con fallback al MIN programmato se
 *     tutte rinviate e `SeasonDataError` se il round non ha partite;
 *   - `getTeams` = UNION di home_team/away_team (robusta ai calendari parziali);
 *   - `getTotalRounds` = MAX(round) (0 se stagione vuota);
 *   - nessun filtro per la finestra torneo `[start_round..N]`: le derivazioni
 *     operano sull'intera stagione, la finestra è un filtro logico (ADR-008).
 *
 * Nota (CRITICAL-02): qui NON c'è un metodo di completezza (`areAllResultsFinal`):
 * non serve — `getMatchesForRound` espone punteggio/postponed per ogni match.
 */
import type Database from 'better-sqlite3';

import { SeasonDataError, type Match, type SeasonDataProvider, type Team } from './provider.js';

/** Riga grezza della tabella `match` (snake_case, come in LLD §3). */
interface MatchRow {
  round: number;
  match_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  postponed: number;
}

/** Colonne della tabella match usate dalle query (evita ripetizione e refusi). */
const MATCH_COLUMNS =
  'round, match_date, home_team, away_team, home_score, away_score, postponed';

export class DbSeasonDataProvider implements SeasonDataProvider {
  constructor(private readonly db: Database.Database) {}

  /** Intera stagione, ordinata per round e orario (deterministico). */
  async getCalendar(): Promise<Match[]> {
    const rows = this.db
      .prepare(`SELECT ${MATCH_COLUMNS} FROM match ORDER BY round, match_date`)
      .all() as unknown as MatchRow[];
    return rows.map((row) => this.toMatch(row));
  }

  /** Partite di un round, ordinate per orario programmato. Metodo primario per il Round Manager. */
  async getMatchesForRound(round: number): Promise<Match[]> {
    const rows = this.db
      .prepare(`SELECT ${MATCH_COLUMNS} FROM match WHERE round = ? ORDER BY match_date`)
      .all(round) as unknown as MatchRow[];
    return rows.map((row) => this.toMatch(row));
  }

  /**
   * Kickoff "effettivo" del round (deadline RF-14 + guard anti-frode RF-31).
   * Semantica per i rinvii (briefing §3-B): MIN(match_date) tra le partite NON
   * rinviate; se TUTTE sono rinviate (kickoff effettivo non noto a priori) si
   * usa il MIN programmato dell'intero round (fallback documentato, il caso
   * "non calcolabile" è coperto dalla chiusura di sicurezza RF-30); se il round
   * non ha partite → SeasonDataError.
   */
  async getFirstMatchDateTime(round: number): Promise<Date> {
    const effective = this.db
      .prepare(
        'SELECT MIN(match_date) AS m FROM match WHERE round = ? AND postponed = 0'
      )
      .get(round) as { m: string | null };
    if (effective.m !== null) return new Date(effective.m);

    const scheduled = this.db
      .prepare('SELECT MIN(match_date) AS m FROM match WHERE round = ?')
      .get(round) as { m: string | null };
    if (scheduled.m !== null) return new Date(scheduled.m);

    throw new SeasonDataError(`Il round ${round} non ha partite in calendario`);
  }

  /**
   * Lista canonica delle squadre (nomi `name` dell'API, come storati da
   * data:import). UNION di home_team/away_team così nessuna squadra si perde
   * anche con calendari/import parziali (briefing §3-D). Ordinata per
   * determinismo. È la lista contro cui il Game Engine fa l'exact-match
   * post-parse dei nomi squadra (LLD §6.2, decisione 5).
   */
  async getTeams(): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT team FROM (
           SELECT home_team AS team FROM match
           UNION
           SELECT away_team AS team FROM match
         ) ORDER BY team`
      )
      .all() as unknown as Array<{ team: string }>;
    return rows.map((row) => row.team);
  }

  /** Numero di round della stagione: MAX(round); 0 se la tabella è vuota. */
  async getTotalRounds(): Promise<number> {
    const row = this.db.prepare('SELECT MAX(round) AS m FROM match').get() as {
      m: number | null;
    };
    return row.m ?? 0;
  }

  /**
   * Squadre con il nome generico (`short_name`) dalla tabella `team`, ordinate
   * per `short_name` (feature AUTOPICK, D1/D2): è la fonte dell'ordinamento
   * alfabetico dell'auto-pick e del comando `rules:teams`. Una tabella `team`
   * vuota (legacy DB mai re-importato) restituisce un array vuoto: il motore
   * degrada all'ordine canonico (`getTeams()`), mai un errore. Il tie-break su
   * `name` garantisce un ordine deterministico a parità di short_name.
   */
  async getTeamsOrderedByShortName(): Promise<Team[]> {
    const rows = this.db
      .prepare('SELECT name, short_name FROM team ORDER BY short_name, name')
      .all() as unknown as Array<{ name: string; short_name: string }>;
    return rows.map((r) => ({ name: r.name, shortName: r.short_name }));
  }

  /** Riga DB (snake_case) → Match (camelCase), con parsing della data canonica. */
  private toMatch(row: MatchRow): Match {
    const match: Match = {
      round: row.round,
      matchDate: new Date(row.match_date),
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      postponed: row.postponed === 1
    };
    // Punteggio presente solo a partita conclusa (o assegnata): altrimenti restano undefined.
    if (row.home_score !== null && row.away_score !== null) {
      match.homeScore = row.home_score;
      match.awayScore = row.away_score;
    }
    return match;
  }
}
