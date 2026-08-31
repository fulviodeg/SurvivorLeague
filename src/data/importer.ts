/**
 * Import dei dati stagione nella tabella `match` (piano Task 2.3, LLD §7.2).
 *
 * Ruolo: pipeline dati stagione, usata dai comandi CLI `data:import`/
 * `data:refresh` (src/cli/commands/data.ts) e dal loader delle fixture
 * sintetiche (tests/fixtures/season.ts). Fa lo **upsert** idempotente di un
 * `Match[]` (tipo di src/data/provider.ts) nella tabella `match` sulla chiave
 * primaria `(round, home_team, away_team)` — il modello dati non ha un id API —
 * sovrascrivendo `match_date`, `postponed`, `home_score`/`away_score` (così un
 * rinvio recuperato, con nuova `utcDate` o punteggio, aggiorna la riga invece
 * di duplicarla; LLD §3.1). Nessuna `DELETE` di righe assenti dall'API: una
 * riga importata resta finché la stagione non viene re-importata/fuori scope
 * POC (briefing Fase 2 §4-A e §1-B).
 *
 * Atomicità: la conversione `Match`→riga avviene PRIMA della transazione (una
 * data invalida fallisce prima di scrivere) e l'inserimento è dentro una
 * transazione SQLite (tutto o niente): in caso di errore il DB resta invariato,
 * senza uno stato parziale — fondamentale perché `data:refresh` è invocato dallo
 * scheduler a ogni tick (decisione 4 del piano).
 *
 * Separazione di responsabilità: la conversione camelCase (`Match`) →
 * snake_case (tabella `match`) vive QUI, nel livello dati orchestrato dai
 * comandi `data:*` — non nel client né nel provider (briefing Fase 2 §7).
 */
import type Database from 'better-sqlite3';

import type { Match, Team } from './provider.js';

/** Formato riga della tabella `match` (LLD §3): conversione dalla forma camelCase di `Match`. */
export interface MatchRow {
  round: number;
  /** Data di inizio canonica ISO-8601 UTC (suffisso Z), formato fissato in Fase 2 (briefing §1-B). */
  match_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  /** 0/1: rinviata/sospesa nella tabella (ADR-002). */
  postponed: number;
}

/**
 * UPSERT idempotente sulla PK `(round, home_team, away_team)`.
 * `DO UPDATE` sovrascrive i campi mutabili: se la stessa partita viene
 * ri-importata con un nuovo orario di recupero o con il punteggio, la riga
 * viene aggiornata (nessun duplicato, nessuna perdita di risultati).
 */
const UPSERT_MATCH = `
  INSERT INTO match (round, match_date, home_team, away_team, home_score, away_score, postponed)
  VALUES (@round, @match_date, @home_team, @away_team, @home_score, @away_score, @postponed)
  ON CONFLICT (round, home_team, away_team) DO UPDATE SET
    match_date = excluded.match_date,
    home_score  = excluded.home_score,
    away_score  = excluded.away_score,
    postponed   = excluded.postponed
`;

/**
 * UPSERT idempotente sulla PK `name` della tabella `team` (feature AUTOPICK,
 * D1): sovrascrive `short_name` se una squadra cambia nome generico tra due
 * import (mai duplicati). `name` resta il canonico dell'API.
 */
const UPSERT_TEAM = `
  INSERT INTO team (name, short_name)
  VALUES (@name, @short_name)
  ON CONFLICT (name) DO UPDATE SET short_name = excluded.short_name
`;

/**
 * Deriva le coppie (name, shortName) da un `Match[]` (feature AUTOPICK, D1):
 * raccoglie home/away team SOLO quando lo shortName è presente (un `Match`
 * letto dal provider non ce l'ha; un `Match` dal client/sintetico sì). Una
 * `Map` per name garantisce l'unicità e l'ultimo shortName visto vince
 * (deterministico perché i match sono ordinati).
 */
function deriveTeams(matches: Match[]): Team[] {
  const byName = new Map<string, string>();
  for (const m of matches) {
    if (m.homeTeamShort !== undefined) byName.set(m.homeTeam, m.homeTeamShort);
    if (m.awayTeamShort !== undefined) byName.set(m.awayTeam, m.awayTeamShort);
  }
  return [...byName.entries()].map(([name, shortName]) => ({ name, shortName }));
}

/** Formato riga della tabella `team` (snake_case, come le altre conversioni). */
interface TeamRow {
  name: string;
  short_name: string;
}

/** Converte un `Team` (camelCase) nella riga `team` (snake_case). */
function toTeamRow(team: Team): TeamRow {
  return { name: team.name, short_name: team.shortName };
}

/**
 * Upsert transazionale di un array di `Team` nella tabella `team` (feature
 * AUTOPICK, D1), sulla PK `name`. Restituisce il numero di righe processate.
 */
export function upsertTeams(db: Database.Database, teams: Team[]): number {
  const stmt = db.prepare(UPSERT_TEAM);
  const run = db.transaction((ts: Team[]): number => {
    for (const t of ts) stmt.run(toTeamRow(t));
    return ts.length;
  });
  return run(teams);
}

/**
 * Converte un `Match` (dominio) nella riga `match` (DB).
 * `matchDate` è scritta in formato canonico `toISOString()` (UTC, suffisso Z);
 * una `Date` invalida (es. `new Date(NaN)`) lancia qui, prima di qualunque scrittura.
 */
export function toMatchRow(match: Match): MatchRow {
  return {
    round: match.round,
    match_date: match.matchDate.toISOString(),
    home_team: match.homeTeam,
    away_team: match.awayTeam,
    home_score: match.homeScore ?? null,
    away_score: match.awayScore ?? null,
    postponed: match.postponed ? 1 : 0
  };
}

/**
 * Upsert transazionale di un array di `Match` nella tabella `match` E, in
 * aggiunta, delle squadre derivate (name → short_name) nella tabella `team`
 * (feature AUTOPICK, D1): un'unica transazione, così un errore non lascia
 * né `match` né `team` a metà. Restituisce il numero di righe `match`
 * processate. Su errore di conversione o di scrittura NON viene persistito
 * nulla (conversione prima + transazione).
 */
export function upsertMatches(db: Database.Database, matches: Match[]): number {
  const rows = matches.map(toMatchRow);
  const teams = deriveTeams(matches);
  const matchStmt = db.prepare(UPSERT_MATCH);
  const teamStmt = db.prepare(UPSERT_TEAM);
  const run = db.transaction((rs: MatchRow[], ts: Team[]): number => {
    for (const row of rs) matchStmt.run(row);
    for (const team of ts) teamStmt.run(toTeamRow(team));
    return rs.length;
  });
  return run(rows, teams);
}

/**
 * Operazione completa `data:import`/`data:refresh`: scarica la stagione dal
 * client (FootballDataClient o suo fake nei test) e la upserta in `match`.
 * Restituisce il numero di righe processate. Il client è iniettato: il comando
 * CLI costruisce il `FootballDataClient` dalla config e lo passa qui.
 */
export async function importMatches(
  db: Database.Database,
  client: { getMatches(): Promise<Match[]> }
): Promise<number> {
  const matches = await client.getMatches();
  return upsertMatches(db, matches);
}

/**
 * Helper ISOLATO per `data:seed-synthetic --force --clear` (piano UAT Task 2):
 * svuota TUTTE le righe della tabella `match`.
 *
 * IMPORTANTE — è l'UNICO punto del livello dati che cancella righe: l'import
 * base (`importMatches`/`upsertMatches`) NON fa MAI DELETE (vedi header di
 * questo file). Viene invocato SOLO dal comando seed con `--force --clear`
 * (doppia conferma) e SOLO dopo la guardia stato di gioco (nessun
 * `season_started`, nessuna riga in `pick`/`round_state`). Agisce SOLO sulla
 * tabella `match`: pick, round_state e tournament_state non vengono toccati.
 */
export function clearMatches(db: Database.Database): void {
  db.prepare('DELETE FROM match').run();
}
