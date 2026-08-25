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
 *   - MAI elenchi nominativi di partecipanti: solo conteggi aggregati;
 *   - date in `it-IT` nel fuso iniettato (TIMEZONE): il sistema di gioco
 *     lavora su istanti UTC assoluti, il fuso conta solo qui (e nei log);
 *   - dati assenti → blocco OMESSO ("se un dato è assente, non inventarlo:
 *     ometti la frase"); chiusura fissa dell'eliminato ("Grazie per essere
 *     stato con noi!", mai riferimenti a canali inesistenti).
 *
 * Ordine dei blocchi (email v3; deadline in CODA per richiesta PO):
 * header → saluto → esito → messaggio chiave → narrativa →
 * partite/risultati → squadre già usate → stato → CTA → iscritti piattaforma
 * → chiusura eliminato → deadline (ultima, solo mail con pick). Blocchi con
 * dati assenti OMESSI; narrativa vuota → blocco omesso (mai testo inventato).
 */
import { formatItDate } from './templates.js';
import { championshipLabel, roundLabel } from '../game/turn.js';
import type { EmailContext, EmailType } from './generator.js';

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
    return `${roundLabel(ctx.round)} · ${championshipLabel(ctx.championshipRound)}`;
  }
  return null;
}

/**
 * Esito (✅/❌) per le mail di esito round, come riga singola senza riquadro
 * (email v3: il vecchio `resultBox` diventa una sezione). Testi esatti:
 *   - corretto → "✅ SEI ANCORA IN GARA!"
 *   - sbagliato → "❌ SEI STATO ELIMINATO!"
 *   - mancante → "❌ SEI STATO ELIMINATO!"
 * I dettagli (squadra/esito/punteggio) restano alla narrativa, non qui.
 */
function resultLine(ctx: EmailContext): string | null {
  if (ctx.type === 'round_result_correct') return '✅ SEI ANCORA IN GARA!';
  if (ctx.type === 'round_result_wrong') return '❌ SEI STATO ELIMINATO!';
  if (ctx.type === 'pick_missing_elimination') return '❌ SEI STATO ELIMINATO!';
  return null;
}

/**
 * Messaggio chiave deterministico per le mail di CONFERMA pick (email v3):
 * "PICK REGISTRATO → {TEAM} → {ESITO}" con squadra ed esito in MAIUSCOLO;
 * dati assenti → forma generica "PICK REGISTRATO" (mai inventare nulla).
 */
function pickConfirmedKey(ctx: EmailContext): string {
  const team = ctx.team;
  const esito = outcomeItalian(ctx.outcome);
  if (team !== undefined && team !== '' && esito !== null) {
    return `PICK REGISTRATO → ${team.toUpperCase()} → ${esito.toUpperCase()}`;
  }
  return 'PICK REGISTRATO';
}

/**
 * Messaggio chiave deterministico per tipo, in MAIUSCOLO (email v3):
 * l'equivalente plain-text del "grassetto +20%". Le mail di ESITO round
 * NON hanno `keyMessage`: usano l'esito ✅/❌ di `resultLine` (separato).
 */
function keyMessage(ctx: EmailContext): string | null {
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
      return pickConfirmedKey(ctx);
    case 'pick_rejected':
      return `PICK NON REGISTRATO: ${ctx.reason ?? ''}`;
    case 'pick_postponed':
      return '⏸ PARTITA RINVIATA';
    case 'round_closed_survived':
      return 'ROUND CHIUSO: SEI ANCORA IN GARA!';
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
 * dopo il saluto (output dei 16 template del piano email v3).
 */
const MESSAGE_BLANK_BEFORE_TYPES: readonly EmailType[] = ['pick_postponed', 'round_closed_survived'];

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
function ctaFor(ctx: EmailContext): string | null {
  switch (ctx.type) {
    case 'pick_instructions':
      return section('➡️ COSA FARE ORA', [
        'Rispondi a questa email con squadra + esito prima della scadenza.'
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
 * Compone il corpo completo dell'email (deterministico, email v3). Ordine:
 * header → saluto (nome se noto) → esito (mail di esito, subito dopo il
 * saluto) → deadline (mail con pick, elemento n.1) → messaggio chiave →
 * narrativa → partite/risultati → squadre già usate → stato → CTA → iscritti
 * piattaforma → chiusura eliminato. Blocchi con dati assenti OMESSI.
 * `narrative` è il testo dell'LLM/del generatore deterministico: se vuota
 * dopo il trim, il blocco è omesso (mai testo inventato).
 */
export function renderEmailV2(ctx: EmailContext, narrative: string, timeZone: string): string {
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
  const result = resultLine(ctx);
  if (result !== null) segments.push({ text: result, blankBefore: true });

  // Messaggio chiave + narrativa (righe consecutive; riga vuota prima SOLO per
  // i tipi di notifica autonoma — la deadline è in coda, non più qui).
  const message: string[] = [];
  const key = keyMessage(ctx);
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
  const burned = burnedSection(ctx);
  if (burned !== null) segments.push({ text: burned, blankBefore: true });
  const state = stateSection(ctx);
  if (state !== null) segments.push({ text: state, blankBefore: true });
  const cta = ctaFor(ctx);
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
