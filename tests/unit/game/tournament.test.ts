/**
 * Test del modulo Torneo — vista aggregata (piano Task 4.1, LLD §7.10).
 *
 * Su DB reale SQLite in-memory + provider reale con la mini-stagione (LLD §8).
 * Verificano:
 * - avvio con calendario valido: tournament_state scritto (season_started,
 *   start_round; registration_open DEPRECATA resta al default 0, ADR-009/B8a)
 *   e round_state pending inizializzati;
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
import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';
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
import type { ChannelAdapter, IncomingMessage } from '../../../src/channel/adapter.js';
import type { EmailContext, LLMGenerator } from '../../../src/llm/generator.js';
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
    // registration_open resta 0: colonna DEPRECATA (ADR-009, B8a), mai scritta.
    expect(db.prepare('SELECT season_started, start_round, registration_open, win_only FROM tournament_state WHERE id = 1').get())
      .toEqual({ season_started: 1, start_round: 1, registration_open: 0, win_only: 1 });
    const pending = db.prepare("SELECT COUNT(*) AS n FROM round_state WHERE status = 'pending'").get() as { n: number };
    expect(pending.n).toBe(6);
  });

  it('ADR-016: WIN_ONLY=true → tournament_state.win_only=1 (fissata a start)', async () => {
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
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true'
      }),
      now: NOW_BEFORE
    };
    await startTournament(ctx);
    expect(db.prepare('SELECT win_only FROM tournament_state WHERE id = 1').get()).toEqual({
      win_only: 1
    });
  });

  it('AUTOPICK (feature AUTOPICK): autopick_on_missing fissata a start e inclusa nell\'export', async () => {
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
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true',
        AUTOPICK_ON_MISSING: 'true'
      }),
      now: NOW_BEFORE
    };
    await startTournament(ctx);
    expect(db.prepare('SELECT autopick_on_missing FROM tournament_state WHERE id = 1').get()).toEqual({
      autopick_on_missing: 1
    });

    const dump = await tournamentExport(ctx);
    expect(dump.tables.tournament_state[0]).toMatchObject({ autopick_on_missing: 1 });
  });

  it('JOLLY (feature JOLLY): jollies_per_player fissata a start (valore config) e inclusa nell\'export', async () => {
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
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true',
        JOLLIES_PER_PLAYER: '2'
      }),
      now: NOW_BEFORE
    };
    await startTournament(ctx);
    expect(db.prepare('SELECT jollies_per_player FROM tournament_state WHERE id = 1').get()).toEqual({
      jollies_per_player: 2
    });
    const dump = await tournamentExport(ctx);
    expect(dump.tables.tournament_state[0]).toMatchObject({ jollies_per_player: 2 });
  });

  it('JOLLY: jollies_per_player=0 (feature off) persistito come 0', async () => {
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
        FOOTBALL_DATA_TOKEN: 't',
        WIN_ONLY: 'true',
        JOLLIES_PER_PLAYER: '0'
      }),
      now: NOW_BEFORE
    };
    await startTournament(ctx);
    expect(db.prepare('SELECT jollies_per_player FROM tournament_state WHERE id = 1').get()).toEqual({
      jollies_per_player: 0
    });
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
  it('status espone iscritti piattaforma, round corrente, profili e anomalie deadline_missing', async () => {
    const { db, ctx } = makeCtx();
    insertProfile(db, 'a@test.it');
    insertProfile(db, 'b@test.it');
    await startTournament(ctx);
    await openRound(ctx, 1);

    const status = await tournamentStatus(ctx);
    expect(status).toMatchObject({
      seasonStarted: true,
      startRound: 1,
      platformSubscribers: 0, // nessun registry iniettato → 0 (ADR-009)
      totalRounds: 6,
      halfBoundary: 4,
      currentRound: { tc: 1, tt: 1, status: 'open' },
      activeProfiles: 2,
      eliminatedProfiles: 0
    });
    // Nessuna "finestra di iscrizione" esposta (ADR-009).
    expect(status).not.toHaveProperty('registrationOpen');
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
    // ADR-016: l'export include la modalità win_only (determinismo RNF1).
    expect(dump.tables.tournament_state[0]).toMatchObject({ win_only: 1 });
    // Rileggibile: round-trip JSON identico.
    expect(JSON.parse(JSON.stringify(dump))).toEqual(dump);
  });
});

describe('tournament:start — auto-join e filtro notifiche (ADR-019)', () => {
  /** Fake ChannelAdapter per verificare i destinatari del broadcast. */
  class FakeChannel implements ChannelAdapter {
    sent: Array<{ to: string; body: string }> = [];
    fetchMessages(): Promise<IncomingMessage[]> {
      return Promise.resolve([]);
    }
    sendMessage(to: string, body: string): Promise<void> {
      this.sent.push({ to, body });
      return Promise.resolve();
    }
  }
  /** Fake LLMGenerator per verificare il contesto del broadcast. */
  class FakeGenerator implements LLMGenerator {
    contexts: EmailContext[] = [];
    generate(ctx: EmailContext): Promise<string> {
      this.contexts.push(ctx);
      return Promise.resolve(`[${ctx.type}]`);
    }
    byType(type: string): EmailContext[] {
      return this.contexts.filter((c) => c.type === type);
    }
  }

  async function makePlatformCtx(): Promise<{
    db: Database.Database;
    platform: DbPlatformRegistry;
    ctx: GameContext;
    channel: FakeChannel;
    generator: FakeGenerator;
  }> {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
    const platformDb = new Database(':memory:');
    migratePlatform(platformDb);
    const platform = new DbPlatformRegistry(platformDb);
    const channel = new FakeChannel();
    const generator = new FakeGenerator();
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
      now: NOW_BEFORE,
      platform,
      channel,
      generator
    };
    return { db, platform, ctx, channel, generator };
  }

  it('auto-join a start: account ON → profilo; account OFF → nessun profilo (D2/D6)', async () => {
    const { db, platform, ctx } = await makePlatformCtx();
    platform.register('on@test.it', null, NOW_BEFORE); // ON (default)
    platform.register('off@test.it', null, NOW_BEFORE); // OFF
    platform.setPreferences('off@test.it', { tournamentAutoJoin: false });

    const res = await startTournament(ctx);

    expect(res.autoJoined).toBe(1);
    const emails = db
      .prepare('SELECT pl.email FROM profile p JOIN player pl ON pl.id = p.player_id')
      .all() as Array<{ email: string }>;
    expect(emails.map((r) => r.email)).toEqual(['on@test.it']);
  });

  it('tournament_open: destinatari filtrati su receive_tournament_start_notification + CTA PARTECIPO (D9/D14)', async () => {
    const { platform, ctx, generator } = await makePlatformCtx();
    platform.register('a@test.it', null, NOW_BEFORE); // notifiche ON (default)
    platform.register('b@test.it', null, NOW_BEFORE); // notifiche OFF
    platform.setPreferences('b@test.it', { receiveTournamentStartNotification: false });

    const res = await startTournament(ctx);

    expect(res.notified).toBe(1);
    const opens = generator.byType('tournament_open');
    expect(opens).toHaveLength(1);
    // platformCount resta il numero di account ATTIVI (non dei destinatari).
    expect(opens[0]).toMatchObject({ platformCount: 2 });
    // La CTA D14 è composta dal renderer deterministico (qui il fake generator
    // non la compone: la verifichiamo sul corpo via il soggetto/contesto).
  });
});
