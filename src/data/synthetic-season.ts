/**
 * Generatore della stagione sintetica (piano UAT Task 1, decisioni D5/D7/D8).
 *
 * Ruolo: modulo PURO che produce un `Match[]` (tipo di src/data/provider.ts) per
 * il test mode. Non legge configurazione, non scrive DB, non tocca la rete:
 * restituisce SOLO dati in memoria. È la fonte del calendario che il comando
 * `data:seed-synthetic` (Task 2) caricherà nella tabella `match` con
 * `upsertMatches` (ADR-007: unica fonte dati, "la CLI inietta").
 *
 * Espone la costante `SYNTHETIC_TEAMS` (D7): i 20 nomi canonici di club di
 * Serie A (stagione 2026/27, nomi `name` dell'API football-data.org) usati
 * come rosa di default del generatore e come lista canonica della risorsa
 * alias sintetica `src/llm/team-aliases-synthetic.md` (Task 0.4). La
 * coincidenza tra i due è verificata da un test dedicato (Checkpoint B).
 *
 * Semantica implementata:
 *   - Round-robin (circle method, vedi `roundRobinPairings`): ogni squadra gioca
 *     esattamente una partita per giornata, mai contro sé stessa, senza duplicati
 *     intra-giornata. Con un numero DISPARI di squadre una squadra riposa a turno
 *     (bye): è la risoluzione standard del girone all'italiana.
 *   - Spacing (D8): tutte le partite di una stessa giornata hanno lo STESSO
 *     orario; `spacingMin` distanzia SOLO le giornate tra loro, non le singole
 *     partite (coerente con `getFirstMatchDateTime` = MIN(match_date)).
 *   - Wrap (D8): il round-robin completo produce `teams-1` giornate (pari) o
 *     `teams` (dispari, con bye); quando `rounds` è maggiore, il generatore
 *     riapplica il circle method CICLICAMENTE: accoppiamenti ripetuti in giornate
 *     successive, PK `(round, home_team, away_team)` diversa perché cambia
 *     `round`, senza MAI auto-match né duplicati intra-giornata.
 *   - Date: `matchDate` è una `Date` valida derivata dal primo fischio; la forma
 *     canonica ISO-8601 UTC con suffisso Z si ottiene con `toISOString()` (LLD
 *     §6.1), come già fa `toMatchRow` in src/data/importer.ts. `postponed=false`
 *     sempre (calendario sintetico senza rinvii).
 *   - Punteggi (D5): presenti su TUTTE le partite (gol interi 0..3) e
 *     deterministici a parità di seed (PRNG `mulberry32` privato, vedi sotto):
 *     il seed influenza SOLO i gol, mai gli accoppiamenti (che dipendono solo
 *     dalla rosa delle squadre).
 *
 * Dipendenze: nessuna, oltre al tipo `Match` di src/data/provider.ts (per
 * restare puro e non accoppiato ai moduli di gioco/DB il PRNG è implementato
 * localmente, come già documentato in src/game/simulation.ts).
 */
import type { Match } from './provider.js';

/**
 * Rosa canonica di club di Serie A (stagione 2026/27, nomi `name` dell'API
 * football-data.org) per la stagione sintetica (D7). Deve coincidere
 * ESATTAMENTE con la lista canonica di `src/llm/team-aliases-synthetic.md`
 * (verificato dal test di Checkpoint B) e non contiene duplicati. I nomi sono
 * in forma editoriale (come compaiono nella risorsa alias) e vengono usati tal
 * quali come `homeTeam`/`awayTeam`.
 */
export const SYNTHETIC_TEAMS: readonly string[] = [
  'AC Milan',
  'AC Monza',
  'ACF Fiorentina',
  'AS Roma',
  'Atalanta BC',
  'Bologna FC 1909',
  'Cagliari Calcio',
  'Como 1907',
  'FC Internazionale Milano',
  'Frosinone Calcio',
  'Genoa CFC',
  'Juventus FC',
  'Parma Calcio 1913',
  'SS Lazio',
  'SSC Napoli',
  'Torino FC',
  'US Lecce',
  'US Sassuolo Calcio',
  'Udinese Calcio',
  'Venezia FC'
];

/**
 * Mappatura canonico → generico (`shortName`) dei 20 club sintetici (feature
 * AUTOPICK, D1): usata dal generatore per popolare `homeTeamShort`/
 * `awayTeamShort` dei `Match` sintetici, così l'import popola la tabella
 * `team` con lo short_name per l'ordinamento dell'auto-pick. I valori sono i
 * `shortName` attesi dell'API football-data.org (da ALLINEARE ai valori reali
 * al primo `data:import`, verifica via `rules:teams`): un nome canonico fuori
 * da questa mappa produce semplicemente `homeTeamShort`/`awayTeamShort`
 * assenti (nessun errore: il generatore resta valido con rose custom).
 */
export const SYNTHETIC_TEAM_SHORT_NAMES: Readonly<Record<string, string>> = {
  'AC Milan': 'Milan',
  'AC Monza': 'Monza',
  'ACF Fiorentina': 'Fiorentina',
  'AS Roma': 'Roma',
  'Atalanta BC': 'Atalanta',
  'Bologna FC 1909': 'Bologna',
  'Cagliari Calcio': 'Cagliari',
  'Como 1907': 'Como 1907',
  'FC Internazionale Milano': 'Inter',
  'Frosinone Calcio': 'Frosinone',
  'Genoa CFC': 'Genoa',
  'Juventus FC': 'Juventus',
  'Parma Calcio 1913': 'Parma',
  'SS Lazio': 'Lazio',
  'SSC Napoli': 'Napoli',
  'Torino FC': 'Torino',
  'US Lecce': 'Lecce',
  'US Sassuolo Calcio': 'Sassuolo',
  'Udinese Calcio': 'Udinese',
  'Venezia FC': 'Venezia FC'
};

/**
 * Parametri di generazione della stagione sintetica. `teams` è opzionale
 * (default `SYNTHETIC_TEAMS`); gli altri sono obbligatori e validati in
 * `validate` (errori chiari su input invalidi).
 */
export interface SyntheticSeasonParams {
  /** Lista nomi squadre (default `SYNTHETIC_TEAMS`). Deve avere ≥ 2 nomi univoci. */
  teams?: readonly string[];
  /** Numero di giornate da generare (intero ≥ 1). Maggiore di `teams-1` → wrap (D8). */
  rounds: number;
  /** Distanza in MINUTI tra due giornate consecutive (> 0). NON distanzia le partite. */
  spacingMin: number;
  /** Data/ora del fischio della PRIMA giornata (le successive derivano da `spacingMin`). */
  firstKickoff: Date;
  /** Seed del PRNG dei punteggi (D5): stesso seed → stessi gol. */
  seed: number;
}

/**
 * Genera il calendario sintetico come `Match[]` (giornate 1..rounds).
 *
 * Per ogni giornata `k` il fischio è `firstKickoff + (k-1)*spacingMin` minuti e
 * TUTTE le partite della giornata condividono quella `Date` (D8). Gli
 * accoppiamenti provengono dal circle method applicato ciclicamente per il wrap
 * (D8, modulo su `pairings.length`); i punteggi sono generati in ordine di
 * giornata/partita da un PRNG seedato (D5). Funzione pura e deterministica:
 * stessi input → stesso output.
 */
export function generateSyntheticSeason(params: SyntheticSeasonParams): Match[] {
  const teams = [...(params.teams ?? SYNTHETIC_TEAMS)];
  validate(teams, params.rounds, params.spacingMin, params.firstKickoff);

  const pairings = roundRobinPairings(teams);
  const rng = mulberry32(params.seed);
  const matches: Match[] = [];

  for (let round = 1; round <= params.rounds; round++) {
    // Data condivisa da tutte le partite della giornata (D8: stesso orario).
    const kickoff = new Date(
      params.firstKickoff.getTime() + (round - 1) * params.spacingMin * 60_000
    );
    // Wrap (D8): indice ciclico sui pairing del round-robin completo.
    const pairs = pairings[(round - 1) % pairings.length]!;
    for (const [homeTeam, awayTeam] of pairs) {
      matches.push({
        round,
        matchDate: kickoff,
        homeTeam,
        awayTeam,
        homeTeamShort: SYNTHETIC_TEAM_SHORT_NAMES[homeTeam],
        awayTeamShort: SYNTHETIC_TEAM_SHORT_NAMES[awayTeam],
        homeScore: rollGoals(rng),
        awayScore: rollGoals(rng),
        postponed: false
      });
    }
  }

  return matches;
}

/**
 * Validazione dei parametri: errori chiari (messaggi in INGLESE, vincolo
 * `log_messages_english`) su input invalidi, lanciati PRIMA di generare
 * qualsiasi dato. Copre: < 2 squadre, nomi duplicati, `rounds` non intero/positivo,
 * `spacingMin` non finito/non positivo, `firstKickoff` non valido (Date → NaN).
 */
function validate(
  teams: readonly string[],
  rounds: number,
  spacingMin: number,
  firstKickoff: Date
): void {
  if (teams.length < 2) {
    throw new Error('Synthetic season: at least 2 teams are required');
  }
  if (new Set(teams).size !== teams.length) {
    throw new Error('Synthetic season: team names must be unique');
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error('Synthetic season: rounds must be a positive integer');
  }
  if (!Number.isFinite(spacingMin) || spacingMin <= 0) {
    throw new Error('Synthetic season: spacingMin must be a positive number of minutes');
  }
  if (Number.isNaN(firstKickoff.getTime())) {
    throw new Error('Synthetic season: firstKickoff must be a valid Date');
  }
}

/**
 * Accoppiamenti round-robin tramite circle method.
 *
 * Ritorna le giornate del girone completo: per ogni giornata un array di coppie
 * `[home, away]`. Con `n` PARI produce `n-1` giornate, ognuna con `n/2` partite
 * in cui ogni squadra compare ESATTAMENTE una volta (mai contro sé stessa, mai
 * duplicata intra-giornata). Con `n` DISPARI aggiunge una "bye" (sentinel `null`)
 * per rendere pari il giro: produce `n` giornate e la squadra abbinata al `null`
 * riposa quella giornata (risoluzione standard del girone all'italiana).
 *
 * Algoritmo: si fissa il primo elemento e si ruotano gli altri di una posizione
 * a destra a ogni giornata; le coppie sono `arr[i]` vs `arr[m-1-i]`. La prima
 * squadra di ogni coppia è la squadra di CASA (assegnazione fissa e
 * deterministica; nel wrap la coppia si ripete identica, cambia solo il round).
 */
function roundRobinPairings(teams: readonly string[]): Array<Array<[string, string]>> {
  const slots: Array<string | null> = [...teams];
  if (slots.length % 2 !== 0) slots.push(null); // bye per girone dispari

  const m = slots.length; // sempre pari
  const totalRounds = m - 1;

  const arr = [...slots];
  const rounds: Array<Array<[string, string]>> = [];

  for (let r = 0; r < totalRounds; r++) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < m / 2; i++) {
      const home = arr[i];
      const away = arr[m - 1 - i];
      // `home`/`away` sono `string | null | undefined` (noUncheckedIndexedAccess);
      // il null è la bye, l'undefined è irraggiungibile (indici sempre in range).
      if (home == null || away == null) continue;
      pairs.push([home, away]);
    }
    rounds.push(pairs);

    // Rotazione del circle method: fissa `arr[0]`, sposta l'ultimo elemento in
    // seconda posizione (rotazione a destra di `arr[1..m-1]`).
    const last = arr.pop();
    if (last !== undefined) arr.splice(1, 0, last);
  }

  return rounds;
}

/**
 * RNG deterministico mulberry32 (funzione pura): da un seed produce una sequenza
 * di numeri in `[0, 1)`. Stesso seed → stessa sequenza (D5). Implementazione a
 * mano (standard mulberry32, senza librerie) per tenere il modulo senza
 * dipendenze; il seed è normalizzato a uint32 con `>>> 0`.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gol per una partita: intero in `[0, 3]` derivato dal RNG. Intervallo
 * arbitrario ma fisso (documentato): i punteggi devono solo essere PRESENTI su
 * tutte le partite (D5) perché `round:score` segni subito `scored`.
 */
function rollGoals(rng: () => number): number {
  return Math.floor(rng() * 4);
}
