/**
 * Torneo — vista aggregata (LLD §7.10, PRD US6/US8; piano Task 4.1).
 *
 * Ruolo: avvio della stagione e viste aggregate del torneo. Modulo di SOLA
 * ORCHESTRAZIONE e lettura: le regole di gioco restano nei moduli dedicati
 * (round manager, pick processor, winner). Usa `round_state`,
 * `tournament_state` e i moduli esistenti — nessuna logica di gioco duplicata.
 *
 * `tournament:start` (US6/RF-20/RF-21):
 *   - verifica il calendario (presente/completo/coerente) e l'aggancio
 *     `--start-round <n>` (default 1, ADR-008): TC esistente, con partite,
 *     deadline del TT 1 FUTURA (RF-21) — rifiuto ATOMICO senza stato parziale;
 *   - aggancio all'ultimo TC → warning informativo (CL12: i tre casi di fine
 *     torneo collassano, RF-26);
 *   - inizializza le righe `round_state` della finestra `[start_round..N]` in
 *     stato `pending` (LLD §7.10) e la riga `tournament_state` con
 *     `season_started=1` e `start_round`. La colonna `registration_open` è
 *     DEPRECATA (ADR-009, B8a): non esiste più una finestra di iscrizione,
 *     resta nello schema solo per compatibilità e NON viene più scritta
 *     (vale sempre il default 0).
 *   - `allowPastDeadline` è una SEAM per la simulazione su dati storici
 *     (Task 7.1): in produzione il vincolo RF-21 resta sempre attivo.
 *   - ADR-011 (§5.5): `tournament:start` è RIAMMISSIBILE se il torneo
 *     precedente è chiuso a tutti gli effetti (`winner_notified = 1`): la
 *     transazione di inizializzazione azzera atomicamente il DB di GIOCO
 *     (pick/profile/player/round_state) e resetta tournament_state; il DB
 *     piattaforma resta intatto (ADR-009) e l'export automatico della
 *     chiusura è l'archivio del torneo precedente.
 *
 * Viste (sola lettura):
 *   - `tournament:status` — round corrente, profili attivi/eliminati,
 *     vincitore (via Winner Engine), anomalie (es. chiusure di sicurezza non
 *     applicabili: round `open` con deadline NULL, RF-30);
 *   - `tournament:history <email>` — storico pick del profilo con coppie TT/TC;
 *   - `tournament:leaderboard` — classifica dei profili ancora in gara
 *     (attivi ordinati per pick corretti, poi eliminati), con coppia TT/TC del
 *     round corrente;
 *   - `tournament:export` — dump JSON di tutte le tabelle + metadati (timestamp
 *     dal clock iniettato, parametri derivati, mappatura TT/TC): verifica del
 *     determinismo (RNF1), trasparenza, audit (decisione 6 del piano).
 */
import type Database from 'better-sqlite3';

import { subjectFor } from '../llm/generator.js';
import type { GameContext } from './context.js';
import { halfBoundary } from './rules.js';
import { autoJoinProfilesAtStart } from './registration.js';
import { getStartRound, ttFor, turnFor } from './turn.js';
import { checkWinner } from './winner.js';

/** Opzioni di avvio stagione. */
export interface StartTournamentOptions {
  /** TC di aggancio del torneo (default 1, RF-20/ADR-008). */
  startRound?: number;
  /**
   * Seam per la simulazione su dati storici: salta il vincolo RF-21
   * "deadline del TT 1 futura". Mai usato dai flussi reali.
   */
  allowPastDeadline?: boolean;
}

/** Esito di `tournament:start`. */
export interface StartTournamentResult {
  startRound: number;
  totalRounds: number;
  halfBoundary: number;
  /** Kickoff effettivo del TT 1 (ISO-8601). */
  tt1Kickoff: string;
  /** Deadline del TT 1 (kickoff − anticipo, ISO-8601). */
  tt1Deadline: string;
  /** Righe round_state inizializzate in stato pending. */
  initializedRounds: number;
  /** CL12: true se l'aggancio è all'ultimo TC (warning informativo). */
  lastRoundWarning: boolean;
  /**
   * Broadcast `tournament_open` (RF-P6, ADR-009): iscritti attivi notificati
   * (0 se canale/generatore/registry assenti nel contesto).
   */
  notified: number;
  /**
   * ADR-019: numero di profili creati dall'auto-join bulk a `tournament:start`
   * (account `active` con `tournament_auto_join = ON`).
   */
  autoJoined: number;
}

/** Riga `round_state` letta dal DB. */
interface RoundStateRow {
  round: number;
  status: string;
  deadline: string | null;
  opened_at: string | null;
  closed_at: string | null;
  scored_at: string | null;
}

/** Stato di `tournament:status`. */
export interface TournamentStatusResult {
  seasonStarted: boolean;
  startRound: number;
  totalRounds: number;
  halfBoundary: number;
  /** Iscritti ATTIVI della piattaforma (dal PlatformRegistry, RF-P6/ADR-009). */
  platformSubscribers: number;
  /** Round corrente: il primo `open` della finestra; altrimenti il prossimo `pending`. */
  currentRound: { tc: number; tt: number; status: string } | null;
  activeProfiles: number;
  eliminatedProfiles: number;
  /** Esito del Winner Engine (finished/winners/case). */
  winner: Awaited<ReturnType<typeof checkWinner>>;
  /**
   * ADR-011: chiusura AUTOMATICA del torneo — true se winner_notified = 1
   * (vincitori notificati, export archiviato, scheduler inibito);
   * `finishedAt` è l'istante di chiusura (ISO-8601, clock iniettato), null
   * finché il torneo non è chiuso.
   */
  closed: boolean;
  finishedAt: string | null;
  /** Anomalie rilevabili dallo stato (es. deadline mancante su round open, RF-30). */
  anomalies: Array<{ round: number; type: 'deadline_missing' }>;
}

/** Riga pick per history/leaderboard. */
interface PickRow {
  id: number;
  profile_id: number;
  round: number;
  team: string;
  outcome: string;
  status: string;
  created_at: string;
}

/** Storico di un profilo (`tournament:history`). */
export interface TournamentHistoryResult {
  profileId: number;
  email: string;
  name: string;
  eliminated: boolean;
  eliminatedAt: string | null;
  eliminatedReason: string | null;
  picks: Array<{
    id: number;
    round: number;
    tt: number;
    tc: number;
    team: string;
    outcome: string;
    status: string;
    createdAt: string;
  }>;
}

/** Voce della classifica (`tournament:leaderboard`). */
export interface LeaderboardEntry {
  profileId: number;
  email: string;
  name: string;
  active: boolean;
  picksCorrect: number;
  picksWrong: number;
  eliminatedReason: string | null;
}

/** Esito di `tournament:leaderboard`. */
export interface LeaderboardResult {
  currentTurn: { tt: number; tc: number } | null;
  entries: LeaderboardEntry[];
}

/** Esito di `tournament:export` (dump JSON rileggibile, decisione 6 del piano). */
export interface ExportResult {
  exportedAt: string;
  startRound: number;
  totalRounds: number;
  halfBoundary: number;
  /** Mappatura TT/TC della finestra `[start_round..N]` (RF-20/25). */
  turns: Array<{ tc: number; tt: number }>;
  tables: {
    player: unknown[];
    profile: unknown[];
    pick: unknown[];
    match: unknown[];
    round_state: unknown[];
    tournament_state: unknown[];
  };
}

/**
 * Nome del file di export automatico (UNICA fonte, PURO, nessun fs — ADR-011
 * §1.3): derivato dal clock iniettato (deterministico, RNF1: nessun RNG/UUID).
 * Il dedup `-N` su file esistente è gestito dal wiring di archiviazione
 * (src/cli/archive-wiring.ts), non qui.
 */
export function exportFilename(now: Date): string {
  return `tournament-export-${now.toISOString().replaceAll(':', '-')}.json`;
}

/**
 * Torneo CHIUSO a tutti gli effetti? (ADR-011, emendamento post-revisione):
 * legge `winner_notified = 1`. Gate di `round:open` (rifiuto) e di
 * `round:score` (tace sulle email di esito) — MEDIUM-1/2.
 */
export function isTournamentClosed(db: Database.Database): boolean {
  return getTournamentState(db)?.winner_notified === 1;
}

/**
 * Legge lo stato registrato del torneo (season_started/start_round/
 * registration_open/winner_notified/finished_at/export_path). Lettore
 * CONDIVISO (fix review 2026-08-23): esportato anche per `scheduler.ts` e
 * per il recupero export di `settleWinnerIfNeeded` (round-manager) — un solo
 * punto di lettura di `tournament_state`, mai copie divergenti.
 */
export function getTournamentState(db: Database.Database): {
  season_started: number;
  start_round: number | null;
  registration_open: number;
  winner_notified: number;
  finished_at: string | null;
  export_path: string | null;
  win_only: number;
  autopick_on_missing: number;
  jollies_per_player: number;
} | undefined {
  return db
    .prepare(
      'SELECT season_started, start_round, registration_open, winner_notified, finished_at, export_path, win_only, autopick_on_missing, jollies_per_player FROM tournament_state WHERE id = 1'
    )
    .get() as
    | {
        season_started: number;
        start_round: number | null;
        registration_open: number;
        winner_notified: number;
        finished_at: string | null;
        export_path: string | null;
        win_only: number;
        autopick_on_missing: number;
        jollies_per_player: number;
      }
    | undefined;
}

/** Legge le righe round_state della finestra, ordinate per round. */
function getRoundStates(db: Database.Database, startRound: number, totalRounds: number): RoundStateRow[] {
  return db
    .prepare(
      'SELECT round, status, deadline, opened_at, closed_at, scored_at FROM round_state WHERE round BETWEEN ? AND ? ORDER BY round'
    )
    .all(startRound, totalRounds) as unknown as RoundStateRow[];
}

/**
 * Avvia la stagione (US6/RF-21): validazioni PRIMA di qualsiasi scrittura, poi
 * una transazione che inizializza tournament_state e le righe round_state
 * pending. Su validazione fallita → errore e DB invariato (nessuno stato
 * parziale).
 */
export async function startTournament(
  ctx: GameContext,
  opts: StartTournamentOptions = {}
): Promise<StartTournamentResult> {
  const { db, dataProvider, config, now } = ctx;
  const startRound = opts.startRound ?? 1;

  const totalRounds = await dataProvider.getTotalRounds();
  if (totalRounds === 0) {
    throw new Error('Calendario assente: importa i dati della stagione (data:import) prima di avviare');
  }

  // RF-21: TC di aggancio esistente e con partite; calendario completo/coerente.
  if (startRound < 1 || startRound > totalRounds) {
    throw new Error(`TC di aggancio inesistente: --start-round ${startRound} fuori da 1..${totalRounds}`);
  }
  for (let r = startRound; r <= totalRounds; r++) {
    const matches = await dataProvider.getMatchesForRound(r);
    if (matches.length === 0) {
      throw new Error(`Calendario incompleto: il TC ${r} non ha partite`);
    }
  }

  // RF-21: deadline del TT 1 futura (kickoff effettivo − anticipo > adesso).
  const tt1Kickoff = await dataProvider.getFirstMatchDateTime(startRound);
  const tt1Deadline = new Date(
    tt1Kickoff.getTime() - config.DEADLINE_ADVANCE_MIN * 60_000
  );
  if (!opts.allowPastDeadline && tt1Deadline <= now) {
    throw new Error(
      `Deadline del TT 1 non futura (${tt1Deadline.toISOString()}): avvio rifiutato (RF-21)`
    );
  }

  // Già avviato / gioco iniziato → rifiuto pulito. ECCEZIONE ADR-011 (§5.5):
  // se il torneo precedente è CHIUSO a tutti gli effetti
  // (`winner_notified = 1`: vincitori notificati + export archiviato), il
  // riavvio è AMMESSO: la transazione di inizializzazione qui sotto azzera
  // il DB di GIOCO (pick/profile/player/round_state) e resetta
  // tournament_state per il nuovo torneo. Il DB PIATTAFORMA non viene mai
  // toccato (ADR-009: account e nomi sopravvivono ai reset del DB torneo);
  // l'export automatico della chiusura è l'archivio che rende sicuro il
  // reset. Senza torneo chiuso → rifiuto come oggi ("stagione già avviata").
  const state = getTournamentState(db);
  const isClosed = state?.winner_notified === 1;
  // HIGH-1 (riavvio sicuro, ADR-011 §5.5 emendamento post-revisione): un
  // torneo chiuso è RIAMMISSIBILE SOLO se l'export automatico è stato
  // archiviato (`export_path` non-null ⇒ file scritto, writeFileSync
  // sincrona): senza archivio il reset distruggerebbe l'unico storico del
  // torneo precedente → riavvio rifiutato.
  if (isClosed && (state?.export_path ?? null) === null) {
    throw new Error(
      'Torneo chiuso senza export archiviato: riavvio rifiutato (verifica TOURNAMENT_EXPORT_DIR)'
    );
  }
  if (state?.season_started === 1 && !isClosed) {
    throw new Error('Stagione già avviata');
  }
  const existingRounds = getRoundStates(db, startRound, totalRounds);
  const started = existingRounds.some((r) => r.status !== 'pending');
  if (started && !isClosed) {
    throw new Error('Il gioco è già iniziato: non posso avviare di nuovo la stagione');
  }

  // CL12: aggancio all'ultimo TC → warning informativo (i casi collassano, RF-26).
  const lastRoundWarning = startRound === totalRounds;

  // Scritture atomiche. `registration_open` NON è scritta (colonna DEPRECATA,
  // ADR-009, B8a): non esiste più una finestra di iscrizione da aprire, la
  // colonna resta al default 0 per compatibilità dello schema. ADR-011
  // (§5.5): su torneo chiuso il RESET del DB di gioco avviene nella STESSA
  // transazione dell'inizializzazione (atomico: mai un torneo a metà) e
  // azzera anche winner_notified/finished_at (nuovo torneo non chiuso).
  const init = db.transaction(() => {
    if (isClosed) {
      db.prepare('DELETE FROM pick').run();
      db.prepare('DELETE FROM profile').run();
      db.prepare('DELETE FROM player').run();
      db.prepare('DELETE FROM round_state').run();
    }
    // ADR-016: `win_only` è FISSATA qui a `tournament:start` (UNICA istruzione
    // UPSERT: copre sia l'avvio pulito sia il reset su torneo chiuso — in
    // quest'ultimo caso la colonna è riscritta dal valore .env corrente, così
    // un torneo nuovo può partire con una modalità diversa). Feature AUTOPICK:
    // `autopick_on_missing` è FISSATA nella STESSA istruzione (speculare a
    // win_only, un'unica sorgente di persistenza). Feature JOLLY:
    // `jollies_per_player` è FISSATA QUI come le altre chiavi di modalità.
    db.prepare(
      `INSERT INTO tournament_state (id, season_started, start_round, winner_notified, finished_at, export_path, win_only, autopick_on_missing, jollies_per_player)
       VALUES (1, 1, ?, 0, NULL, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET season_started = 1, start_round = excluded.start_round,
         winner_notified = 0, finished_at = NULL, export_path = NULL, win_only = excluded.win_only,
         autopick_on_missing = excluded.autopick_on_missing,
         jollies_per_player = excluded.jollies_per_player`
    ).run(
      startRound,
      config.WIN_ONLY ? 1 : 0,
      config.AUTOPICK_ON_MISSING ? 1 : 0,
      config.JOLLIES_PER_PLAYER
    );
    const insertPending = db.prepare(
      "INSERT INTO round_state (round, status) VALUES (?, 'pending')"
    );
    for (let r = startRound; r <= totalRounds; r++) {
      insertPending.run(r);
    }
  });
  init();

  // ADR-019 (D6/D11): auto-join bulk DOPO il reset su torneo chiuso e PRIMA
  // del broadcast — gli account `active` con `tournament_auto_join = ON`
  // nascono qui come profili (snapshot unico a `tournament:start`). Nessuna
  // transazione cross-DB: sola lettura della piattaforma, scrittura sul DB
  // torneo. No-op senza registry nel contesto (es. simulazione pre-registrazione).
  const autoJoined = autoJoinProfilesAtStart(ctx);

  // Broadcast `tournament_open` (RF-P6, ADR-009): DOPO le scritture atomiche e
  // l'auto-join, ai soli iscritti ATTIVI della piattaforma CON
  // `receive_tournament_start_notification = ON` (D9, ADR-019 — sostituisce
  // l'invito a una lista di contatti). ADR-011 (convenzione 8, correzione PO):
  // la mail è SOLO un annuncio — niente invito al pick né date (il
  // commissioner/scheduler decide quando aprire il round 1): "il round 1 parte
  // a breve". Il contesto porta solo il conteggio aggregato degli iscritti
  // alla piattaforma (MAI elenchi nominativi): `platformCount` resta il numero
  // di account ATTIVI (non dei destinatari), per preservare la semantica di
  // conteggio aggregato. No-op senza channel/generator/registry nel contesto
  // (es. simulazione, R1).
  let notified = 0;
  if (ctx.channel !== undefined && ctx.generator !== undefined && ctx.platform !== undefined) {
    const activeAccounts = ctx.platform.activeAccounts();
    const recipients = activeAccounts.filter((a) => a.receiveTournamentStartNotification);
    for (const account of recipients) {
      const body = await ctx.generator.generate({
        type: 'tournament_open',
        platformCount: activeAccounts.length
      });
      await ctx.channel.sendMessage(
        account.email,
        body,
        subjectFor({ type: 'tournament_open', platformCount: activeAccounts.length }, ctx.config.testMode)
      );
      notified += 1;
    }
  }

  return {
    startRound,
    totalRounds,
    halfBoundary: halfBoundary(totalRounds),
    tt1Kickoff: tt1Kickoff.toISOString(),
    tt1Deadline: tt1Deadline.toISOString(),
    initializedRounds: totalRounds - startRound + 1,
    lastRoundWarning,
    notified,
    autoJoined: autoJoined.length
  };
}

/** Stato aggregato del torneo (sola lettura, idempotente). */
export async function tournamentStatus(ctx: GameContext): Promise<TournamentStatusResult> {
  const { db, dataProvider } = ctx;
  const state = getTournamentState(db);
  const totalRounds = await dataProvider.getTotalRounds();
  const startRound = state?.start_round ?? 1;

  const rounds = getRoundStates(db, startRound, totalRounds);
  const current = rounds.find((r) => r.status === 'open') ?? rounds.find((r) => r.status === 'pending');
  const currentRound =
    current === undefined
      ? null
      : { tc: current.round, tt: ttFor(current.round, startRound), status: current.status };

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN eliminated = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN eliminated = 1 THEN 1 ELSE 0 END) AS eliminated
       FROM profile`
    )
    .get() as { active: number | null; eliminated: number | null };

  const anomalies = rounds
    .filter((r) => r.status === 'open' && r.deadline === null)
    .map((r) => ({ round: r.round, type: 'deadline_missing' as const }));

  return {
    seasonStarted: state?.season_started === 1,
    startRound,
    platformSubscribers: ctx.platform?.activeEmails().length ?? 0,
    totalRounds,
    halfBoundary: halfBoundary(totalRounds),
    currentRound,
    activeProfiles: counts.active ?? 0,
    eliminatedProfiles: counts.eliminated ?? 0,
    winner: await checkWinner(ctx),
    closed: state?.winner_notified === 1,
    finishedAt: state?.finished_at ?? null,
    anomalies
  };
}

/** Storico pick di un profilo con coppie TT/TC (sola lettura). */
export function tournamentHistory(
  ctx: GameContext,
  email: string
): TournamentHistoryResult | null {
  const { db } = ctx;
  const profile = db
    .prepare(
      `SELECT p.id, pl.email, COALESCE(pl.name, '') AS name, p.eliminated,
              p.eliminated_at, p.eliminated_reason
       FROM profile p JOIN player pl ON pl.id = p.player_id
       WHERE pl.email = ?`
    )
    .get(email) as
    | {
        id: number;
        email: string;
        name: string;
        eliminated: number;
        eliminated_at: string | null;
        eliminated_reason: string | null;
      }
    | undefined;
  if (profile === undefined) return null;

  const picks = db
    .prepare(
      'SELECT id, profile_id, round, team, outcome, status, created_at FROM pick WHERE profile_id = ? ORDER BY round'
    )
    .all(profile.id) as unknown as PickRow[];

  return {
    profileId: profile.id,
    email: profile.email,
    name: profile.name,
    eliminated: profile.eliminated === 1,
    eliminatedAt: profile.eliminated_at,
    eliminatedReason: profile.eliminated_reason,
    picks: picks.map((p) => {
      const { tt, tc } = turnFor(db, p.round);
      return {
        id: p.id,
        round: p.round,
        tt,
        tc,
        team: p.team,
        outcome: p.outcome,
        status: p.status,
        createdAt: p.created_at
      };
    })
  };
}

/**
 * Classifica: profili ancora in gara (attivi, ordinati per pick corretti
 * decrescenti poi id) seguiti dagli eliminati (per istante di eliminazione);
 * con la coppia TT/TC del round corrente (LLD §7.10).
 */
export function tournamentLeaderboard(ctx: GameContext): LeaderboardResult {
  const { db } = ctx;
  const startRound = getStartRound(db);
  const rounds = getRoundStates(db, startRound, Number.MAX_SAFE_INTEGER);
  const current = rounds.find((r) => r.status === 'open') ?? rounds.find((r) => r.status === 'pending');

  const rows = db
    .prepare(
      `SELECT p.id AS profileId, COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS name,
              p.eliminated, p.eliminated_reason AS eliminatedReason,
              (SELECT COUNT(*) FROM pick pk WHERE pk.profile_id = p.id AND pk.status = 'correct') AS picksCorrect,
              (SELECT COUNT(*) FROM pick pk WHERE pk.profile_id = p.id AND pk.status = 'wrong') AS picksWrong
       FROM profile p LEFT JOIN player pl ON pl.id = p.player_id`
    )
    .all() as unknown as Array<{
    profileId: number;
    email: string;
    name: string;
    eliminated: number;
    eliminatedReason: string | null;
    picksCorrect: number;
    picksWrong: number;
  }>;

  const entries: LeaderboardEntry[] = rows
    .map((r) => ({
      profileId: r.profileId,
      email: r.email,
      name: r.name,
      active: r.eliminated === 0,
      picksCorrect: r.picksCorrect,
      picksWrong: r.picksWrong,
      eliminatedReason: r.eliminatedReason
    }))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.active) return b.picksCorrect - a.picksCorrect || a.profileId - b.profileId;
      return a.profileId - b.profileId;
    });

  return {
    currentTurn:
      current === undefined ? null : { tt: ttFor(current.round, startRound), tc: current.round },
    entries
  };
}

/** Dump JSON di tutte le tabelle + metadati (determinismo RNF1, audit). */
export async function tournamentExport(ctx: GameContext): Promise<ExportResult> {
  const { db, dataProvider, now } = ctx;
  const totalRounds = await dataProvider.getTotalRounds();
  const startRound = getStartRound(db);

  const dump = (table: string): unknown[] =>
    db.prepare(`SELECT * FROM ${table}`).all() as unknown[];

  return {
    exportedAt: now.toISOString(),
    startRound,
    totalRounds,
    halfBoundary: halfBoundary(totalRounds),
    turns: Array.from({ length: totalRounds - startRound + 1 }, (_, i) => {
      const tc = startRound + i;
      return { tc, tt: ttFor(tc, startRound) };
    }),
    tables: {
      player: dump('player'),
      profile: dump('profile'),
      pick: dump('pick'),
      match: dump('match'),
      round_state: dump('round_state'),
      // `export_path` è ESCLUSO dal dump di tournament_state: è metadato
      // operativo auto-referenziale (il path filesystem di QUESTO archivio,
      // scritto SOLO DOPO l'archiviazione) e farebbe dipendere l'export da
      // TOURNAMENT_EXPORT_DIR, violando il determinismo RNF1 (due ambienti
      // diversi produrrebbero dump diversi). L'archivio contiene SOLO la
      // storia del torneo.
      tournament_state: db
        .prepare(
          'SELECT id, season_started, registration_open, start_round, registration_notified, winner_notified, finished_at, win_only, autopick_on_missing, jollies_per_player FROM tournament_state'
        )
        .all() as unknown[]
    }
  };
}
