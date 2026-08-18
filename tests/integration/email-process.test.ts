/**
 * Test e2e del wiring `channel:email:process` (piano Task 6.2, LLD §1.3/§7.9;
 * briefing Fase 5-6 §5, D5/D7/D8/M).
 *
 * DB reale SQLite in-memory + DbSeasonDataProvider reale con la mini-stagione
 * (mai mockati); confini esterni mockati SOLO qui: adapter email fake
 * (scripted inbox, registra gli invii), generator fake e Parser LLM fake
 * (scripted). Coprono: CS1 simulato (profilo completo via email), CL2/RF-27
 * (auto-iscrizione TT1, profilo+pick atomici), CL5 (chiarimento senza
 * profilo), RF-24 (rifiuto dal TT2 senza registrazione), CL3 (nessun round
 * aperto), guard RF-31 (receivedAt forzato oltre il kickoff), flag \Seen a
 * successo e stop del batch su LLMError (D7), finestra iscrizione chiusa
 * (CL2/RF-03), già registrato.
 */
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../src/channel/adapter.js';
import { processEmailBatch } from '../../src/channel/email-processor.js';
import { parseConfig } from '../../src/config.js';
import { DbSeasonDataProvider } from '../../src/data/db-provider.js';
import { migrate } from '../../src/db/schema.js';
import type { GameContext } from '../../src/game/context.js';
import { closeRegistration } from '../../src/game/registration.js';
import { closeRound, openRound } from '../../src/game/round-manager.js';
import { LLMError } from '../../src/llm/errors.js';
import type { EmailContext, LLMGenerator } from '../../src/llm/generator.js';
import type { LLMParser, PickExtraction, PickParseOptions } from '../../src/llm/parser.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../fixtures/season.js';

const [IM, JU] = FIXTURE_TEAMS;

const T_OPEN = new Date('2026-09-12T10:00:00.000Z'); // apertura TT1 (deadline 15:30)
const T_PICK = new Date('2026-09-12T15:00:00.000Z'); // pick entro deadline
const T_AFTER_KICKOFF = new Date('2026-09-12T16:01:00.000Z'); // guard RF-31
const T_OPEN2 = new Date('2026-09-19T10:00:00.000Z'); // apertura TT2

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

/** Parser fake: esito scriptato per corpo (o LLMError), registra le chiamate. */
class FakeParser implements LLMParser {
  calls: PickParseOptions[] = [];
  constructor(
    private readonly script: Map<string, PickExtraction | null>,
    private readonly throwError: Error | undefined = undefined
  ) {}
  extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null> {
    this.calls.push(opts);
    if (this.throwError !== undefined) return Promise.reject(this.throwError);
    return Promise.resolve(this.script.get(emailBody) ?? null);
  }
}

interface Harness {
  db: Database.Database;
  ctx: GameContext;
  channel: FakeChannel;
  generator: FakeGenerator;
  seen: string[];
  deps: (known: Set<string>) => Parameters<typeof processEmailBatch>[2];
}

/** Messaggio in ingresso (internaldate = receivedAt, ADR-001). */
function incoming(from: string, body: string, receivedAt: Date, id: string): IncomingMessage {
  return { from, channel: 'email', body, receivedAt, id };
}

/**
 * Banco di prova: DB in-memory + mini-stagione + stato torneo inizializzato
 * in modo SINCRONO (stessa semantica di tournament:start + round:open):
 * finestra iscrizione aperta (registration_open=1) e TT1 aperto con deadline
 * fissa 15:30 (kickoff 16:00 − anticipo 30').
 */
function makeHarness(
  opts: { startTournament?: boolean; testMode?: boolean; offsetDays?: number } = {}
): Harness {
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
    DEADLINE_ADVANCE_MIN: '30',
    MATCH_DURATION_MIN: '105',
    TC_CLOSE_SKEW_MIN: '15',
    ...(opts.testMode === true ? { TEST_MODE: 'true' } : {}),
    ...(opts.offsetDays !== undefined ? { TEST_OFFSET_DAYS: String(opts.offsetDays) } : {})
  });
  const channel = new FakeChannel();
  const generator = new FakeGenerator();
  // Parser default: nessun corpo interpretabile → null (i test lo scriptano).
  const parser = new FakeParser(new Map());
  const ctx: GameContext = { db, dataProvider, config, now: T_OPEN, channel, generator, parser };
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
    ctx,
    channel,
    generator,
    seen,
    deps: (known: Set<string>) => ({
      teams: ['AC Milan', 'AS Roma', 'FC Internazionale Milano', 'Juventus FC'],
      aliases: '## Alias (fixture)\n- juve → Juventus FC',
      knownEmails: known,
      markSeen: (m: IncomingMessage) => {
        seen.push(m.id ?? m.from);
        return Promise.resolve();
      },
      logger: pino({ level: 'silent' })
    })
  };
}

/** Crea un profilo attivo (giocatore già registrato via CLI). */
function insertProfile(db: Database.Database, email: string, name = ''): number {
  const pid = db.prepare('INSERT INTO player (email, name) VALUES (?, ?)').run(email, name)
    .lastInsertRowid as number;
  return db.prepare('INSERT INTO profile (player_id) VALUES (?)').run(pid)
    .lastInsertRowid as number;
}

describe('channel:email:process — CS1 simulato e flussi principali (Task 6.2)', () => {
  it('iscrizione via email → profilo creato + welcome con coppia TT/TC (RF-25)', async () => {
    const { ctx, channel, generator, deps, seen } = makeHarness();
    const messages = [incoming('Nuovo Giocatore <new@test.it>', 'vorrei iscrivermi al torneo', T_PICK, '1')];

    const result = await processEmailBatch(ctx, messages, deps(new Set()));

    // Profilo creato (CS1 simulato, RF-02/RNF2: identità normalizzata).
    const player = ctx.db.prepare('SELECT email FROM player WHERE email = ?').get('new@test.it');
    expect(player).toBeDefined();
    // Welcome inviato con coppia TT/TC iniettata nel soggetto (D1/RF-25).
    const welcome = channel.sent[0];
    expect(welcome?.to).toBe('new@test.it');
    expect(welcome?.subject).toBe('Survivor League — Benvenuto TT1TC1');
    expect(generator.contexts[0]).toMatchObject({ type: 'welcome', tt: 1, tc: 1 });
    // Flag \Seen a successo (D7).
    expect(result.messages[0]).toMatchObject({ action: 'registration', seen: true });
    expect(seen).toEqual(['1']);
  });

  it('pick da mittente noto → pick_confirmed (registrazione + conferma)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    insertProfile(db, 'a@test.it', 'Aldo');
    const known = new Set(['a@test.it']);
    const parser = new FakeParser(new Map([[`scelgo la ${JU}`, { team: JU, outcome: 'win' }]]));
    ctx.parser = parser;

    const result = await processEmailBatch(
      ctx,
      [incoming('Aldo <a@test.it>', `scelgo la ${JU}`, T_PICK, '1')],
      deps(known)
    );

    const pick = db.prepare('SELECT team, outcome, status FROM pick').get();
    expect(pick).toMatchObject({ team: JU, outcome: 'win', status: 'pending' });
    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick registrato TT1TC1');
    expect(result.messages[0]).toMatchObject({ action: 'pick_registered', seen: true });
    // Lista canonica e alias iniettati al Parser UNA volta per batch (D2/M).
    expect(parser.calls[0]).toMatchObject({
      teams: ['AC Milan', 'AS Roma', 'FC Internazionale Milano', 'Juventus FC'],
      aliases: '## Alias (fixture)\n- juve → Juventus FC'
    });
  });

  it('pick da mittente noto non interpretabile → rifiuto formato (CL5/CS7)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    insertProfile(db, 'a@test.it');
    ctx.parser = new FakeParser(new Map()); // tutto null

    await processEmailBatch(ctx, [incoming('a@test.it', 'ciao!', T_PICK, '1')], deps(new Set(['a@test.it'])));

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    const pick = db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number };
    expect(pick.n).toBe(0);
  });

  it('pick rifiutato dalla cascata: squadra già usata (RF-10/CS5), si può riprovare (RF-09)', async () => {
    const { db, ctx, channel, generator, deps } = makeHarness();
    const profileId = insertProfile(db, 'a@test.it');
    // Il profilo ha GIÀ bruciato JU nel TC 1 (girone di andata): riproporla = rifiuto cascata.
    db.prepare(
      "INSERT INTO pick (profile_id, round, team, outcome, status) VALUES (?, 1, ?, 'win', 'pending')"
    ).run(profileId, JU);
    ctx.parser = new FakeParser(new Map([[`scelgo la ${JU}`, { team: JU, outcome: 'win' }]]));

    await processEmailBatch(ctx, [incoming('a@test.it', `scelgo la ${JU}`, T_PICK, '1')], deps(new Set(['a@test.it'])));

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    // Motivo esplicito della cascata nel contesto dell'email (RF-09: si può riprovare).
    expect(generator.contexts[0]).toMatchObject({ type: 'pick_rejected', reason: 'team_already_used' });
    const picks = db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number };
    expect(picks.n).toBe(1); // nessun pick duplicato (CL6/RF-08)
  });

  it('auto-iscrizione RF-27: mittente ignoto interpretabile nel TT1 → profilo+pick atomici (CL2, CS1)', async () => {
    const { db, ctx, channel, generator, deps } = makeHarness();
    ctx.parser = new FakeParser(new Map([[`vado di ${JU}`, { team: JU, outcome: 'win' }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('sconosciuto@test.it', `vado di ${JU}`, T_PICK, '1')],
      deps(new Set())
    );

    // Profilo + pick atomici (un solo messaggio di risposta: auto_registered, D5).
    const player = db.prepare('SELECT id FROM player WHERE email = ?').get('sconosciuto@test.it') as
      | { id: number }
      | undefined;
    expect(player).toBeDefined();
    const pick = db
      .prepare('SELECT team, outcome FROM pick WHERE profile_id = (SELECT id FROM profile WHERE player_id = ?)')
      .get(player?.id) as { team: string; outcome: string } | undefined;
    expect(pick).toMatchObject({ team: JU, outcome: 'win' });
    expect(generator.contexts[0]?.type).toBe('auto_registered');
    expect(generator.contexts[0]).toMatchObject({ tt: 1, tc: 1, team: JU, outcome: 'win' });
    expect(channel.sent).toHaveLength(1); // RF-27: UN UNICO messaggio
    expect(result.messages[0]).toMatchObject({ action: 'auto_registered', seen: true });
  });

  it('auto-iscrizione oltre il kickoff effettivo → respinta senza profilo (RF-31/CL17)', async () => {
    const { db, ctx, deps } = makeHarness();
    // Pick interpretabile ma ricevuto DOPO il fischio d'inizio (16:00): il guard
    // RF-31 blocca l'accettazione → ROLLBACK: nessun profilo orfano.
    ctx.parser = new FakeParser(new Map([[`vado di ${JU}`, { team: JU, outcome: 'win' }]]));

    await processEmailBatch(
      ctx,
      [incoming('sconosciuto@test.it', `vado di ${JU}`, T_AFTER_KICKOFF, '1')],
      deps(new Set())
    );

    const players = db.prepare('SELECT COUNT(*) AS n FROM player WHERE email = ?').get('sconosciuto@test.it') as {
      n: number;
    };
    expect(players.n).toBe(0); // CL5/CL17: nessun profilo creato a partita iniziata
  });

  it('mittente ignoto non interpretabile nel TT1 → chiarimento senza registrazione (CL5)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    ctx.parser = new FakeParser(new Map()); // null → chiarimento

    const result = await processEmailBatch(
      ctx,
      [incoming('sconosciuto@test.it', 'boh', T_PICK, '1')],
      deps(new Set())
    );

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    expect(result.messages[0]).toMatchObject({ action: 'clarification', seen: true });
    const players = db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number };
    expect(players.n).toBe(0);
  });

  it('mittente ignoto dal TT2 → rifiuto senza registrazione (RF-24/CL2)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    // Chiude il TT1 e apre il TT2: il primo round open è ora il TC 2.
    await closeRound(ctx, 1, {});
    ctx.now = T_OPEN2;
    await openRound(ctx, 2);
    ctx.parser = new FakeParser(new Map([[`vado di ${IM}`, { team: IM, outcome: 'win' }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('sconosciuto@test.it', `vado di ${IM}`, new Date('2026-09-19T15:00:00.000Z'), '1')],
      deps(new Set())
    );

    expect(result.messages[0]).toMatchObject({ action: 'rejected_tt2', seen: true });
    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT2TC2');
    const players = db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number };
    expect(players.n).toBe(0); // RF-24: nessuna registrazione
  });

  it('nessun round aperto → rifiuto round_not_open e messaggio marcato letto (CL3/D7 esteso)', async () => {
    const { ctx, channel, deps, seen } = makeHarness({ startTournament: false });

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', 'scelgo la Juve', T_PICK, '1')],
      deps(new Set())
    );

    expect(result.messages[0]).toMatchObject({ action: 'round_not_open', seen: true });
    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato');
    expect(seen).toEqual(['1']);
  });

  it('guard RF-31: pick oltre il kickoff effettivo → after_kickoff (receivedAt = internaldate)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    insertProfile(db, 'a@test.it');
    ctx.parser = new FakeParser(new Map([[`vado di ${JU}`, { team: JU, outcome: 'win' }]]));

    await processEmailBatch(
      ctx,
      [incoming('a@test.it', `vado di ${JU}`, T_AFTER_KICKOFF, '1')],
      deps(new Set(['a@test.it']))
    );

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    const pick = db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number };
    expect(pick.n).toBe(0); // CL17/CL18: nessuna accettazione oltre il fischio
  });

  it('finestra di iscrizione chiusa → rifiuto "torneo iniziato" senza profilo (CL2/RF-03)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    closeRegistration(ctx, {});

    await processEmailBatch(ctx, [incoming('new@test.it', 'vorrei iscrivermi', T_PICK, '1')], deps(new Set()));

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    const players = db.prepare('SELECT COUNT(*) AS n FROM player').get() as { n: number };
    expect(players.n).toBe(0);
  });

  it('mittente con keyword ma già registrato → risposta "già registrato" (knownEmails stale)', async () => {
    const { db, ctx, channel, deps } = makeHarness();
    insertProfile(db, 'a@test.it');

    // knownEmails del batch costruito PRIMA della registrazione: caso difensivo.
    await processEmailBatch(ctx, [incoming('a@test.it', 'mi iscrivo di nuovo', T_PICK, '1')], deps(new Set()));

    expect(channel.sent[0]?.subject).toBe('Survivor League — Pick non registrato TT1TC1');
    const players = db.prepare('SELECT COUNT(*) AS n FROM player WHERE email = ?').get('a@test.it') as {
      n: number;
    };
    expect(players.n).toBe(1); // nessun duplicato (RNF2)
  });
});

describe('channel:email:process — errori (D7/RNF9)', () => {
  it('LLMError → messaggio NON marcato letto e batch FERMATO (retry al prossimo tick)', async () => {
    const { db, ctx, channel, deps, seen } = makeHarness();
    insertProfile(db, 'a@test.it');
    insertProfile(db, 'b@test.it');
    insertProfile(db, 'c@test.it');
    const broken = new FakeParser(new Map(), new LLMError('API giù', 429));
    // Scripted: il primo messaggio va bene, il secondo fa scattare l'errore.
    const scripted = {
      extractPick: (body: string, opts: PickParseOptions) => {
        if (body === 'vado di inter') return Promise.resolve({ team: IM, outcome: 'win' } satisfies PickExtraction);
        return broken.extractPick(body, opts);
      }
    } as unknown as LLMParser;
    ctx.parser = scripted;

    const messages = [
      incoming('a@test.it', 'vado di inter', T_PICK, '1'),
      incoming('b@test.it', 'vado di roma', T_PICK, '2'),
      incoming('c@test.it', 'vado di milan', T_PICK, '3')
    ];

    const result = await processEmailBatch(ctx, messages, deps(new Set(['a@test.it', 'b@test.it', 'c@test.it'])));

    expect(result.messages.map((m) => m.action)).toEqual(['pick_registered', 'error_llm']);
    expect(result.stopped).toBe(true);
    expect(seen).toEqual(['1']); // solo il primo è stato marcato letto
    expect(channel.sent).toHaveLength(1); // nessuna risposta inviata per i falliti
  });
});

describe('channel:email:process — offset receivedAt test-only (D9, piano UAT Task 0.3)', () => {
  it('con testMode=false il receivedAt NON è shiftato: pick oltre il kickoff resta rifiutato (regressione)', async () => {
    const { db, ctx, deps } = makeHarness();
    insertProfile(db, 'a@test.it');
    ctx.parser = new FakeParser(new Map([[`vado di ${JU}`, { team: JU, outcome: 'win' }]]));

    await processEmailBatch(
      ctx,
      [incoming('a@test.it', `vado di ${JU}`, T_AFTER_KICKOFF, '1')],
      deps(new Set(['a@test.it']))
    );

    // Nessuno shift: receivedAt (16:01) > kickoff (16:00) → after_kickoff.
    const pick = db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number };
    expect(pick.n).toBe(0);
  });

  it('con testMode=true + TEST_OFFSET_DAYS=1 il receivedAt è shiftato indietro di 1 giorno: il pick oltre il kickoff reale diventa accettabile', async () => {
    // receivedAt reale 16:01 (oltre il kickoff 16:00) → shiftato di 1 giorno a
    // 09-11T16:01, ben prima della deadline (09-12T15:30): accettato. Dimostra
    // che lo shift è applicato UNA volta all'ingresso del batch con il delta
    // giusto (senza shift resterebbe after_kickoff, vedi test di regressione).
    const { db, ctx, deps } = makeHarness({ testMode: true, offsetDays: 1 });
    insertProfile(db, 'a@test.it');
    ctx.parser = new FakeParser(new Map([[`vado di ${JU}`, { team: JU, outcome: 'win' }]]));

    const result = await processEmailBatch(
      ctx,
      [incoming('a@test.it', `vado di ${JU}`, T_AFTER_KICKOFF, '1')],
      deps(new Set(['a@test.it']))
    );

    expect(result.messages[0]).toMatchObject({ action: 'pick_registered', seen: true });
    const pick = db.prepare('SELECT COUNT(*) AS n FROM pick').get() as { n: number };
    expect(pick.n).toBe(1); // pick accettato grazie allo shift
  });
});
