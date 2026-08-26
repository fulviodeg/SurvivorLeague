/**
 * Reply Cleaner (piano email-reply-quote-stripping, decisioni D1-D9; report
 * di analisi UAT 2026-08-22 §2).
 *
 * Ruolo: funzione PURA che estrae dal body di una reply email SOLO il testo
 * del giocatore, tagliando la citazione della mail precedente (di sistema o
 * meno) al primo "confine di citazione" e limitando il risultato alle prime 5
 * righe NON vuote. Nessun accesso a DB/config/rete: è la preparazione
 * deterministica del corpo eseguita dal Message Router PRIMA della
 * classificazione LLM (incidente UAT: il classificatore veniva confuso dalla
 * citazione con box "SQUADRE BRUCIATE"/"PARTITE DEL ROUND").
 *
 * `SYSTEM_EMAIL_SEPARATOR` è la costante UNICA condivisa tra invio
 * (EmailAdapter `sendMessage` la antepone a ogni email di sistema) e ricezione
 * (questo modulo): quando citata nella reply, tutto ciò che segue viene
 * tagliato in ogni caso (D2/D3). Nessuna importazione verso l'adapter: il
 * flusso di dipendenza è solo adapter/router → cleaner.
 *
 * Confini di citazione riconosciuti, al PRIMO che occorre nel corpo (D5):
 *   (a) riga che inizia con il separatore (eventuale prefisso ">" e spazi, D9);
 *   (b) riga che inizia con ">";
 *   (c) riga che contiene "ha scritto:" / "wrote:" — anche spezzato su due
 *       righe ("…ha" + "scritto:"), wrapping osservato nei body reali Gmail.
 * Poi si tengono le prime 5 righe NON vuote (D4). Se il taglio produce una
 * stringa vuota → fallback al body originale trimmato (D6: mai peggiorare il
 * comportamento attuale — il classificatore decide invece di un silenzioso
 * unknown). CRLF normalizzato a LF (D8).
 */

/** Separatore di brand anteposto a ogni email di sistema (D2/D3, email v3). */
export const SYSTEM_EMAIL_SEPARATOR = '─── Survivor League ───';

/** Marker "ha scritto:" / "wrote:" (D5c): ciò che segue è citazione della mail precedente. */
const QUOTE_MARKER_PATTERN = /ha scritto:|wrote:/i;

/** Numero massimo di righe NON vuote del giocatore passate al classificatore (D4). */
const MAX_PLAYER_LINES = 5;

/**
 * Estrae dal body di una reply email il solo testo del giocatore (D1/D4/D5):
 * normalizza CRLF→LF e trim, trova il primo confine di citazione, tiene le
 * prime 5 righe NON vuote che lo precedono. Risultato vuoto → body originale
 * trimmato (D6). Funzione PURA: nessun DB/config/rete.
 *
 * @param body corpo completo della reply (parsed.text di mailparser, che
 *   include la citazione della mail precedente nei client che la inseriscono).
 * @returns testo del giocatore (max 5 righe non vuote, join "\n") oppure il
 *   body originale trimmato se il taglio produrrebbe una stringa vuota (D6).
 */
export function extractPlayerReply(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (normalized === '') {
    return normalized;
  }

  const lines = normalized.split('\n');
  let boundary = lines.length; // nessun confine trovato → tutto il testo è del giocatore

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.trimStart();
    const withoutQuotePrefix = stripped.startsWith('>') ? stripped.slice(1).trimStart() : stripped;
    if (withoutQuotePrefix.startsWith(SYSTEM_EMAIL_SEPARATOR)) {
      boundary = i; // (a) separatore di sistema (eventualmente citato con ">") — vince sempre
      break;
    }
    if (stripped.startsWith('>')) {
      boundary = i; // (b) riga di citazione standard
      break;
    }
    const next = i + 1 < lines.length ? (lines[i + 1] ?? '').trim() : '';
    const withNext = next === '' ? stripped : `${stripped} ${next}`;
    if (QUOTE_MARKER_PATTERN.test(withNext)) {
      boundary = i; // (c) "Il giorno … ha scritto:" / "wrote:" (anche "…ha" + "scritto:" su due righe)
      break;
    }
  }

  const playerText = lines
    .slice(0, boundary)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, MAX_PLAYER_LINES)
    .join('\n');

  return playerText === '' ? normalized : playerText;
}
