/**
 * Renderer deterministico del CANALE EMAIL (ADR-011 "Email v2", opzione 2
 * approvata: testo strutturato plain-text con riquadri ASCII, NIENTE HTML).
 *
 * Principio architetturale (ADR-011, LLD §6.4): la RESA appartiene al
 * CANALE, i DATI di notifica (`EmailContext`) sono canale-agnostici. Il Game
 * Engine compone SOLO dati e chiama `generator.generate`: questo renderer
 * impagina deterministically — header (coppia umana "Round N · Turno di
 * campionato M"), box ASCII (esito, deadline+countdown, bruciate,
 * partite/risultati, stato aggregato), sezioni dati e CTA per tipo — attorno
 * alla narrativa prodotta dall'LLM (ADR-004: l'LLM è confinato all'I/O e
 * produce SOLO il testo narrativo). Un futuro WebAdapter riusa gli stessi
 * dati con un renderer dedicato, senza toccare il Game Engine.
 *
 * Vincoli implementati (convenzioni 1-11 approvate):
 *   - box deadline = elemento n.1 nelle mail che richiedono un pick, con
 *     countdown calcolato DAL SISTEMA (`formatRemaining` nel Game Engine,
 *     mai dall'LLM e mai dal clock qui: il renderer è PURO, RNF1);
 *   - box esito subito dopo l'header nelle mail di esito (✅/❌);
 *   - MAI elenchi nominativi di partecipanti: solo conteggi aggregati;
 *   - date in `it-IT` nel fuso iniettato (TIMEZONE): il sistema di gioco
 *     lavora su istanti UTC assoluti, il fuso conta solo qui (e nei log);
 *   - dati assenti → blocco OMESSO ("se un dato è assente, non inventarlo:
 *     ometti la frase"); chiusura fissa dell'eliminato ("Grazie per essere
 *     stato con noi!", mai riferimenti a canali inesistenti).
 */
import { UNSUBSCRIBE_CONFIRM_WORDS, formatItDate } from './templates.js';
import { championshipLabel, roundLabel } from '../game/turn.js';
import type { EmailContext, EmailType } from './generator.js';

/** Esito pick in italiano per i box di esito (dati iniettati, mai generati). */
function outcomeItalian(outcome: string | undefined): string | null {
  if (outcome === 'win') return 'vittoria';
  if (outcome === 'draw') return 'pareggio';
  if (outcome === 'lose') return 'sconfitta';
  return null;
}

/**
 * Riquadro ASCII (═══ bordo, ║ lati, ─── separatore sotto il titolo in
 * MAIUSCOLO): larghezza calcolata dal contenuto (deterministico). Il testo
 * è plain-text: nessun HTML (opzione 2 approvata).
 */
function makeBox(title: string, lines: string[]): string {
  const innerWidth = Math.max(title.length, ...lines.map((l) => l.length), 12);
  const bar = '═'.repeat(innerWidth + 2);
  const sep = `║ ${'─'.repeat(innerWidth)} ║`;
  const pad = (s: string): string => (s.length >= innerWidth ? s : s + ' '.repeat(innerWidth - s.length));
  return [
    `╔${bar}╗`,
    `║ ${pad(title)} ║`,
    sep,
    ...lines.map((l) => `║ ${pad(l)} ║`),
    `╚${bar}╝`
  ].join('\n');
}

/** Sezione con titolo (emoji + maiuscolo) e righe di contenuto. */
function section(title: string, lines: string[]): string {
  return [title, ...lines].join('\n');
}

/** Header della mail: coppia umana se presente (convenzione 1), altrimenti il brand. */
function header(ctx: EmailContext): string {
  if (ctx.round !== undefined && ctx.championshipRound !== undefined) {
    return `${roundLabel(ctx.round)} · ${championshipLabel(ctx.championshipRound)}`;
  }
  return 'Survivor League';
}

/**
 * Box esito centrale (convenzione 5): subito dopo l'header nelle mail di
 * esito. Testi esatti approvati:
 *   - corretto → "✅ SEI ANCORA IN GARA — Hai indovinato! {squadra} → {esito}"
 *   - sbagliato → "❌ SEI STATO ELIMINATO — Il tuo pick ({squadra} → {esito})
 *     non si è avverato"
 *   - mancante → "❌ SEI STATO ELIMINATO — Non è arrivato alcun pick entro
 *     la deadline"
 * Dati assenti (squadra/esito) → forma generica senza inventare nulla.
 */
function resultBox(ctx: EmailContext): string | null {
  let text: string;
  if (ctx.type === 'round_result_correct') {
    const team = ctx.team;
    const esito = outcomeItalian(ctx.outcome);
    text =
      team !== undefined && esito !== null
        ? `✅ SEI ANCORA IN GARA — Hai indovinato! ${team} → ${esito}`
        : '✅ SEI ANCORA IN GARA — Hai indovinato!';
  } else if (ctx.type === 'round_result_wrong') {
    const team = ctx.team;
    const esito = outcomeItalian(ctx.outcome);
    text =
      team !== undefined && esito !== null
        ? `❌ SEI STATO ELIMINATO — Il tuo pick (${team} → ${esito}) non si è avverato`
        : '❌ SEI STATO ELIMINATO — Il tuo pick non si è avverato';
  } else if (ctx.type === 'pick_missing_elimination') {
    text = '❌ SEI STATO ELIMINATO — Non è arrivato alcun pick entro la deadline';
  } else {
    return null;
  }
  return makeBox('ESITO DEL ROUND', [text]);
}

/** Tipi di email che richiedono un pick: il box deadline è l'elemento n.1. */
const PICK_EMAIL_TYPES: readonly EmailType[] = [
  'pick_instructions',
  'pick_confirmed',
  'pick_rejected',
  'clarification'
];

/**
 * Box deadline (convenzione 2): in cima nelle mail che richiedono un pick.
 * Data nel fuso iniettato + countdown pre-calcolato dal Game Engine
 * (`deadlineRemaining`, mai dal clock né dall'LLM): "Mancano circa …".
 */
function deadlineBox(ctx: EmailContext, timeZone: string): string | null {
  if (!PICK_EMAIL_TYPES.includes(ctx.type) || ctx.deadline === undefined) return null;
  const lines = [formatItDate(ctx.deadline, timeZone)];
  if (ctx.deadlineRemaining !== undefined && ctx.deadlineRemaining !== '') {
    lines.push(`Mancano circa ${ctx.deadlineRemaining}`);
  }
  return makeBox('⏰ DEADLINE PICK', lines);
}

/** Box squadre bruciate (convenzione 3): squadra + round di utilizzo. */
function burnedBox(ctx: EmailContext): string | null {
  if (ctx.type !== 'pick_instructions' || ctx.burnedTeams === undefined || ctx.burnedTeams.length === 0) {
    return null;
  }
  return makeBox(
    '🔒 SQUADRE BRUCIATE',
    ctx.burnedTeams.map((b) => `${b.team} — ${roundLabel(b.round)}`)
  );
}

/** Sezione partite/risultati del round (dati iniettati; mai inventati). */
function matchesSection(ctx: EmailContext): string | null {
  if (ctx.matches === undefined || ctx.matches.length === 0) return null;
  return section(
    '⚽ PARTITE DEL ROUND',
    ctx.matches.map((m) => {
      if (m.score !== undefined) return `${m.home} - ${m.away}: ${m.score.home}-${m.score.away}`;
      if (m.postponed === true) return `${m.home} - ${m.away} (rinviata)`;
      return `${m.home} - ${m.away}`;
    })
  );
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
 * averci giocato" (vincolo PO) né riferimenti a canali inesistenti
 * ("seguire i round" VIETATO: gli eliminati non possono seguirli).
 */
function eliminatedClosing(ctx: EmailContext): string | null {
  if (ctx.type !== 'round_result_wrong' && ctx.type !== 'pick_missing_elimination') return null;
  if (ctx.inGameCount === undefined) return null;
  return `Il torneo continua con ${ctx.inGameCount} giocatori in gara. Grazie per essere stato con noi!`;
}

/** CTA per tipo (deterministica): focus su eventi + prossimi passi. */
function ctaFor(ctx: EmailContext): string | null {
  switch (ctx.type) {
    case 'pick_instructions':
      return section('➡️ COSA FARE ORA', [
        'Rispondi a questa email indicando squadra ed esito (win, draw, lose) prima della scadenza.'
      ]);
    case 'pick_confirmed':
      return section('➡️ COSA FARE ORA', [
        'Puoi correggere la scelta rispondendo con un nuovo pick finché il round è aperto.'
      ]);
    case 'pick_rejected':
      return section('➡️ COSA FARE ORA', [
        'Riprova rispondendo a questa email con squadra ed esito (win, draw, lose).'
      ]);
    case 'round_closed_survived':
      return section('📌 PROSSIMO PASSO', [
        'Le istruzioni per il prossimo pick arriveranno all\'apertura del prossimo round.'
      ]);
    case 'pick_postponed':
      return section('📌 PROSSIMO PASSO', ['Ti aggiorneremo appena la partita verrà giocata.']);
    case 'tournament_open':
      // Convenzione 8/correzione PO: SOLO annuncio, niente invito al pick né
      // date (non note all'invio: decide commissioner/scheduler).
      return section('⏳ COSA SUCCEDE ORA', ['Il round 1 parte a breve: stai pronto!']);
    case 'platform_registered':
      return section('➡️ COSA FARE ORA', [
        'Non serve altro: riceverai le istruzioni per il primo pick all\'apertura del round.'
      ]);
    case 'platform_unsubscribe_confirm':
      // Le parole di conferma derivano dalla costante UNICA
      // `UNSUBSCRIBE_CONFIRM_WORDS` (templates.ts) — mai copie letterali che
      // possono divergere dalla barriera `isUnsubscribeConfirmation`
      // (email-processor.ts:166-172, fix review 2026-08-23).
      return section('➡️ COSA FARE ORA', [
        `Rispondi con "${UNSUBSCRIBE_CONFIRM_WORDS[0]}" o "${UNSUBSCRIBE_CONFIRM_WORDS[1]}" per completare la disiscrizione.`
      ]);
    case 'platform_unsubscribed':
      return section('➡️ COSA FARE ORA', [
        'Puoi re-iscriverti in qualunque momento rispondendo a questa email.'
      ]);
    case 'platform_already_registered':
      return section('➡️ COSA FARE ORA', [
        'Non serve re-iscriversi: riceverai le istruzioni per il primo pick all\'apertura del round.'
      ]);
    case 'tournament_won':
      return '🏆 Complimenti campione!';
    case 'tournament_shared_win':
      return '🏆 Complimenti campioni!';
    case 'clarification':
      // Convenzione 7 (vincolo PO): ovunque ci sia un invito all'iscrizione,
      // la formula fondamentale è "dimmi il tuo nome e scrivi voglio iscrivermi".
      return section('🤔 COSA PUOI FARE', [
        '1. Iscriverti: dimmi il tuo nome e scrivi "voglio iscrivermi".',
        '2. Disiscriverti: scrivi "voglio disiscrivermi".',
        '3. Inviare un pick: scrivi squadra + esito (win, draw, lose).'
      ]);
    default:
      return null;
  }
}

/**
 * Compone il corpo completo dell'email (deterministico): header → saluto
 * (nome se noto) → box esito (mail di esito, subito dopo l'header) → box
 * deadline (mail con pick, elemento n.1) → narrativa LLM → box bruciate →
 * sezioni partite/stato → CTA → chiusura eliminato. Blocchi con dati
 * assenti OMESSI. `narrative` è il testo dell'LLM (2-4 frasi): se vuota
 * dopo il trim, il blocco è omesso (mai testo inventato).
 */
export function renderEmailV2(ctx: EmailContext, narrative: string, timeZone: string): string {
  const blocks: string[] = [];
  blocks.push(header(ctx));
  if (ctx.playerName !== undefined && ctx.playerName !== '') {
    blocks.push(`Ciao ${ctx.playerName}!`);
  }
  const outcome = resultBox(ctx);
  if (outcome !== null) blocks.push(outcome);
  const deadline = deadlineBox(ctx, timeZone);
  if (deadline !== null) blocks.push(deadline);
  const trimmedNarrative = narrative.trim();
  if (trimmedNarrative !== '') blocks.push(trimmedNarrative);
  const burned = burnedBox(ctx);
  if (burned !== null) blocks.push(burned);
  const matches = matchesSection(ctx);
  if (matches !== null) blocks.push(matches);
  const state = stateSection(ctx);
  if (state !== null) blocks.push(state);
  const count = platformCountLine(ctx);
  if (count !== null) blocks.push(count);
  const cta = ctaFor(ctx);
  if (cta !== null) blocks.push(cta);
  const closing = eliminatedClosing(ctx);
  if (closing !== null) blocks.push(closing);
  return blocks.join('\n\n');
}
