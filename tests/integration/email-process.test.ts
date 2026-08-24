/**
 * Test e2e del wiring `channel:email:process` (piano Task 8, ADR-009;
 * LLD §1.3/§7.9 v0.5.0, D5/D7/D8/M).
 *
 * DB reale SQLite in-memory (torneo + PIATTAFORMA) + DbSeasonDataProvider
 * reale con la mini-stagione (mai mockati); confini esterni mockati SOLO qui:
 * adapter email fake (scripted inbox, registra gli invii), generator fake e
 * Intent Classifier fake (scripted). Coprono il modello a due livelli:
 * subscribe (nuovo/già attivo/riattivazione con stesso registerID, RF-P1/P3),
 * unsubscribe a due passi (pending → conferma; soft-delete solo col secondo
 * messaggio, RF-P2), silenzio anti-spam (pick/other/unsubscribe da sconosciuto
 * o unsubscribed, RF-P4), auto-join al TT1 (RF-P5, risposta pick_confirmed),
 * rifiuto post-TT1, ri-iscrizione con stesso registerID, subscribe+pick nello
 * STESSO batch (mittenti rivalutati per messaggio, HIGH-2), gate round (CL3),
 * guard RF-31, flag \Seen a successo e stop del batch su LLMError (D7).
 */
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../src/channel/adapter.js';
import { processEmailBatch } from '../../src/channel/email-processor.js';
import { parseConfig } from '../../src/config.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import { migratePlatform } from '../../src/db/platform-schema.js';
import { DbPlatformRegistry } from '../../src/platform/registry.js';
import type { GameContext } from '../../src/game/context.js';
import { closeRound, openRound } from '../../src/game/round-manager.js';
import { LLMError } from '../../src/llm/errors.js';
import type { EmailContext, LLMGenerator } from '../../src/llm/generator.js';
import type {
  IntentClassification,
  LLMIntentClassifier
} from '../../src/llm/intent-classifier.js';
import type { PickParseOptions } from '../../src/llm/parser.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../fixtures/season.js';

const [IM, JU] = FIXTURE_TEAMS;

const T_OPEN = new Date('2026-09-12T10:00:00.000Z'); // apertura TT1 (deadline 15:30)
const T_PICK = new Date('2026-09-12T15:00:00.000Z'); // pick entro deadline
const T_AFTER_KICKOFF = new Date('2026-09-12T16:01:00.000Z'); // guard RF-31

/** Adapter email fake: registra gli invii (mock al confine esterno, LLD §8). */
class FakeChannel implements ChannelAdapter {
  sent: Array<{ to: string; body: string; subject: string }> = [];
  fetchMessages(): Promise<IncomingMessage[]> {
    return Promise.resolve([]);
  }
  sendMessage(to: string, body: string, subject?: string): Promise<void> {
    this.sent.push({ to, body, subject: subject ?? '' });
    return Promise.resolve();
  }
}

/** Generator fake: registra i contesti (mai rete). */
class FakeGenerator implements LLMGenerator {
  contexts: EmailContext[] = [];
  generate(ctx: EmailContext): Promise<string> {
    this.contexts.push(ctx);
    return Promise.resolve(`[${ctx.type}]`);
  }
}

/** Classificatore fake: intento scriptato per corpo (o LLMError), registra le chiamate. */
class FakeClassifier implements LLMIntentClassifier {
  calls: PickParseOptions[] = [];
  constructor(
    private readonly script: Map<string, IntentClassification>,
    private readonly throwError: Error | undefined = undefined
  ) {}
  classify(body: string, opts: PickParseOptions): Promise<IntentClassification> {
    this.calls.push(opts);
    if (this.throwError !== undefined) return Promise.reject(this.throwError);
    return Promise.resolve(this.script.get(body) ?? { intent: 'other', pick: null, name: null });
  }
}

interface Harness {
  db: Database.Database;
  platformDb: Database.Database;
  platform: DbPlatformRegistry;
  ctx: GameContext;
  channel: FakeChannel;
  generator: FakeGenerator;
  seen: string[];
  deps: () => Parameters<typeof processEmailBatch>[2];
}

/** Messaggio in ingresso (internaldate = receivedAt, ADR-001). */
function incoming(from: string, body: string, receivedAt: Date, id: string): IncomingMessage {
  return { from, channel: 'email', body, receivedAt, id };
}

/** Classificazione pick canonica per la mini-stagione. */
function pick(team: string, outcome: 'win' | 'draw' | 'lose'): IntentClassification {
  return { intent: 'pick', pick: { team, outcome }, name: null };
}

/**
 * Banco di prova: DB torneo in-memory + mini-stagione + TT1 aperto (deadline
 * fissa 15:30, kickoff 16:00 − anticipo 30') + DB PIATTAFORMA in-memory
 * migrato con registry iniettato (ADR-009).
 */
function makeHarness(opts: { startTournament?: boolean; testMode?: boolean; offsetDays?: number } = {}): Harness {
  const db = new Database(':memory:');
  migrate(db);
  loadBaseSeason(db);
  const platformDb = new Database(':memory:');
  migratePlatform(platformDb);
  const platform = new DbPlatformRegistry(platformDb);
  const dataProvider = new DbSeasonDataProvider(db);
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
    ...(opts.testMode === true ? { TEST_MODE: 'true' } : {}),
    ...(opts.offsetDays !== undefined ? { TEST_OFFSET_DAYS: String(opts.offsetDays) } : {})
  });
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  const classifier = new FakeClassifier(new Map());
  const ctx: GameContext = {
    db,
    dataProvider,
    config,
    now: T_OPEN,
    channel,
    generator,
    classifier,
    platform
  };
  if (opts.startTournament !== false) {
    db.prepare(
      `INSERT INTO tournament_state (id, season_started, start_round, registration_open)
       VALUES (1, 1, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO round_state (round, status, deadline, opened_at)
       VALUES (1, 'open', '2026-09-12T15:30:00.000Z', ?)`
    ).run(T_OPEN.toISOString());
  }
  const seen: string[] = [];
  return {
    db,
    platformDb,
    platform,
    ctx,
    channel,
    generator,
    seen,
    deps: () => ({
      teams: ['AC Milan', 'AS Roma', 'FC Internazionale Milano', 'Juventus FC'],
      aliases: '## Alias (fixture)\n- juve → Juventus FC',
      markSeen: (m: IncomingMessage) => {
        seen.push(m.id ?? m.from);
        return Promise.resolve();
      },
      logger: pino({ level: 'silent' })
    })
  };
}

/** Sostituisce il classificatore del contesto con uno scriptato. */
function useClassifier(ctx: GameContext, script: Map<string, IntentClassification>, throwError?: Error): FakeClassifier {
  const classifier = new FakeClassifier(script, throwError);
  ctx.classifier = classifier;
  return classifier;
}

describe('channel:email:process — subscribe (RF-P1/P3, ADR-009)', () => {
  it('mittente nuovo → account active + platform_registered (registerID nuovo)', async () => {
    const { ctx, platform, channel, generator, deps, seen } = makeHarness();
    useClassifier(ctx, new Map([['vorrei iscrivermi', { intent: 'subscribe', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('Nuovo Giocatore <new@test.it>', 'vorrei iscrivermi', T_PICK, '1')],
      deps()
    );

    const account = platform.find('new@test.it');
    expect(account).toMatchObject({ status: 'active', registerId: 1 });
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_registered' });
    expect(channel.sent[0]?.subject).toBe('⚽🏆SURVIVOR LEAGUE🏆⚽ - Iscrizione Confermata');
    expect(result.messages[0]).toMatchObject({ action: 'subscribed', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('nome dedotto dalla mail di registrazione → salvato sull\'account e nel saluto (ADR-011, RF-P1)', async () => {
    const { ctx, platform, generator, deps } = makeHarness();
    useClassifier(
      ctx,
      new Map([['mi chiamo Mario e voglio iscrivermi', { intent: 'subscribe', pick: null, name: 'Mario' }]])
    );

    await processEmailBatch(
      ctx,
      [incoming('mario@test.it', 'mi chiamo Mario e voglio iscrivermi', T_PICK, '1')],
      deps()
    );

    expect(platform.find('mario@test.it')?.name).toBe('Mario');
    expect(generator.contexts[0]).toMatchObject({
      type: 'platform_registered',
      playerName: 'Mario'
    });

    // Senza nome nella mail → il sistema usa l'email al posto del nome.
    const { ctx: ctx2, platform: platform2, generator: generator2, deps: deps2 } = makeHarness();
    useClassifier(ctx2, new Map([['voglio iscrivermi', { intent: 'subscribe', pick: null, name: null }]]));
    await processEmailBatch(ctx2, [incoming('anonimo@test.it', 'voglio iscrivermi', T_PICK, '1')], deps2());
    expect(platform2.find('anonimo@test.it')?.name).toBeNull();
    expect(generator2.contexts[0]).toMatchObject({
      type: 'platform_registered',
      playerName: 'anonimo@test.it'
    });
  });

  it('mittente già active → "già iscritto" con tipo email dedicato, nessun duplicato', async () => {
    const { ctx, platform, generator, deps } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([['mi iscrivo', { intent: 'subscribe', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('a@test.it', 'mi iscrivo', T_PICK, '1')], deps());

    expect(generator.contexts[0]).toMatchObject({
      type: 'platform_already_registered',
      reason: 'sei già iscritto alla piattaforma (email_already_registered)'
    });
    expect(platform.list()).toHaveLength(1);
    expect(platform.find('a@test.it')?.status).toBe('active');
  });

  it('mittente già active → soggetto "⚽🏆SURVIVOR LEAGUE🏆⚽ - Già Iscritto" e action already_subscribed (A7/B6)', async () => {
    const { ctx, platform, channel, generator, deps } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([['mi iscrivo di nuovo', { intent: 'subscribe', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'mi iscrivo di nuovo', T_PICK, '1')],
      deps()
    );

    expect(generator.contexts[0]).toMatchObject({ type: 'platform_already_registered' });
    expect(channel.sent[0]?.subject).toBe('⚽🏆SURVIVOR LEAGUE🏆⚽ - Già Iscritto');
    expect(result.messages[0]).toMatchObject({ action: 'already_subscribed', seen: true });
    expect(platform.list()).toHaveLength(1);
    expect(platform.find('a@test.it')?.status).toBe('active');
  });

  it('mittente unsubscribed → riattivazione con lo STESSO registerID (RF-P3)', async () => {
    const { ctx, platform, generator, deps } = makeHarness();
    const original = platform.register('b@test.it', null, T_OPEN);
    platform.beginUnsubscribe('b@test.it', T_OPEN);
    platform.confirmUnsubscribe('b@test.it', T_OPEN);
    useClassifier(ctx, new Map([['mi reiscrivo', { intent: 'subscribe', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('b@test.it', 'mi reiscrivo', T_PICK, '1')], deps());

    const account = platform.find('b@test.it');
    expect(account?.status).toBe('active');
    expect(account?.registerId).toBe(original.registerId);
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_registered' });
  });
});

describe('channel:email:process — unsubscribe a due passi (RF-P2)', () => {
  it('primo unsubscribe da active → pending_unsubscribe + conferma, NESSUNA soft-delete', async () => {
    const { ctx, platform, channel, generator, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([['disiscrivetemi', { intent: 'unsubscribe', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'disiscrivetemi', T_PICK, '1')],
      deps()
    );

    expect(platform.find('a@test.it')?.status).toBe('pending_unsubscribe');
    expect(platform.find('a@test.it')?.unsubscribedAt).toBeNull();
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_unsubscribe_confirm' });
    expect(channel.sent[0]?.subject).toBe('⚽🏆SURVIVOR LEAGUE🏆⚽ - Richiesta conferma disiscrizione');
    expect(result.messages[0]).toMatchObject({ action: 'unsubscribe_pending', seen: true });
    expect(seen).toEqual(['1']);
  });

  it.each(['confermo', 'sì', 'si', 'yes'])(
    'secondo unsubscribe con body "%s" → soft-delete + platform_unsubscribed',
    async (body) => {
      const { ctx, platform, generator, deps } = makeHarness();
      platform.register('a@test.it', null, T_OPEN);
      platform.beginUnsubscribe('a@test.it', T_OPEN);
      useClassifier(ctx, new Map([[body, { intent: 'unsubscribe', pick: null, name: null }]]));

      const result = await processEmailBatch(
        ctx,
        [incoming('a@test.it', body, T_PICK, '1')],
        deps()
      );

      const account = platform.find('a@test.it');
      expect(account?.status).toBe('unsubscribed');
      expect(account?.unsubscribedAt).toBe(T_OPEN.toISOString());
      expect(generator.contexts[0]).toMatchObject({ type: 'platform_unsubscribed' });
      expect(result.messages[0]).toMatchObject({ action: 'unsubscribe_confirmed', seen: true });
    }
  );

  it('pending + "confermo" classificato other → soft-delete INTENTO-AGNOSTICO (barriera B1, D1/D2)', async () => {
    const { ctx, platform, generator, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    // Comportamento reale dell'LLM (report D2): la risposta "confermo" alla
    // richiesta di conferma è classificata `other`, NON `unsubscribe`. La
    // barriera (decisione (a)) deve completare la soft-delete comunque.
    useClassifier(ctx, new Map([['confermo', { intent: 'other', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'confermo', T_PICK, '1')],
      deps()
    );

    const account = platform.find('a@test.it');
    expect(account?.status).toBe('unsubscribed');
    expect(account?.unsubscribedAt).toBe(T_OPEN.toISOString());
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_unsubscribed' });
    expect(result.messages[0]).toMatchObject({ action: 'unsubscribe_confirmed', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('secondo messaggio da pending con body NON di conferma → resta pending, conferma ripetuta', async () => {
    const { ctx, platform, generator, deps } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    useClassifier(ctx, new Map([['ma forse no', { intent: 'unsubscribe', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('a@test.it', 'ma forse no', T_PICK, '1')], deps());

    expect(platform.find('a@test.it')?.status).toBe('pending_unsubscribe');
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_unsubscribe_confirm' });
  });

  it('unsubscribe da unsubscribed o sconosciuto → log SILENZIOSO, marcato letto (RF-P2)', async () => {
    const { ctx, platform, channel, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    platform.confirmUnsubscribe('a@test.it', T_OPEN);
    useClassifier(ctx, new Map([
      ['disiscrivetemi', { intent: 'unsubscribe', pick: null, name: null }],
      ['toglietemi', { intent: 'unsubscribe', pick: null, name: null }]
    ]));

    const result = await processEmailBatch(
      ctx,
      [
        incoming('a@test.it', 'disiscrivetemi', T_PICK, '1'),
        incoming('sconosciuto@test.it', 'toglietemi', T_PICK, '2')
      ],
      deps()
    );

    expect(channel.sent).toHaveLength(0);
    expect(result.messages[0]).toMatchObject({ action: 'unsubscribe_silent', seen: true });
    expect(result.messages[1]).toMatchObject({ action: 'unsubscribe_silent', seen: true });
    expect(seen).toEqual(['1', '2']);
  });

  it('subscribe da pending_unsubscribe → ritorno ad active con stesso registerID (RF-P2/P3)', async () => {
    const { ctx, platform, deps } = makeHarness();
    const original = platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    useClassifier(ctx, new Map([['ci ripenso, mi iscrivo', { intent: 'subscribe', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('a@test.it', 'ci ripenso, mi iscrivo', T_PICK, '1')], deps());

    const account = platform.find('a@test.it');
    expect(account?.status).toBe('active');
    expect(account?.registerId).toBe(original.registerId);
  });
});

describe('channel:email:process — pick (RF-P4/P5, auto-join)', () => {
  it('pick da sconosciuto o unsubscribed → log interno, NESSUNA risposta, marcato letto (RF-P4)', async () => {
    const { ctx, platform, channel, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    platform.confirmUnsubscribe('a@test.it', T_OPEN);
    useClassifier(ctx, new Map([
      [`vado di ${JU}`, pick(JU, 'win')],
      [`scelgo la ${IM}`, pick(IM, 'win')]
    ]));

    const result = await processEmailBatch(
      ctx,
      [
        incoming('a@test.it', `vado di ${JU}`, T_PICK, '1'),
        incoming('sconosciuto@test.it', `scelgo la ${IM}`, T_PICK, '2')
      ],
      deps()
    );

    expect(channel.sent).toHaveLength(0);
    expect(result.messages[0]).toMatchObject({ action: 'silent_pick', seen: true });
    expect(result.messages[1]).toMatchObject({ action: 'silent_pick', seen: true });
    expect(seen).toEqual(['1', '2']);
    expect(platform.list()).toHaveLength(1);
  });

  it('pick da pending_unsubscribe → riattiva active e registra il pick', async () => {
    const { db, ctx, platform, generator, deps } = makeHarness();
    const account = platform.register('a@test.it', null, T_OPEN);
    db.prepare('INSERT INTO player (email, register_id) VALUES (?, ?)').run('a@test.it', account.registerId);
    const pid = db.prepare('INSERT INTO profile (player_id, register_id) VALUES ((SELECT id FROM player WHERE email = ?), ?)').run('a@test.it', account.registerId).lastInsertRowid as number;
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    useClassifier(ctx, new Map([[`vado di ${JU}`, pick(JU, 'win')]]));

    await processEmailBatch(ctx, [incoming('a@test.it', `vado di ${JU}`, T_PICK, '1')], deps());

    expect(platform.find('a@test.it')?.status).toBe('active');
    expect(generator.contexts[0]).toMatchObject({ type: 'pick_confirmed', team: JU });
    expect(
      db.prepare('SELECT team FROM pick WHERE profile_id = ?').get(pid)
    ).toMatchObject({ team: JU });
  });

  it('pick da active con profilo → pick_confirmed (cascata attuale)', async () => {
    const { db, ctx, platform, channel, generator, deps, seen } = makeHarness();
    const account = platform.register('a@test.it', null, T_OPEN);
    db.prepare('INSERT INTO player (email, name, register_id) VALUES (?, ?, ?)').run('a@test.it', 'Aldo', account.registerId);
    db.prepare('INSERT INTO profile (player_id, register_id) VALUES ((SELECT id FROM player WHERE email = ?), ?)').run('a@test.it', account.registerId);
    useClassifier(ctx, new Map([[`scelgo la ${JU}`, pick(JU, 'win')]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('Aldo <a@test.it>', `scelgo la ${JU}`, T_PICK, '1')],
      deps()
    );

    const stored = db.prepare('SELECT team, outcome, status FROM pick').get();
    expect(stored).toMatchObject({ team: JU, outcome: 'win', status: 'pending' });
    expect(generator.contexts[0]).toMatchObject({ type: 'pick_confirmed', round: 1, championshipRound: 1, deadline: new Date('2026-09-12T15:30:00.000Z') });
    expect(channel.sent[0]?.subject).toBe('⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 1 di Campionato - Pick Registrato');
    expect(result.messages[0]).toMatchObject({ action: 'pick_registered', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('pick da active senza profilo nel TT1 → auto-join: profilo+pick atomici, risposta pick_confirmed (RF-P5)', async () => {
    const { db, ctx, platform, channel, generator, deps } = makeHarness();
    platform.register('nuovo@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([[`vado di ${JU}`, pick(JU, 'win')]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('nuovo@test.it', `vado di ${JU}`, T_PICK, '1')],
      deps()
    );

    const player = db.prepare('SELECT id, register_id FROM player WHERE email = ?').get('nuovo@test.it') as {
      id: number;
      register_id: number;
    };
    expect(player).toBeDefined();
    const profile = db
      .prepare('SELECT register_id FROM profile WHERE player_id = ?')
      .get(player.id) as { register_id: number };
    expect(profile.register_id).toBe(platform.find('nuovo@test.it')?.registerId);
    const stored = db
      .prepare('SELECT team, outcome FROM pick WHERE profile_id = (SELECT id FROM profile WHERE player_id = ?)')
      .get(player.id) as { team: string; outcome: string };
    expect(stored).toMatchObject({ team: JU, outcome: 'win' });
    // RF-P5/D5: UN UNICO messaggio, pick_confirmed (nessuna conferma separata).
    expect(generator.contexts[0]).toMatchObject({ type: 'pick_confirmed', round: 1, championshipRound: 1, deadline: new Date('2026-09-12T15:30:00.000Z') });
    expect(channel.sent).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ action: 'auto_joined', seen: true });
  });

  it('pick da active senza profilo con pick non estratto → chiarimento senza profilo (CL5)', async () => {
    const { db, ctx, platform, deps } = makeHarness();
    platform.register('nuovo@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([['ciao!', { intent: 'pick', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('nuovo@test.it', 'ciao!', T_PICK, '1')], deps());

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('pick da active senza profilo oltre il kickoff → rollback senza profilo (RF-31)', async () => {
    const { db, ctx, platform, generator, deps } = makeHarness();
    platform.register('tardivo@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([[`vado di ${JU}`, pick(JU, 'win')]]));

    await processEmailBatch(
      ctx,
      [incoming('tardivo@test.it', `vado di ${JU}`, T_AFTER_KICKOFF, '1')],
      deps()
    );

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
    expect(generator.contexts[0]).toMatchObject({ type: 'pick_rejected', reason: 'after_kickoff' });
  });

  it('pick da active senza profilo dal TT2 → rifiuto "torneo iniziato" (post-TT1)', async () => {
    const { db, ctx, platform, generator, deps } = makeHarness();
    platform.register('ritardatario@test.it', null, T_OPEN);
    // Apre il TT2: il round corrente diventa il 2.
    await closeRound(ctx, 1);
    await openRound(ctx, 2);
    useClassifier(ctx, new Map([[`vado di ${JU}`, pick(JU, 'win')]]));

    await processEmailBatch(
      ctx,
      [incoming('ritardatario@test.it', `vado di ${JU}`, T_PICK, '1')],
      deps()
    );

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
    expect(generator.contexts[0]).toMatchObject({
      type: 'pick_rejected',
      reason: expect.stringContaining('torneo iniziato')
    } as EmailContext);
  });
});

describe('channel:email:process — other, unknown, gate round (ADR-009)', () => {
  it('other da mittente noto → chiarimento; other da sconosciuto → log silenzioso (RF-P4)', async () => {
    const { ctx, platform, channel, generator, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    useClassifier(ctx, new Map([
      ['come funziona?', { intent: 'other', pick: null, name: null }],
      ['chi siete?', { intent: 'other', pick: null, name: null }]
    ]));

    const result = await processEmailBatch(
      ctx,
      [
        incoming('a@test.it', 'come funziona?', T_PICK, '1'),
        incoming('sconosciuto@test.it', 'chi siete?', T_PICK, '2')
      ],
      deps()
    );

    expect(channel.sent).toHaveLength(1); // solo il chiarimento al noto
    expect(channel.sent[0]?.to).toBe('a@test.it');
    // ADR-011 (Task 7): il chiarimento usa il tipo DEDICATO `clarification`
    // (soggetto "Non Ho Capito", CTA con formula iscrizione col nome) con
    // turno di campionato e box deadline del round aperto.
    expect(channel.sent[0]?.subject).toBe(
      '⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno 1 di Campionato - Non Ho Capito'
    );
    expect(generator.contexts[0]).toMatchObject({
      type: 'clarification',
      round: 1,
      championshipRound: 1,
      deadline: new Date('2026-09-12T15:30:00.000Z'),
      deadlineRemaining: expect.stringContaining('ore')
    } as EmailContext);
    expect(result.messages[0]).toMatchObject({ action: 'clarification', seen: true });
    expect(result.messages[1]).toMatchObject({ action: 'silent_other', seen: true });
    expect(seen).toEqual(['1', '2']);
  });

  it('other da account unsubscribed → NESSUNA risposta, silenzio + seen (A6a/B5, D3, decisione (e))', async () => {
    const { ctx, platform, channel, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    platform.confirmUnsubscribe('a@test.it', T_OPEN);
    // Comportamento reale dell'LLM (report D3): "come funziona?" è `other`.
    useClassifier(ctx, new Map([['come funziona?', { intent: 'other', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'come funziona?', T_PICK, '1')],
      deps()
    );

    // Decisione 7/ADR-009: NESSUNA email ad account unsubscribed; il messaggio
    // è comunque marcato letto (niente retry infinito).
    expect(channel.sent).toHaveLength(0);
    expect(result.messages[0]).toMatchObject({ action: 'silent_other', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('other da account pending_unsubscribe con body NON di conferma → NESSUNA risposta, stato invariato (A6b/B5, D3, decisione (e))', async () => {
    const { ctx, platform, channel, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.beginUnsubscribe('a@test.it', T_OPEN);
    // Body NON in lista di conferma (`confermo`/`sì`/`si`/`yes`): la barriera
    // B1 non interviene, si arriva al ramo `other` con account pending.
    useClassifier(ctx, new Map([['ma forse cambio idea?', { intent: 'other', pick: null, name: null }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'ma forse cambio idea?', T_PICK, '1')],
      deps()
    );

    // Decisione 7/ADR-009: nessuna email ad account pending_unsubscribe; lo
    // stato resta pending (la disiscrizione si completa solo con la conferma).
    expect(platform.find('a@test.it')?.status).toBe('pending_unsubscribe');
    expect(channel.sent).toHaveLength(0);
    expect(result.messages[0]).toMatchObject({ action: 'silent_other', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('corpo vuoto → unknown: marcato letto, nessuna risposta, nessuna chiamata LLM', async () => {
    const { ctx, channel, deps, seen } = makeHarness();
    const classifier = useClassifier(ctx, new Map());

    await processEmailBatch(ctx, [incoming('a@test.it', '   ', T_PICK, '1')], deps());

    expect(channel.sent).toHaveLength(0);
    expect(classifier.calls).toHaveLength(0);
    expect(seen).toEqual(['1']);
  });

  it('pick da active senza round aperto → round_not_open (il ramo pick richiede un round)', async () => {
    const { db, ctx, platform, generator, deps } = makeHarness({ startTournament: false });
    const account = platform.register('a@test.it', null, T_OPEN);
    db.prepare('INSERT INTO player (email, register_id) VALUES (?, ?)').run('a@test.it', account.registerId);
    db.prepare('INSERT INTO profile (player_id, register_id) VALUES ((SELECT id FROM player WHERE email = ?), ?)').run('a@test.it', account.registerId);
    useClassifier(ctx, new Map([[`vado di ${JU}`, pick(JU, 'win')]]));

    await processEmailBatch(ctx, [incoming('a@test.it', `vado di ${JU}`, T_PICK, '1')], deps());

    expect(generator.contexts[0]).toMatchObject({
      type: 'pick_rejected',
      reason: 'nessun turno è aperto in questo momento (round_not_open)'
    });
  });

  it('subscribe SENZA round aperto → accettata (indipendente dai round, ADR-009)', async () => {
    const { ctx, platform, generator, deps } = makeHarness({ startTournament: false });
    useClassifier(ctx, new Map([['mi iscrivo', { intent: 'subscribe', pick: null, name: null }]]));

    await processEmailBatch(ctx, [incoming('new@test.it', 'mi iscrivo', T_PICK, '1')], deps());

    expect(platform.find('new@test.it')?.status).toBe('active');
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_registered' });
  });
});

describe('channel:email:process — mittenti rivalutati per messaggio (HIGH-2)', () => {
  it('subscribe + pick dello stesso mittente nello STESSO batch → il pick è accettato (auto-join)', async () => {
    const { db, ctx, platform, generator, deps } = makeHarness();
    useClassifier(ctx, new Map([
      ['vorrei iscrivermi', { intent: 'subscribe', pick: null, name: null }],
      [`vado di ${JU}`, pick(JU, 'win')]
    ]));

    const result = await processEmailBatch(
      ctx,
      [
        incoming('sconosciuto@test.it', 'vorrei iscrivermi', T_PICK, '1'),
        incoming('sconosciuto@test.it', `vado di ${JU}`, T_PICK, '2')
      ],
      deps()
    );

    // Il secondo messaggio vede l'account appena creato dal primo (nessuno
    // snapshot di inizio batch): auto-join riuscito.
    expect(platform.find('sconosciuto@test.it')?.status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pick').get()).toEqual({ n: 1 });
    expect(generator.contexts[0]).toMatchObject({ type: 'platform_registered' });
    expect(generator.contexts[1]).toMatchObject({ type: 'pick_confirmed' });
    expect(result.messages[0]).toMatchObject({ action: 'subscribed', seen: true });
    expect(result.messages[1]).toMatchObject({ action: 'auto_joined', seen: true });
  });
});

describe('channel:email:process — errori (D7/RNF9)', () => {
  it('LLMError → messaggio NON marcato letto e batch FERMATO (retry al prossimo tick)', async () => {
    const { ctx, platform, deps, seen } = makeHarness();
    platform.register('a@test.it', null, T_OPEN);
    platform.register('b@test.it', null, T_OPEN);
    useClassifier(ctx, new Map(), new LLMError('API giù', 429));

    const result = await processEmailBatch(
      ctx,
      [
        incoming('a@test.it', 'primo', T_PICK, '1'),
        incoming('b@test.it', 'secondo', T_PICK, '2')
      ],
      deps()
    );

    expect(result.stopped).toBe(true);
    expect(result.messages[0]).toMatchObject({ action: 'error_llm', seen: false });
    expect(result.processed).toBe(1);
    expect(seen).toEqual([]);
  });
});
