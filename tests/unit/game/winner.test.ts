/**
 * Test del Winner Engine (piano Task 3.4, LLD §7.7, PRD §4.6 RF-18/RF-26).
 *
 * Su DB reale SQLite in-memory + provider reale (LLD §8). I test preparano gli
 * stati direttamente (pick/eliminazioni/round_state), senza passare per
 * tournament:start (briefing §5.1). Verificano:
 * - i tre casi di fine torneo (CS6): vincitore unico (1), eliminazione
 *   collettiva nella stessa ondata (2), superstiti dopo l'ultimo TC scored (3);
 * - il freeze a fine stagione: profilo con pick frozen non contabilizzato resta
 *   in gara e rientra nei superstiti (CS6);
 * - CL12/RF-26: torneo di un turno (aggancio all'ultimo TC) — i casi collassano
 *   senza logica speciale, mai "richiede almeno 2 round".
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import { eliminate } from '../../../src/game/elimination.js';
import { checkWinner } from '../../../src/game/winner.js';
import { loadBaseSeason } from '../../fixtures/season.js';

const T1 = new Date('2026-09-12T20:00:00.000Z'); // ondata TT1
const T2 = new Date('2026-09-19T20:00:00.000Z'); // ondata TT2

/** Crea DB in-memory migrato con la mini-stagione (6 round) e il contesto. */
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
    now: T1
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

/** Segna l'ultimo round della mini-stagione (6) come scored. */
function scoreLastRound(db: Database.Database): void {
  db.prepare("INSERT INTO round_state (round, status) VALUES (6, 'scored')").run();
}

describe('caso 1 — vincitore unico', () => {
  it('un solo profilo attivo (gli altri eliminati) → finished, case 1', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    eliminate(db, b, 'wrong_pick', T1);

    const res = await checkWinner(ctx);
    expect(res).toEqual({
      finished: true,
      case: 1,
      winners: [{ profileId: a, email: 'a@test.it' }]
    });
  });

  it('torneo senza profili → non finito (nessun vincitore)', async () => {
    const { ctx } = makeCtx();
    expect(await checkWinner(ctx)).toEqual({ finished: false, winners: [] });
  });
});

describe('caso 2 — eliminazione collettiva nella stessa ondata (decisione 2)', () => {
  it('zero attivi e gli ultimi eliminated_at coincidono → vittoria condivisa', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    // Eliminati nella STESSA ondata di round:score (stesso clock) → stesso eliminated_at.
    eliminate(db, a, 'wrong_pick', T1);
    eliminate(db, b, 'wrong_pick', T1);

    const res = await checkWinner(ctx);
    expect(res).toEqual({
      finished: true,
      case: 2,
      winners: [
        { profileId: a, email: 'a@test.it' },
        { profileId: b, email: 'b@test.it' }
      ]
    });
  });

  it("l'ultima ondata con un solo profilo → vince lui (ha resistito più a lungo)", async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    const c = insertProfile(db, 'c@test.it');
    eliminate(db, a, 'missing_pick', T1);
    eliminate(db, b, 'missing_pick', T1);
    // c eliminato in un'ondata successiva: è l'ultimo superstite.
    eliminate(db, c, 'wrong_pick', T2);

    const res = await checkWinner(ctx);
    expect(res).toEqual({
      finished: true,
      case: 2,
      winners: [{ profileId: c, email: 'c@test.it' }]
    });
  });
});

describe('caso 3 — superstiti dopo l’ultimo TC scored (CS6)', () => {
  it('2+ attivi con ultimo TC scored → vittoria condivisa', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    scoreLastRound(db);

    const res = await checkWinner(ctx);
    expect(res).toEqual({
      finished: true,
      case: 3,
      winners: [
        { profileId: a, email: 'a@test.it' },
        { profileId: b, email: 'b@test.it' }
      ]
    });
  });

  it('freeze a fine stagione: profilo con pick frozen resta in gara e vince ex aequo (CS6)', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    // b ha un pick frozen nell'ultimo round: NON è eliminato, resta in gara.
    db.prepare(
      "INSERT INTO pick (profile_id, round, team, outcome, status) VALUES (?, 6, 'Juventus FC', 'win', 'frozen')"
    ).run(b);
    scoreLastRound(db);

    const res = await checkWinner(ctx);
    expect(res.finished).toBe(true);
    expect(res.case).toBe(3);
    expect(res.winners.map((w) => w.profileId)).toEqual([a, b]);
  });

  it('2+ attivi a stagione NON conclusa → non finito', async () => {
    const { db, ctx } = makeCtx();
    insertProfile(db, 'a@test.it');
    insertProfile(db, 'b@test.it');
    // Nessun round scored (o un round intermedio scored non basta).
    db.prepare("INSERT INTO round_state (round, status) VALUES (3, 'scored')").run();

    const res = await checkWinner(ctx);
    expect(res).toEqual({ finished: false, winners: [] });
  });
});

describe('CL12/RF-26 — torneo di un turno (aggancio all’ultimo TC)', () => {
  it('aggancio all’ultimo TC: i casi collassano senza logica speciale', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it');
    const b = insertProfile(db, 'b@test.it');
    // Torneo agganciato al TC 6 (start_round=6): dopo lo score del TC 6 con 2
    // attivi → caso 3; il Winner Engine non richiede un numero minimo di round.
    scoreLastRound(db);

    const res = await checkWinner(ctx);
    expect(res).toEqual({
      finished: true,
      case: 3,
      winners: [
        { profileId: a, email: 'a@test.it' },
        { profileId: b, email: 'b@test.it' }
      ]
    });
  });
});
