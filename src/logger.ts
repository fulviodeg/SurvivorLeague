/**
 * Logger applicativo (pino) — output JSON strutturato su stdout.
 *
 * Ruolo: unica factory dei logger del sistema. Il livello deriva da LOG_LEVEL
 * (src/config.ts, LLD §4.2); pino emette una riga JSON per evento, adatta a
 * essere raccolta da cron/journald in produzione.
 *
 * Interazioni: istanziato dai comandi CLI (src/cli/) con il livello della
 * configurazione; non dipende da config.ts per restare utilizzabile anche
 * quando la configurazione non è valida (es. per loggare il ConfigError).
 * In test mode (D3 del piano UAT) ogni logger creato dai comandi riceve il
 * binding `testMode: true` (vedi createLogger), così ogni riga di log lo porta.
 *
 * Timezone (ADR-011 "Email v2"): il timestamp pino di default è ISO UTC;
 * `createLogger(level, stream?, testMode?, timeZone?)` lo configura nel FUSO
 * di sistema (TIMEZONE di config, es. `2026-08-21T18:23:15+02:00`) — il fuso
 * conta SOLO per la comunicazione verso l'esterno, inclusi i log; il
 * sistema di gioco resta su istanti UTC assoluti. Default del parametro =
 * comportamento attuale (UTC): è il path di emergenza quando la
 * configurazione non è ancora validata (ConfigError) e non rompe i test
 * esistenti che non passano il fuso.
 */
import { pino, type Logger } from 'pino';

import type { AppConfig } from './config.js';

/** Stream di destinazione minimale accettato da pino (default: stdout). */
interface LogStream {
  write: (chunk: string) => unknown;
}

/**
 * Formatta un istante nel FUSO richiesto come timestamp ISO-like con offset
 * esplicito (`2026-08-21T18:23:15+02:00`) — lo stesso formato del timestamp
 * pino di default, ma con l'orario locale del fuso invece dell'UTC. Funzione
 * esportata per i test (deterministica: riceve la data).
 */
export function formatTimestampInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  // longOffset produce "GMT+02:00" (o "GMT-05:00"): si estrae il segno+offset.
  const offset = offsetPart === undefined || offsetPart === 'GMT' ? '' : offsetPart.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

/**
 * Timestamp pino nel fuso (chiamato da pino a ogni riga con l'istante
 * corrente). Il contratto di pino per l'opzione `timestamp` è una funzione
 * che restituisce l'INTERO frammento di proprietà, inclusi virgola e nome
 * del campo (`,"time":"…"`).
 */
function timestampInZone(timeZone: string): () => string {
  return () => `,"time":"${formatTimestampInZone(new Date(), timeZone)}"`;
}

/**
 * Crea un logger pino JSON al livello indicato (LOG_LEVEL della configurazione).
 * Il parametro stream esiste solo per i test, che catturano l'output in
 * memoria; in produzione si usa il default (stdout di processo).
 *
 * `testMode` (D3 del piano UAT): quando `true`, il logger è un CHILD con il
 * campo strutturato `testMode: true` legato a ogni riga emessa (binding). Il
 * default `false` NON aggiunge il campo: è il path di emergenza usato quando
 * la configurazione non è ancora validata (es. per loggare un ConfigError,
 * dove `testMode` è sconosciuto) — `createLogger(level)` resta valido senza
 * alcuna dipendenza da config.ts.
 *
 * `timeZone` (ADR-011): se presente, il timestamp di ogni riga è formattato
 * nel fuso indicato (con offset esplicito); assente → timestamp ISO UTC di
 * pino (comportamento storico, path di emergenza ConfigError).
 */
export function createLogger(
  level: AppConfig['LOG_LEVEL'],
  stream?: LogStream,
  testMode = false,
  timeZone?: string
): Logger {
  const options =
    timeZone === undefined ? { level } : { level, timestamp: timestampInZone(timeZone) };
  const logger = stream === undefined ? pino(options) : pino(options, stream);
  return testMode ? logger.child({ testMode: true }) : logger;
}

export type { Logger };
