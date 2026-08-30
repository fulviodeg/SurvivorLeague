/**
 * Renderer deterministico del CANALE EMAIL (email v3: testo strutturato
 * plain-text, NIENTE riquadri ASCII e NIENTE HTML).
 *
 * Principio architetturale (ADR-011, LLD §6.4): la RESA appartiene al
 * CANALE, i DATI di notifica (`EmailContext`) sono canale-agnostici. Il Game
 * Engine compone SOLO dati e chiama `generator.generate`: questo renderer
 * impagina deterministicamente — header (coppia umana "Round N · Turno di
 * campionato M"), messaggio chiave `keyMessage(ctx)` in MAIUSCOLO (l'equivalente
 * plain-text del "grassetto"), sezioni a righe con titolo emoji + MAIUSCOLO
 * (esito ✅/❌, deadline+countdown, partite/risultati, squadre già usate,
 * stato aggregato), CTA per tipo e chiusura — attorno alla narrativa prodotta
 * dall'LLM o dal generatore deterministico (ADR-004: l'LLM è confinato
 * all'I/O e produce SOLO il testo narrativo). Un futuro WebAdapter riusa gli
 * stessi dati con un renderer dedicato, senza toccare il Game Engine.
 *
 * Vincoli implementati (email v3):
 *   - NESSUN carattere di riquadro (`╔ ═ ╗ ║ ╚ ─`): ogni "box" è diventato
 *     una sezione a righe con titolo emoji + MAIUSCOLO;
 *   - deadline = ULTIMO elemento nelle mail che richiedono un pick (richiesta
 *     PO: "quanto manca alla deadline" scritto per ultimo, non per primo), con
 *     countdown calcolato DAL SISTEMA (`formatRemaining` nel Game Engine, mai
 *     dall'LLM e mai dal clock qui: il renderer è PURO, RNF1); data e countdown
 *     sulla STESSA riga, separati da " · ";
 *   - esito (✅/❌) subito dopo il saluto nelle mail di esito;
 *   - `keyMessage(ctx)` deterministico per tipo, in MAIUSCOLO;
 *   - MAI elenchi nominativi di partecipanti: solo conteggi aggregati — ad
 *     eccezione dei due tipi retrospettivi `round_closed_survived` e
 *     `tournament_closed` (ADR-015 email v4, carve-out esplicito: elenco
 *     nominativo opt-in via il campo `players`, mai nelle mail di istruzione,
 *     pick o esito);
 *   - date in `it-IT` nel fuso iniettato (TIMEZONE): il sistema di gioco
 *     lavora su istanti UTC assoluti, il fuso conta solo qui (e nei log);
 *   - dati assenti → blocco OMESSO ("se un dato è assente, non inventarlo:
 *     ometti la frase"); chiusura fissa dell'eliminato ("Grazie per essere
 *     stato con noi!", mai riferimenti a canali inesistenti).
 *
 * Ordine dei blocchi (email v3 + v4; deadline in CODA per richiesta PO):
 * header → saluto → esito → messaggio chiave → narrativa →
 * partite/risultati → elenco giocatori (solo `round_closed_survived`/
 * `tournament_closed`) → squadre già usate → stato → storico torneo (solo
 * `tournament_closed`) → co-vincitori (solo `tournament_shared_win`) → CTA →
 * iscritti piattaforma → chiusura eliminato → deadline (ultima, solo mail con
 * pick). Blocchi con dati assenti OMESSI; narrativa vuota → blocco omesso
 * (mai testo inventato).
 */
import { formatItDate } from './templates.js';
import { championshipHeaderLabel, roundHeaderLabel, roundLabel } from '../game/turn.js';
import type { EmailContext, EmailPlayerResult, EmailType } from './generator.js';

/** Esito pick in italiano (dati iniettati, mai generati). */
function outcomeItalian(outcome: string | undefined): string | null {
  if (outcome === 'win') return 'vittoria';
  if (outcome === 'draw') return 'pareggio';
  if (outcome === 'lose') return 'sconfitta';
  return null;
}

/** Sezione con titolo (emoji + MAIUSCOLO) e righe di contenuto. */
function section(title: string, lines: string[]): string {
  return [title, ...lines].join('\n');
}

/** Header della mail: coppia umana se presente; altrimenti null (il brand è nel separatore di sistema). */
function header(ctx: EmailContext): string | null {
  if (ctx.round !== undefined && ctx.championshipRound !== undefined) {
    return `${roundHeaderLabel(ctx.round)} · ${championshipHeaderLabel(ctx.championshipRound)}`;
  }
  return null;
}

/**
 * Esito (✅/❌) per le mail di esito round, come riga singola senza riquadro
 * (email v3: il vecchio `resultBox` diventa una sezione). Testi esatti:
 *   - corretto → "✅ SEI ANCORA IN GARA!"
 *   - sbagliato → "❌ SEI STATO ELIMINATO!"
 *   - mancante → "❌ SEI STATO ELIMINATO!"
 * In modalità `win_only` (ADR-016), per gli esiti CON pick (`round_result_correct`
 * e `round_result_wrong`) subito dopo l'esito è mostrato il pick del giocatore
 * ("⚽ il tuo Pick: {TEAM} ⚽", squadra in MAIUSCOLO): in win_only l'esito non
 * distingue win/draw/lose, quindi mostrare il pick rende esplicita la scelta.
 * `pick_missing_elimination` non ha un pick e non riceve questa riga.
 */
function resultLine(ctx: EmailContext, winOnly: boolean): string | null {
  let base: string | null;
  if (ctx.type === 'round_result_correct') base = '✅ SEI ANCORA IN GARA!';
  else if (ctx.type === 'round_result_wrong') base = '❌ SEI STATO ELIMINATO!';
  else if (ctx.type === 'pick_missing_elimination') base = '❌ SEI STATO ELIMINATO!';
  else return null;

  const team = ctx.team;
  if (
    winOnly &&
    (ctx.type === 'round_result_correct' || ctx.type === 'round_result_wrong') &&
    team !== undefined &&
    team !== ''
  ) {
    return `${base}\n⚽ il tuo Pick: ${team.toUpperCase()} ⚽`;
  }
  return base;
}

/**
 * Messaggio chiave deterministico per le mail di CONFERMA pick (email v3):
 * classica "PICK REGISTRATO → {TEAM} → {ESITO}" con squadra ed esito in
 * MAIUSCOLO; win_only (ADR-016) "PICK REGISTRATO → {TEAM}" SENZA esito
 * (l'outcome è sempre 'win', mostrarlo non aggiunge nulla). Dati assenti →
 * forma generica "PICK REGISTRATO" (mai inventare nulla).
 */
function pickConfirmedKey(ctx: EmailContext, winOnly: boolean): string {
  const team = ctx.team;
  if (team !== undefined && team !== '') {
    if (winOnly) return `PICK REGISTRATO → ${team.toUpperCase()}`;
    const esito = outcomeItalian(ctx.outcome);
    if (esito !== null) return `PICK REGISTRATO → ${team.toUpperCase()} → ${esito.toUpperCase()}`;
  }
  return 'PICK REGISTRATO';
}

/**
 * Messaggio chiave deterministico per tipo, in MAIUSCOLO (email v3):
 * l'equivalente plain-text del "grassetto +20%". Le mail di ESITO round
 * NON hanno `keyMessage`: usano l'esito ✅/❌ di `resultLine` (separato).
 */
function keyMessage(ctx: EmailContext, winOnly: boolean): string | null {
  switch (ctx.type) {
    case 'platform_registered':
      return 'ISCRIZIONE CONFERMATA: SEI IN PIATTAFORMA!';
    case 'platform_unsubscribe_confirm':
      return 'CONFERMA LA DISISCRIZIONE?';
    case 'platform_unsubscribed':
      return 'DISISCRIZIONE COMPLETATA';
    case 'platform_already_registered':
      return 'SEI GIÀ ISCRITTO: NON SERVE RE-ISCRIVERTI.';
    case 'tournament_open':
      return '🏆 TORNEO APERTO!';
    case 'pick_instructions':
      return 'ROUND APERTO: INVIA IL TUO PICK!';
    case 'pick_confirmed':
      return pickConfirmedKey(ctx, winOnly);
    case 'pick_rejected':
      return `PICK NON REGISTRATO: ${ctx.reason ?? ''}`;
    case 'pick_auto_assigned':
      // Feature AUTOPICK (D8): conferma a posteriori, squadra in MAIUSCOLO
      // (come pick_confirmed). Nessuna sezione deadline/countdown (post-deadline).
      return ctx.team !== undefined && ctx.team !== ''
        ? `PICK AUTO ASSEGNATO → ${ctx.team.toUpperCase()}`
        : 'PICK AUTO ASSEGNATO';
    case 'pick_postponed':
      return '⏸ PARTITA RINVIATA';
    case 'round_closed_survived':
      return 'ROUND CHIUSO: SEI ANCORA IN GARA!';
    case 'tournament_closed':
      return '🏆 TORNEO CONCLUSO!';
    case 'tournament_won':
      return '🏆 HAI VINTO IL TORNEO!';
    case 'tournament_shared_win':
      return '🏆 VITTORIA CONDIVISA!';
    case 'clarification':
      return 'NON HO CAPITO LA TUA RICHIESTA';
    default:
      return null;
  }
}

/** Tipi di email che richiedono un pick: la deadline è l'elemento n.1. */
const PICK_EMAIL_TYPES: readonly EmailType[] = [
  'pick_instructions',
  'pick_confirmed',
  'pick_rejected',
  'clarification'
];

/**
 * Tipi il cui messaggio chiave è separato dal saluto da una riga vuota (email
 * di notifica "autonoma" sul round, con sezioni dati a seguire). Le email di
 * piattaforma e di vittoria, invece, fanno fluire il messaggio chiave subito
 * dopo il saluto (output dei 17 template del piano email v3/v4).
 */
const MESSAGE_BLANK_BEFORE_TYPES: readonly EmailType[] = [
  'pick_postponed',
  'round_closed_survived',
  'tournament_closed'
];

/**
 * Sezione deadline (email v3): data nel fuso iniettato + countdown
 * pre-calcolato dal Game Engine (`deadlineRemaining`, mai dal clock né
 * dall'LLM) sulla STESSA riga, separati da " · " ("Mancano circa …").
 */
function deadlineSection(ctx: EmailContext, timeZone: string): string | null {
  if (!PICK_EMAIL_TYPES.includes(ctx.type) || ctx.deadline === undefined) return null;
  let line = formatItDate(ctx.deadline, timeZone);
  if (ctx.deadlineRemaining !== undefined && ctx.deadlineRemaining !== '') {
    line += ` · Mancano circa ${ctx.deadlineRemaining}`;
  }
  return `⏰ DEADLINE PICK\n${line}`;
}

/** Sezione squadre già usate (email v3): squadra + round di utilizzo "(Round N)". */
function burnedSection(ctx: EmailContext): string | null {
  if (ctx.type !== 'pick_instructions' || ctx.burnedTeams === undefined || ctx.burnedTeams.length === 0) {
    return null;
  }
  return `🔒 SQUADRE GIÀ USATE\n${ctx.burnedTeams
    .map((b) => `${b.team} (${roundLabel(b.round)})`)
    .join('\n')}`;
}

/**
 * Sezione partite/risultati del round (dati iniettati; mai inventati).
 * Titolo dipendente dal contenuto: "⚽ RISULTATI DEL ROUND" quando ci sono
 * punteggi, altrimenti "⚽ PARTITE DEL ROUND" (partite in programma).
 */
function matchesSection(ctx: EmailContext): string | null {
  if (ctx.matches === undefined || ctx.matches.length === 0) return null;
  const hasScore = ctx.matches.some((m) => m.score !== undefined);
  const title = hasScore ? '⚽ RISULTATI DEL ROUND' : '⚽ PARTITE DEL ROUND';
  const lines = ctx.matches.map((m) => {
    if (m.score !== undefined) return `${m.home} - ${m.away}: ${m.score.home}-${m.score.away}`;
    if (m.postponed === true) return `${m.home} - ${m.away} (rinviata)`;
    return `${m.home} - ${m.away}`;
  });
  return section(title, lines);
}

/**
 * Riga di un giocatore in un elenco nominativo (ADR-015 email v4, carve-out
 * della convenzione 6 per i SOLI tipi retrospettivi `round_closed_survived` e
 * `tournament_closed`): con pick "{nome} — {squadra} · {esito} — {esito}",
 * senza pick "{nome} — nessun pick — ❌ eliminato". Esito/eliminazione dai
 * DATI iniettati (mai inventati); l'esito è in italiano via `outcomeItalian`.
 */
function playerResultRow(p: EmailPlayerResult, winOnly: boolean): string {
  const status = p.eliminated ? '❌ eliminato' : '✅ ancora in gara';
  // Feature AUTOPICK (D9): marcatore in CODA alla riga quando il pick è stato
  // auto-assegnato — vale per `round_closed_survived` e `tournament_closed`
  // (riusano entrambe playerResultRow), senza parametro per distinguerle.
  const autoMarker = p.autoPick === true ? ' · 🤖 Auto-assegnato' : '';
  if (p.team !== undefined && p.team !== '') {
    const outcome = outcomeItalian(p.outcome);
    if (!winOnly && outcome !== null) {
      return `${p.name} — ${p.team} · ${outcome} — ${status}${autoMarker}`;
    }
    // ADR-016 (win_only): l'outcome è sempre 'win' — mostrare "· vittoria"
    // accanto a "❌ eliminato" è fuorviante, quindi la riga omette l'esito.
    // Vale anche per lo storico `tournament_closed` (riusa playerResultRow).
    return `${p.name} — ${p.team} — ${status}${autoMarker}`;
  }
  return `${p.name} — nessun pick — ❌ eliminato`;
}

/**
 * Sezione elenco giocatori del round (ADR-015 email v4): resa SOLO se
 * `ctx.players` è presente (opt-in del Game Engine per `round_closed_survived`
 * e — riusata — per lo storico di `tournament_closed`). Le altre mail restano
 * sui soli conteggi aggregati di `stateSection` (convenzione 6).
 */
function playersSection(ctx: EmailContext, winOnly: boolean): string | null {
  if (ctx.players === undefined || ctx.players.length === 0) return null;
  return section('👥 GIOCATORI DEL ROUND', ctx.players.map((p) => playerResultRow(p, winOnly)));
}

/**
 * Sezione co-vincitori (ADR-015 email v4): resa SOLO se `ctx.coWinners` è
 * presente (nomi degli ALTRI vincitori, escluso il destinatario), per
 * `tournament_shared_win` — `tournament_won` (vittoria unica) non la riceve.
 */
function coWinnersSection(ctx: EmailContext): string | null {
  if (ctx.coWinners === undefined || ctx.coWinners.length === 0) return null;
  return section('🤝 HAI CONDIVISO LA VITTORIA CON', ctx.coWinners);
}

/**
 * Sezione storico del torneo (ADR-015 email v4): per ogni round della finestra
 * giocata, la riga "Round del torneo N · Turno di Campionato M" seguita dalle
 * righe giocatore (stesso formato di `playerResultRow`). Resa SOLO se
 * `ctx.tournamentHistory` è presente (`tournament_closed`).
 */
function historySection(ctx: EmailContext, winOnly: boolean): string | null {
  if (ctx.tournamentHistory === undefined || ctx.tournamentHistory.length === 0) return null;
  const blocks = ctx.tournamentHistory.map(
    (r) =>
      [
        `${roundHeaderLabel(r.round)} · ${championshipHeaderLabel(r.championshipRound)}`,
        ...r.players.map((p) => playerResultRow(p, winOnly))
      ].join('\n')
  );
  return `📜 STORICO DEL TORNEO\n\n${blocks.join('\n\n')}`;
}

/**
 * Sezione stato aggregato (convenzione 6): SOLO conteggi, MAI elenchi
 * nominativi di partecipanti (scalabilità 50+ giocatori).
 * "In gara: N · Eliminati: X (Y pick sbagliati · Z senza pick)".
 */
function stateSection(ctx: EmailContext): string | null {
  if (ctx.inGameCount === undefined) return null;
  const eliminated = (ctx.eliminatedWrong ?? 0) + (ctx.eliminatedMissing ?? 0);
  const details: string[] = [];
  if (ctx.eliminatedWrong !== undefined && ctx.eliminatedWrong > 0) {
    details.push(`${ctx.eliminatedWrong} pick sbagliati`);
  }
  if (ctx.eliminatedMissing !== undefined && ctx.eliminatedMissing > 0) {
    details.push(`${ctx.eliminatedMissing} senza pick`);
  }
  const eliminatedText =
    details.length > 0 ? ` · Eliminati: ${eliminated} (${details.join(' · ')})` : '';
  return `📊 STATO DEL TORNEO\nIn gara: ${ctx.inGameCount}${eliminatedText}`;
}

/** Riferimento iscritti piattaforma (convenzione 8: "Iscritti alla piattaforma: N"). */
function platformCountLine(ctx: EmailContext): string | null {
  if (ctx.platformCount === undefined) return null;
  return `👥 Iscritti alla piattaforma: ${ctx.platformCount}`;
}

/**
 * Chiusura fissa dell'eliminato (convenzione 10): "Il torneo continua con N
 * giocatori in gara. Grazie per essere stato con noi!" — MAI "grazie per
 * averci giocato" (vincolo PO) né riferimenti a canali inesistenti.
 */
function eliminatedClosing(ctx: EmailContext): string | null {
  if (ctx.type !== 'round_result_wrong' && ctx.type !== 'pick_missing_elimination') return null;
  if (ctx.inGameCount === undefined) return null;
  return `Il torneo continua con ${ctx.inGameCount} giocatori in gara. Grazie per essere stato con noi!`;
}

/** CTA per tipo (deterministica, email v3): focus su eventi + prossimi passi. */
function ctaFor(ctx: EmailContext, winOnly: boolean): string | null {
  switch (ctx.type) {
    case 'pick_instructions':
      // ADR-016 (win_only): la CTA chiede solo la squadra vincente.
      return section('➡️ COSA FARE ORA', [
        winOnly
          ? 'Rispondi a questa email con il nome della squadra che vincerà prima della scadenza.'
          : 'Rispondi a questa email con squadra + esito prima della scadenza.'
      ]);
    case 'round_result_correct':
    case 'round_closed_survived':
      return section('📌 PROSSIMO PASSO', [
        'Le istruzioni per il prossimo pick arriveranno all\'apertura del prossimo round.'
      ]);
    case 'pick_postponed':
      return section('📌 PROSSIMO PASSO', ['Ti aggiorneremo appena la partita verrà giocata.']);
    case 'tournament_open':
      // Convenzione 8/correzione PO: SOLO annuncio, niente invito al pick né
      // date (non note all'invio: decide commissioner/scheduler).
      return section('⏳ COSA SUCCEDE ORA', [
        'Le istruzioni con la scadenza del pick arriveranno con una mail dedicata.'
      ]);
    case 'platform_registered':
      return section('➡️ COSA FARE ORA', [
        'Non serve altro: aspetta la mail di apertura del round.'
      ]);
    case 'tournament_won':
      return '🎉 Festeggia, te la sei meritata!';
    case 'tournament_shared_win':
      return '🎉 Festeggiate, ve lo siete meritato!';
    default:
      return null;
  }
}

/**
 * Compone il corpo completo dell'email (deterministico, email v3 + v4). Ordine:
 * header → saluto (nome se noto) → esito (mail di esito, subito dopo il
 * saluto) → messaggio chiave → narrativa → partite/risultati → elenco
 * giocatori (solo se `players`) → squadre già usate → stato → storico torneo
 * (solo se `tournamentHistory`) → co-vincitori (solo se `coWinners`) → CTA →
 * iscritti piattaforma → chiusura eliminato → deadline (ultima, solo mail con
 * pick). Blocchi con dati assenti OMESSI.
 * `narrative` è il testo dell'LLM/del generatore deterministico: se vuota
 * dopo il trim, il blocco è omesso (mai testo inventato).
 */
export function renderEmailV2(ctx: EmailContext, narrative: string, timeZone: string, winOnly = false): string {
  const segments: Array<{ text: string; blankBefore: boolean }> = [];

  // Saluto + header (righe consecutive, nessuna riga vuota interna).
  const greeting: string[] = [];
  const head = header(ctx);
  if (head !== null) greeting.push(head);
  if (ctx.playerName !== undefined && ctx.playerName !== '') {
    greeting.push(`Ciao ${ctx.playerName}!`);
  }
  if (greeting.length > 0) segments.push({ text: greeting.join('\n'), blankBefore: false });

  // Esito (mail di esito): riga vuota prima, poi l'esito.
  const result = resultLine(ctx, winOnly);
  if (result !== null) segments.push({ text: result, blankBefore: true });

  // Messaggio chiave + narrativa (righe consecutive; riga vuota prima SOLO per
  // i tipi di notifica autonoma — la deadline è in coda, non più qui).
  const message: string[] = [];
  const key = keyMessage(ctx, winOnly);
  if (key !== null) message.push(key);
  const trimmedNarrative = narrative.trim();
  if (trimmedNarrative !== '') message.push(trimmedNarrative);
  if (message.length > 0) {
    segments.push({
      text: message.join('\n'),
      blankBefore: MESSAGE_BLANK_BEFORE_TYPES.includes(ctx.type)
    });
  }

  const matches = matchesSection(ctx);
  if (matches !== null) segments.push({ text: matches, blankBefore: true });
  const players = playersSection(ctx, winOnly);
  if (players !== null) segments.push({ text: players, blankBefore: true });
  const burned = burnedSection(ctx);
  if (burned !== null) segments.push({ text: burned, blankBefore: true });
  const state = stateSection(ctx);
  if (state !== null) segments.push({ text: state, blankBefore: true });
  const history = historySection(ctx, winOnly);
  if (history !== null) segments.push({ text: history, blankBefore: true });
  const coWinners = coWinnersSection(ctx);
  if (coWinners !== null) segments.push({ text: coWinners, blankBefore: true });
  const cta = ctaFor(ctx, winOnly);
  if (cta !== null) segments.push({ text: cta, blankBefore: true });
  const count = platformCountLine(ctx);
  if (count !== null) segments.push({ text: count, blankBefore: true });
  const closing = eliminatedClosing(ctx);
  if (closing !== null) segments.push({ text: closing, blankBefore: true });

  // Deadline (mail con pick): ULTIMO blocco (richiesta PO).
  const deadline = deadlineSection(ctx, timeZone);
  if (deadline !== null) segments.push({ text: deadline, blankBefore: true });

  const out: string[] = [];
  for (const segment of segments) {
    if (segment.blankBefore && out.length > 0) out.push('');
    out.push(segment.text);
  }
  return out.join('\n');
}
