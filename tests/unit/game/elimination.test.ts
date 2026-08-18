/**
 * Test dell'Elimination Engine (piano Task 3.3, LLD §7.6, PRD §5.2).
 *
 * Su DB reale SQLite in-memory (nessun mock, LLD §8). Verificano:
 * - i due casi di eliminazione (missing_pick al close, wrong_pick allo score)
 *   con eliminated_at dal clock iniettato (decisione A, determinismo CS4);
 * - l'idempotenza: un profilo già eliminato non viene ri-eliminato e conserva
 *   motivo e istante della PRIMA eliminazione (PRD §5.4);
 * - elimination:check/list in sola lettura;
 * - l'interazione col Pick Processor: un profilo eliminato non può più inviare
 *   pick (motivo profile_eliminated, LLD §3.1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import {
  checkElimination,
  eliminate,
  listEliminated
} from '../../../src/game/elimination.js';
import { validatePick } from '../../../src/game/pick-processor.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM] = FIXTURE_TEAMS;
const NOW = new Date('2026-09-12T16:30:00.000Z');
const LATER = new Date('2026-09-19T20:00:00.000Z');

/** Crea DB in-memory migrato con la mini-stagione e il contesto di gioco. */
function makeCtx(): { db: Database.Database; ctx: GameContext } {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const ctx: GameContext = {
    db,
    dataProvider: new DbSeasonDataProvider(db),
    config: parseConfig({
      IMAP_USER: 'u',
      IMAP_PASS: 'p',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      LLM_API_KEY: 'k',
      FOOTBALL_DATA_TOKEN: 't'
    }),
    now: NOW
  };
  return { db, ctx };
}

/** Crea un profilo attivo con email. */
function insertProfile(db: Database.Database, email: string): number {
  const pid = db.prepare('INSERT INTO player (email) VALUES (?)').run(email)
    .lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid)
    .lastInsertRowid as number;
}

describe('eliminate — i due casi (PRD §5.2)', () => {
  it('missing_pick: elimina con motivo e timestamp dal clock iniettato', () => {
    const { db } = makeCtx();
    const pid = insertProfile(db, 'a@test.it');

    const status = eliminate(db, pid, 'missing_pick', NOW);

    expect(status).toEqual({
      eliminated: true,
      reason: 'missing_pick',
      eliminatedAt: '2026-09-12T16:30:00.000Z'
    });
    expect(
      db.prepare('SELECT eliminated, eliminated_reason, eliminated_at FROM profile WHERE id = ?').get(pid)
    ).toEqual({
      eliminated: 1,
      eliminated_reason: 'missing_pick',
      eliminated_at: '2026-09-12T16:30:00.000Z'
    });
  });

  it('wrong_pick: elimina con il motivo dedicato', () => {
    const { db } = makeCtx();
    const pid = insertProfile(db, 'b@test.it');

    const status = eliminate(db, pid, 'wrong_pick', NOW);

    expect(status).toMatchObject({ eliminated: true, reason: 'wrong_pick' });
  });

  it('è idempotente: un profilo già eliminato conserva motivo e istante della prima eliminazione', () => {
    const { db } = makeCtx();
    const pid = insertProfile(db, 'c@test.it');

    eliminate(db, pid, 'wrong_pick', NOW);
    // Nel TT successivo il close proverebbe a ri-eliminare come missing: no-op.
    const second = eliminate(db, pid, 'missing_pick', LATER);

    expect(second).toEqual({
      eliminated: true,
      reason: 'wrong_pick',
      eliminatedAt: '2026-09-12T16:30:00.000Z'
    });
  });

  it('su un profilo inesistente non fa nulla e non crasha', () => {
    const { db } = makeCtx();
    expect(eliminate(db, 999, 'missing_pick', NOW)).toEqual({ eliminated: false });
  });
});

describe('checkElimination / listEliminated — lettura dello stato', () => {
  it('checkElimination: profilo attivo → eliminated false; eliminato → motivo+istante', () => {
    const { db } = makeCtx();
    const active = insertProfile(db, 'd@test.it');
    const gone = insertProfile(db, 'e@test.it');
    eliminate(db, gone, 'missing_pick', NOW);

    expect(checkElimination(db, active)).toEqual({ eliminated: false });
    expect(checkElimination(db, gone)).toEqual({
      eliminated: true,
      reason: 'missing_pick',
      eliminatedAt: '2026-09-12T16:30:00.000Z'
    });
    expect(checkElimination(db, 999)).toEqual({ eliminated: false });
  });

  it('listEliminated elenca i profili eliminati con email, motivo e istante', () => {
    const { db } = makeCtx();
    const p1 = insertProfile(db, 'f@test.it');
    const p2 = insertProfile(db, 'g@test.it');
    insertProfile(db, 'h@test.it'); // resta in gara
    eliminate(db, p1, 'wrong_pick', NOW);
    eliminate(db, p2, 'missing_pick', LATER);

    expect(listEliminated(db)).toEqual([
      {
        profileId: p1,
        email: 'f@test.it',
        reason: 'wrong_pick',
        eliminatedAt: '2026-09-12T16:30:00.000Z'
      },
      {
        profileId: p2,
        email: 'g@test.it',
        reason: 'missing_pick',
        eliminatedAt: '2026-09-19T20:00:00.000Z'
      }
    ]);
  });
});

describe('interazione col Pick Processor (LLD §3.1)', () => {
  it('un profilo eliminato non può più inviare pick (profile_eliminated)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db, 'i@test.it');
    db.prepare("INSERT INTO round_state (round, status) VALUES (1, 'open')").run();
    eliminate(db, pid, 'missing_pick', NOW);

    const result = await validatePick(ctx, {
      profileId: pid,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: NOW
    });

    expect(result).toEqual({ valid: false, reason: 'profile_eliminated' });
  });
});
