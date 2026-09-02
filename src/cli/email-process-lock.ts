/**
 * Lock file del comando `channel:email:process` (anti-concorrenza cron).
 *
 * Ruolo: impedire che due run di `channel:email:process` che leggono la STESSA
 * casella IMAP elaborino le stesse email non lette e producano risposte
 * duplicate o contraddittorie (il cron lancia il comando ogni minuto; un run
 * può durare oltre 1 minuto per i retry LLM, worst-case ~135 s per messaggio).
 *
 * Meccanismo: file di lock SCOPATO ALLA CASELLA condivisa (`lockPathFor`),
 * non al DB: il path è `os.tmpdir()/survivor-email-process-<hash>.lock` con
 * `<hash>` = sha256 di `IMAP_HOST` + `IMAP_USER` (16 hex). La risorsa protetta
 * è la casella, non il DB locale: due ambienti della stessa macchina che
 * condividono la casella (es. staging e prod) DEVONO collidere sullo stesso
 * lock, altrimenti processerebbero le stesse email in parallelo (incidente UAT
 * 2026-09-02: una seconda istanza sulla macchina di sviluppo leggeva la stessa
 * casella Gmail del VPS e rispondeva "nessun turno è aperto" a pick che il VPS
 * registrava correttamente). `os.tmpdir()` è CONDIVISO tra gli ambienti della
 * stessa macchina, a differenza di `data/` che è per-ambiente.
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
 * Nota operativa: un crash lascia un `.lock` in `os.tmpdir()` con PID morto:
 * viene rubato automaticamente al run successivo (nessuna pulizia manuale
 * richiesta). Un PID riusato da un processo non correlato farebbe apparire il
 * lock vivo: caso rarissimo; il fallback mtime non scatta finché il file non
 * è rimosso a mano. Il check PID è affidabile solo su stesso host (il cron
 * gira sulla stessa macchina del processo; target: Linux VPS, single-host).
 *
 * LIMITE NOTO: un lock su file coordina SOLO processi della STESSA macchina
 * (stesso filesystem). Due istanze su macchine DIVERSE che condividono la
 * stessa casella non possono essere coordinate da un file locale: quel caso va
 * evitato a livello operativo (una sola istanza per casella tra macchine
 * diverse). Una rivendicazione atomica a livello di casella (claim via IMAP) è
 * fuori dallo scope POC.
 *
 * Interazioni: usato SOLO dal handler `channel:email:process` in
 * src/cli/commands/channel.ts (fetch/send/scheduler/tournament/round non ne
 * hanno bisogno: read-only o idempotenti); testato in
 * tests/unit/cli/email-process-lock.test.ts. Nessuna dipendenza esterna oltre
 * `node:fs`, `node:os`, `node:crypto`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

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
 * Deriva il path del lock dalla CASELLA IMAP condivisa (`host` + `user`), NON
 * dal DB_PATH: la risorsa protetta è la casella, quindi due ambienti che
 * leggono la stessa casella devono condividere lo stesso lock. Il path è
 * `os.tmpdir()/survivor-email-process-<sha256(host\0user) 16 hex>.lock`:
 * `os.tmpdir()` è condiviso tra gli ambienti della stessa macchina e l'hash
 * evita caratteri speciali/collisioni tra caselle diverse.
 */
export function lockPathFor(host: string, user: string): string {
  const hash = createHash('sha256').update(`${host}\u0000${user}`).digest('hex').slice(0, 16);
  return join(os.tmpdir(), `survivor-email-process-${hash}.lock`);
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
