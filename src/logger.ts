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
 */
import { pino, type Logger } from 'pino';

import type { AppConfig } from './config.js';

/** Stream di destinazione minimale accettato da pino (default: stdout). */
interface LogStream {
  write: (chunk: string) => unknown;
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
 */
export function createLogger(
  level: AppConfig['LOG_LEVEL'],
  stream?: LogStream,
  testMode = false
): Logger {
  const logger = stream === undefined ? pino({ level }) : pino({ level }, stream);
  return testMode ? logger.child({ testMode: true }) : logger;
}

export type { Logger };
