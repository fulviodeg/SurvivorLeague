/**
 * Clock helper test-only (piano UAT Task 0.3, D9).
 *
 * Ruolo: applica l'offset orario UNIFICATO `TEST_OFFSET_DAYS` (in giorni) sia
 * all'orologio iniettato nel GameContext (`makeNow`) sia al timestamp di
 * ricezione delle email (`shiftReceivedAt`). UN SOLO delta, applicato nella
 * stessa direzione (indietro di N giorni) ai due timestamp, elimina per
 * costrutto la classe di errore "offset disallineati" (D9). L'offset è attivo
 * SOLO in test mode con `TEST_OFFSET_DAYS > 0` (gating a consumo, §0.3):
 * default 0 = clock e receivedAt REALI (comportamento identico a oggi).
 *
 * Interazioni:
 *   - `makeNow` è usato dai comandi CLI per costruire il `now` iniettato,
 *     ECCETTO `simulate:*` (D10: la simulazione deriva il clock dai dati ed è
 *     deterministica, `now` resta `new Date()` reale);
 *   - `shiftReceivedAt` è usato UNA SOLA volta in `processEmailBatch`
 *     (src/channel/email-processor.ts) all'ingresso del batch, mai nel
 *     comando `channel.ts` (evita il doppio shift).
 * Non contiene logica di gioco: è solo il "clock" che la CLI inietta.
 *
 * Nota: l'offset sottrae N×86400000 ms (giorni interi), preservando l'ora del
 * giorno come richiesto da D9 ("in giorni per preservare l'ora del giorno").
 */
import type { AppConfig } from './config.js';

/** Millisecondi in un giorno (l'offset è espresso in giorni interi, D9). */
const MS_PER_DAY = 86_400_000;

/**
 * Delta attivo in millisecondi: `TEST_OFFSET_DAYS` giorni se testMode attivo e
 * valore > 0, altrimenti 0 (nessun offset). Funzione pura, unica fonte del
 * delta condiviso tra clock e receivedAt (garanzia di coerenza, D9).
 */
export function offsetMs(config: AppConfig): number {
  return config.testMode && config.TEST_OFFSET_DAYS > 0
    ? config.TEST_OFFSET_DAYS * MS_PER_DAY
    : 0;
}

/**
 * Orologio iniettabile della CLI: istante REALE spostato indietro di
 * `TEST_OFFSET_DAYS` giorni quando l'offset è attivo, altrimenti `new Date()`
 * reale. Usato da TUTTI i contesti CLI che facevano `now: new Date()`, eccetto
 * `simulate:*` (D10).
 */
export function makeNow(config: AppConfig): Date {
  const delta = offsetMs(config);
  return delta > 0 ? new Date(Date.now() - delta) : new Date();
}

/**
 * Sposta il timestamp di ricezione di un'email (`receivedAt` = internaldate
 * IMAP) indietro dello STESSO delta del clock quando l'offset è attivo (D9);
 * con offset 0 restituisce il timestamp originale (nessuna copia inutile).
 * Shift MONOTONO: sottraendo lo stesso valore a tutti i messaggi l'ordine di
 * arrivo è preservato per costruzione.
 */
export function shiftReceivedAt(receivedAt: Date, config: AppConfig): Date {
  const delta = offsetMs(config);
  return delta > 0 ? new Date(receivedAt.getTime() - delta) : receivedAt;
}
