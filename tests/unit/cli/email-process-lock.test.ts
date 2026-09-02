/**
 * Test del lock file per `channel:email:process`
 * (src/cli/email-process-lock.ts, anti-concorrenza cron).
 *
 * Verificano il modulo puro (il handler CLI è solo wiring) su directory
 * temporanee (`fs.mkdtempSync`): MAI sulla `data/` reale del repo. Nessuna
 * rete, nessun DB: solo `node:fs` + `process.kill(pid, 0)`.
 *
 * Coprono: derivazione del path dalla CASELLA IMAP (stessa casella → stesso
 * lock, caselle diverse → lock diversi, path in os.tmpdir()),
 * acquisizione esclusiva (secondo acquire → null), rilascio,
 * steal del lock stantio (PID morto / contenuto corrotto + mtime vecchio),
 * fallback mtime che NON scatta su contenuto corrotto ma mtime fresco,
 * touch dell'mtime e rilascio no-op su file assente.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  acquireLock,
  lockPathFor,
  readHolderPid,
  releaseLock,
  STALE_MS,
  touchLock
} from '../../../src/cli/email-process-lock.js';

/** Directory temporanea pulita per ogni test. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'email-lock-'));
}

describe('lockPathFor', () => {
  it('stessa casella → stesso path (lock condiviso tra ambienti, mai per DB)', () => {
    const a = lockPathFor('imap.gmail.com', 'a@example.com');
    const b = lockPathFor('imap.gmail.com', 'a@example.com');
    expect(a).toBe(b);
  });

  it('il path vive in os.tmpdir() (condiviso tra gli ambienti della macchina)', () => {
    const p = lockPathFor('imap.gmail.com', 'a@example.com');
    expect(p.startsWith(os.tmpdir() + path.sep)).toBe(true);
  });

  it('utenti diversi → lock diversi (caselle diverse non collidono)', () => {
    const a = lockPathFor('imap.gmail.com', 'a@example.com');
    const b = lockPathFor('imap.gmail.com', 'b@example.com');
    expect(a).not.toBe(b);
  });

  it('host diversi → lock diversi', () => {
    const a = lockPathFor('imap.gmail.com', 'a@example.com');
    const b = lockPathFor('imap.other.com', 'a@example.com');
    expect(a).not.toBe(b);
  });
});

describe('acquireLock', () => {
  it('crea il file (e la directory padre se assente) con il PID corrente e restituisce l\'handle', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'nested', 'x.db.lock');
    const lock = acquireLock(lockPath);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(readHolderPid(lockPath)).toBe(process.pid);
  });

  it('secondo acquire sullo stesso path → null (lock vivo)', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    const first = acquireLock(lockPath);
    expect(first).not.toBeNull();
    expect(acquireLock(lockPath)).toBeNull();
    expect(readHolderPid(lockPath)).toBe(process.pid);
  });

  it('release rimuove il file; un acquire successivo riesce', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    const lock = acquireLock(lockPath)!;
    releaseLock(lock);
    expect(fs.existsSync(lockPath)).toBe(false);
    const again = acquireLock(lockPath);
    expect(again).not.toBeNull();
    expect(again!.pid).toBe(process.pid);
  });

  it('lock stantio con PID morto (ESRCH) → ruba e riesce', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    fs.writeFileSync(lockPath, '999999');
    const lock = acquireLock(lockPath);
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(readHolderPid(lockPath)).toBe(process.pid);
  });

  it('contenuto corrotto + mtime vecchio oltre STALE_MS → ruba e riesce', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    fs.writeFileSync(lockPath, 'not-a-pid');
    const old = new Date(Date.now() - STALE_MS - 1000);
    fs.utimesSync(lockPath, old, old);
    const lock = acquireLock(lockPath);
    expect(lock).not.toBeNull();
    expect(readHolderPid(lockPath)).toBe(process.pid);
  });

  it('contenuto corrotto + mtime fresco → null (fallback mtime non scatta)', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    fs.writeFileSync(lockPath, 'not-a-pid');
    expect(acquireLock(lockPath)).toBeNull();
  });
});

describe('touchLock / releaseLock', () => {
  it('touchLock aggiorna l\'mtime del lock', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    const lock = acquireLock(lockPath)!;
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    const before = fs.statSync(lockPath).mtimeMs;
    touchLock(lock);
    expect(fs.statSync(lockPath).mtimeMs).toBeGreaterThan(before);
  });

  it('releaseLock è no-op se il file è già assente (non lancia)', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.db.lock');
    const lock = acquireLock(lockPath)!;
    fs.unlinkSync(lockPath);
    expect(() => releaseLock(lock)).not.toThrow();
  });
});
