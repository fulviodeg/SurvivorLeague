/**
 * Lock file del comando `channel:email:process` (anti-concorrenza cron).
 *
 * Ruolo: impedisce che due run sovrapposti di `channel:email:process`
 * elaborino le STESSE email non lette e producano risposte duplicate o
 * contraddittorie (il cron scheduler lancia il comando ogni minuto; un run
 * può durare oltre 1 minuto per i retry LLM, worst-case ~135 s per messaggio).
 *
 * Meccanismo: file di lock derivato da DB_PATH (`<dir>/<nome DB>.lock`,
 * `lockPathFor`): percorsi DB diversi → lock diversi, quindi UAT e produzione
 * (DB_PATH diversi) non collidono mai. `data/` è gitignorata: i file `.lock`
 * non vengono mai committati.
 *
 * Staleness (PID check + touch):
 *   - alla collisione il file contiene il PID del proprietario; se il processo
 *     è vivo (`process.kill(pid, 0)` → nessun ESRCH) il lock è legittimo e
 *     l'acquisizione restituisce null (SKIP, nessun steal anche se il batch è
 *     lento);
 *   - se il PID è morto (ESRCH) o il file è corrotto/illeggibile, il lock è
 *     stantio → viene rimosso e l'acquisto è ritentato una volta;
 *   - fallback di sicurezza: contenuto non parsabile + mtime più vecchio di
 *     STALE_MS (default 10 min) → considerato stantio;
 *   - durante l'elaborazione il proprietario aggiorna l'mtime ogni
 *     TOUCH_INTERVAL_MS (default 30 s) con un timer `setInterval` + `unref()`,
 *     così un run lungo non appare mai stantio e un crash viene rilevato
 *     subito (PID morto, senza attendere soglie).
 *
 * Nota operativa: dopo un reset dei DB (cancellazione dei file) il `.lock`
 * residuo viene rubato automaticamente al run successivo (PID proprietario
 * morto), ma per igiene conviene eliminarlo insieme al DB
 * (es. `rm data/uat-synthetic-pippo.db data/uat-synthetic-pippo.db.lock`).
 * Con un nuovo DB_PATH il vecchio `.lock` non viene MAI letto (resta orfano,
 * innocuo). Un PID riusato da un processo non correlato farebbe apparire il
 * lock vivo: caso rarissimo; il fallback mtime non scatta finché il file non
 * è rimosso a mano. Il check PID è affidabile solo su stesso host (il cron
 * gira sulla stessa macchina del processo; target: Linux VPS, single-host).
 *
 * Interazioni: usato SOLO dal handler `channel:email:process` in
 * src/cli/commands/channel.ts (fetch/send/scheduler/tournament/round non ne
 * hanno bisogno: read-only o idempotenti); testato in
 * tests/unit/cli/email-process-lock.test.ts. Nessuna dipendenza esterna:
 * sola API `node:fs` (creazione esclusiva atomica `wx`).
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Soglia di staleness dell'mtime (fallback di sicurezza): 10 minuti. */
export const STALE_MS = 10 * 60_000;

/** Intervallo del touch periodico dell'mtime del lock: 30 secondi. */
export const TOUCH_INTERVAL_MS = 30_000;

/** Handle del lock acquisito: path del file + PID del processo proprietario. */
export interface EmailProcessLock {
  path: string;
  pid: number;
}

/**
 * Deriva il path del lock dal percorso del DB di gioco: `<dir>/<basename>.lock`.
 * Path DB diversi → lock diversi (nessun riuso incrociato tra UAT e produzione).
 */
export function lockPathFor(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.lock`);
}

/**
 * Legge il PID scritto nel file di lock, o null se il contenuto non è un
 * intero positivo valido o il file è illeggibile/assente.
 */
export function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Sonda la vivacità del processo col PID dato via `process.kill(pid, 0)`:
 * nessuna eccezione → vivo; `ESRCH` → inesistente (morto); `EPERM` → esiste
 * ma non è nostro → considerato vivo (conservativo).
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * True se l'mtime del file di lock è più vecchio di STALE_MS (fallback di
 * sicurezza per contenuti corrotti). File assente/illeggibile → false.
 */
function isOld(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Acquisisce il lock con creazione esclusiva atomica (`flag: 'wx'`): scrive
 * il PID corrente nel file `<lockPath>`. Se il file esiste già, distingue:
 *   - PID vivo → lock legittimo → restituisce null (SKIP del chiamante);
 *   - PID morto, o contenuto corrotto con mtime oltre STALE_MS → lock stantio
 *     → lo rimuove e ritenta una volta;
 *   - contenuto corrotto con mtime fresco → null (fallback mtime non scatta).
 * La directory padre viene creata se assente (stesso pattern di
 * createConnection in src/db/connection.ts).
 */
export function acquireLock(lockPath: string): EmailProcessLock | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return { path: lockPath, pid: process.pid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = readHolderPid(lockPath);
      if (pid !== null) {
        if (isAlive(pid)) return null;
      } else if (!isOld(lockPath)) {
        return null;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Già rimosso da un altro processo nel frattempo: si ritenta comunque.
      }
    }
  }
  return null;
}

/**
 * Rilascia il lock: rimuove il file SOLO se il PID scritto coincide ancora
 * col proprietario (non rimuove mai un lock di qualcun altro). No-op se il
 * file è assente o illeggibile (non lancia mai).
 */
export function releaseLock(lock: EmailProcessLock): void {
  if (readHolderPid(lock.path) !== lock.pid) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // File già rimosso: nessuna azione.
  }
}

/**
 * Touch del lock: aggiorna l'mtime al momento corrente per segnalare che il
 * proprietario è ancora vivo. Chiamato dal timer periodico del handler; non
 * lancia mai (un errore qui non deve far cadere il processo).
 */
export function touchLock(lock: EmailProcessLock): void {
  try {
    utimesSync(lock.path, new Date(), new Date());
  } catch {
    // Lock rimosso/stantio nel frattempo: il rilascio in finally farà pulizia.
  }
}
