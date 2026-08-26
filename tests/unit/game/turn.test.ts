/**
 * Test della mappatura TT ↔ TC (piano Task 3.5, briefing Fase 3 §1-E, ADR-008).
 *
 * getStartRound: riga assente/NULL → 1 (legacy); ttFor: TT = TC − start_round + 1
 * (RF-20); forme compatta/estesa per email e CLI (RF-25).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrate } from '../../../src/db/schema.js';
import {
  championshipHeaderLabel,
  getStartRound,
  roundHeaderLabel,
  ttFor,
  turnCompact,
  turnExtended,
  turnFor
} from '../../../src/game/turn.js';

/** DB in-memory migrato (la migrazione NON inserisce la riga tournament_state). */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('getStartRound (ADR-008 n. 4)', () => {
  it('riga tournament_state assente → 1 (legacy)', () => {
    const db = makeDb();
    expect(getStartRound(db)).toBe(1);
    db.close();
  });

  it('start_round NULL → 1 (TC1 legacy)', () => {
    const db = makeDb();
    db.prepare('INSERT INTO tournament_state (id, start_round) VALUES (1, NULL)').run();
    expect(getStartRound(db)).toBe(1);
    db.close();
  });

  it('start_round valorizzato → il valore letto', () => {
    const db = makeDb();
    db.prepare('INSERT INTO tournament_state (id, start_round) VALUES (1, 6)').run();
    expect(getStartRound(db)).toBe(6);
    db.close();
  });
});

describe('ttFor / turnFor (RF-20)', () => {
  it('TT = TC − start_round + 1', () => {
    expect(ttFor(6, 6)).toBe(1); // aggancio al TC 6 → TT 1
    expect(ttFor(7, 6)).toBe(2);
    expect(ttFor(1, 1)).toBe(1); // legacy: TT = TC
    expect(ttFor(38, 20)).toBe(19);
  });

  it('turnFor deriva la coppia dallo stato del torneo', () => {
    const db = makeDb();
    db.prepare('INSERT INTO tournament_state (id, start_round) VALUES (1, 6)').run();
    expect(turnFor(db, 7)).toEqual({ tt: 2, tc: 7 });
    db.close();
  });
});

describe('forme testuali (RF-25)', () => {
  it('forma compatta TTnTCm per oggetto/CLI', () => {
    expect(turnCompact(2, 7)).toBe('TT2TC7');
  });

  it('forma estesa per il corpo email', () => {
    expect(turnExtended(2, 7)).toBe('TT 2, TC 7');
  });
});

describe('label header renderer (ADR-015 email v4)', () => {
  it('roundHeaderLabel → "Round del torneo N"', () => {
    expect(roundHeaderLabel(3)).toBe('Round del torneo 3');
  });

  it('championshipHeaderLabel → "Turno di Campionato M" (maiuscolo)', () => {
    expect(championshipHeaderLabel(5)).toBe('Turno di Campionato 5');
  });
});
