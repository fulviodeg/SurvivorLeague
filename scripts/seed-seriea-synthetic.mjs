/**
 * Seed del calendario sintetico con le 20 squadre REALI di Serie A 2026/27
 * (nomi canonici API football-data.org, costante `SYNTHETIC_TEAMS`). Lo script
 * riusa la stessa pipeline del CLI (generateSyntheticSeason + upsertMatches,
 * ADR-007) con la rosa completa, poi salva i punteggi veri in un JSON e li
 * AZZERA (scenario "risultati che arrivano dopo", guida §5.5).
 *
 * Uso: node --import tsx scripts/seed-seriea-synthetic.mjs
 *   --rounds N --spacing-min M --offset-min K --seed S [--db PATH] [--scores FILE] [--no-null]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

import { SYNTHETIC_TEAMS, generateSyntheticSeason } from '../src/data/synthetic-season.js';
import { upsertMatches } from '../src/data/importer.js';

function parseArg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const rounds = parseArg('rounds', 8);
const spacingMin = parseArg('spacing-min', 10);
const offsetMin = parseArg('offset-min', 10);
const seed = parseArg('seed', 7);
const noNull = process.argv.includes('--no-null');
const dbPath = argValue('db', './data/uat-synthetic-pippo.db');
const scoresPath = argValue('scores', '/tmp/kilo/uat-scores.json');

function argValue(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const db = new Database(dbPath);
const firstKickoff = new Date(Date.now() + offsetMin * 60_000);
const matches = generateSyntheticSeason({
  teams: SYNTHETIC_TEAMS,
  rounds,
  spacingMin,
  firstKickoff,
  seed
});

const n = upsertMatches(db, matches);
console.log(`Seed completato: ${SYNTHETIC_TEAMS.length} squadre Serie A, ${rounds} giornate, ${n} partite`);
console.log(`Primo fischio: ${firstKickoff.toISOString()}`);
console.log(`Ultimo fischio: ${matches[matches.length - 1].matchDate.toISOString()}`);

if (!noNull) {
  const rows = db
    .prepare('SELECT round, home_team, away_team, home_score, away_score FROM match ORDER BY round, home_team')
    .all();
  writeFileSync(scoresPath, JSON.stringify(rows, null, 2));
  const r = db.prepare('UPDATE match SET home_score = NULL, away_score = NULL').run();
  console.log(`Salvati ${rows.length} match in ${scoresPath}, azzerati ${r.changes} punteggi`);
}
db.close();
