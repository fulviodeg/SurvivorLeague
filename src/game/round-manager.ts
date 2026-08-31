/**
 * Round Manager (LLD §7.3, §1.1, §1.4; piano Task 3.5) — ciclo di vita dei round.
 *
 * Ruolo: orchestra apertura, chiusura e contabilizzazione dei round (TC) del
 * torneo. È l'unico modulo che scrive su `round_state` e che invoca
 * l'Elimination Engine; usa il Rules Engine per le squadre disponibili e
 * `pickOutcomeFor` per gli esiti (mai logica duplicata, briefing §3.2/§6.1).
 *
 * Comandi (LLD §7.3):
 *   - `round:open`   — crea `round_state` (status `open`, opened_at = clock) con
 *     deadline FISSA = kickoff − DEADLINE_ADVANCE_MIN (RF-14); invia l'email
 *     pick ai profili attivi con le sole squadre disponibili (decisione 12).
 *     ADR-019: SOLO ai partecipanti (profili) — l'eccezione TT1 per gli
 *     account `active` senza profilo è RIMOSSA (la nascita dei profili non è
 *     più legata al pick). Errore se il round è già aperto o in stato non
 *     riapribile. GUARDIA (fix UAT
 *     2026-08-22): rifiuta l'apertura se la deadline calcolata è GIÀ scaduta
 *     (`now >= deadline`) — vedi il corpo della funzione.
 *   - `round:close`  — CONSOLIDA: elimina i profili attivi senza pick
 *     (`missing_pick`), notifica, `closed_at`, status `closed`. Con `--force`
 *     richiede `--reason` (audit obbligatorio, RF-29): stessa identica
 *     semantica di consolidamento — non esiste "chiudi senza eliminare".
 *     Feature AUTOPICK (D3/D4/D5): con `WIN_ONLY && AUTOPICK_ON_MISSING` e
 *     deadline REALE, ai mancanti viene assegnata in automatico la prima
 *     squadra disponibile per short_name invece di eliminarli.
 *   - `round:score`  — contabilizzazione INCREMENTALE (ADR-003): per ogni pick
 *     `pending` del round: match con punteggio → `correct`/`wrong` (ed
 *     eliminazione `wrong_pick`); match `postponed` senza punteggio → `frozen`
 *     se `now > tcClose` (CL1/CL8), altrimenti resta `pending` (CL7); match non
 *     rinviato senza punteggio → resta `pending`. Poi valuta i pick `frozen`
 *     la cui partita ORA ha punteggio (→ `correct`/`wrong`, eliminazione a
 *     posteriori — anche su round già `scored`, LLD §1.4). Il round passa a
 *     `scored` quando non restano `pending` (RF-16; i `frozen` sono terminali
 *     per il TT). Idempotente (RF-17). Alla transizione `closed→scored` invia
 *     il riepilogo ai sopravvissuti con account `active` (RF-P6): la guardia
 *     `summary_sent` è scritta atomicamente INSIEME allo stato (B2, decisione
 *     (b)) e l'invio è best-effort per destinatario (fallimenti loggati con
 *     warn pino in inglese, la contabilizzazione non fallisce).
 *   - `round:status` / `round:deadline` — sola lettura; espongono la coppia
 *     TT/TC derivata (RF-25) e, per deadline, ENTRAMBE le sorgenti temporali
 *     (deadline registrata + kickoff effettivo = istante di accettazione RF-31).
 *
 * Notifiche: consuma le interfacce ChannelAdapter/LLMGenerator iniettate nel
 * contesto (mock nei test). Se assenti (CLI di Fase 3) le email non partono:
 * implementazione reale nelle Fasi 5–6 (briefing §6.5).
 */
import type Database from 'better-sqlite3';

import {
  subjectFor,
  type EmailBurnedTeam,
  type EmailContext,
  type EmailMatchContext,
  type EmailPlayerResult,
  type EmailTournamentRound
} from '../llm/generator.js';
import type { Match } from '../data/provider.js';
import type { GameContext } from './context.js';
import { eliminate } from './elimination.js';
import { computeDeadline, computeTcClose, formatRemaining } from './round-time.js';
import {
  checkHalf,
  getAvailableTeams,
  getFirstAvailableTeamByShortName,
  halfWindow,
  pickOutcomeFor
} from './rules.js';
import { insertPendingPick } from './pick-processor.js';
import { getTournamentState, isTournamentClosed, tournamentExport } from './tournament.js';
import { getStartRound, ttFor, turnFor } from './turn.js';
import { checkWinner, type WinnerInfo } from './winner.js';
import { assertModeConsistent } from './mode.js';

/** Riga `round_state` letta dal DB. */
interface RoundStateRow {
  round: number;
  status: string;
  deadline: string | null;
  opened_at: string | null;
  closed_at: string | null;
  scored_at: string | null;
  summary_sent: number;
}

/** Riga `pick` letta dal DB. */
interface PickRow {
  id: number;
  profile_id: number;
  round: number;
  team: string;
  outcome: string;
  status: string;
  jolly_used: number;
}

/** Profilo attivo con email e nome (per le notifiche). */
interface ActiveProfile {
  id: number;
  email: string;
  playerName: string;
  /** Feature JOLLY: contatore di jolly rimasti (per le righe "Jolly rimasti: N"). */
  jollies_remaining: number;
}

/**
 * L'account piattaforma dell'email è `active`? (ADR-009, RF-P6): ogni
 * notifica di round è filtrata sullo stato dell'account al momento
 * dell'invio — `unsubscribed` e `pending_unsubscribe` non ricevono alcuna
 * email. Senza registry iniettato nel contesto il filtro FALLISCE CHIUSO
 * (B3, decisione (c)): ritorna `false` e le notifiche NON partono — nessun
 * bypass silenzioso, simmetria con `checkEligibility`
 * (`platform_unavailable`). Tutte le CLI reali che inviano email
 * (`round:*`, `tournament:start`) iniettano già il registry, quindi il
 * comportamento di produzione non cambia.
 */
function isAccountActive(ctx: GameContext, email: string): boolean {
  if (ctx.platform === undefined) return false;
  const account = ctx.platform.find(email);
  return account !== null && account.status === 'active';
}

/**
 * Conteggio dei profili ancora in gara (`eliminated = 0`): UNA query,
 * riusata dai punti di notifica di chiusura/contabilizzazione per garantire
 * lo STESSO valore a ogni destinatario della stessa run (fix review
 * 2026-08-23 — prima veniva ricalcolato dentro i loop di eliminazione,
 * producendo conteggi divergenti tra le email; convenzione 10).
 */
function countInGame(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM profile WHERE eliminated = 0').get() as { n: number }
  ).n;
}

/**
 * Giocatori di un round per l'elenco nominativo retrospettivo (ADR-015 email
 * v4): partecipanti del round = profili in gara alla chiusura del round
 * (`eliminated = 0`) O eliminati IN QUESTO round (`eliminated_at >= opened_at`):
 * gli eliminati nei round PRECEDENTI restano esclusi. LEFT JOIN `pick` per
 * squadra/esito/status (mancante → nessun pick); `name` con fallback sull'email
 * quando vuoto. Sola lettura, computata UNA volta per round (stesso valore
 * per ogni destinatario, come `countInGame`). `openedAt` è la stringa ISO-8601
 * di apertura del round (mai il clock: il filtro è sullo snapshot di stato).
 *
 * Lo stato `eliminated` è PER-ROUND e deriva dall'esito del pick di QUEL round
 * (`pk.status`), NON dal flag finale `p.eliminated`: quest'ultimo vale solo per
 * l'ultimo round e farebbe risultare 'eliminato' un giocatore eliminato in un
 * round SUCCESSIVO anche nei round precedenti (bug storico `tournament_closed`).
 * Regola: pick `correct` → ancora in gara; `wrong` o nessun pick (missing_pick)
 * → eliminato; `pending`/`frozen` (non ancora valutato) → ancora in gara.
 */
function getRoundPlayers(db: Database.Database, round: number, openedAt: string): EmailPlayerResult[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(pl.name, '') AS name, COALESCE(pl.email, '') AS email,
              pk.team AS team, pk.outcome AS outcome, pk.status AS pickStatus,
              pk.auto_pick AS autoPick, pk.jolly_used AS jollyUsed
       FROM profile p
       JOIN player pl ON pl.id = p.player_id
       LEFT JOIN pick pk ON pk.profile_id = p.id AND pk.round = ?
       WHERE p.eliminated = 0 OR p.eliminated_at >= ?
       ORDER BY p.id`
    )
    .all(round, openedAt) as unknown as Array<{
    name: string;
    email: string;
    team: string | null;
    outcome: string | null;
    pickStatus: string | null;
    autoPick: number | null;
    jollyUsed: number | null;
  }>;
  return rows.map((r) => ({
    name: r.name !== '' ? r.name : r.email,
    ...(r.team !== null ? { team: r.team } : {}),
    ...(r.outcome !== null ? { outcome: r.outcome } : {}),
    // Feature AUTOPICK (D9): marcatore storico del pick auto-assegnato.
    ...(r.autoPick === 1 ? { autoPick: true } : {}),
    // Feature JOLLY (D9): marcatore storico del pick con jolly usato.
    ...(r.jollyUsed === 1 ? { jolly: true } : {}),
    eliminated: r.pickStatus === 'wrong' || r.pickStatus === null
  }));
}

/** Esito di `round:open`. */
export interface RoundOpenResult {
  round: number;
  tt: number;
  tc: number;
  status: 'open';
  /** Deadline registrata (ISO-8601), fissa per tutto il round (RF-14). */
  deadline: string;
  /** Profili attivi notificati con l'email pick. */
  notified: number;
}

/** Esito di `round:close`. */
export interface RoundCloseResult {
  round: number;
  tt: number;
  tc: number;
  status: 'closed';
  /** Profili eliminati per pick mancante in questa chiusura. */
  eliminatedMissing: number[];
  /**
   * Profili che hanno ricevuto un PICK AUTO-ASSEGNATO in questa chiusura
   * (feature AUTOPICK: solo con deadline reale e autopick attivo). Vuoto se
   * l'auto-pick è disattivato o la deadline è NULL.
   */
  autoAssigned: number[];
  /** true se chiusura forzata (RF-29, con reason auditato). */
  forced: boolean;
  reason?: string;
}

/** Pick valutato in una contabilizzazione. */
export interface ScoredPick {
  profileId: number;
  team: string;
  outcome: string;
  result: 'correct' | 'wrong';
  /** Feature JOLLY: true se il pick era stato dichiarato con jolly. */
  jollyUsed: boolean;
  /** Feature JOLLY: true se il pick è stato SALVATO dal pareggio tramite jolly. */
  savedByJolly: boolean;
}

/** Esito di `round:score`. */
export interface RoundScoreResult {
  round: number;
  tt: number;
  tc: number;
  /** Stato del round dopo la contabilizzazione. */
  status: string;
  /** Pick valutati in questa esecuzione (pending→esito e frozen→esito). */
  evaluated: ScoredPick[];
  /** Profili il cui pick è appena passato in Freeze (CL1/CL8). */
  newlyFrozen: number[];
  /** Profili appena eliminati per pick sbagliato. */
  newlyEliminated: number[];
}

/** Esito di `round:status` (sola lettura). */
export interface RoundStatusResult {
  round: number;
  tt: number;
  tc: number;
  status: string;
  deadline: string | null;
  openedAt: string | null;
  closedAt: string | null;
  scoredAt: string | null;
  /** Conteggio pick per stato (pending/frozen/correct/wrong). */
  picks: Record<string, number>;
}

/** Esito di `round:deadline` (sola lettura, RF-31). */
export interface RoundDeadlineResult {
  round: number;
  tt: number;
  tc: number;
  /** Deadline registrata in round_state (fissa, RF-14); null se non aperto. */
  deadline: string | null;
  /** Kickoff effettivo dai dati correnti (ISO-8601). */
  kickoff: string;
  /** Istante di accettazione = min(deadline ?? +∞, kickoff) (RF-31). */
  acceptance: string;
}

/** Legge la riga round_state (undefined se il round non è mai stato aperto). */
function getRoundState(db: Database.Database, round: number): RoundStateRow | undefined {
  return db
    .prepare(
      'SELECT round, status, deadline, opened_at, closed_at, scored_at, summary_sent FROM round_state WHERE round = ?'
    )
    .get(round) as RoundStateRow | undefined;
}

/** Profili attivi (eliminated = 0) con email, nome e jolly rimasti. */
function getActiveProfiles(db: Database.Database): ActiveProfile[] {
  return db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName,
              p.jollies_remaining
       FROM profile p
       LEFT JOIN player pl ON pl.id = p.player_id
       WHERE p.eliminated = 0
       ORDER BY p.id`
    )
    .all() as unknown as ActiveProfile[];
}

/**
 * Invia una notifica email via ChannelAdapter+LLMGenerator iniettati, SOLO se
 * l'account piattaforma del destinatario è `active` (RF-P6, ADR-009). Se uno
 * dei componenti manca (CLI di Fase 3) è un no-op: le email reali arrivano
 * nelle Fasi 5–6 (briefing §6.5). Restituisce true se l'email è stata
 * effettivamente inviata. Il soggetto è composto deterministicamente con
 * `subjectFor` (D1, forma umana ADR-011).
 */
async function notify(ctx: GameContext, to: string, emailCtx: EmailContext): Promise<boolean> {
  if (ctx.channel === undefined || ctx.generator === undefined) return false;
  if (!isAccountActive(ctx, to)) return false;
  const body = await ctx.generator.generate(emailCtx);
  await ctx.channel.sendMessage(to, body, subjectFor(emailCtx, ctx.config.testMode));
  return true;
}

/** Converte i match del provider nel contesto email (nomi/date/punteggi, ADR-011). */
function toEmailMatches(matches: Match[]): EmailMatchContext[] {
  return matches.map((m) => ({
    home: m.homeTeam,
    away: m.awayTeam,
    ...(m.homeScore !== undefined && m.awayScore !== undefined
      ? { score: { home: m.homeScore, away: m.awayScore } }
      : {}),
    ...(m.postponed ? { postponed: true } : {})
  }));
}

/**
 * Squadre bruciate di un profilo per il box dedicato (convenzione 3): squadra
 * + round del torneo (TT) di utilizzo. Derivate dalle PICK del profilo nel
 * girone del round (stessa finestra di `getBurnedTeams` — unica fonte in
 * src/game/rules.ts, qui riusata via `halfWindow`/`checkHalf` per ottenere
 * anche il round di utilizzo: nessuna duplicazione della regola del girone).
 * `startRound` è letto UNA volta dal chiamante (fix review 2026-08-23: prima
 * ogni riga bruciata rilanciando `turnFor` rileggeva `tournament_state` —
 * N query identiche per profilo): il TT deriva con `ttFor` puro. Esposta
 * anche al wiring email (`email-processor`) per la mail `pick_rejected` con
 * motivo `team_already_used` (lista bruciate sotto il motivo).
 */
export function getBurnedEmailTeams(
  db: Database.Database,
  profileId: number,
  round: number,
  totalRounds: number,
  startRound: number
): EmailBurnedTeam[] {
  const { min, max } = halfWindow(checkHalf(round, totalRounds), totalRounds);
  const rows = (max === null
    ? db
        .prepare('SELECT team, round AS r FROM pick WHERE profile_id = ? AND round >= ? ORDER BY r')
        .all(profileId, min)
    : db
        .prepare(
          'SELECT team, round AS r FROM pick WHERE profile_id = ? AND round BETWEEN ? AND ? ORDER BY r'
        )
        .all(profileId, min, max)) as Array<{ team: string; r: number }>;
  return rows.map((row) => ({ team: row.team, round: ttFor(row.r, startRound) }));
}

/**
 * Apre un round: crea (o porta da `pending` — righe inizializzate da
 * `tournament:start`, LLD §7.10) la riga `round_state` con deadline fissa
 * (RF-14) e invia l'email pick ai profili attivi con le sole squadre
 * disponibili (decisione 12). Errore se il round è già `open` (niente
 * duplicati) o in stato terminale (`closed`/`scored`: un round contabilizzato
 * si corregge solo col flusso CL9, US10).
 */
export async function openRound(ctx: GameContext, round: number): Promise<RoundOpenResult> {
  const { db, dataProvider, config, now } = ctx;

  // ADR-016: guardia fatal all'inizio (copre anche `round:open` manuale, che
  // invia le istruzioni mode-aware): un cambio di modalità a torneo aperto
  // aborta PRIMA di scrivere round_state o inviare email.
  assertModeConsistent(ctx);

  // MEDIUM-1 (ADR-011 §5.5, emendamento post-revisione): a torneo CHIUSO
  // (winner_notified=1) non si apre più alcun round — il torneo è finito e
  // l'unica prosecuzione è il riavvio via `tournament:start`.
  if (isTournamentClosed(db)) {
    throw new Error('Torneo chiuso: non è possibile aprire un nuovo round (riavvia con tournament:start)');
  }

  const existing = getRoundState(db, round);
  if (existing !== undefined && existing.status !== 'pending') {
    throw new Error(
      `Il round ${round} esiste già in stato '${existing.status}': non riapribile con round:open`
    );
  }

  // Deadline fissa: kickoff effettivo (MIN match_date dei non rinviati) − anticipo.
  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = computeDeadline(kickoff, config.DEADLINE_ADVANCE_MIN);
  // GUARDIA UAT 2026-08-22: aprire un round con deadline GIÀ SCADUTA crea una
  // trappola — ogni pick successivo verrebbe rifiutato dalla cascata RF-31
  // (`after_acceptance`/`after_kickoff`) e l'auto-join farebbe ROLLBACK senza
  // creare profili: è esattamente l'incidente UAT reale (round aperto 24s dopo
  // la deadline, 0 pick registrati, 0 profili, giocatori invitati a fare
  // l'impossibile). Stesso stile del gate RF-21 in `tournament:start`:
  // rifiuto pulito PRIMA di qualunque scrittura (nessuno stato parziale).
  // Nota: `deadline <= now` anche a parità esatta — una finestra pick di
  // lunghezza zero non è una finestra. Lo scheduler apre i round appena il TC
  // precedente è `scored`, sempre con kickoff futuri (deadline futura), quindi
  // il flusso automatico non è impattato.
  if (deadline <= now) {
    throw new Error(
      `Deadline del round ${round} non futura (${deadline.toISOString()}): apertura rifiutata (nessun pick sarebbe accettabile)`
    );
  }
  if (existing === undefined) {
    db.prepare(
      "INSERT INTO round_state (round, status, deadline, opened_at) VALUES (?, 'open', ?, ?)"
    ).run(round, deadline.toISOString(), now.toISOString());
  } else {
    db.prepare(
      "UPDATE round_state SET status = 'open', deadline = ?, opened_at = ? WHERE round = ?"
    ).run(deadline.toISOString(), now.toISOString(), round);
  }

  // Coppia TT/TC derivata (RF-25): `startRound` è letto UNA volta qui e
  // riusato da `getBurnedEmailTeams` per ogni profilo (fix review
  // 2026-08-23: nessuna rilettura di tournament_state per riga bruciata).
  const startRound = getStartRound(db);
  const tt = ttFor(round, startRound);
  const tc = round;
  const matches = await dataProvider.getMatchesForRound(round);
  const totalRounds = await dataProvider.getTotalRounds();
  const emailMatches = toEmailMatches(matches);

  // Email pick ai profili attivi: solo squadre disponibili del profilo
  // (decisione 12). ADR-019: SOLO i partecipanti (profili) ricevono la mail
  // pick — nessuna eccezione TT1 per gli account senza profilo (vedi sotto).
  const active = getActiveProfiles(db);
  let notified = 0;
  for (const profile of active) {
    const availableTeams = await getAvailableTeams(db, dataProvider, profile.id, round);
    const sent = await notify(ctx, profile.email, {
      type: 'pick_instructions',
      playerName: profile.playerName,
      round: tt,
      championshipRound: tc,
      roundStart: kickoff,
      deadline,
      // Countdown calcolato DAL SISTEMA col clock iniettato (ADR-011, RNF1):
      // mai dall'LLM e mai dal renderer.
      deadlineRemaining: formatRemaining(now, deadline),
      availableTeams,
      burnedTeams: getBurnedEmailTeams(db, profile.id, round, totalRounds, startRound),
      matches: emailMatches,
      // Feature JOLLY: contatore per-profilo (solo per profili con contatore noto).
      jolliesRemaining: profile.jollies_remaining
    });
    if (sent) notified += 1;
  }

  // Amendment RF-P6 (decisione 2026-08-21) RIMOSSO (ADR-019): all'apertura del
  // TT 1 l'email `pick_instructions` va SOLO ai partecipanti (profili) — gli
  // account `active` senza profilo NON ricevono più la mail di pick, perché
  // la nascita dei profili non avviene più per auto-join al primo pick (RF-P5):
  // chi vuole partecipare dichiara (PARTECIPO/tournament:join) e l'auto-join
  // a `tournament:start` copre gli account con flag ON. L'annuncio di
  // partecipazione è `tournament_open` (D9), non `pick_instructions`.

  return { round, tt, tc, status: 'open', deadline: deadline.toISOString(), notified };
}

/**
 * Chiude un round consolidando: elimina i profili attivi senza pick
 * (`missing_pick`), li notifica e marca `closed`. Con `force` richiede
 * `reason` (RF-29: audit obbligatorio); la semantica è IDENTICA alla chiusura
 * a deadline — non esiste "chiudi senza eliminare". Idempotente su round già
 * `closed` (ri-consolida senza effetti: gli eliminati restano tali).
 *
 * Feature AUTOPICK (D3/D4/D5): con `WIN_ONLY && AUTOPICK_ON_MISSING` e
 * deadline REALE (`rs.deadline !== null`), al posto dell'eliminazione il
 * sistema assegna a ogni mancante la prima squadra disponibile per short_name
 * (`pick_auto_assigned`, `auto_pick=1`, outcome 'win'). Con deadline NULL
 * (`close_safety`, RF-30) o autopick disattivato, i mancanti restano eliminati
 * `missing_pick` come oggi.
 */
export async function closeRound(
  ctx: GameContext,
  round: number,
  opts: { force?: boolean; reason?: string } = {}
): Promise<RoundCloseResult> {
  const { db, now, config, dataProvider } = ctx;

  // ADR-016: guardia fatal all'inizio (copre `round:close` manuale, che scrive
  // ed elimina SENZA passare dallo scheduler).
  assertModeConsistent(ctx);

  if (opts.force === true && (opts.reason === undefined || opts.reason.trim() === '')) {
    throw new Error('La chiusura forzata richiede --reason (audit obbligatorio, RF-29)');
  }

  const rs = getRoundState(db, round);
  if (rs === undefined) {
    throw new Error(`Il round ${round} non è mai stato aperto`);
  }
  if (rs.status === 'scored') {
    throw new Error(`Il round ${round} è già contabilizzato (scored): non chiudibile`);
  }

  const { tt, tc } = turnFor(db, round);

  // Feature AUTOPICK (D3/D5): l'auto-assign scatta SOLO se il gating è attivo
  // (WIN_ONLY && AUTOPICK_ON_MISSING) E la chiusura ha una deadline REALE
  // (`rs.deadline !== null`); la chiusura di sicurezza (`close_safety`,
  // deadline NULL, RF-30) continua a eliminare i mancanti come oggi. I dati
  // necessari all'auto-pick (partite, squadre, totali round, short_name) sono
  // letti UNA VOLTA qui — non per profilo — per evitare N round-trip (stesso
  // stile del fix review 2026-08-23).
  const autopickEnabled = config.WIN_ONLY && config.AUTOPICK_ON_MISSING;
  let autopickData:
    | { matches: Match[]; teams: string[]; totalRounds: number; shortNames: Map<string, string> }
    | undefined;
  if (autopickEnabled && rs.deadline !== null) {
    const [matches, teams, totalRounds, teamRows] = await Promise.all([
      dataProvider.getMatchesForRound(round),
      dataProvider.getTeams(),
      dataProvider.getTotalRounds(),
      dataProvider.getTeamsOrderedByShortName()
    ]);
    autopickData = {
      matches,
      teams,
      totalRounds,
      shortNames: new Map(teamRows.map((t) => [t.name, t.shortName]))
    };
  }

  // Consolidamento: profili attivi SENZA pick per questo round.
  const missing = db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName
       FROM profile p
       LEFT JOIN player pl ON pl.id = p.player_id
       WHERE p.eliminated = 0
         AND NOT EXISTS (SELECT 1 FROM pick pk WHERE pk.profile_id = p.id AND pk.round = ?)
       ORDER BY p.id`
    )
    .all(round) as unknown as ActiveProfile[];

  const eliminatedMissing: number[] = [];
  const autoAssigned: number[] = [];
  const assignedTeams = new Map<number, string>();
  for (const profile of missing) {
    // Feature AUTOPICK (D4): inserimento DIRETTO (bypassa `validatePick`, che
    // a chiusura rifiuterebbe con after_acceptance/round_not_open), con
    // outcome 'win' e auto_pick=1. Fallback (autopick disattivato, deadline
    // NULL o nessuna squadra disponibile, D6): eliminazione missing_pick.
    const team =
      autopickData === undefined
        ? null
        : getFirstAvailableTeamByShortName(
            db,
            profile.id,
            round,
            autopickData.totalRounds,
            autopickData.matches,
            autopickData.teams,
            autopickData.shortNames
          );
    if (team !== null) {
      insertPendingPick(db, profile.id, round, team, 'win', now.toISOString(), 1);
      autoAssigned.push(profile.id);
      assignedTeams.set(profile.id, team);
    } else {
      if (autopickEnabled && rs.deadline !== null) {
        // D6 (caso difensivo): nessuna squadra disponibile → resta missing_pick
        // con warn log in inglese (mai assegnare una squadra non in giornata).
        ctx.logger?.warn(
          { profileId: profile.id, round },
          'round:close: auto-pick skipped (no available team) — profile eliminated as missing_pick'
        );
      }
      eliminate(db, profile.id, 'missing_pick', now);
      eliminatedMissing.push(profile.id);
    }
  }
  // ADR-011: esito `missing` + conteggio aggregato dei superstiti
  // ("Il torneo continua con N giocatori in gara", convenzione 10) — fix
  // review 2026-08-23: il conteggio è calcolato UNA volta DOPO tutte le
  // eliminazioni del round, così OGNI destinatario riceve lo STESSO valore
  // (mai numeri divergenti tra destinatari della stessa chiusura).
  const inGame = countInGame(db);
  // LOW-1 (best-effort): un fallimento SMTP/LLM sulla notifica viene loggato
  // (warn pino, inglese) e NON interrompe il loop: la chiusura e il successivo
  // check vincitore (`settleWinnerIfNeeded`) devono girare comunque (stesso
  // pattern di riepilogo e vincitori).
  for (const profile of missing) {
    const team = assignedTeams.get(profile.id);
    try {
      if (team !== undefined) {
        // Feature AUTOPICK (D8): conferma A POSTERIORI, senza sezione
        // deadline/countdown (post-deadline): il renderer NON la aggiunge a
        // PICK_EMAIL_TYPES.
        await notify(ctx, profile.email, {
          type: 'pick_auto_assigned',
          playerName: profile.playerName,
          round: tt,
          championshipRound: tc,
          team
        });
      } else {
        await notify(ctx, profile.email, {
          type: 'pick_missing_elimination',
          playerName: profile.playerName,
          round: tt,
          championshipRound: tc,
          playerResult: 'missing',
          inGameCount: inGame
        });
      }
    } catch (error) {
      ctx.logger?.warn(
        {
          email: profile.email,
          error: error instanceof Error ? error.message : String(error)
        },
        'round:close: elimination notification not sent — continuing (best-effort)'
      );
    }
  }

  if (rs.status !== 'closed') {
    db.prepare("UPDATE round_state SET status = 'closed', closed_at = ? WHERE round = ?").run(
      now.toISOString(),
      round
    );
  }

  // ADR-011: alla chiusura di ogni round il sistema verifica AUTOMATICAMENTE
  // se c'è un vincitore (es. tutti gli altri eliminati) e chiude il torneo
  // (notifica + export + inibizione scheduler): hook del Round Manager, mai
  // del comando CLI `winner:check` (sola lettura). Disattivato nella
  // simulazione dry-run (`ctx.autoClose = false`, R1).
  if (ctx.autoClose !== false) {
    await settleWinnerIfNeeded(ctx);
  }

  return {
    round,
    tt,
    tc,
    status: 'closed',
    eliminatedMissing,
    autoAssigned,
    forced: opts.force === true,
    reason: opts.reason
  };
}

/**
 * Contabilizza un round (incrementale, ADR-003; idempotente, RF-17):
 * pending con punteggio → correct/wrong (+ eliminazione wrong_pick); postponed
 * senza punteggio → frozen se oltre tcClose (CL1/CL8), altrimenti resta pending
 * (CL7); frozen con punteggio ora disponibile → valutato (anche su round già
 * scored, LLD §1.4). Il round passa a `scored` quando non restano pending
 * (RF-16; i frozen sono terminali per il TT). La transizione a `scored` e la
 * guardia `summary_sent` sono scritte in UN'UNICA istruzione UPDATE (B2,
 * decisione (b)): non esiste mai `scored` con summary_sent=0. L'invio del
 * riepilogo che segue è BEST-EFFORT per destinatario (vedi blocco 3): un
 * errore SMTP/LLM viene loggato con warn pino in inglese via `ctx.logger`
 * (quando iniettato) e NON fa fallire la contabilizzazione.
 */
export async function scoreRound(ctx: GameContext, round: number): Promise<RoundScoreResult> {
  const { db, dataProvider, config, now } = ctx;

  // ADR-016: guardia fatal all'inizio (copre `round:score` manuale, che scrive
  // e invia email SENZA passare dallo scheduler).
  assertModeConsistent(ctx);

  // MEDIUM-2 (emendamento post-revisione ADR-011): a torneo CHIUSO
  // (winner_notified=1) una ricontabilizzazione aggiorna comunque lo stato DB
  // (idempotenza RF-17), ma NON invia più email di esito: round_result_*,
  // pick_postponed e il riepilogo round_closed_survived tacciono.
  const closed = isTournamentClosed(db);

  const matches = await dataProvider.getMatchesForRound(round);
  const tcClose = computeTcClose(matches, config.MATCH_DURATION_MIN, config.TC_CLOSE_SKEW_MIN);
  const { tt, tc } = turnFor(db, round);
  const emailMatches = toEmailMatches(matches);

  const evaluated: ScoredPick[] = [];
  const newlyFrozen: number[] = [];
  const newlyEliminated: number[] = [];
  /**
   * Esiti da notificare dopo la valutazione di TUTTI i pick (fix review
   * 2026-08-23): la notifica è differita per calcolare il conteggio dei
   * superstiti UNA sola volta — ogni destinatario della run riceve lo
   * stesso `inGameCount`, coerente col riepilogo.
   */
  const resultEmails: Array<{
    email: string;
    playerName: string;
    result: 'correct' | 'wrong';
    team: string;
    outcome: string;
    jollyUsed: boolean;
    savedByJolly: boolean;
  }> = [];

  /** Valuta un pick contro il match della sua squadra (a punteggio noto). */
  const evaluatePick = async (pick: PickRow): Promise<void> => {
    const match = matches.find((m) => m.homeTeam === pick.team || m.awayTeam === pick.team);
    if (match === undefined) return; // non dovrebbe accadere (validato alla registrazione)
    if (match.homeScore === undefined || match.awayScore === undefined) return;
    const actual = pickOutcomeFor(pick.team, match);
    // Feature JOLLY (D1): un pick dichiarato con jolly e con risultato
    // "pareggio" NON elimina: `savedByJolly` trasforma il risultato in
    // 'correct' (nessun nuovo pick.status: il CHECK della DDL resta
    // "baked" — la distinzione è nota SOLO qui e trasportata alle email via
    // flag di runtime, mai ricostruita dopo).
    const jollyUsed = pick.jolly_used === 1;
    let result: 'correct' | 'wrong' = actual === pick.outcome ? 'correct' : 'wrong';
    const savedByJolly = result === 'wrong' && jollyUsed && actual === 'draw';
    if (savedByJolly) result = 'correct';
    db.prepare('UPDATE pick SET status = ? WHERE id = ?').run(result, pick.id);
    evaluated.push({
      profileId: pick.profile_id,
      team: pick.team,
      outcome: pick.outcome,
      result,
      jollyUsed,
      savedByJolly
    });

    const profile = db
      .prepare(
        `SELECT COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName
         FROM profile p LEFT JOIN player pl ON pl.id = p.player_id WHERE p.id = ?`
      )
      .get(pick.profile_id) as { email: string; playerName: string } | undefined;

    if (result === 'wrong') {
      // Idempotente: un profilo già eliminato non viene ri-eliminato.
      const wasEliminated =
        (db.prepare('SELECT eliminated FROM profile WHERE id = ?').get(pick.profile_id) as
          | { eliminated: number }
          | undefined)?.eliminated === 1;
      eliminate(db, pick.profile_id, 'wrong_pick', now);
      if (!wasEliminated) newlyEliminated.push(pick.profile_id);
    }
    if (profile !== undefined && !closed) {
      // ADR-011: esito (playerResult) + risultati del round + conteggio
      // aggregato dei superstiti (convenzioni 5/6/10). A torneo chiuso il
      // ramo è saltato (MEDIUM-2: lo stato DB è già aggiornato sopra).
      // Fix review 2026-08-23: qui si RACCOGLIE solo il payload — l'invio
      // avviene dopo la valutazione di tutti i pick (vedi sotto), con il
      // conteggio calcolato una sola volta.
      resultEmails.push({
        email: profile.email,
        playerName: profile.playerName,
        result,
        team: pick.team,
        outcome: pick.outcome,
        jollyUsed,
        savedByJolly
      });
    }
  };

  // 1) Pick PENDING del round.
  const pending = db
    .prepare("SELECT id, profile_id, round, team, outcome, status, jolly_used FROM pick WHERE round = ? AND status = 'pending' ORDER BY id")
    .all(round) as unknown as PickRow[];
  for (const pick of pending) {
    const match = matches.find((m) => m.homeTeam === pick.team || m.awayTeam === pick.team);
    if (match === undefined) continue;
    if (match.homeScore !== undefined && match.awayScore !== undefined) {
      await evaluatePick(pick);
    } else if (match.postponed && tcClose !== null && now > tcClose) {
      // Rinviata e oltre la chiusura del TC → Freeze (CL1/CL8).
      db.prepare("UPDATE pick SET status = 'frozen' WHERE id = ?").run(pick.id);
      newlyFrozen.push(pick.profile_id);
      const profile = db
        .prepare(
          `SELECT COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName
           FROM profile p LEFT JOIN player pl ON pl.id = p.player_id WHERE p.id = ?`
        )
        .get(pick.profile_id) as { email: string; playerName: string } | undefined;
      if (profile !== undefined && !closed) {
        await notify(ctx, profile.email, {
          type: 'pick_postponed',
          playerName: profile.playerName,
          round: tt,
          championshipRound: tc,
          team: pick.team
        });
      }
    }
    // Altrimenti (in corso / rinviata entro la finestra) resta pending (CL7).
  }

  // 2) Pick FROZEN la cui partita ORA ha punteggio (recupero concluso):
  //    valutazione a posteriori, anche su round già scored (LLD §1.4).
  const frozen = db
    .prepare("SELECT id, profile_id, round, team, outcome, status, jolly_used FROM pick WHERE round = ? AND status = 'frozen' ORDER BY id")
    .all(round) as unknown as PickRow[];
  for (const pick of frozen) {
    await evaluatePick(pick);
  }

  // Fix review 2026-08-23: conteggio dei superstiti calcolato UNA volta
  // DOPO tutte le eliminazioni della run (pending + frozen): ogni email di
  // esito porta lo stesso valore, identico a quello del riepilogo
  // round_closed_survived qui sotto (nessuna query per pick).
  const inGame = countInGame(db);
  for (const email of resultEmails) {
    await notify(ctx, email.email, {
      type: email.result === 'correct' ? 'round_result_correct' : 'round_result_wrong',
      playerName: email.playerName,
      round: tt,
      championshipRound: tc,
      team: email.team,
      outcome: email.outcome,
      playerResult: email.result,
      inGameCount: inGame,
      matches: emailMatches,
      // Feature JOLLY (D1/D9): flag runtime trasportati alle mail di esito —
      // il renderer sceglie il testo corretto (salvato dal pareggio / jolly
      // usato / il jolly non salva dalla sconfitta).
      jollyUsed: email.jollyUsed,
      savedByJolly: email.savedByJolly
    });
  }

  // 3) Transizione a `scored` quando non restano pending (RF-16): solo da
  //    `closed` (la chiusura deve aver già eliminato i mancanti).
  const remainingPending = (
    db.prepare("SELECT COUNT(*) AS n FROM pick WHERE round = ? AND status = 'pending'").get(round) as {
      n: number;
    }
  ).n;
  const rs = getRoundState(db, round);
  let status = rs?.status ?? 'unknown';
  if (rs !== undefined && rs.status === 'closed' && remainingPending === 0) {
    // B2 (decisione (b)): transizione a `scored` e guardia `summary_sent`
    // scritte INSIEME, in un'unica istruzione UPDATE, PRIMA del loop di invio
    // del riepilogo. Prima di questa correzione `scored_at` era scritto prima
    // del loop e `summary_sent=1` DOPO: un'eccezione durante l'invio lasciava
    // il round `scored` con summary_sent=0 e il riepilogo perso per sempre
    // (le riaperture saltano il blocco perché lo stato non è più `closed`).
    // Ora lo stato intermedio non esiste: la guardia non si perde MAI.
    db.prepare(
      "UPDATE round_state SET status = 'scored', scored_at = ?, summary_sent = 1 WHERE round = ?"
    ).run(now.toISOString(), round);
    status = 'scored';
    // RF-P6 (ADR-009): riepilogo `round_closed_survived` SOLO alla transizione
    // closed→scored e UNA SOLA volta — la guardia È la transizione stessa: lo
    // stato passa a `scored` nell'UPDATE atomico sopra, quindi le riaperture
    // di round:score saltano l'intero blocco (nessun check separato su
    // summary_sent: vale 0 per OGNI riga in stato `closed`, è scritta a 1
    // solo insieme a `scored`). Destinatari: SOLO i sopravvissuti
    // (eliminated = 0) con account piattaforma `active` (filtro in notify).
    // BEST-EFFORT per destinatario (B2, decisione (b)): ogni invio è avvolto
    // in try/catch — un errore SMTP/LLM su un destinatario viene loggato con
    // warn pino in INGLESE (via `ctx.logger`, quando iniettato dalla CLI) e il
    // loop continua coi destinatari successivi; `scoreRound` risolve
    // normalmente anche con invii falliti. Il fallimento NON viene ritentato
    // (trade-off POC accettato, rischio §8 del piano): resta visibile nei log.
    //
    // ADR-011: il riepilogo porta risultati del round e stato AGGREGATO
    // (solo conteggi — convenzione 6) PIÙ, da ADR-015 email v4, l'elenco
    // nominativo dei partecipanti del round (carve-out della convenzione 6,
    // SOLO per `round_closed_survived` e `tournament_closed`). Nessuna
    // deadline del prossimo round (fix review 2026-08-23: il box deadline
    // del renderer vale SOLO per le mail che richiedono un pick,
    // PICK_EMAIL_TYPES in email-renderer.ts — l'iniezione era dato morto
    // senza la guardia LOW-3 `now < deadline`).
    const rsRow = getRoundState(db, round);
    const openedAt = rsRow?.opened_at != null ? new Date(rsRow.opened_at) : null;
    // Fix review 2026-08-23: `inGame` è il conteggio UNICO calcolato sopra
    // dopo tutte le eliminazioni — lo stesso valore delle email di esito.
    const eliminatedWrong = (
      db.prepare("SELECT COUNT(*) AS n FROM pick WHERE round = ? AND status = 'wrong'").get(round) as {
        n: number;
      }
    ).n;
    const eliminatedMissing =
      openedAt === null
        ? 0
        : (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM profile
                 WHERE eliminated = 1 AND eliminated_reason = 'missing_pick' AND eliminated_at >= ?`
              )
              .get(openedAt.toISOString()) as { n: number }
          ).n;
    // ADR-015 (email v4): elenco nominativo dei partecipanti del round,
    // computato UNA volta (come `inGame`) e condiviso da OGNI destinatario
    // del riepilogo — stesso valore per tutti, mai query per giocatore.
    // `openedAt` sentinella: un round chiuso è SEMPRE stato aperto (opened_at
    // valorizzato); la sentinella preserva il filtro "eliminati nel round" in
    // un eventuale stato anomalo senza far saltare l'invio.
    const roundPlayers = getRoundPlayers(
      db,
      round,
      openedAt === null ? '0000-01-01T00:00:00.000Z' : openedAt.toISOString()
    );

    const survivors = getActiveProfiles(db);
    // MEDIUM-2: a torneo chiuso il riepilogo round_closed_survived tace
    // (la transizione closed→scored è già avvenuta prima della chiusura).
    if (!closed) {
      for (const survivor of survivors) {
        try {
          await notify(ctx, survivor.email, {
            type: 'round_closed_survived',
            playerName: survivor.playerName,
            round: tt,
            championshipRound: tc,
            matches: emailMatches,
            players: roundPlayers,
            inGameCount: inGame,
            eliminatedWrong,
            eliminatedMissing,
            // Feature JOLLY: contatore del DESTINATARIO (per destinatario).
            jolliesRemaining: survivor.jollies_remaining
          });
        } catch (error) {
          ctx.logger?.warn(
            {
              email: survivor.email,
              error: error instanceof Error ? error.message : String(error)
            },
            `round:score: summary not sent to ${survivor.email} — continuing (best-effort)`
          );
        }
      }
    }
  }

  // ADR-011: alla contabilizzazione di ogni round il sistema verifica
  // AUTOMATICAMENTE se c'è un vincitore (casi 1/2/3) e chiude il torneo
  // (guardia atomica → notifica → export → inibizione scheduler). No-op se
  // il torneo non è finito o è già stato chiuso da una chiamata precedente.
  // Disattivato nella simulazione dry-run (`ctx.autoClose = false`, R1).
  if (ctx.autoClose !== false) {
    await settleWinnerIfNeeded(ctx);
  }

  return { round, tt, tc, status, evaluated, newlyFrozen, newlyEliminated };
}

/** Esito di `settleWinnerIfNeeded` (ADR-011, chiusura automatica). */
export interface SettleWinnerResult {
  /** true se QUESTA chiamata ha chiuso il torneo (la guardia atomica è passata). */
  closed: boolean;
  /** Vincitori identificati (vuoto se il torneo non è finito o era già chiuso). */
  winners: WinnerInfo[];
  /** Path del file di export scritto (presente solo se closed). */
  exportPath?: string;
}

/**
 * CHIUSURA AUTOMATICA E COMPLETA del torneo (ADR-011 §5): alla
 * identificazione del/i vincitore/i — invocata dal Round Manager dopo
 * `closeRound` e dopo `scoreRound` (e SOLO da qui: `winner:check` resta
 * sola lettura, nessun side-effect) — esegue TUTTO in sequenza:
 *
 * 1. VERIFICA vincitore (`checkWinner`, sola lettura): nessun vincitore →
 *    no-op.
 * 2. GUARDIA ATOMICA idempotente: `tournament_state.winner_notified = 1` +
 *    `finished_at = <clock>` in un'unica istruzione (UPSERT con WHERE
 *    winner_notified = 0): ri-avvii di round/CL9 non duplicano nulla.
 * 3. NOTIFICA VINCITORI: `tournament_won` (vincitore unico) /
 *    `tournament_shared_win` (2+, con la lista `coWinners` degli altri
 *    vincitori, ADR-015 email v4), best-effort per destinatario (filtro
 *    account `active` in notify, warn pino in inglese via ctx.logger).
 * 3b. NOTIFICA CHIUSURA (ADR-015 email v4): `tournament_closed` con lo
 *    storico per-round a TUTTI i partecipanti (profili con almeno un pick,
 *    vincitori inclusi), best-effort per destinatario.
 * 4. EXPORT AUTOMATICO: riuso di `tournamentExport` (dump JSON completo)
 *    archiviato via il SEAM `ctx.archiveTournament` iniettato dal wiring
 *    (ADR-011 §1.3: mai node:fs nei moduli di gioco) — il path di
 *    destinazione (`TOURNAMENT_EXPORT_DIR`) e il filename dal clock iniettato
 *    (deterministico, RNF1) vivono nel wiring; l'esito è loggato (pino info
 *    in inglese) e `tournament_state.export_path` è scritto SOLO a
 *    archiviazione riuscita. L'export è l'archivio che rende SICURO il reset
 *    del DB di gioco al riavvio (`tournament:start` su torneo chiuso, §5.5):
 *    un errore di scrittura è loggato (warn, inglese) senza far fallire la
 *    chiusura (la guardia è già scritta e le notifiche sono partite), ma
 *    `export_path` resta NULL e il riavvio viene rifiutato dal gate.
 * 5. L'INIBIZIONE dello scheduler è implicita: `computeActions` ritorna []
 *    quando `winner_notified = 1` (src/game/scheduler.ts).
 */
export async function settleWinnerIfNeeded(ctx: GameContext): Promise<SettleWinnerResult> {
  const { db, now } = ctx;

  // RECUPERO EXPORT (fix review 2026-08-23): torneo GIÀ chiuso ma export
  // mancante (write fallita/crash alla prima chiusura) → al rientro
  // successivo di round:close/score (idempotenti, CL9) ritenta SOLO
  // l'archiviazione. I vincitori NON vengono mai rinotificati: questo ramo
  // salta del tutto `checkWinner` e il blocco notifiche. Senza seam
  // (simulazione dry-run) logga solo warn, nessun loop.
  const existing = getTournamentState(db);
  if (existing?.winner_notified === 1) {
    if ((existing.export_path ?? null) !== null) {
      return { closed: false, winners: [] };
    }
    ctx.logger?.warn('tournament closed: export missing (export_path NULL) — retrying archive');
    const exportPath = await archiveTournamentExport(ctx, now);
    return exportPath !== undefined
      ? { closed: true, winners: [], exportPath }
      : { closed: false, winners: [] };
  }

  const result = await checkWinner(ctx);
  if (!result.finished) return { closed: false, winners: [] };

  // Guardia atomica: chiusura eseguita UNA SOLA volta anche con ri-avvii di
  // round:score/close (CL9, riavvii manuali). UPSERT: crea la riga se
  // assente, aggiorna solo se winner_notified = 0.
  const guarded = db
    .prepare(
      `INSERT INTO tournament_state (id, winner_notified, finished_at) VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET winner_notified = 1, finished_at = excluded.finished_at
       WHERE tournament_state.winner_notified = 0`
    )
    .run(now.toISOString());
  if (guarded.changes === 0) return { closed: false, winners: [] };

  // Notifica vincitori (best-effort per destinatario, filtro active in notify).
  // ADR-015 (email v4): costruita PRIMA la mappa profilo→nome per tutti i
  // vincitori (fallback nome vuoto → email), poi per ogni vincitore la lista
  // degli ALTRI vincitori (`coWinners`), escluso sé stesso — usata dal
  // renderer per la sezione "HAI CONDIVISO LA VITTORIA CON" (solo
  // `tournament_shared_win`; `tournament_won` resta senza coWinners).
  const type = result.winners.length === 1 ? 'tournament_won' : 'tournament_shared_win';
  const winnerNames = new Map<number, string>();
  for (const winner of result.winners) {
    const row = db
      .prepare(
        `SELECT COALESCE(pl.name, '') AS playerName
         FROM profile p JOIN player pl ON pl.id = p.player_id WHERE p.id = ?`
      )
      .get(winner.profileId) as { playerName: string } | undefined;
    const playerName = row?.playerName ?? '';
    winnerNames.set(winner.profileId, playerName === '' ? winner.email : playerName);
  }
  for (const winner of result.winners) {
    const coWinners = result.winners
      .filter((w) => w.profileId !== winner.profileId)
      .map((w) => winnerNames.get(w.profileId) ?? w.email);
    try {
      await notify(ctx, winner.email, {
        type,
        playerName: winnerNames.get(winner.profileId),
        ...(coWinners.length > 0 ? { coWinners } : {})
      });
    } catch (error) {
      ctx.logger?.warn(
        {
          email: winner.email,
          error: error instanceof Error ? error.message : String(error)
        },
        `winner notification not sent to ${winner.email} — continuing (best-effort)`
      );
    }
  }

  // ADR-015 (email v4): mail `tournament_closed` con lo STORICO per-round a
  // TUTTI i partecipanti (profili con almeno un pick), UNA sola volta (questo
  // ramo è raggiunto solo con `guarded.changes === 1`), best-effort per
  // destinatario (filtro active in notify, warn pino in inglese). I vincitori
  // la ricevono IN AGGIUNTA alla loro mail di vittoria. Lo storico è
  // calcolato UNA volta e condiviso da ogni destinatario.
  const participants = db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName
       FROM profile p
       JOIN player pl ON pl.id = p.player_id
       WHERE EXISTS (SELECT 1 FROM pick pk WHERE pk.profile_id = p.id)
       ORDER BY p.id`
    )
    .all() as unknown as ActiveProfile[];
  const tournamentHistory = await buildTournamentHistory(ctx);
  for (const participant of participants) {
    try {
      await notify(ctx, participant.email, {
        type: 'tournament_closed',
        playerName: participant.playerName === '' ? participant.email : participant.playerName,
        tournamentHistory
      });
    } catch (error) {
      ctx.logger?.warn(
        {
          email: participant.email,
          error: error instanceof Error ? error.message : String(error)
        },
        `tournament closed: closing notification not sent to ${participant.email} — continuing (best-effort)`
      );
    }
  }

  // Export automatico (vedi `archiveTournamentExport`): il fallimento è
  // loggato e NON blocca la chiusura; il recupero avviene al rientro.
  const exportPath = await archiveTournamentExport(ctx, now);

  return { closed: true, winners: result.winners, exportPath };
}

/**
 * Storico per-round del torneo per la mail `tournament_closed` (ADR-015 email
 * v4): SOLA LETTURA. Per ogni round della finestra `[start_round..N]` con
 * `round_state` non `pending` (quindi giocato), riusa la query di
 * `getRoundPlayers` con lo snapshot di apertura di quel round (partecipanti =
 * `eliminated = 0 OR eliminated_at >= opened_at`). NON riusa `tournamentExport`:
 * quello è il dump JSON di archivio (destinato al file), qui serve un elenco
 * per-round snello e canale-agnostico per il renderer. I round futuri (mai
 * aperti, `pending`) sono esclusi; `opened_at` sentinella per stati anomali.
 */
async function buildTournamentHistory(ctx: GameContext): Promise<EmailTournamentRound[]> {
  const { db, dataProvider } = ctx;
  const startRound = getStartRound(db);
  const totalRounds = await dataProvider.getTotalRounds();
  const history: EmailTournamentRound[] = [];
  for (let round = startRound; round <= totalRounds; round++) {
    const rs = getRoundState(db, round);
    if (rs === undefined || rs.status === 'pending') continue;
    const openedAt = rs.opened_at ?? '0000-01-01T00:00:00.000Z';
    history.push({
      round: ttFor(round, startRound),
      championshipRound: round,
      players: getRoundPlayers(db, round, openedAt)
    });
  }
  return history;
}

/**
 * Archivia il dump JSON del torneo tramite il SEAM iniettato dal wiring
 * (`ctx.archiveTournament`, ADR-011 §1.3: MAI node:fs nei moduli di gioco).
 * `tournament_state.export_path` è scritto SOLO a writeFileSync riuscita
 * (sincrona) → export_path non-null ⇒ file archiviato; il gate di riavvio in
 * `tournament:start` legge SOLO il campo DB (mai fs.existsSync). Senza seam
 * iniettato (es. simulazione dry-run, R1) l'export NON viene scritto e
 * `export_path` resta NULL. Fallimento → warn pino (inglese) e `undefined`:
 * il recupero avviene al rientro successivo di `settleWinnerIfNeeded`
 * (fix review 2026-08-23: il fallimento viene SEMPRE loggato, mai silenzioso).
 */
async function archiveTournamentExport(ctx: GameContext, now: Date): Promise<string | undefined> {
  if (ctx.archiveTournament === undefined) {
    ctx.logger?.warn('tournament closed: no archive dependency — export not written');
    return undefined;
  }
  try {
    const dump = await tournamentExport(ctx);
    const exportPath = ctx.archiveTournament(dump, now);
    ctx.db.prepare('UPDATE tournament_state SET export_path = ? WHERE id = 1').run(exportPath);
    ctx.logger?.info({ exportPath }, 'tournament closed: export written');
    return exportPath;
  } catch (error) {
    ctx.logger?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'tournament closed: export write failed — history not archived'
    );
    return undefined;
  }
}

/** Stato di un round (sola lettura) con coppia TT/TC e conteggi pick. */
export function roundStatus(ctx: GameContext, round: number): RoundStatusResult {  const { db } = ctx;
  const rs = getRoundState(db, round);
  const { tt, tc } = turnFor(db, round);
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM pick WHERE round = ? GROUP BY status')
    .all(round) as unknown as Array<{ status: string; n: number }>;
  const picks: Record<string, number> = {};
  for (const c of counts) picks[c.status] = c.n;
  return {
    round,
    tt,
    tc,
    status: rs?.status ?? 'pending',
    deadline: rs?.deadline ?? null,
    openedAt: rs?.opened_at ?? null,
    closedAt: rs?.closed_at ?? null,
    scoredAt: rs?.scored_at ?? null,
    picks
  };
}

/**
 * Deadline di un round (sola lettura, RF-31): espone ENTRAMBE le sorgenti
 * temporali — la deadline registrata (fissa, RF-14) e il kickoff effettivo dai
 * dati correnti — e l'istante di accettazione = min(deadline ?? +∞, kickoff).
 */
export async function roundDeadline(ctx: GameContext, round: number): Promise<RoundDeadlineResult> {
  const { db, dataProvider } = ctx;
  const rs = getRoundState(db, round);
  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = rs?.deadline != null ? new Date(rs.deadline) : null;
  const acceptance =
    deadline !== null && deadline < kickoff ? deadline : kickoff;
  const { tt, tc } = turnFor(db, round);
  return {
    round,
    tt,
    tc,
    deadline: rs?.deadline ?? null,
    kickoff: kickoff.toISOString(),
    acceptance: acceptance.toISOString()
  };
}
