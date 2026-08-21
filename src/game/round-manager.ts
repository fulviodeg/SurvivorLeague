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
 *     All'apertura del SOLO TT 1 notifica anche gli account piattaforma
 *     `active` senza profilo (amendment RF-P6, 2026-08-21). Errore se il
 *     round è già aperto o in stato non riapribile.
 *   - `round:close`  — CONSOLIDA: elimina i profili attivi senza pick
 *     (`missing_pick`), notifica, `closed_at`, status `closed`. Con `--force`
 *     richiede `--reason` (audit obbligatorio, RF-29): stessa identica
 *     semantica di consolidamento — non esiste "chiudi senza eliminare".
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

import { subjectFor, type EmailContext } from '../llm/generator.js';
import type { GameContext } from './context.js';
import { eliminate } from './elimination.js';
import { computeDeadline, computeTcClose } from './round-time.js';
import { getAvailableTeams, pickOutcomeFor } from './rules.js';
import { turnFor } from './turn.js';

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
}

/** Profilo attivo con email e nome (per le notifiche). */
interface ActiveProfile {
  id: number;
  email: string;
  playerName: string;
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
  /**
   * Registrati alla piattaforma SENZA profilo notificati all'apertura del
   * TT 1 (amendment RF-P6, 2026-08-21): 0 per i round successivi o senza
   * registry nel contesto.
   */
  registeredNotified: number;
}

/** Esito di `round:close`. */
export interface RoundCloseResult {
  round: number;
  tt: number;
  tc: number;
  status: 'closed';
  /** Profili eliminati per pick mancante in questa chiusura. */
  eliminatedMissing: number[];
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

/** Profili attivi (eliminated = 0) con email e nome, per le notifiche. */
function getActiveProfiles(db: Database.Database): ActiveProfile[] {
  return db
    .prepare(
      `SELECT p.id, COALESCE(pl.email, '') AS email, COALESCE(pl.name, '') AS playerName
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
 * `subjectFor` (D1, RF-25).
 */
async function notify(ctx: GameContext, to: string, emailCtx: EmailContext): Promise<boolean> {
  if (ctx.channel === undefined || ctx.generator === undefined) return false;
  if (!isAccountActive(ctx, to)) return false;
  const body = await ctx.generator.generate(emailCtx);
  await ctx.channel.sendMessage(to, body, subjectFor(emailCtx));
  return true;
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

  const existing = getRoundState(db, round);
  if (existing !== undefined && existing.status !== 'pending') {
    throw new Error(
      `Il round ${round} esiste già in stato '${existing.status}': non riapribile con round:open`
    );
  }

  // Deadline fissa: kickoff effettivo (MIN match_date dei non rinviati) − anticipo.
  const kickoff = await dataProvider.getFirstMatchDateTime(round);
  const deadline = computeDeadline(kickoff, config.DEADLINE_ADVANCE_MIN);
  if (existing === undefined) {
    db.prepare(
      "INSERT INTO round_state (round, status, deadline, opened_at) VALUES (?, 'open', ?, ?)"
    ).run(round, deadline.toISOString(), now.toISOString());
  } else {
    db.prepare(
      "UPDATE round_state SET status = 'open', deadline = ?, opened_at = ? WHERE round = ?"
    ).run(deadline.toISOString(), now.toISOString(), round);
  }

  const { tt, tc } = turnFor(db, round);

  // Email pick ai profili attivi: solo squadre disponibili del profilo
  // (decisione 12). Le email dei profili attivi finiscono in un Set
  // normalizzato lowercase: serve da dedup per il blocco RF-P6 che segue
  // (un iscritto con profilo non deve ricevere una seconda email).
  const active = getActiveProfiles(db);
  const notifiedEmails = new Set<string>();
  let notified = 0;
  for (const profile of active) {
    notifiedEmails.add(profile.email.toLowerCase());
    const availableTeams = await getAvailableTeams(db, dataProvider, profile.id, round);
    const sent = await notify(ctx, profile.email, {
      type: 'pick_instructions',
      playerName: profile.playerName,
      tt,
      tc,
      availableTeams,
      deadline
    });
    if (sent) notified += 1;
  }

  // Amendment RF-P6 (decisione 2026-08-21): all'apertura del SOLO TT 1
  // l'email pick_instructions va anche agli account piattaforma `active`
  // che NON hanno ancora un profilo (i profili nascono con l'auto-join al
  // primo pick, RF-P5): senza questo blocco un iscritto senza profilo non
  // verrebbe MAI informato dell'apertura del round 1 (UAT del 21/08). Dal
  // round 2 in poi il blocco è saltato (tt !== 1): i partecipanti sono
  // già profili e il loop qui sopra li copre. Le squadre in giornata sono
  // calcolate UNA volta per l'intero blocco (stessa fonte di
  // getAvailableTeams, ma senza profilo non esistono bruciate) e ordinate
  // come getTeams() per output deterministico. `playerName` è omesso: un
  // account piattaforma senza profilo non ha nome (il template omette i
  // dati assenti). Il filtro sullo stato `active` resta dentro `notify`
  // (isAccountActive, fail-closed); senza registry iniettato
  // (ctx.platform undefined, es. simulazione o chiamante senza registry)
  // il blocco è saltato: nessun crash, coerenza col test "senza registry
  // → nessuna email". Senza channel/generator `notify` è no-op e il
  // conteggio resta 0.
  let registeredNotified = 0;
  if (tt === 1 && ctx.platform !== undefined) {
    const matches = await dataProvider.getMatchesForRound(round);
    const inRound = new Set(matches.flatMap((m) => [m.homeTeam, m.awayTeam]));
    const inRoundTeams = (await dataProvider.getTeams()).filter((team) => inRound.has(team));
    for (const email of ctx.platform.activeEmails()) {
      // Dedup: l'account ha già ricevuto la mail del loop profili.
      if (notifiedEmails.has(email.toLowerCase())) continue;
      const sent = await notify(ctx, email, {
        type: 'pick_instructions',
        tt,
        tc,
        availableTeams: inRoundTeams,
        deadline
      });
      if (sent) registeredNotified += 1;
    }
  }

  return { round, tt, tc, status: 'open', deadline: deadline.toISOString(), notified, registeredNotified };
}

/**
 * Chiude un round consolidando: elimina i profili attivi senza pick
 * (`missing_pick`), li notifica e marca `closed`. Con `force` richiede
 * `reason` (RF-29: audit obbligatorio); la semantica è IDENTICA alla chiusura
 * a deadline — non esiste "chiudi senza eliminare". Idempotente su round già
 * `closed` (ri-consolida senza effetti: gli eliminati restano tali).
 */
export async function closeRound(
  ctx: GameContext,
  round: number,
  opts: { force?: boolean; reason?: string } = {}
): Promise<RoundCloseResult> {
  const { db, now } = ctx;

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

  // Consolidamento: profili attivi SENZA pick per questo round → missing_pick.
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
  for (const profile of missing) {
    eliminate(db, profile.id, 'missing_pick', now);
    eliminatedMissing.push(profile.id);
    await notify(ctx, profile.email, {
      type: 'pick_missing_elimination',
      playerName: profile.playerName,
      tt,
      tc
    });
  }

  if (rs.status !== 'closed') {
    db.prepare("UPDATE round_state SET status = 'closed', closed_at = ? WHERE round = ?").run(
      now.toISOString(),
      round
    );
  }

  return {
    round,
    tt,
    tc,
    status: 'closed',
    eliminatedMissing,
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

  const matches = await dataProvider.getMatchesForRound(round);
  const tcClose = computeTcClose(matches, config.MATCH_DURATION_MIN, config.TC_CLOSE_SKEW_MIN);
  const { tt, tc } = turnFor(db, round);

  const evaluated: ScoredPick[] = [];
  const newlyFrozen: number[] = [];
  const newlyEliminated: number[] = [];

  /** Valuta un pick contro il match della sua squadra (a punteggio noto). */
  const evaluatePick = async (pick: PickRow): Promise<void> => {
    const match = matches.find((m) => m.homeTeam === pick.team || m.awayTeam === pick.team);
    if (match === undefined) return; // non dovrebbe accadere (validato alla registrazione)
    if (match.homeScore === undefined || match.awayScore === undefined) return;
    const actual = pickOutcomeFor(pick.team, match);
    const result = actual === pick.outcome ? 'correct' : 'wrong';
    db.prepare('UPDATE pick SET status = ? WHERE id = ?').run(result, pick.id);
    evaluated.push({ profileId: pick.profile_id, team: pick.team, outcome: pick.outcome, result });

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
    if (profile !== undefined) {
      await notify(ctx, profile.email, {
        type: result === 'correct' ? 'round_result_correct' : 'round_result_wrong',
        playerName: profile.playerName,
        tt,
        tc,
        team: pick.team,
        outcome: pick.outcome
      });
    }
  };

  // 1) Pick PENDING del round.
  const pending = db
    .prepare("SELECT id, profile_id, round, team, outcome, status FROM pick WHERE round = ? AND status = 'pending' ORDER BY id")
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
      if (profile !== undefined) {
        await notify(ctx, profile.email, {
          type: 'pick_postponed',
          playerName: profile.playerName,
          tt,
          tc,
          team: pick.team
        });
      }
    }
    // Altrimenti (in corso / rinviata entro la finestra) resta pending (CL7).
  }

  // 2) Pick FROZEN la cui partita ORA ha punteggio (recupero concluso):
  //    valutazione a posteriori, anche su round già scored (LLD §1.4).
  const frozen = db
    .prepare("SELECT id, profile_id, round, team, outcome, status FROM pick WHERE round = ? AND status = 'frozen' ORDER BY id")
    .all(round) as unknown as PickRow[];
  for (const pick of frozen) {
    await evaluatePick(pick);
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
    const survivors = getActiveProfiles(db);
    for (const survivor of survivors) {
      try {
        await notify(ctx, survivor.email, {
          type: 'round_closed_survived',
          playerName: survivor.playerName,
          tt,
          tc
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

  return { round, tt, tc, status, evaluated, newlyFrozen, newlyEliminated };
}

/** Stato di un round (sola lettura) con coppia TT/TC e conteggi pick. */
export function roundStatus(ctx: GameContext, round: number): RoundStatusResult {
  const { db } = ctx;
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
