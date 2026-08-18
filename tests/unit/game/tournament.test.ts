/**
 * Test del modulo Torneo — vista aggregata (piano Task 4.1, LLD §7.10).
 *
 * Su DB reale SQLite in-memory + provider reale con la mini-stagione (LLD §8).
 * Verificano:
 * - avvio con calendario valido: tournament_state scritto (season_started,
 *   start_round, registration_open=1, RF-22) e round_state pending inizializzati;
 * - RF-21: TC di aggancio inesistente / senza partite / deadline TT1 non futura
 *   → rifiuto ATOMICO (DB invariato);
 * - CL12: aggancio all'ultimo TC → warning informativo;
 * - avvio su stagione già avviata → errore;
 * - openRound su round pending (inizializzato da start) → open;
 * - status: stato aggregato + anomalia deadline_missing (RF-30);
 * - history con coppie TT/TC (RF-25); leaderboard (attivi prima);
 * - export completo e rileggibile (decisione 6).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import { registerPick } from '../../../src/game/pick-processor.js';
import { openRound } from '../../../src/game/round-manager.js';
import {
  startTournament,
  tournamentExport,
  tournamentHistory,
  tournamentLeaderboard,
  tournamentStatus
} from '../../../src/game/tournament.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM] = FIXTURE_TEAMS;

// La mini-stagione ha TC 1..6; kickoff TC 1 = 2026-09-12T16:00Z.
const NOW_BEFORE = new Date('2026-09-01T10:00:00.000Z'); // deadline TT1 futura
const NOW_AFTER = new Date('2026-09-13T10:00:00.000Z'); // deadline TT1 passata

/** Crea il contesto con DB in-memory migrato + mini-stagione. */
function makeCtx(now: Date = NOW_BEFORE): { db: Database.Database; ctx: GameContext } {
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
    now
  };
  return { db, ctx };
}

/** Crea un profilo attivo con email. */
function insertProfile(db: Database.Database, email: string, name = ''): number {
  const pid = db.prepare('INSERT INTO player (email, name) VALUES (?, ?)').run(email, name)
    .lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid)
    .lastInsertRowid as number;
}

describe('tournament:start (US6, RF-21, RF-20)', () => {
  it('avvia la stagione: tournament_state + round_state pending per la finestra', async () => {
    const { db, ctx } = makeCtx();
    const res = await startTournament(ctx);

    expect(res).toMatchObject({
      startRound: 1,
      totalRounds: 6,
      halfBoundary: 4,
      initializedRounds: 6,
      lastRoundWarning: false
    });
    expect(res.tt1Kickoff).toBe('2026-09-12T16:00:00.000Z');
    expect(res.tt1Deadline).toBe('2026-09-12T15:30:00.000Z');
    expect(db.prepare('SELECT season_started, start_round, registration_open FROM tournament_state WHERE id = 1').get())
      .toEqual({ season_started: 1, start_round: 1, registration_open: 1 });
    const pending = db.prepare("SELECT COUNT(*) AS n FROM round_state WHERE status = 'pending'").get() as { n: number };
    expect(pending.n).toBe(6);
  });

  it('aggancio --start-round 4: TT1 = TC 4, righe pending solo per la finestra', async () => {
    const { db, ctx } = makeCtx();
    const res = await startTournament(ctx, { startRound: 4 });
    expect(res.startRound).toBe(4);
    expect(res.initializedRounds).toBe(3); // TC 4..6
    const rows = db.prepare('SELECT round FROM round_state ORDER BY round').all() as Array<{ round: number }>;
    expect(rows.map((r) => r.round)).toEqual([4, 5, 6]);
  });

  it('RF-21: TC di aggancio inesistente → errore e DB invariato (nessuno stato parziale)', async () => {
    const { db, ctx } = makeCtx();
    await expect(startTournament(ctx, { startRound: 7 })).rejects.toThrow(/inesistente/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tournament_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_state').get()).toEqual({ n: 0 });
  });

  it('RF-21: TC senza partite → errore e DB invariato', async () => {
    const { db, ctx } = makeCtx();
    // Svuota il TC 3: il calendario diventa incompleto.
    db.prepare('DELETE FROM match WHERE round = 3').run();
    await expect(startTournament(ctx, { startRound: 1 })).rejects.toThrow(/TC 3 non ha partite/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_state').get()).toEqual({ n: 0 });
  });

  it('RF-21: deadline del TT 1 non futura → rifiuto; allowPastDeadline (seam simulazione) lo consente', async () => {
    const { db, ctx } = makeCtx(NOW_AFTER);
    await expect(startTournament(ctx)).rejects.toThrow(/Deadline del TT 1 non futura/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM round_state').get()).toEqual({ n: 0 });

    const res = await startTournament(ctx, { allowPastDeadline: true });
    expect(res.startRound).toBe(1);
  });

  it('CL12: aggancio all\'ultimo TC → warning informativo, avvio ammesso', async () => {
    const { ctx } = makeCtx();
    const res = await startTournament(ctx, { startRound: 6 });
    expect(res.lastRoundWarning).toBe(true);
  });

  it('stagione già avviata → errore', async () => {
    const { ctx } = makeCtx();
    await startTournament(ctx);
    await expect(startTournament(ctx)).rejects.toThrow(/già avviata/);
  });
});

describe('openRound su round pending (inizializzato da start)', () => {
  it('porta la riga pending a open con deadline', async () => {
    const { db, ctx } = makeCtx();
    await startTournament(ctx);
    const opened = await openRound(ctx, 1);
    expect(opened.status).toBe('open');
    expect(opened.deadline).toBe('2026-09-12T15:30:00.000Z');
    const row = db.prepare("SELECT status, deadline FROM round_state WHERE round = 1").get() as {
      status: string;
      deadline: string | null;
    };
    expect(row.status).toBe('open');
    expect(row.deadline).toBe('2026-09-12T15:30:00.000Z');
  });
});

describe('tournament:status / history / leaderboard / export', () => {
  it('status espone finestra, round corrente, profili e anomalie deadline_missing', async () => {
    const { db, ctx } = makeCtx();
    insertProfile(db, 'a@test.it');
    insertProfile(db, 'b@test.it');
    await startTournament(ctx);
    await openRound(ctx, 1);

    const status = await tournamentStatus(ctx);
    expect(status).toMatchObject({
      seasonStarted: true,
      startRound: 1,
      registrationOpen: true,
      totalRounds: 6,
      halfBoundary: 4,
      currentRound: { tc: 1, tt: 1, status: 'open' },
      activeProfiles: 2,
      eliminatedProfiles: 0
    });
    expect(status.winner.finished).toBe(false);

    // Anomalia: un round open con deadline NULL (chiusura di sicurezza RF-30).
    db.prepare("UPDATE round_state SET status = 'open', deadline = NULL WHERE round = 2").run();
    const withAnomaly = await tournamentStatus(ctx);
    expect(withAnomaly.anomalies).toEqual([{ round: 2, type: 'deadline_missing' }]);
  });

  it('history espone lo storico pick di un profilo con coppie TT/TC (RF-25)', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    await startTournament(ctx);
    await openRound(ctx, 1);
    await registerPick(ctx, {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: new Date('2026-09-12T15:00:00Z')
    });

    const history = tournamentHistory(ctx, 'a@test.it');
    expect(history).toMatchObject({
      profileId: a,
      email: 'a@test.it',
      name: 'Aldo',
      eliminated: false,
      picks: [{ tt: 1, tc: 1, team: IM, outcome: 'win', status: 'pending' }]
    });
    expect(tournamentHistory(ctx, 'sconosciuto@test.it')).toBeNull();
  });

  it('leaderboard: attivi prima (per pick corretti), poi eliminati; currentTurn con TT/TC', async () => {
    const { db, ctx } = makeCtx();
    const a = insertProfile(db, 'a@test.it', 'Aldo');
    const b = insertProfile(db, 'b@test.it', 'Beppe');
    await startTournament(ctx);
    await openRound(ctx, 1);
    await registerPick(ctx, {
      profileId: a,
      round: 1,
      team: IM,
      outcome: 'win',
      receivedAt: new Date('2026-09-12T15:00:00Z')
    });
    db.prepare("UPDATE profile SET eliminated = 1, eliminated_reason = 'missing_pick' WHERE id = ?").run(b);

    const lb = tournamentLeaderboard(ctx);
    expect(lb.currentTurn).toEqual({ tt: 1, tc: 1 });
    expect(lb.entries.map((e) => e.email)).toEqual(['a@test.it', 'b@test.it']);
    expect(lb.entries[0]).toMatchObject({ active: true, picksCorrect: 0 });
    expect(lb.entries[1]).toMatchObject({ active: false, eliminatedReason: 'missing_pick' });
  });

  it('export: dump completo e rileggibile con metadati e mappatura TT/TC', async () => {
    const { db, ctx } = makeCtx();
    insertProfile(db, 'a@test.it');
    await startTournament(ctx, { startRound: 4 });

    const dump = await tournamentExport(ctx);
    expect(dump.startRound).toBe(4);
    expect(dump.totalRounds).toBe(6);
    expect(dump.turns).toEqual([
      { tc: 4, tt: 1 },
      { tc: 5, tt: 2 },
      { tc: 6, tt: 3 }
    ]);
    expect(dump.tables.match.length).toBeGreaterThan(0);
    expect(dump.tables.player.length).toBe(1);
    expect(dump.tables.tournament_state).toHaveLength(1);
    // Rileggibile: round-trip JSON identico.
    expect(JSON.parse(JSON.stringify(dump))).toEqual(dump);
  });
});
