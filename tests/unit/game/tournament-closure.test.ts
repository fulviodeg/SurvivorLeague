/**
 * Test della CHIUSURA AUTOMATICA E COMPLETA del torneo (ADR-011, Task 8).
 *
 * DB reale SQLite in-memory (torneo + PIATTAFORMA) + provider reale con la
 * mini-stagione; channel/generator FAKE (confini esterni). Verificano:
 *   - caso 1 (un solo superstite dopo scoreRound): vincitore notificato
 *     (`tournament_won`), guardia atomica `winner_notified=1` +
 *     `finished_at` dal clock, EXPORT AUTOMATICO scritto in
 *     `TOURNAMENT_EXPORT_DIR` e coerente con `tournamentExport` (RNF1:
 *     filename dal clock iniettato);
 *   - caso 3 (2+ superstiti dopo l'ultimo TC scored): `tournament_shared_win`
 *     a entrambi;
 *   - doppio scoreRound → NESSUNA duplicazione (guardia idempotente: un solo
 *     export, una sola notifica);
 *   - vincitore con account NON active → nessuna email (filtro RF-P6);
 *   - scheduler FERMO a torneo chiuso (`computeActions` → [], tick senza
 *     eventi) e `scheduler:status` con `tournamentFinished`;
 *   - `tournament:start` RIAMMISSIBILE dopo la chiusura: reset ATOMICO del
 *     DB di GIOCO (pick/profile/player/round_state), tournament_state
 *     ripristinato (`winner_notified=0`), DB piattaforma INTATTO (ADR-009);
 *   - riavvio SENZA chiusura → rifiuto invariato ("stagione già avviata").
 */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../../src/channel/adapter.js';
import { makeArchiveTournament } from '../../../src/cli/archive-wiring.js';
import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';
import type { GameContext } from '../../../src/game/context.js';
import type { EmailContext, LLMGenerator } from '../../../src/llm/generator.js';
import { closeRound, openRound, scoreRound } from '../../../src/game/round-manager.js';
import { registerPick } from '../../../src/game/pick-processor.js';
import { computeActions, schedulerStatus, schedulerTick } from '../../../src/game/scheduler.js';
import { exportFilename, startTournament, tournamentExport } from '../../../src/game/tournament.js';
import { createLogger } from '../../../src/logger.js';
import { FIXTURE_TEAMS, loadBaseSeason, setScore } from '../../fixtures/season.js';

const [IM, AC, JU, MA] = FIXTURE_TEAMS;

const NOW = new Date('2026-09-01T10:00:00.000Z');
const T_PICK = new Date('2026-09-12T15:00:00.000Z'); // entro deadline TT1
const T_CLOSE = new Date('2026-09-12T15:31:00.000Z'); // dopo deadline
const T_SCORE = new Date('2026-09-12T21:00:00.000Z'); // dopo tcClose

/** Fake ChannelAdapter: registra gli invii. */
class FakeChannel implements ChannelAdapter {
  sent: Array<{ to: string; body: string; subject?: string }> = [];
  fetchMessages(): Promise<IncomingMessage[]> {
    return Promise.resolve([]);
  }
  sendMessage(to: string, body: string, subject?: string): Promise<void> {
    this.sent.push({ to, body, subject });
    return Promise.resolve();
  }
}

/** Fake LLMGenerator: registra i contesti per tipo. */
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

interface Harness {
  db: Database.Database;
  platformDb: Database.Database;
  platform: DbPlatformRegistry;
  ctx: GameContext;
  channel: FakeChannel;
  generator: FakeGenerator;
  exportDir: string;
}

/** Banco di prova: DB torneo + DB piattaforma + fake I/O + export dir temporanea. */
async function makeHarness(): Promise<Harness> {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const platformDb = new Database(':memory:');
  migratePlatform(platformDb);
  const platform = new DbPlatformRegistry(platformDb);
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  const exportDir = mkdtempSync(join(tmpdir(), 'sl-export-'));
  const lines: string[] = [];
  const config = parseConfig({
    IMAP_USER: 'u',
    IMAP_PASS: 'p',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    LLM_API_KEY: 'k',
    FOOTBALL_DATA_TOKEN: 't',
    DEADLINE_ADVANCE_MIN: '30',
    MATCH_DURATION_MIN: '105',
    TC_CLOSE_SKEW_MIN: '15',
    TOURNAMENT_EXPORT_DIR: exportDir
  });
  const ctx: GameContext = {
    db,
    dataProvider: new DbSeasonDataProvider(db),
    config,
    now: NOW,
    channel,
    generator,
    platform,
    // Seam di archiviazione reale (ADR-011 §1.3) sulla dir temporanea: il
    // gate di riavvio richiede export_path valorizzato.
    archiveTournament: makeArchiveTournament(config),
    logger: createLogger('debug', { write: (chunk: string) => void lines.push(chunk) })
  };
  return { db, platformDb, platform, ctx, channel, generator, exportDir };
}

/** Crea un profilo torneo per email (partecipazione già esistente). */
function insertProfile(db: Database.Database, email: string, name: string): number {
  const pid = db
    .prepare('INSERT INTO player (email, name) VALUES (?, ?)')
    .run(email, name).lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid).lastInsertRowid as number;
}

/** Registra un pick per email (profilo cercato per email). */
async function pickFor(ctx: GameContext, email: string, team: string, outcome: 'win' | 'draw' | 'lose'): Promise<void> {
  const profile = ctx.db
    .prepare('SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = ?)')
    .get(email) as { id: number };
  await registerPick(ctx, { profileId: profile.id, round: 1, team, outcome, receivedAt: T_PICK });
}

/** Gioca un intero round con esiti IM 2-0 AC (IM vince), JU 0-2 MA (JU perde). */
async function playRound1(h: Harness, pickers: Array<{ email: string; team: string }>): Promise<void> {
  h.ctx.now = T_PICK;
  for (const p of pickers) await pickFor(h.ctx, p.email, p.team, 'win');
  setScore(h.db, 1, IM, AC, 2, 0);
  setScore(h.db, 1, JU, MA, 0, 2);
  h.ctx.now = T_CLOSE;
  await closeRound(h.ctx, 1);
  h.generator.contexts = [];
  h.ctx.now = T_SCORE;
  await scoreRound(h.ctx, 1);
}

describe('chiusura automatica del torneo — caso 1 (vincitore unico, ADR-011)', () => {
  it('scoreRound con un solo superstite → notifica winner, guardia atomica, export automatico coerente (RNF1)', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);

    // a: IM win (corretto, IM vince); b: JU win (sbagliato, JU perde) → 1 superstite.
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    // Notifica vincitore (caso 1 → tournament_won al solo superstite).
    const won = h.generator.byType('tournament_won');
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ playerName: 'Aldo' });
    expect(h.channel.sent.filter((s) => s.to === 'a@test.it').length).toBeGreaterThan(0);

    // Guardia atomica: winner_notified=1 + finished_at dal clock iniettato.
    const state = h.db
      .prepare('SELECT winner_notified, finished_at FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number; finished_at: string | null };
    expect(state.winner_notified).toBe(1);
    expect(state.finished_at).toBe(T_SCORE.toISOString());

    // Export automatico: UN file nel dir configurato, JSON coerente con
    // tournamentExport (determinismo RNF1: filename dal clock).
    const files = readdirSync(h.exportDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(exportFilename(T_SCORE));
    const written = JSON.parse(readFileSync(join(h.exportDir, files[0] ?? ''), 'utf8')) as unknown;
    const expected = await tournamentExport(h.ctx);
    expect(written).toEqual(JSON.parse(JSON.stringify(expected)));

    // tournament:status e scheduler:status espongono la chiusura.
    expect(await computeActions(h.ctx)).toEqual([]);
    const sched = await schedulerStatus(h.ctx);
    expect(sched.tournamentFinished).toBe(true);
    expect(sched.finishedAt).toBe(T_SCORE.toISOString());
    expect(sched.nextActions).toEqual([]);
  });

  it('export fallito alla chiusura → ritentato al rientro: export_path valorizzato, NESSUNA notifica duplicata (fix review 2026-08-23)', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);

    // Seam di archiviazione che FALLISCE: la chiusura avviene comunque
    // (winner_notified=1) ma l'export non viene scritto (export_path NULL).
    h.ctx.archiveTournament = (): string => {
      throw new Error('disk full');
    };
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    const stateAfterFail = h.db
      .prepare('SELECT winner_notified, export_path FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number; export_path: string | null };
    expect(stateAfterFail.winner_notified).toBe(1);
    expect(stateAfterFail.export_path).toBeNull();
    expect(readdirSync(h.exportDir)).toHaveLength(0);
    const wonCount = h.generator.byType('tournament_won').length;
    expect(wonCount).toBe(1);

    // Rientro (round:score idempotente, CL9) con seam FUNZIONANTE → l'export
    // viene RECUPERATO: export_path valorizzato, file scritto, vincitori MAI
    // rinotificati.
    h.ctx.archiveTournament = makeArchiveTournament(h.ctx.config);
    h.ctx.now = new Date('2026-09-13T21:00:00.000Z');
    await scoreRound(h.ctx, 1);

    const stateAfterRetry = h.db
      .prepare('SELECT winner_notified, export_path FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number; export_path: string | null };
    expect(stateAfterRetry.winner_notified).toBe(1);
    expect(stateAfterRetry.export_path).not.toBeNull();
    expect(readdirSync(h.exportDir)).toHaveLength(1);
    expect(h.generator.byType('tournament_won')).toHaveLength(wonCount);
  });

  it('doppio scoreRound → NESSUNA duplicazione (guardia idempotente: 1 notifica, 1 export)', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);
    const sentAfterFirst = h.channel.sent.length;

    // Riapertura di scoreRound (clock più avanti, CL9/riavvii manuali).
    h.ctx.now = new Date('2026-09-13T21:00:00.000Z');
    await scoreRound(h.ctx, 1);

    expect(h.generator.byType('tournament_won')).toHaveLength(1);
    expect(h.channel.sent.length).toBe(sentAfterFirst);
    expect(readdirSync(h.exportDir)).toHaveLength(1);
    const state = h.db
      .prepare('SELECT winner_notified, finished_at FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number; finished_at: string };
    expect(state.finished_at).toBe(T_SCORE.toISOString()); // invariato: la prima chiusura vince
  });

  it('vincitore con account NON active → nessuna email al vincitore (filtro RF-P6), chiusura invariata', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.beginUnsubscribe('a@test.it', NOW); // pending → filtro active lo esclude
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    // Il filtro `active` scarta il destinatario PRIMA della generazione:
    // nessun contesto tournament_won per il vincitore disiscritto e nessun
    // invio verso di lui; la chiusura del torneo resta invariata.
    expect(h.generator.byType('tournament_won')).toHaveLength(0);
    expect(h.channel.sent.some((s) => s.to === 'a@test.it')).toBe(false);
    const state = h.db
      .prepare('SELECT winner_notified FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number };
    expect(state.winner_notified).toBe(1);
  });
});

describe('chiusura automatica — caso 3 (superstiti dopo l’ultimo TC scored)', () => {
  it('vittoria condivisa → tournament_shared_win a entrambi i superstiti', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    // Entrambi IM win → entrambi corretti → 2 superstiti.
    h.ctx.now = T_PICK;
    await pickFor(h.ctx, 'a@test.it', IM, 'win');
    await pickFor(h.ctx, 'b@test.it', IM, 'win');
    setScore(h.db, 1, IM, AC, 2, 0);
    setScore(h.db, 1, JU, MA, 0, 2);
    // Caso 3: 2+ attivi DOPO che l'ULTIMO TC della stagione è scored
    // (winner.ts: la mini-stagione ha 6 round → TC 2..6 già contabilizzati).
    h.db.prepare("UPDATE round_state SET status = 'scored' WHERE round BETWEEN 2 AND 6").run();
    h.ctx.now = T_CLOSE;
    await closeRound(h.ctx, 1);
    h.ctx.now = T_SCORE;
    await scoreRound(h.ctx, 1);

    const shared = h.generator.byType('tournament_shared_win');
    expect(shared).toHaveLength(2);
    const sharedSent = h.channel.sent.filter((s) => s.subject?.includes('Vittoria condivisa'));
    expect(sharedSent.map((s) => s.to).sort()).toEqual(['a@test.it', 'b@test.it']);
  });
});

describe('scheduler fermo a torneo chiuso (ADR-011 §5.4)', () => {
  it('computeActions → [] e schedulerTick senza eventi dopo la chiusura', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    expect(await computeActions(h.ctx)).toEqual([]);
    // Anche con un round pending dopo la chiusura (es. TC2 mai aperto) il
    // tick NON emette alcuna azione.
    h.ctx.now = new Date('2026-09-20T10:00:00.000Z');
    const tick = await schedulerTick(h.ctx);
    expect(tick.events).toEqual([]);
  });
});

describe('riavvio del torneo dopo la chiusura (ADR-011 §5.5)', () => {
  it('tournament:start su torneo chiuso → reset atomico del DB di gioco, piattaforma INTATTA, nuovo torneo giocabile', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);
    expect(
      (h.db.prepare('SELECT winner_notified FROM tournament_state WHERE id = 1').get() as { winner_notified: number })
        .winner_notified
    ).toBe(1);

    // Riavvio sullo stesso calendario (deadline TT1 passata → seam simulazione).
    const restarted = await startTournament(h.ctx, { allowPastDeadline: true });
    expect(restarted.startRound).toBe(1);

    // DB di gioco azzerato; tournament_state ripristinato per il nuovo torneo.
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number }).n).toBe(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM profile').get() as { n: number }).n).toBe(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number }).n).toBe(0);
    const state = h.db
      .prepare('SELECT season_started, winner_notified, finished_at FROM tournament_state WHERE id = 1')
      .get() as { season_started: number; winner_notified: number; finished_at: string | null };
    expect(state).toEqual({ season_started: 1, winner_notified: 0, finished_at: null });
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM round_state WHERE status = 'pending'").get() as { n: number }).n).toBe(6);

    // Piattaforma INTATTA (ADR-009: sopravvive ai reset del DB torneo).
    expect(h.platform.list().map((a) => a.email).sort()).toEqual(['a@test.it', 'b@test.it']);
    expect(h.platform.find('a@test.it')?.name).toBe('Aldo');

    // Nuovo torneo GIOCABILE: apertura round e pick funzionano di nuovo.
    h.ctx.now = NOW;
    const opened = await openRound(h.ctx, 1);
    expect(opened.status).toBe('open');
    const autoJoin = await import('../../../src/game/registration.js');
    const joined = await autoJoin.autoJoinFromPick(
      h.ctx,
      { channel: 'email', identifier: 'a@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );
    expect(joined.ok).toBe(true);
    const player = h.db.prepare('SELECT name FROM player WHERE email = ?').get('a@test.it') as {
      name: string;
    };
    // Il nome del nuovo profilo nasce dall'account piattaforma (ADR-011).
    expect(player.name).toBe('Aldo');
  });

  it('riavvio SENZA chiusura → rifiuto invariato ("stagione già avviata")', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await expect(startTournament(h.ctx)).rejects.toThrow(/già avviata/);
  });

  it('export fallito → riavvio rifiutato (gate export_path, HIGH-1)', async () => {
    const h = await makeHarness();
    // Seam che lancia: l'export NON viene archiviato, export_path resta NULL.
    h.ctx.archiveTournament = () => {
      throw new Error('disk full');
    };
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    // winner_notified=1 (guardia) ma export_path NULL (archiviazione fallita).
    const state = h.db
      .prepare('SELECT winner_notified, export_path FROM tournament_state WHERE id = 1')
      .get() as { winner_notified: number; export_path: string | null };
    expect(state.winner_notified).toBe(1);
    expect(state.export_path).toBeNull();

    // Riavvio rifiutato: senza archivio il reset distruggerebbe lo storico.
    await expect(startTournament(h.ctx, { allowPastDeadline: true })).rejects.toThrow(/export/i);
  });
});

describe('gate torneo chiuso (MEDIUM-1/2, emendamento post-revisione ADR-011)', () => {
  it('round:open dopo la chiusura → rifiuto', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);

    await expect(openRound(h.ctx, 2)).rejects.toThrow(/Torneo chiuso/);
  });

  it('round:score dopo la chiusura → stato DB aggiornato ma nessuna email di esito', async () => {
    const h = await makeHarness();
    await startTournament(h.ctx);
    await openRound(h.ctx, 1);
    insertProfile(h.db, 'a@test.it', 'Aldo');
    insertProfile(h.db, 'b@test.it', 'Beppe');
    h.platform.register('a@test.it', 'Aldo', NOW);
    h.platform.register('b@test.it', 'Beppe', NOW);
    await playRound1(h, [
      { email: 'a@test.it', team: IM },
      { email: 'b@test.it', team: JU }
    ]);
    expect(
      (h.db.prepare('SELECT winner_notified FROM tournament_state WHERE id = 1').get() as { winner_notified: number })
        .winner_notified
    ).toBe(1);

    // Riporta il pick del vincitore a pending per simulare una
    // ricontabilizzazione post-chiusura (idempotenza RF-17).
    h.db
      .prepare(
        "UPDATE pick SET status = 'pending' WHERE profile_id = (SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = 'a@test.it'))"
      )
      .run();
    h.generator.contexts = [];

    await scoreRound(h.ctx, 1);

    // Stato DB aggiornato (pick di nuovo corretto)...
    const pickStatus = h.db
      .prepare(
        "SELECT status FROM pick WHERE profile_id = (SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = 'a@test.it'))"
      )
      .get() as { status: string };
    expect(pickStatus.status).toBe('correct');
    // ...ma nessuna email di esito round (torneo chiuso: round:score tace).
    expect(h.generator.byType('round_result_correct')).toHaveLength(0);
    expect(h.generator.byType('round_result_wrong')).toHaveLength(0);
    expect(h.generator.byType('round_closed_survived')).toHaveLength(0);
  });
});
