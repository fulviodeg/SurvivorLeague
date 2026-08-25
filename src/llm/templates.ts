/**
 * Template di sistema del LLM Generator — STILE UNICO "energetic" (ADR-011,
 * email v2; convenzioni 1-11 approvate).
 *
 * Ruolo: 16 prompt di sistema (15 tipi esistenti + `clarification`), uno per
 * `EmailType`. Ogni prompt istruisce l'LLM a produrre SOLO il TESTO
 * NARRATIVO (2-4 frasi brevi, tono entusiasta, focus sugli eventi principali
 * e sui prossimi passi): header, box (esito/deadline/bruciate/partite/stato
 * aggregato), sezioni dati e CTA sono composti DETERMINISTICAMENTE dal
 * renderer di canale (`src/llm/email-renderer.ts`, "la resa appartiene al
 * canale, i dati sono canale-agnostici") attorno alla narrativa.
 *
 * Vincoli (RF-25/ADR-004, D4/D9):
 *   - i numeri di turno NON entrano MAI nel prompt: la coppia "Round N ·
 *     Turno di campionato M" è scritta dal renderer dai dati (mai sigle
 *     TT/TC nelle email — convenzione 1);
 *   - la narrativa NON deve ripetere date, orari, deadline, punteggi o
 *     conteggi già mostrati dai box deterministici: se un dato è assente,
 *     non inventarlo — ometti la frase;
 *   - l'LLM produce SOLO la narrativa (mai oggetto, mai firma, mai markup,
 *     mai box/righe di separazione: li aggiunge il renderer);
 *   - nessuna data letterale nel template: le date arrivano come dati di
 *     contesto già formattati in `it-IT` nel fuso di sistema (TIMEZONE)
 *     via `formatItDate` (determinismo RNF1).
 *
 * Il vecchio prompt-set V1 (stile con segnaposto {{TT_TC}}) è stato RIMOSSO
 * (fix review 2026-08-23): nessun file storico morto nel repo.
 */
import type { EmailContext, EmailType } from './generator.js';

/**
 * Parole di conferma della barriera unsubscribe (RF-P2, decisione (a)/B1):
 * UNICA fonte della lista. Il match esatto del Message Processor
 * (`isUnsubscribeConfirmation`, src/channel/email-processor.ts), il template
 * `platform_unsubscribe_confirm` (qui sotto) e gli esempi del prompt del
 * classificatore (src/llm/intent-classifier.ts) derivano tutti da questa
 * costante: niente copie indipendenti che possono divergere sulla barriera.
 * Il confronto è ESATTO sul corpo normalizzato (trim, minuscolo).
 */
export const UNSUBSCRIBE_CONFIRM_WORDS = ['confermo', 'sì', 'si', 'yes'] as const;

/** Intestazione comune: comportamento dell'LLM (narrativa pura, tono v2). */
const COMMON_HEADER = [
  'Sei l\'assistente di Survivor League, un torneo privato di pronostici sulla Serie A tra amici.',
  'Scrivi in ITALIANO il TESTO NARRATIVO di un\'email: 2-4 frasi BREVI, tono entusiasta e amichevole,',
  'focalizzate sull\'evento principale e sul prossimo passo del giocatore. Puoi usare emoji.',
  'Il sistema compone SEPARATAMENTE intestazione, saluto ("Ciao {nome}!"), box con esito/deadline/',
  'squadre bruciate, sezioni dati e istruzioni: NON ripetere il saluto né numeri di turno, date,',
  'orari, scadenze, punteggi o conteggi già mostrati dai box — se un dato del contesto è assente,',
  'non inventarlo: ometti la frase.',
  'MAI sigle TT/TC e MAI numeri di turno: li scrive il sistema nella forma umana.',
  'Rispondi SOLO con il testo narrativo: niente oggetto, niente saluti finali di firma, niente',
  'markup, niente box o righe di separazione.'
].join('\n');

/**
 * Template per ogni tipo di email. La chiave DEVE coprire tutti i valori di
 * `EmailType` (garanzia compilativa con Record<EmailType, string>).
 */
export const EMAIL_TEMPLATES: Record<EmailType, string> = {
  platform_registered: `${COMMON_HEADER}
Argomento: CONFERMA DI ISCRIZIONE alla piattaforma. Dai il benvenuto al giocatore con entusiasmo:
il torneo è alle porte e la sua partecipazione parte da qui. Accenna in breve al formato del pick
(scegli una squadra e un esito: vittoria, pareggio o sconfitta) e al prossimo passo (rispondere
alla prima email di pick quando il round si aprirà).`,

  platform_unsubscribe_confirm: `${COMMON_HEADER}
Argomento: RICHIESTA DI CONFERMA per la disiscrizione. Spiega in modo cortese che per completare
la disiscrizione dalla piattaforma serve un secondo messaggio di conferma (basta rispondere
"${UNSUBSCRIBE_CONFIRM_WORDS[0]}" o "${UNSUBSCRIBE_CONFIRM_WORDS[1]}") e che la disiscrizione ferma
comunicazioni e pick, senza toccare lo storico del torneo in corso.`,

  platform_unsubscribed: `${COMMON_HEADER}
Argomento: CONFERMA DI DISISCRIZIONE. Comunica con garbo che l'account è stato disiscritto e non
riceverà più comunicazioni; può tornare quando vuole rispondendo a questa email con una richiesta
di iscrizione; lo storico del torneo non è stato cancellato.`,

  platform_already_registered: `${COMMON_HEADER}
Argomento: SEI GIÀ ISCRITTO ALLA PIATTAFORMA. Comunica con tono positivo che l'account è già
attivo e non serve re-iscriversi; per partecipare al torneo basta inviare la prima scelta
(squadra + esito) quando arriverà la mail di apertura del primo round.`,

  tournament_open: `${COMMON_HEADER}
Argomento: ANNUNCIO DI APERTURA DEL TORNEO. Trasmetti entusiasmo: il torneo è ufficialmente
aperto e il round 1 parte a breve — stai pronto! NON invitare ancora a fare un pick e NON citare
date: le istruzioni con la scadenza arrivano con una mail dedicata all'apertura del round.`,

  pick_instructions: `${COMMON_HEADER}
Argomento: ISTRUZIONI PER IL PICK. Il round è aperto: incoraggia il giocatore a scegliere UNA
squadra tra quelle disponibili (campo "squadre disponibili" del contesto) con l'esito previsto
(vittoria, pareggio o sconfitta) e a inviarla prima della scadenza. Le squadre già bruciate e la
deadline sono nei box del sistema: non elencarle di nuovo.`,

  pick_confirmed: `${COMMON_HEADER}
Argomento: CONFERMA DEL PICK REGISTRATO. Festeggia la mossa del giocatore (squadra ed esito sono
nel box del sistema); ricorda che può correggere la scelta finché il round è aperto.`,

  pick_rejected: `${COMMON_HEADER}
Argomento: PICK NON REGISTRATO. Spiega il motivo (campo "motivo" del contesto) in modo semplice,
costruttivo e incoraggiante: il giocatore può riprovare con una nuova email, formulando squadra
ed esito in modo riconoscibile.`,

  pick_missing_elimination: `${COMMON_HEADER}
Argomento: NESSUN PICK ARRIVATO. Comunica con rispetto e senza colpevolizzare che non è arrivato
alcun pick entro la scadenza e che per questo l'avventura del giocatore si ferma qui (l'esito è
nel box del sistema); ringrazia con calore per essere stato con noi. NON invitare a seguire i
prossimi round (gli eliminati non li seguono) e MAI dire "grazie per averci giocato".`,

  round_result_correct: `${COMMON_HEADER}
Argomento: PICK CORRETTO. Esprimi gioia autentica: la squadra scelta ha prodotto l'esito previsto
e il giocatore resta in gara (l'esito è nel box del sistema). Proietta sul prossimo round:
riceverà le istruzioni quando si aprirà.`,

  round_result_wrong: `${COMMON_HEADER}
Argomento: PICK SBAGLIATO. Comunica con tono rispettoso e sportivo che la squadra scelta non ha
prodotto l'esito previsto e che l'avventura del giocatore si ferma qui (l'esito è nel box del
sistema); ringrazia per essere stato con noi. MAI "grazie per averci giocato" e MAI invitare a
seguire i prossimi round (gli eliminati non li seguono).`,

  pick_postponed: `${COMMON_HEADER}
Argomento: PARTITA RINVIATA. Rassicura il giocatore: la partita della squadra scelta è stata
rinviata o sospesa; il pick resta in attesa (Freeze) e sarà valutato quando la partita verrà
giocata — niente è deciso.`,

  round_closed_survived: `${COMMON_HEADER}
Argomento: RIEPILOGO DI CHIUSURA DEL ROUND. Il round è chiuso e il giocatore resta in gara:
breve carica positiva, i numeri del round (superstiti ed eliminati) sono nel box del sistema.
Il prossimo passo è la mail di istruzioni all'apertura del prossimo round.`,

  tournament_won: `${COMMON_HEADER}
Argomento: VITTORIA DEL TORNEO. Esplodi di gioia: congratulazioni al campione, ha vinto l'intero
torneo restando l'ultimo in gara. Chiudi con un festeggiamento.`,

  tournament_shared_win: `${COMMON_HEADER}
Argomento: VITTORIA CONDIVISA. Festeggia: il torneo termina con più vincitori, come previsto
dalle regole; congratulazioni al giocatore, campione insieme ai suoi compagni di vetta.`,

  clarification: `${COMMON_HEADER}
Argomento: CHIARIMENTO. Non hai capito la richiesta del giocatore: dillo con leggerezza e
simpatica, poi elenca le tre cose che può fare: iscriversi, disiscriversi, o inviare un pick
(squadra + esito). Se nel contesto c'è una scadenza attiva, accenna solo che il tempo stringe
(senza date). Se non è iscritto, ricorda la formula: dire il proprio nome e scrivere "voglio
iscrivermi".`
};

/**
 * Narrativa DETERMINISTICA per ogni tipo di email (email v3): testo FISSO,
 * corto e in italiano. È la narrativa PRIMARIA del `DeterministicGenerator`
 * (src/llm/deterministic-generator.ts) e il FALLBACK della guardia
 * anti-degenerazione `deterministicNarrative` (src/llm/generator.ts) in
 * modalità LLM. Un testo vuoto → il renderer omette il blocco narrativa.
 *
 * I testi derivano dai 16 template del piano email v3: dove il template
 * mostra una narrativa con dati specifici (esiti round con squadra/punteggio,
 * partita rinviata con nome squadra) il testo deterministico è la forma
 * GENERICA equivalente (il dato specifico è prodotto dall'LLM in modalità
 * llm). La parola di conferma disiscrizione è interpolata dalla costante
 * UNICA `UNSUBSCRIBE_CONFIRM_WORDS` (mai copie letterali divergenti dalla
 * barriera). Mai spedire spazzatura: il fallback deterministico è sempre
 * meglio di un corpo illeggibile.
 */
export const DETERMINISTIC_NARRATIVES: Record<EmailType, string> = {
  platform_registered: 'Quando si apre il round riceverai le istruzioni per il pick.',
  platform_unsubscribe_confirm: `Rispondi a questa email con "${UNSUBSCRIBE_CONFIRM_WORDS[0]}" per completare la disiscrizione.\n\nSe cambi idea, non fare nulla: resterai iscritto.`,
  platform_unsubscribed:
    'Non riceverai più comunicazioni. Per tornare, rispondi con "ISCRIZIONE [il tuo nome]" (nel subject o nel corpo).',
  platform_already_registered: "All'apertura del round riceverai le istruzioni per il pick.",
  tournament_open: 'Il round 1 parte a breve: stai pronto.',
  pick_instructions: "Scegli una squadra e l'esito (vittoria, pareggio, sconfitta).",
  pick_confirmed: 'Puoi correggere la scelta rispondendo con un nuovo pick finché il round è aperto.',
  pick_rejected: 'Riprova rispondendo con squadra + esito (win, draw, lose).',
  pick_missing_elimination: 'Non è arrivato alcun pick entro la deadline.',
  round_result_correct: "Hai indovinato: hai centrato l'esito previsto.",
  round_result_wrong: "Il tuo pick non si è avverato: l'avventura si ferma qui.",
  pick_postponed: 'La partita della tua squadra è stata rinviata: il tuo pick resta in attesa.',
  round_closed_survived: '',
  tournament_won: "Sei rimasto l'ultimo in gara: la vittoria è tutta tua!",
  tournament_shared_win: 'Insieme ai tuoi compagni di vetta avete portato a casa il torneo.',
  clarification:
    'Puoi:\n1. Iscriverti: scrivi "ISCRIZIONE [il tuo nome]" (es. "ISCRIZIONE Mario") nel subject o nel corpo.\n2. Disiscriverti: scrivi "DISISCRIZIONE".\n3. Inviare un pick: scrivi squadra + esito (win, draw, lose).'
};

/**
 * Formatta una data in italiano nel FUSO richiesto (D9): le date di gioco
 * sono istanti UTC assoluti; il fuso (TIMEZONE di sistema, default
 * Europe/Rome) conta SOLO al momento della comunicazione verso l'esterno e
 * rende il testo deterministico nei test (RNF1: fuso esplicito). Formato:
 * data completa + ora breve (es. "sabato 12 settembre 2026 alle 17:30").
 */
export function formatItDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(date);
}

/**
 * Serializza i dati di contesto per il messaggio utente della narrativa.
 * I numeri di turno (`round`/`championshipRound`) NON sono serializzati
 * (ADR-004/RF-25: mai nel prompt — la coppia la scrive il renderer); le date
 * sono formattate con `formatItDate` nel fuso iniettato.
 */
export function serializeEmailContext(ctx: EmailContext, timeZone: string): string {
  const lines: string[] = ['Ecco i dati a disposizione per comporre il testo narrativo:'];
  if (ctx.playerName !== undefined) lines.push(`- Giocatore: ${ctx.playerName}`);
  if (ctx.team !== undefined) lines.push(`- Squadra: ${ctx.team}`);
  if (ctx.outcome !== undefined) lines.push(`- Esito previsto: ${ctx.outcome}`);
  if (ctx.playerResult !== undefined) lines.push(`- Esito del pick: ${ctx.playerResult}`);
  if (ctx.reason !== undefined) lines.push(`- Motivo: ${ctx.reason}`);
  if (ctx.availableTeams !== undefined && ctx.availableTeams.length > 0) {
    lines.push(`- Squadre disponibili: ${ctx.availableTeams.join(', ')}`);
  }
  if (ctx.burnedTeams !== undefined && ctx.burnedTeams.length > 0) {
    lines.push(`- Squadre bruciate: ${ctx.burnedTeams.map((b) => b.team).join(', ')}`);
  }
  if (ctx.matches !== undefined && ctx.matches.length > 0) {
    lines.push(
      `- Partite: ${ctx.matches
        .map((m) =>
          m.score !== undefined
            ? `${m.home} ${m.score.home}-${m.score.away} ${m.away}`
            : `${m.home}-${m.away}${m.postponed === true ? ' (rinviata)' : ''}`
        )
        .join('; ')}`
    );
  }
  if (ctx.roundStart !== undefined) {
    lines.push(`- Inizio del round: ${formatItDate(ctx.roundStart, timeZone)}`);
  }
  if (ctx.deadline !== undefined) {
    lines.push(`- Scadenza: ${formatItDate(ctx.deadline, timeZone)}`);
  }
  if (ctx.inGameCount !== undefined) lines.push(`- Giocatori in gara: ${ctx.inGameCount}`);
  if (ctx.eliminatedWrong !== undefined) {
    lines.push(`- Eliminati per pick sbagliato: ${ctx.eliminatedWrong}`);
  }
  if (ctx.eliminatedMissing !== undefined) {
    lines.push(`- Eliminati senza pick: ${ctx.eliminatedMissing}`);
  }
  if (ctx.platformCount !== undefined) lines.push(`- Iscritti alla piattaforma: ${ctx.platformCount}`);
  return lines.join('\n');
}
