/**
 * Tipi e contratti condivisi del dominio "dati stagione" (LLD §6.1).
 *
 * Ruolo: definisce UNA SOLA volta il tipo `Match` e l'interfaccia
 * `SeasonDataProvider`, condivisi tra:
 *   - `FootballDataClient` (Task 2.1, src/data/football-data-client.ts): produce `Match[]` dall'API;
 *   - `DbSeasonDataProvider` (Task 2.2, src/data/db-provider.ts): produce `Match[]` dalla tabella `match`;
 *   - il comando `data:import` (Task 2.3): consuma `Match[]` dal client e scrive la tabella `match`.
 *
 * Definire il tipo qui — e non rispettivamente in `football-data-client.ts` e
 * `db-provider.ts` — evita la duplicazione di tipo tra i due moduli (violazione
 * della separazione di responsabilità, AGENTS.md §1.3 / briefing Fase 2 §1-A).
 *
 * Convenzioni di dominio fissate per tutta la Fase 2:
 *   - `round` è il Turno di campionato (TC); l'API football-data.org lo espone
 *     come `matchday` (mappatura `matchday → round`, LLD §6.1 / briefing 2.1-4).
 *   - `matchDate` è canonica, ISO-8601 UTC con suffisso `Z` (LLD §6.1 / briefing
 *     §1-B): così i confronti lessicografici di SQLite e il parsing in Date sono
 *     deterministici indipendentemente dal fuso orario.
 *   - i nomi squadra sono i `name` ufficiali dell'API (non `shortName`/`tla`):
 *     sono il nome canonico stabile tra import e alias (LLD §6.2, briefing §1-C).
 */
export interface Match {
  /** Turno di campionato (TC) a cui appartiene la partita (l'API lo chiama `matchday`). */
  round: number;
  /**
   * Data/ora di inizio programmata, canonica ISO-8601 UTC (suffisso Z). Se la
   * partita rinviata viene recuperata, il refresh sovrascrive questo valore con
   * la nuova `utcDate` dell'API (regola operativa rinvii, LLD §3.1: nessun
   * `rescheduled_date`; il recupero giocato emerge dai dati).
   */
  matchDate: Date;
  /** Nome canonico della squadra di casa (campo `name` dell'API). */
  homeTeam: string;
  /** Nome canonico della squadra ospite (campo `name` dell'API). */
  awayTeam: string;
  /**
   * Nome generico della squadra di casa (campo `shortName` dell'API, es.
   * "Inter"). Usato SOLO dall'import per popolare la tabella `team`
   * (ordinamento alfabetico dell'auto-pick, feature AUTOPICK). ASSENTE nei
   * `Match` letti da `DbSeasonDataProvider` (la tabella `match` non lo
   * memorizza: lo short_name vive nella tabella `team`) — per questo è
   * opzionale nel tipo condiviso.
   */
  homeTeamShort?: string;
  /** Nome generico della squadra ospite (campo `shortName` dell'API). Come `homeTeamShort`. */
  awayTeamShort?: string;
  /** Reti della squadra di casa; presenti solo a partita conclusa (`FINISHED`) o assegnata (`AWARDED`). */
  homeScore?: number;
  /** Reti della squadra ospite; presenti solo a partita conclusa (`FINISHED`) o assegnata (`AWARDED`). */
  awayScore?: number;
  /** true se rinviata/sospesa/cancellata. Nella POC le sospese sono trattate come rinviate (ADR-002, PRD §5.4). */
  postponed: boolean;
}

/**
 * Contratto astratto di calendario e risultati stagione (LLD §6.1).
 *
 * Il Game Engine dialoga SOLO con questa interfaccia e non accede mai
 * all'API esterna (ADR-007). Unica implementazione nella POC:
 * `DbSeasonDataProvider` (legge dalla tabella `match`).
 */
export interface SeasonDataProvider {
  /** Intera stagione: tutte le partite, ordinate per round e orario (deterministico). */
  getCalendar(): Promise<Match[]>;
  /**
   * Partite di un singolo round, ordinate per orario programmato. Espone
   * `homeScore?`/`awayScore?`/`postponed` per ogni match: un match con punteggio
   * è concluso, `postponed` senza punteggio è un rinvio (Freeze) e un match senza
   * punteggio né rinvio è ancora in corso (resta `pending`) — nota CRITICAL-02,
   * LLD §6.1. È il metodo primario per il Round Manager (sostituisce `getResults`
   * di versioni precedenti dell'interfaccia, rimossa perché ridondante).
   */
  getMatchesForRound(round: number): Promise<Match[]>;
  /**
   * Kickoff "effettivo" del round, usato sia per la deadline (RF-14) sia per il
   * guard anti-frode `min(deadline registrata, kickoff effettivo)` (RF-31).
   *
   * Semantica per i match rinviate (fissata in Fase 2, briefing §3-B):
   * il valore è `MIN(match_date)` TRA I MATCH NON RINVIATI del round — una
   * partita rinviata non ha un fischio effettivo noto. Se TUTTE le partite del
   * round sono rinviate, il kickoff effettivo non è noto a priori e viene
   * restituito il `MIN(match_date)` programmato dell'intero round (valore di
   * fallback documentato; il guard RF-31 usa comunque questo istante, e la
   * chiusura di sicurezza RF-30/CL17 copre il caso non calcolabile).
   * Se il round non ha partite: `SeasonDataError`.
   */
  getFirstMatchDateTime(round: number): Promise<Date>;
  /**
   * Lista canonica delle squadre (nomi `name` dell'API), come DISTINCT della
   * UNION di `home_team` e `away_team` (robusta anche per import/calendari
   * parziali, briefing §3-D). È la lista contro cui il Game Engine fa
   * l'exact-match post-parse dei nomi squadra (LLD §6.2, decisione 5 del piano).
   */
  getTeams(): Promise<string[]>;
  /** Numero di round della stagione: `MAX(round)` (0 se la stagione è vuota). */
  getTotalRounds(): Promise<number>;
  /**
   * Squadre con nome generico (`shortName`) dalla tabella `team`, ordinate per
   * `short_name` (feature AUTOPICK, D1/D2). Fonte dell'ordinamento alfabetico
   * dell'auto-pick e del comando `rules:teams`. Una tabella `team` vuota
   * (legacy DB) restituisce `[]`: il motore degrada all'ordine canonico.
   */
  getTeamsOrderedByShortName(): Promise<Team[]>;
}

/**
 * Squadra con il suo nome generico `shortName` (feature AUTOPICK, D1): coppia
 * usata per popolare la tabella `team` (name → short_name) all'import e come
 * forma di lettura ordinata per short_name (comando `rules:teams`, auto-pick).
 * Il `name` resta il nome canonico dell'API (usato ovunque nel gioco); lo
 * `shortName` serve SOLO per l'ordinamento alfabetico dell'auto-pick.
 */
export interface Team {
  /** Nome canonico (campo `name` dell'API), PK della tabella `team`. */
  name: string;
  /** Nome generico (campo `shortName` dell'API, es. "Inter"). */
  shortName: string;
}

/**
 * Errore sui dati stagione (tabella `match` incoerente con i contratti del
 * provider, es. un round senza partite in calendario). Distinto da
 * `FootballDataError` (errore di comunicazione con l'API, Task 2.1).
 */
export class SeasonDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonDataError';
  }
}
