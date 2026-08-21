/**
 * Test delle notifiche filtrate sull'account piattaforma (piano Task 9,
 * ADR-009, RF-P6).
 *
 * DB torneo + DB PIATTAFORMA in-memory reali, mini-stagione reale, channel/
 * generator FAKE (confini esterni). Verificano che OGNI email in uscita dai
 * flussi di round e dal broadcast di apertura torneo vada SOLO ad account
 * `active`:
 *   - round:open → pick_instructions ai soli partecipanti attivi
 *     (eliminated = 0) con account `active`;
 *   - round:open al TT 1 → pick_instructions ANCHE agli account `active`
 *     SENZA profilo (amendment RF-P6, 2026-08-21), con dedup sui profili e
 *     squadre in giornata; dal TT 2 nessun invio ai senza-profilo;
 *   - round:close → pick_missing_elimination ai soli account `active`;
 *   - round:score → round_result_correct/wrong ai soli account `active`;
 *   - round:score alla transizione closed→scored → round_closed_survived ai
 *     SOLI sopravvissuti con account `active`, UNA sola volta (guardia
 *     summary_sent: la riapertura di round:score non rinvìa);
 *   - round:score con un invio di riepilogo che FALLISCE (A3/B2, decisione
 *     (b)): la transizione a `scored` e la guardia `summary_sent` sono scritte
 *     in UN'UNICA istruzione UPDATE (mai `scored` con summary_sent=0);
 *     l'invio è best-effort per destinatario (try/catch + warn pino in
 *     inglese, il loop continua) e `scoreRound` risolve senza lanciare;
 *     l'idempotenza del riepilogo è invariata;
 *   - tournament:start → tournament_open a tutti gli activeEmails() (e SOLO a
 *     quelli: pending/unsubscribed esclusi);
 *   - contesto con channel + generator ma SENZA registry (D4, A4/B3): il
 *     filtro notifiche FALLISCE CHIUSO — nessuna email parte (simmetria con
 *     checkEligibility → platform_unavailable); il broadcast di
 *     tournament:start senza registry resta un no-op (invariato);
 *   - nessun round_closed_eliminated, nessun criterio eliminated_at >= opened_at.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../../src/channel/adapter.js';
import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import { migratePlatform } from '../../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../../src/platform/registry.js';
import type { GameContext } from '../../../src/game/context.js';
import type { EmailContext, LLMGenerator } from '../../../src/llm/generator.js';
import { closeRound, openRound, scoreRound } from '../../../src/game/round-manager.js';
import { registerPick } from '../../../src/game/pick-processor.js';
import { startTournament } from '../../../src/game/tournament.js';
import { createLogger } from '../../../src/logger.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

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

/**
 * Fake LLMGenerator (A3/B2) che lancia SOLO sulla 2ª chiamata di tipo
 * `round_closed_survived` — simula un outage SMTP/LLM sul SECONDO destinatario
 * del riepilogo (finding §3 del report: l'eccezione propagava fuori da
 * `scoreRound` lasciando `summary_sent=0` con status già `scored`).
 */
class ThrowingOnSecondSummaryGenerator implements LLMGenerator {
  contexts: EmailContext[] = [];
  private summaryCalls = 0;
  generate(ctx: EmailContext): Promise<string> {
    this.contexts.push(ctx);
    if (ctx.type === 'round_closed_survived') {
      this.summaryCalls += 1;
      if (this.summaryCalls === 2) {
        return Promise.reject(new Error('smtp down'));
      }
    }
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
}

/** Crea profilo torneo per email (partecipazione già esistente). */
function insertProfile(db: Database.Database, email: string, registerId: number | null = null): number {
  const pid = db
    .prepare('INSERT INTO player (email, register_id) VALUES (?, ?)')
    .run(email, registerId).lastInsertRowid as number;
  return db
    .prepare('INSERT INTO profile (player_id, register_id) VALUES (?, ?)')
    .run(pid, registerId).lastInsertRowid as number;
}

/**
 * Banco di prova con DB torneo + DB piattaforma + fake I/O, SENZA aprire
 * round né avviare il torneo: usato dai test che preparano account/profili
 * PRIMA dell'apertura (amendment RF-P6 al TT 1).
 */
async function makeContext(): Promise<Harness> {
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
      FOOTBALL_DATA_TOKEN: 't',
      DEADLINE_ADVANCE_MIN: '30',
      MATCH_DURATION_MIN: '105',
      TC_CLOSE_SKEW_MIN: '15'
    }),
    now: NOW,
    channel,
    generator,
    platform
  };
  return { db, platformDb, platform, ctx, channel, generator };
}

/** Banco di prova con DB torneo + DB piattaforma + fake I/O + TT1 aperto. */
async function makeHarness(): Promise<Harness> {
  const harness = await makeContext();
  await startTournament(harness.ctx);
  await openRound(harness.ctx, 1);
  return harness;
}

describe('filtro account active sulle notifiche (RF-P6, ADR-009)', () => {
  it('round:open → pick_instructions ai soli partecipanti attivi con account active', async () => {
    const { db, ctx, platform, generator } = await makeHarness();
    const accountA = platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    platform.register('c@test.it', NOW);
    platform.beginUnsubscribe('c@test.it', NOW); // pending → escluso
    platform.register('d@test.it', NOW);
    platform.beginUnsubscribe('d@test.it', NOW);
    platform.confirmUnsubscribe('d@test.it', NOW); // unsubscribed → escluso
    // e@test.it: profilo SENZA account piattaforma → escluso.
    insertProfile(db, 'a@test.it', accountA.registerId);
    insertProfile(db, 'b@test.it');
    insertProfile(db, 'c@test.it');
    insertProfile(db, 'd@test.it');
    insertProfile(db, 'e@test.it');
    // b è ELIMINATO → escluso anche se account active.
    db.prepare('UPDATE profile SET eliminated = 1, eliminated_reason = ? WHERE player_id = (SELECT id FROM player WHERE email = ?)').run('missing_pick', 'b@test.it');

    generator.contexts = [];
    await openRound(ctx, 2);

    const recipients = generator.byType('pick_instructions');
    // L'unico destinatario è a@test.it (active + in gara): pending, unsubscribed,
    // senza account ed eliminati sono esclusi (RF-P6).
    expect(recipients).toHaveLength(1);
  });

  it('TT1: account active SENZA profilo ricevono pick_instructions con le squadre in giornata (amendment RF-P6, dedup sui profili)', async () => {
    const { db, platform, ctx, channel, generator } = await makeContext();
    // a: account active SENZA profilo → deve ricevere (amendment RF-P6).
    platform.register('a@test.it', NOW);
    // b: account active CON profilo → UNA sola email (dedup col loop profili).
    const b = platform.register('b@test.it', NOW);
    insertProfile(db, 'b@test.it', b.registerId);
    // c (pending_unsubscribe) e d (unsubscribed): SENZA profilo ma esclusi.
    platform.register('c@test.it', NOW);
    platform.beginUnsubscribe('c@test.it', NOW);
    platform.register('d@test.it', NOW);
    platform.beginUnsubscribe('d@test.it', NOW);
    platform.confirmUnsubscribe('d@test.it', NOW);

    const result = await openRound(ctx, 1);

    expect(result).toMatchObject({ round: 1, tt: 1, tc: 1, notified: 1, registeredNotified: 1 });
    const invites = generator.byType('pick_instructions');
    expect(invites).toHaveLength(2);
    // L'email del senza-profilo ha le squadre in giornata (stessa fonte di
    // getAvailableTeams, ordinate come getTeams()) e NESSUN playerName:
    // l'account piattaforma non ha nome e il template omette i dati assenti.
    const noProfile = invites.find((c) => !('playerName' in c));
    expect(noProfile).toMatchObject({
      type: 'pick_instructions',
      tt: 1,
      tc: 1,
      availableTeams: [AC, MA, IM, JU]
    });
    // Dedup: il profilo di b riceve UNA sola email (dal loop profili).
    expect(channel.sent.filter((s) => s.to === 'b@test.it')).toHaveLength(1);
    // pending_unsubscribe/unsubscribed (senza profilo) non ricevono nulla.
    expect(channel.sent.map((s) => s.to)).toEqual(expect.not.arrayContaining(['c@test.it', 'd@test.it']));
  });

  it('TT2: account SENZA profilo NON ricevono nulla (amendment RF-P6 solo al TT 1)', async () => {
    const { db, platform, ctx, channel, generator } = await makeContext();
    platform.register('a@test.it', NOW); // SENZA profilo
    const b = platform.register('b@test.it', NOW);
    insertProfile(db, 'b@test.it', b.registerId); // CON profilo

    // TT1: anche il senza-profilo a viene notificato (comportamento atteso).
    await openRound(ctx, 1);
    channel.sent = [];
    generator.contexts = [];

    // TT2: solo i profili attivi — a (senza profilo) non riceve nulla.
    const result = await openRound(ctx, 2);

    expect(result).toMatchObject({ tt: 2, notified: 1, registeredNotified: 0 });
    expect(generator.byType('pick_instructions')).toHaveLength(1);
    expect(channel.sent.map((s) => s.to)).toEqual(['b@test.it']);
  });

  it('round:close → pick_missing_elimination ai soli account active (pending/unsubscribed/senza account esclusi)', async () => {
    const { db, ctx, platform, generator } = await makeHarness();
    const a = platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    platform.beginUnsubscribe('b@test.it', NOW); // pending
    platform.register('c@test.it', NOW);
    platform.beginUnsubscribe('c@test.it', NOW);
    platform.confirmUnsubscribe('c@test.it', NOW); // unsubscribed
    insertProfile(db, 'a@test.it', a.registerId);
    insertProfile(db, 'b@test.it');
    insertProfile(db, 'c@test.it');
    insertProfile(db, 'd@test.it'); // nessun account

    // Nessun pick per nessuno → tutti mancanti alla chiusura.
    ctx.now = T_CLOSE;
    await closeRound(ctx, 1);

    const eliminations = generator.byType('pick_missing_elimination');
    expect(eliminations).toHaveLength(1);
  });

  it('round:score → round_result_* ai soli account active; riepilogo ai soli sopravvissuti (UNA volta)', async () => {
    const { db, ctx, platform, generator } = await makeHarness();
    const a = platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    platform.beginUnsubscribe('b@test.it', NOW); // pending → nessuna email
    insertProfile(db, 'a@test.it', a.registerId);
    insertProfile(db, 'b@test.it');
    // Entrambi i pick su IM; IM vince → entrambi corretti (b non riceve nulla).
    db.prepare('UPDATE match SET home_score = 2, away_score = 0 WHERE round = 1 AND home_team = ?').run(IM);

    ctx.now = T_PICK;
    for (const email of ['a@test.it', 'b@test.it']) {
      const profile = db
        .prepare('SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = ?)')
        .get(email) as { id: number };
      await registerPick(ctx, {
        profileId: profile.id,
        round: 1,
        team: IM,
        outcome: 'win',
        receivedAt: T_PICK
      });
    }

    ctx.now = T_CLOSE;
    await closeRound(ctx, 1);
    generator.contexts = [];
    ctx.now = T_SCORE;
    await scoreRound(ctx, 1);

    // Solo a@test.it riceve l'esito.
    expect(generator.byType('round_result_correct')).toHaveLength(1);
    expect(generator.byType('round_result_wrong')).toHaveLength(0);
    // Riepilogo: solo i sopravvissuti con account active → solo a@test.it.
    expect(generator.byType('round_closed_survived')).toHaveLength(1);
    const summarySent = db
      .prepare('SELECT summary_sent FROM round_state WHERE round = 1')
      .get() as { summary_sent: number };
    expect(summarySent.summary_sent).toBe(1);

    // Riapertura di round:score → NESSUN nuovo riepilogo (guardia summary_sent).
    generator.contexts = [];
    await scoreRound(ctx, 1);
    expect(generator.byType('round_closed_survived')).toHaveLength(0);
    expect(generator.byType('round_result_correct')).toHaveLength(0);
  });

  it('round:score con eliminati → gli eliminati ricevono SOLO round_result_wrong, MAI il riepilogo', async () => {
    const { db, ctx, platform, generator } = await makeHarness();
    const a = platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    insertProfile(db, 'a@test.it', a.registerId);
    insertProfile(db, 'b@test.it');
    // IM vince 2-0; JU perde 0-2: a (IM win) sopravvive, b (JU win) eliminato.
    db.prepare('UPDATE match SET home_score = 2, away_score = 0 WHERE round = 1 AND home_team = ?').run(IM);
    db.prepare('UPDATE match SET home_score = 0, away_score = 2 WHERE round = 1 AND home_team = ?').run(JU);

    ctx.now = T_PICK;
    const pickFor = async (email: string, team: string) => {
      const profile = db
        .prepare('SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = ?)')
        .get(email) as { id: number };
      await registerPick(ctx, { profileId: profile.id, round: 1, team, outcome: 'win', receivedAt: T_PICK });
    };
    await pickFor('a@test.it', IM);
    await pickFor('b@test.it', JU);

    ctx.now = T_CLOSE;
    await closeRound(ctx, 1);
    generator.contexts = [];
    ctx.now = T_SCORE;
    await scoreRound(ctx, 1);

    expect(generator.byType('round_result_correct')).toHaveLength(1);
    expect(generator.byType('round_result_wrong')).toHaveLength(1);
    // Il riepilogo va SOLO al sopravvissuto (a); b eliminato non lo riceve.
    expect(generator.byType('round_closed_survived')).toHaveLength(1);
    // Non esiste alcun round_closed_eliminated (ADR-009).
    expect(generator.byType('round_closed_eliminated' as EmailContext['type'])).toHaveLength(0);
  });

  it('round:score con invio riepilogo che fallisce sul 2° destinatario → scored+summary_sent atomici, best-effort, idempotente (A3/B2)', async () => {
    const { db, ctx, platform, channel } = await makeHarness();
    const a = platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    insertProfile(db, 'a@test.it', a.registerId);
    insertProfile(db, 'b@test.it');
    // IM vince 2-0: entrambi i pick (IM win) corretti → 2 sopravvissuti.
    db.prepare('UPDATE match SET home_score = 2, away_score = 0 WHERE round = 1 AND home_team = ?').run(IM);

    ctx.now = T_PICK;
    for (const email of ['a@test.it', 'b@test.it']) {
      const profile = db
        .prepare('SELECT id FROM profile WHERE player_id = (SELECT id FROM player WHERE email = ?)')
        .get(email) as { id: number };
      await registerPick(ctx, {
        profileId: profile.id,
        round: 1,
        team: IM,
        outcome: 'win',
        receivedAt: T_PICK
      });
    }
    ctx.now = T_CLOSE;
    await closeRound(ctx, 1);

    // Generatore che lancia SOLO sul 2° invio di riepilogo + logger pino del
    // contesto catturato in memoria (stesso pattern di tests/unit/logger.test.ts:
    // stream custom, livello debug → anche i warn vengono emessi).
    const generator = new ThrowingOnSecondSummaryGenerator();
    ctx.generator = generator;
    const lines: string[] = [];
    ctx.logger = createLogger('debug', { write: (chunk: string) => void lines.push(chunk) });

    channel.sent = [];
    ctx.now = T_SCORE;

    // (1) scoreRound risolve SENZA lanciare: l'invio è best-effort per
    //     destinatario, un errore SMTP/LLM non fa fallire la contabilizzazione.
    const result = await scoreRound(ctx, 1);
    expect(result.status).toBe('scored');

    // (2) Transizione e guardia scritte INSIEME (unica istruzione UPDATE
    //     atomica): non esiste mai `scored` con summary_sent = 0.
    const rs = db
      .prepare('SELECT status, summary_sent FROM round_state WHERE round = 1')
      .get() as { status: string; summary_sent: number };
    expect(rs.status).toBe('scored');
    expect(rs.summary_sent).toBe(1);

    // (3) Il 1° destinatario (a@test.it, ORDER BY p.id) ha ricevuto il
    //     riepilogo; il 2° (b@test.it) no: il suo invio è fallito e il
    //     fallimento è loggato con warn pino in INGLESE, senza interrompere
    //     il loop.
    const summaries = channel.sent.filter((s) => s.body === '[round_closed_survived]');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.to).toBe('a@test.it');
    expect(lines.join('')).toContain('round:score: summary not sent');

    // (4) Rieseguire round:score NON produce nuovi invii di riepilogo
    //     (idempotenza conservata: la guardia summary_sent è già a 1).
    const sentBefore = channel.sent.length;
    await scoreRound(ctx, 1);
    expect(generator.byType('round_closed_survived')).toHaveLength(2); // solo i 2 tentativi della 1ª esecuzione
    expect(channel.sent.length).toBe(sentBefore);
  });

  it('senza registry iniettato → nessuna email dai flussi di round (filtro fail-closed, A4/B3, D4)', async () => {
    // Contesto con channel + generator FAKE iniettati ma `platform` ASSENTE
    // (D4: simula un chiamante che dimentica il registry). Post-fix il filtro
    // deve fallire CHIUSO, come checkEligibility (platform_unavailable): un
    // chiamante che dimentica l'iniezione NON riceve email non filtrate.
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
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
        FOOTBALL_DATA_TOKEN: 't',
        DEADLINE_ADVANCE_MIN: '30',
        MATCH_DURATION_MIN: '105',
        TC_CLOSE_SKEW_MIN: '15'
      }),
      now: NOW,
      channel,
      generator
      // `platform` NON iniettato di proposito (chiamante senza registry).
    };
    insertProfile(db, 'a@test.it'); // 1 profilo attivo (eliminated = 0)

    // Broadcast di apertura torneo senza registry: resta un no-op (invariato).
    const start = await startTournament(ctx);
    expect(start.notified).toBe(0);

    await openRound(ctx, 1);

    // Filtro fail-closed: nessuna email inviata (oggi pick_instructions parte
    // non filtrata perché isAccountActive ritorna true senza registry).
    expect(channel.sent).toHaveLength(0);
  });

  it('tournament:start → tournament_open a tutti gli activeEmails (pending/unsubscribed esclusi)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    loadBaseSeason(db);
    const platformDb = new Database(':memory:');
    migratePlatform(platformDb);
    const platform = new DbPlatformRegistry(platformDb);
    const channel = new FakeChannel();
    const generator = new FakeGenerator();
    platform.register('a@test.it', NOW);
    platform.register('b@test.it', NOW);
    platform.beginUnsubscribe('b@test.it', NOW);
    platform.register('c@test.it', NOW);
    platform.beginUnsubscribe('c@test.it', NOW);
    platform.confirmUnsubscribe('c@test.it', NOW);
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
      now: NOW,
      channel,
      generator,
      platform
    };

    const result = await startTournament(ctx);

    expect(result.notified).toBe(1);
    expect(generator.byType('tournament_open')).toHaveLength(1);
    expect(channel.sent.map((s) => s.to)).toEqual(['a@test.it']);
  });
});
