/**
 * Template di sistema del LLM Generator (LLD §6.3, piano Task 5.2; briefing
 * Fase 5-6 §3, D4/D9).
 *
 * Ruolo: testi STATICI in italiano per ogni `EmailType` (12 tipi, incluso
 * `auto_registered` — D5). Ogni template è un prompt di sistema che istruisce
 * l'LLM su tono, uso dei campi di contesto (arrivano nel messaggio utente,
 * serializzati da `serializeEmailContext`) e vincoli di output.
 *
 * Vincoli (RF-25/ADR-004, D4):
 *   - i numeri TT/TC NON entrano MAI nel prompt: dove serve la coppia il
 *     template ordina di scrivere ESATTAMENTE il segnaposto `{{TT_TC}}`
 *     (forma estesa nel corpo) o `{{TTTC}}` (forma compatta), che
 *     l'implementazione sostituisce DOPO la generazione con
 *     `turnExtended(tt,tc)`/`turnCompact(tt,tc)` dai dati di `EmailContext`
 *     (coppia assente → stringa vuota);
 *   - nessuna data letterale nel template: le date arrivano come dati di
 *     contesto già formattati in `it-IT` con fuso fisso `Europe/Rome` (D9,
 *     determinismo RNF1) via `formatItDate`;
 *   - l'LLM produce SOLO il corpo dell'email (mai oggetto, mai firma).
 */
import type { EmailType } from './generator.js';

/** Segnaposto della coppia TT/TC in forma estesa (corpo: "TT 2, TC 7"). */
export const TURN_PLACEHOLDER_EXTENDED = '{{TT_TC}}';
/** Segnaposto della coppia TT/TC in forma compatta (corpo/CLI: "TT2TC7"). */
export const TURN_PLACEHOLDER_COMPACT = '{{TTTC}}';

/** Intestazione comune: istruzioni di comportamento per l'LLM. */
const COMMON_HEADER = [
  'Sei l\'assistente di Survivor League, un torneo privato di pronostici sulla Serie A tra amici.',
  'Scrivi un\'email in ITALIANO, cordiale e chiara, rivolta a un giocatore del torneo.',
  'Usa i dati di contesto forniti nel messaggio utente (giocatore, squadra, esito, motivo,',
  'squadre disponibili, scadenza). Se un dato è assente, non inventarlo: ometti la frase.',
  'Dove serve indicare il turno del torneo scrivi ESATTAMENTE il segnaposto ' +
    `"${TURN_PLACEHOLDER_EXTENDED}" (mai numeri di turno, mai sostituirlo: lo fa il sistema).`,
  'Rispondi SOLO con il corpo dell\'email: niente oggetto, niente saluti finali di firma,',
  'niente markup.'
].join('\n');

/** Chiusura comune: invito all'azione per i messaggi che lo richiedono. */
const ACTION_CLOSING = `\n\nChiudi ricordando al giocatore di inviare la sua scelta prima della scadenza (${TURN_PLACEHOLDER_EXTENDED} se presente).`;

/**
 * Template per ogni tipo di email (LLD §6.3). La chiave DEVE coprire tutti i
 * valori di `EmailType` (garanzia compilativa con Record<EmailType, string>).
 */
export const EMAIL_TEMPLATES: Record<EmailType, string> = {
  welcome: `${COMMON_HEADER}
Scrivi il messaggio di BENVENUTO per un nuovo iscritto: conferma l'iscrizione al torneo,
spiega in breve il formato del pick (prima di ogni turno si sceglie una squadra tra quelle
disponibili e un esito: vittoria, pareggio o sconfitta), il limite di una squadra per girone
e l'invito a inviare la prima scelta${ACTION_CLOSING}`,

  registration_open_invite: `${COMMON_HEADER}
Scrivi l'INVITO ad iscriversi al torneo appena aperto: spiega che le iscrizioni sono aperte,
come si partecipa (basta rispondere con una squadra e un esito nel primo turno) e che
l'iscrizione chiude alla scadenza del primo turno${ACTION_CLOSING}`,

  pick_instructions: `${COMMON_HEADER}
Scrivi le ISTRUZIONI PER IL PICK del turno: elenca le squadre disponibili del giocatore
(campo "squadre disponibili"), ricorda che può sceglierne una sola con l'esito previsto
(win = vittoria, draw = pareggio, lose = sconfitta), indica la scadenza${ACTION_CLOSING}`,

  pick_confirmed: `${COMMON_HEADER}
Scrivi la CONFERMA del pick registrato: riporta la squadra scelta e l'esito previsto
(campo "squadra" e "esito"), il turno in corso (segnaposto) e la scadenza entro cui
l'eventuale correzione è ancora possibile${ACTION_CLOSING}`,

  pick_rejected: `${COMMON_HEADER}
Scrivi il RIFIUTO del pick con il motivo indicato nel campo "motivo" (spiegandolo in modo
semplice e costruttivo): il giocatore può riprovare con una nuova email. Se il motivo è
una richiesta di chiarimento, spiega esattamente cosa non si è capito e come formulare
la scelta (squadra + esito)${ACTION_CLOSING}`,

  pick_missing_elimination: `${COMMON_HEADER}
Scrivi la NOTIFICA DI ELIMINAZIONE per pick mancante: comunica che non è arrivato alcun
pick per il turno (segnaposto) e che per questo il giocatore è eliminato dal torneo,
con tono rispettoso e senza colpevolizzare${ACTION_CLOSING}`,

  round_result_correct: `${COMMON_HEADER}
Scrivi la NOTIFICA DI ESITO CORRETTO: la squadra scelta (campo "squadra") ha prodotto
l'esito previsto nel turno (segnaposto); il giocatore resta in gara e può preparare
la prossima scelta${ACTION_CLOSING}`,

  round_result_wrong: `${COMMON_HEADER}
Scrivi la NOTIFICA DI ESITO SBAGLIATO: la squadra scelta (campo "squadra") non ha
prodotto l'esito previsto nel turno (segnaposto) e per questo il giocatore è eliminato
dal torneo, con tono rispettoso${ACTION_CLOSING}`,

  pick_postponed: `${COMMON_HEADER}
Scrivi la NOTIFICA DI PARTITA RINVIATA: la partita della squadra scelta (campo "squadra")
è stata rinviata/sospesa; il pick resta in attesa (Freeze) e sarà valutato quando la
partita sarà giocata${ACTION_CLOSING}`,

  auto_registered: `${COMMON_HEADER}
Scrivi il messaggio UNICO di auto-iscrizione (RF-27): il giocatore è stato iscritto
automaticamente al torneo con la sua prima email; conferma che il pick è stato
registrato (squadra e esito dal contesto) e spiega brevemente le regole del torneo
(una squadra per girone, prima della scadenza di ogni turno)${ACTION_CLOSING}`,

  tournament_won: `${COMMON_HEADER}
Scrivi il messaggio di VITTORIA del torneo: congratulazioni al giocatore, ha vinto
l'intero torneo restando l'ultimo in gara${ACTION_CLOSING}`,

  tournament_shared_win: `${COMMON_HEADER}
Scrivi il messaggio di VITTORIA CONDIVISA: il torneo termina con più vincitori
(come previsto dalle regole); congratulazioni al giocatore${ACTION_CLOSING}`
};

/**
 * Formatta una data in italiano con fuso FISSO Europe/Rome (D9): le date di
 * gioco sono UTC; il fuso fisso rende il testo deterministico (RNF1).
 * Formato: data completa + ora breve (es. "sabato 12 settembre 2026 alle 17:30").
 */
export function formatItDate(date: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(date);
}

/**
 * Serializza i dati di contesto per il messaggio utente (mai tt/tc: la coppia
 * entra SOLO come segnaposto post-generazione, RF-25/ADR-004). Le date sono
 * formattate con `formatItDate` (it-IT, Europe/Rome — D9).
 */
export function serializeEmailContext(ctx: {
  playerName?: string;
  team?: string;
  outcome?: string;
  reason?: string;
  availableTeams?: string[];
  deadline?: Date;
}): string {
  const lines: string[] = ['Ecco i dati a disposizione per comporre l\'email:'];
  if (ctx.playerName !== undefined) lines.push(`- Giocatore: ${ctx.playerName}`);
  if (ctx.team !== undefined) lines.push(`- Squadra: ${ctx.team}`);
  if (ctx.outcome !== undefined) lines.push(`- Esito: ${ctx.outcome}`);
  if (ctx.reason !== undefined) lines.push(`- Motivo: ${ctx.reason}`);
  if (ctx.availableTeams !== undefined && ctx.availableTeams.length > 0) {
    lines.push(`- Squadre disponibili: ${ctx.availableTeams.join(', ')}`);
  }
  if (ctx.deadline !== undefined) lines.push(`- Scadenza: ${formatItDate(ctx.deadline)}`);
  return lines.join('\n');
}
