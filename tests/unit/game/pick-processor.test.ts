/**
 * Test del Pick Processor (piano Task 3.2, LLD §7.4/§3.1) — cascata di
 * validazione con motivo dedicato, guard anti-frode RF-31, register atomico.
 *
 * Girano sul DB reale SQLite in-memory + DbSeasonDataProvider reale con la
 * mini-stagione (LLD §8: provider mai mockato). Verificano:
 * - ogni motivo della cascata (CL3/CL4/CL5/RF-08/RF-10/RF-11);
 * - il guard anti-frode RF-31: rifiuto oltre il kickoff EFFETTIVO con deadline
 *   NULL (CL17) e con calendario anticipato (CL18);
 * - CS4: receivedAt forzato oltre/entro l'accettazione;
 * - CS2/CL6: due invii concorrenti → uno solo passa (vincolo UNIQUE);
 * - override US10 con --reason: bypassa solo i check temporali (una squadra
 *   bruciata resta rifiutata, briefing §1-G).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import {
  registerPick,
  validatePick,
  type PickInput
} from '../../../src/game/pick-processor.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM, AC] = FIXTURE_TEAMS;

// Deadline registrata all'apertura del round 1: kickoff (2026-09-12T16:00:00Z) - 30 min.
const R1_DEADLINE = '2026-09-12T15:30:00.000Z';

/** Ide: receivedAt entro l'accettazione (validità temporale). */
const EARLY = new Date('2026-09-12T15:00:00.000Z');
/** receivedAt oltre la deadline ma prima del kickoff → after_acceptance. */
const AFTER_DEADLINE = new Date('2026-09-12T15:35:00.000Z');
/** receivedAt oltre il kickoff → after_kickoff. */
const AFTER_KICKOFF = new Date('2026-09-12T16:10:00.000Z');

/** Crea un contesto di gioco su DB in-memory migrato e con la mini-stagione. */
function makeCtx(winOnly = false): { db: Database.Database; ctx: GameContext } {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const dataProvider = new DbSeasonDataProvider(db);
  const config = parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    ...(winOnly ? { WIN_ONLY: 'true' } : { WIN_ONLY: 'false' })
  });
  const ctx: GameContext = {
    db,
    dataProvider,
    config,
    now: new Date('2026-09-12T15:00:00.000Z')
  };
  return { db, ctx };
}

/** Crea un profilo attivo e restituisce il suo id. */
function insertProfile(db: Database.Database, email = 'p@test.it'): number {
  const pid = db.prepare('INSERT INTO player (email) VALUES (?)').run(email).lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid).lastInsertRowid as number;
}

/** Apre il round 1 (status open) con la deadline registrata (o NULL se assente). */
function openRound1(db: Database.Database, deadline: string | null = R1_DEADLINE): void {
  db.prepare('INSERT INTO round_state (round, status, deadline) VALUES (1, ?, ?)').run(
    'open',
    deadline
  );
}

/** Input minimo valido del round 1 (in giornata, non bruciato, esito win). */
function baseInput(override: Partial<PickInput> = {}): PickInput {
  return {
    profileId: 1,
    round: 1,
    team: IM,
    outcome: 'win',
    receivedAt: EARLY,
    ...override
  };
}

describe('cascata di validazione — gate di profilo e contenuto (LLD §3.1)', () => {
  it('profilo inesistente → profile_not_registered', async () => {
    const { ctx } = makeCtx();
    expect(await validatePick(ctx, baseInput({ profileId: 999 }))).toEqual({
      valid: false,
      reason: 'profile_not_registered'
    });
  });

  it('profilo eliminato → profile_eliminated', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    db.prepare("UPDATE profile SET eliminated = 1, eliminated_reason = 'wrong_pick' WHERE id = ?").run(pid);
    expect(await validatePick(ctx, baseInput({ profileId: pid }))).toEqual({
      valid: false,
      reason: 'profile_eliminated'
    });
  });

  it('squadra non nella lista canonica → unknown_team (CL5, check esatto post-parse)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, team: 'Inter' }))).toEqual({
      valid: false,
      reason: 'unknown_team'
    });
  });

  it('squadra canonica che non gioca nel TC → team_not_in_round (CL4)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    // La mini-stagione a 4 squadre ha TUTTE le squadre in gioco a ogni round:
    // per esercitare CL4 aggiungiamo una squadra canonica extra (gioca solo in
    // R6) che entra in getTeams() ma NON gioca nel TC 2.
    db.prepare(
      "INSERT INTO match (round, match_date, home_team, away_team, postponed) VALUES (6, '2026-10-17T16:00:00Z', 'Napoli', 'Bologna', 0)"
    ).run();
    expect(
      await validatePick(ctx, baseInput({ profileId: pid, round: 2, team: 'Napoli' }))
    ).toEqual({
      valid: false,
      reason: 'team_not_in_round'
    });
  });

  it('esito fuori enum → invalid_outcome (RF-11)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'draw?' }))).toEqual({
      valid: false,
      reason: 'invalid_outcome'
    });
  });

  it('pick già esistente per profilo+round → pick_already_exists (RF-08/CL6)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    db.prepare("INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, 1, ?, 'win')").run(
      pid,
      IM
    );
    // AC non è bruciata, ma esiste già un pick per (profilo, round 1): il motivo
    // dedicato scatta solo se la cascata supera i check precedenti (AC è valida).
    expect(await validatePick(ctx, baseInput({ profileId: pid, team: AC }))).toEqual({
      valid: false,
      reason: 'pick_already_exists'
    });
  });

  it('squadra già bruciata nel girone → team_already_used (RF-10/CS5), anche in pick separati', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    // Brucia IM nel round 1 (girone di andata).
    db.prepare(
      "INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, 1, ?, 'win')"
    ).run(pid, IM);
    // IM gioca anche in R2 (IM-JU) ma è già bruciata nel girone.
    expect(await validatePick(ctx, baseInput({ profileId: pid, round: 2, team: IM }))).toEqual({
      valid: false,
      reason: 'team_already_used'
    });
  });
});

describe('accettazione temporale — round aperto, deadline e guard RF-31', () => {
  it('round non aperto (round_state assente) → round_not_open (CL3)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid }))).toEqual({
      valid: false,
      reason: 'round_not_open'
    });
  });

  it('pick valido entro accettazione → valid (CS4: ricevuto in tempo anche se processato dopo)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid }))).toEqual({ valid: true });
  });

  it('receivedAt oltre la deadline ma prima del kickoff → after_acceptance (CS4)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, receivedAt: AFTER_DEADLINE }))).toEqual({
      valid: false,
      reason: 'after_acceptance'
    });
  });

  it('guard RF-31 CL17: deadline NULL, pick oltre il kickoff effettivo → after_kickoff', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db, null); // deadline non registrata → vale solo il kickoff
    expect(await validatePick(ctx, baseInput({ profileId: pid, receivedAt: AFTER_KICKOFF }))).toEqual({
      valid: false,
      reason: 'after_kickoff'
    });
  });

  it('guard RF-31 CL18: calendario anticipa, pick oltre il nuovo kickoff → after_kickoff', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    // Il calendario anticipa la prima partita del TC (refresh successivo): nuovo kickoff 14:00.
    db.prepare(
      'UPDATE match SET match_date = ? WHERE round = 1 AND home_team = ? AND away_team = ?'
    ).run('2026-09-12T14:00:00.000Z', IM, AC);
    // receivedAt 15:00: dopo il kickoff (14:00) ma prima della deadline registrata (15:30).
    expect(await validatePick(ctx, baseInput({ profileId: pid, receivedAt: EARLY }))).toEqual({
      valid: false,
      reason: 'after_kickoff'
    });
  });

  it('guard RF-31 CL18: receivedAt prima del nuovo kickoff resta accettato', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    db.prepare(
      'UPDATE match SET match_date = ? WHERE round = 1 AND home_team = ? AND away_team = ?'
    ).run('2026-09-12T14:00:00.000Z', IM, AC);
    // receivedAt 13:00: prima sia del kickoff sia della deadline.
    expect(
      await validatePick(ctx, baseInput({ profileId: pid, receivedAt: new Date('2026-09-12T13:00:00Z') }))
    ).toEqual({ valid: true });
  });
});

describe('registerPick — atomicità e override (CS2/CL6/RF-31, US10)', () => {
  it('registra un pick valido e restituisce id+status', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    const res = await registerPick(ctx, baseInput({ profileId: pid }));
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    if (res.ok) {
      expect(db.prepare('SELECT team FROM pick WHERE id = ?').get(res.id)).toEqual({ team: IM });
    }
  });

  it('due invii concorrenti sullo stesso profilo+round → uno solo passa (CS2/CL6)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    const first = await registerPick(ctx, baseInput({ profileId: pid }));
    const second = await registerPick(ctx, baseInput({ profileId: pid, team: AC }));
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'pick_already_exists' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pick WHERE profile_id = ?').get(pid)).toEqual({ n: 1 });
  });

  it('override --reason bypassa after_acceptance (US10, pick fuori accettazione)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    const res = await registerPick(
      ctx,
      baseInput({ profileId: pid, receivedAt: AFTER_DEADLINE }),
      { reason: 'intervento commissioner' }
    );
    expect(res).toMatchObject({ ok: true });
  });

  it('override --reason NON aggira una squadra bruciata (briefing §1-G)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    db.prepare("INSERT INTO pick (profile_id, round, team, outcome) VALUES (?, 1, ?, 'win')").run(pid, IM);
    // IM già bruciata; anche con reason l'inserimento di IM è rifiutato.
    const res = await registerPick(ctx, baseInput({ profileId: pid, team: IM }), {
      reason: 'rimedio'
    });
    expect(res).toEqual({ ok: false, reason: 'team_already_used' });
  });

  it('override NON aggira un round non aperto (gate sostanziale, non temporale)', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    const res = await registerPick(ctx, baseInput({ profileId: pid }), { reason: 'x' });
    expect(res).toEqual({ ok: false, reason: 'round_not_open' });
  });

  it('Decisione A (RNF1): created_at del pick = clock iniettato, non datetime(\'now\')', async () => {
    const { db, ctx } = makeCtx();
    const pid = insertProfile(db);
    openRound1(db);
    const res = await registerPick(ctx, baseInput({ profileId: pid }));
    expect(res.ok).toBe(true);
    const row = db.prepare('SELECT created_at FROM pick WHERE profile_id = ?').get(pid) as {
      created_at: string;
    };
    expect(row.created_at).toBe(ctx.now.toISOString());
  });
});

describe('win_only — cascata invalid_outcome mode-aware (ADR-016)', () => {
  it('outcome win → valido in win_only', async () => {
    const { db, ctx } = makeCtx(true);
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'win' }))).toEqual({
      valid: true
    });
  });

  it('outcome draw → invalid_outcome in win_only (pareggio = pick sbagliato)', async () => {
    const { db, ctx } = makeCtx(true);
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'draw' }))).toEqual({
      valid: false,
      reason: 'invalid_outcome'
    });
  });

  it('outcome lose → invalid_outcome in win_only (sconfitta = pick sbagliato)', async () => {
    const { db, ctx } = makeCtx(true);
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'lose' }))).toEqual({
      valid: false,
      reason: 'invalid_outcome'
    });
  });

  it('in modalità classica draw/lose restano validi (nessuna regressione)', async () => {
    const { db, ctx } = makeCtx(false);
    const pid = insertProfile(db);
    openRound1(db);
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'draw' }))).toEqual({
      valid: true
    });
    expect(await validatePick(ctx, baseInput({ profileId: pid, outcome: 'lose' }))).toEqual({
      valid: true
    });
  });
});
