/**
 * Watcher UAT scheduler run 3 — inietta i risultati veri del round N esattamente
 * 3 scheduler tick dopo la chiusura del round N (simula data:refresh che arriva
 * in ritardo). Loop ogni 10s, idempotente: un round già iniettato non viene
 * ritoccato. Uso: node scripts/uat-inject-watcher.mjs
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const DB_PATH = './data/uat-synthetic-pippo.db';
const SCORES = JSON.parse(readFileSync('/tmp/kilo/uat-scores.json', 'utf8'));

const db = new Database(DB_PATH);

// Ticks già osservati dopo la chiusura di ogni round (per conteggiare 3 tick).
const ticksAfterClose = new Map();
let lastTickSeen = null;

function injectRound(round) {
  const up = db.prepare('UPDATE match SET home_score = ?, away_score = ? WHERE round = ? AND home_team = ?');
  let changes = 0;
  for (const m of SCORES.filter((s) => s.round === round)) {
    changes += up.run(m.home_score, m.away_score, m.round, m.home_team).changes;
  }
  console.log(`[watcher] ${new Date().toISOString()} INIETTATO round ${round} (${changes} punteggi)`);
}

async function tick() {
  const now = new Date().toISOString().slice(0, 16); // minuto corrente
  const rows = db.prepare('SELECT round, status, closed_at, scored_at FROM round_state ORDER BY round').all();

  for (const r of rows) {
    if (r.status !== 'closed') continue;
    if (r.scored_at !== null) continue; // già contabilizzato
    if (hasScore(r.round)) continue; // già iniettato

    // Conta i tick in cui il round è closed ma non scored (senza risultati).
    if (lastTickSeen !== now) {
      ticksAfterClose.set(r.round, (ticksAfterClose.get(r.round) ?? 0) + 1);
    }
    const count = ticksAfterClose.get(r.round) ?? 0;
    if (count >= 3) {
      injectRound(r.round);
      ticksAfterClose.delete(r.round);
    }
  }
  lastTickSeen = now;
}

function hasScore(round) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM match WHERE round = ? AND home_score IS NOT NULL')
    .get(round);
  return row.n > 0;
}

console.log('[watcher] avviato — inietta i risultati 3 tick dopo ogni chiusura');
setInterval(tick, 10000);
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
