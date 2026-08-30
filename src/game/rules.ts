/**
 * Rules Engine (LLD §7.5, piano Task 3.1) — regole dei gironi e delle squadre.
 *
 * Ruolo: parametri DATA-DRIVEN dei gironi (RF-19, LLD §3.2) e derivazione delle
 * squadre bruciate/disponibili per profilo+round. È la FONTE unica della logica:
 * il Pick Processor (Task 3.2) e il Round Manager (Task 3.5) chiedono a questo
 * modulo — mai duplicano le query delle bruciate (briefing §2.4).
 *
 * Regola-base (LLD §3.1, PRD §5.1): una squadra si usa una volta per girone;
 * il pool si azzera al confine di girone. Il confine tra andata e ritorno è
 * DERIVATO dal numero totale di round N = MAX(round) della stagione importata —
 * nessun letterale hardcodato (RF-19).
 *
 * Allineamento semantico dei due gironi (fonti: LLD §3.1 "andata round 1-N/2,
 * ritorno round N/2+1-N", §1.1 e le fixture di Task 2.5 "3 di andata + 3 di
 * ritorno, confine ceil(6/2)=3"):
 *   - andata  = round 1..floor(N/2);
 *   - ritorno = round floor(N/2)+1..N;
 *   - confine = floor(N/2)+1 (primo round del ritorno).
 * Con N=38 → andata 1–19, ritorno 20–38; con N=6 → andata 1–3, ritorno 4–6.
 * (Il briefing §2.2 formulava checkHalf con `ceil`; per N pari ceil==floor==N/2
 * e la differenza emerge solo su N dispari, non presenti in POC: qui si
 * adotta la regola autorevole di LLD §3.1, dove il confine separa esattamente
 * i due gironi — documento autorevole per le decisioni, es. "round == confine → ritorno".)
 *
 * I pick in Freeze contano come squadre bruciate (LLD §1.1, CRITICAL-01): la
 * query delle bruciate NON filtra sugli stati dei pick. Le derivazioni operano
 * sull'INTERA stagione: la finestra torneo `[start_round..N]` è un filtro logico
 * e non entra mai nelle query (ADR-008, briefing §1-E/§2.5).
 *
 * Interazioni: usato dai moduli pick/round e dai comandi CLI `rules:*`
 * (src/cli/commands/rules.ts); legge i dati via `SeasonDataProvider` e
 * interroga la tabella `pick` via `db` (niente scritture: è sola lettura).
 */
import type Database from 'better-sqlite3';

import type { Match, SeasonDataProvider } from '../data/provider.js';

/** Girone di una stagione: 1 = andata, 2 = ritorno. */
export type Half = 1 | 2;

/** Esito di un pick dato un match concluso: chi vince e chi perde (o pareggio). */
export type PickOutcome = 'win' | 'draw' | 'lose';

/**
 * Ultimo round del girone di andata: floor(N/2). Con N pari = N/2 (andata
 * esatta metà stagione); con N dispari l'andata ha un round in meno (round-robin
 * a dispari, LLD §3.1). Derivato dai dati, mai hardcodato.
 */
export function lastAndataRound(totalRounds: number): number {
  return Math.floor(totalRounds / 2);
}

/**
 * Confine tra i gironi: primo round del girone di ritorno = floor(N/2)+1.
 * N=38 → 20; N=6 → 4.
 */
export function halfBoundary(totalRounds: number): number {
  return Math.floor(totalRounds / 2) + 1;
}

/**
 * Girone a cui appartiene un round (LLD §3.1): 1 (andata) se
 * `round <= floor(N/2)`, 2 (ritorno) se `round >= floor(N/2)+1`.
 * Il round al confine (es. 20 con N=38) è di RITORNO.
 */
export function checkHalf(round: number, totalRounds: number): Half {
  return round < halfBoundary(totalRounds) ? 1 : 2;
}

/**
 * Finestra dei round del girone indicato, per la query delle squadre bruciate:
 * andata `round BETWEEN min AND max`; ritorno `round >= min` (max = null).
 * Confini derivati (RF-19): mai letterali nella query del chiamante.
 */
export function halfWindow(
  half: Half,
  totalRounds: number
): { min: number; max: number | null } {
  if (half === 1) {
    return { min: 1, max: lastAndataRound(totalRounds) };
  }
  return { min: halfBoundary(totalRounds), max: null };
}

/**
 * Squadre già usate (bruciate) da un profilo nel girone indicato, DERIVATE
 * dalla tabella `pick` senza filtri di stato: i pick pending/frozen contano
 * come bruciati (LLD §1.1, CRITICAL-01). Nessun filtro su `[start_round..N]`
 * (ADR-008): le bruciate si interrogano sull'intera stagione.
 */
export function getBurnedTeamsForHalf(
  db: Database.Database,
  profileId: number,
  half: Half,
  totalRounds: number
): string[] {
  const { min, max } = halfWindow(half, totalRounds);
  const rows = (max === null
    ? db.prepare('SELECT team FROM pick WHERE profile_id = ? AND round >= ?').all(profileId, min)
    : db
        .prepare('SELECT team FROM pick WHERE profile_id = ? AND round BETWEEN ? AND ?')
        .all(profileId, min, max)) as Array<{ team: string }>;
  return rows.map((r) => r.team);
}

/**
 * Squadre bruciate da un profilo nel girone di `round` (delega alla variante
 * per girone). Forma usata dai consumer che partono dal round del pick.
 */
export function getBurnedTeams(
  db: Database.Database,
  profileId: number,
  round: number,
  totalRounds: number
): string[] {
  return getBurnedTeamsForHalf(db, profileId, checkHalf(round, totalRounds), totalRounds);
}

/**
 * Un team è bruciato per un profilo nel girone di un round? Delegato del Pick
 * Processor (briefing §2.4): il rules espone `isBurned`, i consumer chiedono.
 * Confronto esatto sui nomi canonici di `pick.team` (nessuna normalizzazione).
 */
export function isBurned(
  db: Database.Database,
  profileId: number,
  team: string,
  round: number,
  totalRounds: number
): boolean {
  return getBurnedTeams(db, profileId, round, totalRounds).includes(team);
}

/**
 * Squadre disponibili per un profilo in un round: quelle che GIOCANO nel TC
 * (CL4: la squadra deve essere in giornata) E non sono ancora bruciate nel
 * girone di `round` (decisione 12 del piano: email di apertura con solo squadre
 * disponibili; briefing §2.3). Ordinate (getTeams è già ordinata) per output
 * deterministico.
 */
export async function getAvailableTeams(
  db: Database.Database,
  dataProvider: SeasonDataProvider,
  profileId: number,
  round: number
): Promise<string[]> {
  const [teams, matches, totalRounds] = await Promise.all([
    dataProvider.getTeams(),
    dataProvider.getMatchesForRound(round),
    dataProvider.getTotalRounds()
  ]);
  const inRound = new Set(matches.flatMap((m) => [m.homeTeam, m.awayTeam]));
  const burned = new Set(getBurnedTeams(db, profileId, round, totalRounds));
  return teams.filter((team) => inRound.has(team) && !burned.has(team));
}

/**
 * Prima squadra disponibile per l'AUTO-PICK (feature AUTOPICK, D1/D4): la
 * prima delle squadre disponibili (in giornata E non bruciate nel girone di
 * `round`, stessa fonte di `getAvailableTeams`) in ORDINE ALFABETICO per
 * `shortName` (nome generico dalla tabella `team`). Ritorna il NOME CANONICO
 * della prima, o `null` se nessuna disponibile (il chiamante mantiene il
 * fallback `missing_pick`).
 *
 * I dati round/team/partite sono LETTI UNA VOLTA DAL CHIAMANTE e passati qui
 * (`matches`, `teams`, `totalRounds`, `shortNames`) per evitare N round-trip
 * per profilo (stesso stile del fix review 2026-08-23). `shortNames` è la
 * mappa nome canonico → short_name (dal provider); un nome SENZA short_name
 * degrada all'ordine canonico (fallback sicuro su DB legacy con tabella `team`
 * vuota, mai un errore). L'ordinamento è stabile (tie-break sul nome canonico):
 * dipende solo dai dati, mai dal clock/LLM (RNF1).
 */
export function getFirstAvailableTeamByShortName(
  db: Database.Database,
  profileId: number,
  round: number,
  totalRounds: number,
  matches: Match[],
  teams: string[],
  shortNames: ReadonlyMap<string, string>
): string | null {
  const inRound = new Set(matches.flatMap((m) => [m.homeTeam, m.awayTeam]));
  const burned = new Set(getBurnedTeams(db, profileId, round, totalRounds));
  const available = teams.filter((team) => inRound.has(team) && !burned.has(team));
  if (available.length === 0) return null;
  const sorted = [...available].sort((a, b) => {
    const sa = shortNames.get(a) ?? a;
    const sb = shortNames.get(b) ?? b;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/**
 * Girone "corrente" per i comandi con default (es. `rules:burned-teams` senza
 * `--half`): il girone del round più avanzato in `round_state`; se nessun round
 * è ancora stato aperto → andata (1). Fonte è lo stato reale del torneo.
 */
export function getCurrentHalf(
  db: Database.Database,
  dataProvider: SeasonDataProvider
): Promise<Half> {
  return dataProvider.getTotalRounds().then((totalRounds) => {
    const row = db
      .prepare('SELECT MAX(round) AS r FROM round_state')
      .get() as { r: number | null };
    if (row.r === null) return 1 as Half;
    return checkHalf(row.r, totalRounds);
  });
}

/**
 * Esito di un pick per la squadra scelta dato un match CONCLUSO (con punteggio).
 * Funzione pura condivisa: il Round Manager (Task 3.5) la usa per la
 * contabilizzazione `correct`/`wrong` — mai duplicata (briefing §3.2).
 * Lancia se il match non ha punteggio (contratto: chiamata solo a esito noto)
 * o se `team` non gioca nel match (bug del chiamante, non un caso di gioco).
 */
export function pickOutcomeFor(team: string, match: Match): PickOutcome {
  if (match.homeScore === undefined || match.awayScore === undefined) {
    throw new Error(
      `pickOutcomeFor richiede un match concluso (senza punteggio: R${match.round} ${match.homeTeam}-${match.awayTeam})`
    );
  }
  const isHome = match.homeTeam === team;
  const isAway = match.awayTeam === team;
  if (!isHome && !isAway) {
    throw new Error(`La squadra ${team} non gioca nel match ${match.homeTeam}-${match.awayTeam}`);
  }
  const scored = isHome ? match.homeScore : match.awayScore;
  const conceded = isHome ? match.awayScore : match.homeScore;
  if (scored > conceded) return 'win';
  if (scored < conceded) return 'lose';
  return 'draw';
}
