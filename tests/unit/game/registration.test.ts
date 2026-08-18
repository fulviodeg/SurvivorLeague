/**
 * Test di registrazione e auto-iscrizione (piano Task 4.2, LLD §7.10).
 *
 * Su DB reale SQLite in-memory + provider reale con la mini-stagione (LLD §8).
 * Verificano:
 * - registrazione manuale (US8): univocità email (RNF2), gate finestra con
 *   override US10 a finestra chiusa (--reason), eligibilità esposta e loggata;
 * - register:open/close (US7/RF-28): apertura/chiusura finestra, notifica
 *   best-effort UNA SOLA volta, chiusura forzata con motivo, finestre
 *   indipendenti (pick TT1 ancora accettati a finestra chiusa);
 * - auto-iscrizione RF-27 (CL2): profilo+pick ATOMICI nel TT1; CL5 (contenuto
 *   non interpretabile → nessun profilo); RF-24 (dal TT2 → rifiuto senza
 *   registrazione); pick rifiutato → nessun profilo orfano; mittente già
 *   registrato (difensivo).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ChannelAdapter, IncomingMessage } from '../../../src/channel/adapter.js';
import { parseConfig } from '../../../src/config.js';
import { DbSeasonDataProvider } from '../../../src/data/db-provider.js';
import { migrate } from '../../../src/db/schema.js';
import type { GameContext } from '../../../src/game/context.js';
import type { LLMGenerator } from '../../../src/llm/generator.js';
import { openRound } from '../../../src/game/round-manager.js';
import {
  autoRegisterFromPick,
  closeRegistration,
  openRegistration,
  registerPlayer
} from '../../../src/game/registration.js';
import { startTournament } from '../../../src/game/tournament.js';
import { FIXTURE_TEAMS, loadBaseSeason } from '../../fixtures/season.js';

const [IM] = FIXTURE_TEAMS;

const NOW = new Date('2026-09-01T10:00:00.000Z'); // prima della deadline TT1 (15:30 del 12/09)
const T_PICK = new Date('2026-09-12T15:00:00.000Z'); // entro la deadline del TT1

/** Fake ChannelAdapter per le notifiche. */
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

/** Fake LLMGenerator con contesti registrati. */
class FakeGenerator implements LLMGenerator {
  contexts: Array<{ type: string }> = [];
  generate(ctx: { type: string }): Promise<string> {
    this.contexts.push(ctx);
    return Promise.resolve(`[${ctx.type}]`);
  }
}

interface Harness {
  db: Database.Database;
  channel: FakeChannel;
  generator: FakeGenerator;
  ctx: GameContext;
}

/** Banco di prova: DB migrato + mini-stagione + fake I/O + torneo avviato. */
async function makeHarness(): Promise<Harness> {
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
      FOOTBALL_DATA_TOKEN: 't'
    }),
    now: NOW,
    channel,
    generator
  };
  await startTournament(ctx);
  return { db, channel, generator, ctx };
}

/** Apre il round 1 (TT1) per i test di auto-iscrizione. */
async function openTT1(h: Pick<Harness, 'db' | 'ctx'>): Promise<void> {
  await openRound(h.ctx, 1);
}

describe('registrazione manuale (US8, RNF2, override US10)', () => {
  it('a finestra aperta registra senza motivo (eligibilità esposta)', async () => {
    const { db, ctx } = await makeHarness();
    const res = registerPlayer(ctx, { email: 'a@test.it', name: 'Aldo' });
    expect(res).toMatchObject({ ok: true, eligibility: { eligible: true } });
    if (res.ok) {
      expect(db.prepare('SELECT email FROM player WHERE id = (SELECT player_id FROM profile WHERE id = ?)').get(res.profileId)).toEqual({ email: 'a@test.it' });
    }
  });

  it('univocità email (RNF2): il secondo invio è rifiutato', async () => {
    const { ctx } = await makeHarness();
    expect(registerPlayer(ctx, { email: 'a@test.it' })).toMatchObject({ ok: true });
    expect(registerPlayer(ctx, { email: 'a@test.it' })).toMatchObject({
      ok: false,
      reason: 'email_already_registered',
      eligibility: { eligible: true }
    });
  });

  it('a finestra chiusa senza --reason → registration_closed', async () => {
    const { ctx } = await makeHarness();
    closeRegistration(ctx);
    const res = registerPlayer(ctx, { email: 'b@test.it' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('registration_closed');
  });

  it('a finestra chiusa con --reason (override US10) → registra ed espone il motivo', async () => {
    const { db, ctx } = await makeHarness();
    closeRegistration(ctx);
    const res = registerPlayer(ctx, { email: 'b@test.it', reason: 'ingresso manuale commissione' });
    expect(res).toMatchObject({
      ok: true,
      eligibility: { eligible: true, reason: 'ingresso manuale commissione' }
    });
    if (res.ok) {
      expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
    }
  });

  it('Decisione A (RNF1): player e profile con created_at dal clock iniettato', async () => {
    const { db, ctx } = await makeHarness();
    const res = registerPlayer(ctx, { email: 'clock@test.it' });
    expect(res.ok).toBe(true);
    const player = db
      .prepare(
        'SELECT created_at FROM player WHERE id = (SELECT player_id FROM profile WHERE id = ?)'
      )
      .get(res.ok ? res.profileId : 0) as { created_at: string };
    const profile = db
      .prepare('SELECT created_at FROM profile WHERE id = ?')
      .get(res.ok ? res.profileId : 0) as { created_at: string };
    expect(player.created_at).toBe(NOW.toISOString());
    expect(profile.created_at).toBe(NOW.toISOString());
  });
});

describe('register:open / register:close (US7, RF-22, RF-28)', () => {
  it('open mantiene aperta la finestra e notifica i contatti UNA SOLA volta', async () => {
    const { db, channel, generator, ctx } = await makeHarness();
    // La finestra è già aperta da tournament:start (RF-22): opened=false = "già aperta".
    const first = await openRegistration(ctx, { contacts: ['c1@test.it', 'c2@test.it'] });
    expect(first).toEqual({ opened: false, notified: 2 });
    expect(channel.sent).toHaveLength(2);
    expect(generator.contexts[0]?.type).toBe('registration_open_invite');

    // Seconda chiamata: la notifica non si ripete (registration_notified).
    const second = await openRegistration(ctx, { contacts: ['c1@test.it'] });
    expect(second.notified).toBe(0);
    expect(channel.sent).toHaveLength(2);
    expect(db.prepare('SELECT registration_open, registration_notified FROM tournament_state WHERE id = 1').get())
      .toEqual({ registration_open: 1, registration_notified: 1 });
  });

  it('close chiude la finestra; con --reason è forzata e auditata', async () => {
    const { db, ctx } = await makeHarness();
    const normal = closeRegistration(ctx);
    expect(normal).toMatchObject({ closed: true, forced: false });
    expect(db.prepare('SELECT registration_open FROM tournament_state WHERE id = 1').get())
      .toEqual({ registration_open: 0 });

    // Riapri e chiudi forzatamente.
    void openRegistration(ctx);
    const forced = closeRegistration(ctx, { reason: 'quota raggiunta' });
    expect(forced).toMatchObject({ closed: true, forced: true, reason: 'quota raggiunta' });
  });

  it('finestre indipendenti: a finestra di iscrizione chiusa i pick del TT1 restano accettati', async () => {
    const { ctx } = await makeHarness();
    await openTT1({ db: ctx.db, ctx });
    closeRegistration(ctx);
    // Il round 1 è aperto e la deadline non è passata: i pick del TT1 restano
    // accettati (la finestra di iscrizione chiusa NON chiude la finestra di pick).
    expect(
      ctx.db.prepare("SELECT status FROM round_state WHERE round = 1").get()
    ).toMatchObject({ status: 'open' });
    // Registrazione manuale a finestra chiusa → serve il motivo (override US10).
    expect(registerPlayer(ctx, { email: 't@test.it' }).ok).toBe(false);
  });
});

describe('auto-iscrizione RF-27 (CL2/CL5/RF-24)', () => {
  it('CL2: pick interpretabile da sconosciuto nel TT1 → profilo + pick atomici', async () => {
    const { db, ctx } = await makeHarness();
    await openTT1({ db, ctx });

    const res = await autoRegisterFromPick(
      ctx,
      { channel: 'email', identifier: 'nuovo@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      const pick = db.prepare('SELECT profile_id, round, team, outcome, status FROM pick WHERE id = ?').get(res.pickId) as {
        profile_id: number;
        round: number;
        team: string;
        outcome: string;
        status: string;
      };
      expect(pick).toMatchObject({ profile_id: res.profileId, round: 1, team: IM, outcome: 'win', status: 'pending' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM pick').get()).toEqual({ n: 1 });
    }
  });

  it('CL5: contenuto non interpretabile → nessun profilo creato', async () => {
    const { db, ctx } = await makeHarness();
    const res = await autoRegisterFromPick(ctx, { channel: 'email', identifier: 'x@test.it' }, null, 1, T_PICK);
    expect(res).toEqual({ ok: false, reason: 'not_interpretable' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('RF-24: dal TT2 l\'auto-iscrizione è rifiutata senza registrazione', async () => {
    const { db, ctx } = await makeHarness();
    const res = await autoRegisterFromPick(
      ctx,
      { channel: 'email', identifier: 'y@test.it' },
      { team: IM, outcome: 'win' },
      2, // TC 2 = TT 2
      new Date('2026-09-19T15:00:00Z')
    );
    expect(res).toEqual({ ok: false, reason: 'not_tt1' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
  });

  it('pick rifiutato dalla cascata → ROLLBACK: nessun profilo orfano', async () => {
    const { db, ctx } = await makeHarness();
    await openTT1({ db, ctx });
    // 'Napoli' non è nella lista canonica della mini-stagione → unknown_team.
    const res = await autoRegisterFromPick(
      ctx,
      { channel: 'email', identifier: 'z@test.it' },
      { team: 'Napoli', outcome: 'win' },
      1,
      T_PICK
    );
    expect(res).toEqual({ ok: false, reason: 'pick_rejected', pickReason: 'unknown_team' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pick').get()).toEqual({ n: 0 });
  });

  it('finestra chiusa → window_closed', async () => {
    const { ctx } = await makeHarness();
    closeRegistration(ctx);
    const res = await autoRegisterFromPick(ctx, { channel: 'email', identifier: 'w@test.it' }, { team: IM, outcome: 'win' }, 1, T_PICK);
    expect(res).toEqual({ ok: false, reason: 'window_closed' });
  });

  it('mittente già registrato → already_registered (difensivo)', async () => {
    const { ctx } = await makeHarness();
    registerPlayer(ctx, { email: 'v@test.it' });
    const res = await autoRegisterFromPick(ctx, { channel: 'email', identifier: 'v@test.it' }, { team: IM, outcome: 'win' }, 1, T_PICK);
    expect(res).toEqual({ ok: false, reason: 'already_registered' });
  });

  it('Decisione A (RNF1): auto-iscrizione con created_at dal clock su player/profile/pick', async () => {
    const { db, ctx } = await makeHarness();
    await openTT1({ db, ctx });

    const res = await autoRegisterFromPick(
      ctx,
      { channel: 'email', identifier: 'clock2@test.it' },
      { team: IM, outcome: 'win' },
      1,
      T_PICK
    );
    expect(res.ok).toBe(true);
    const player = db
      .prepare(
        'SELECT created_at FROM player WHERE id = (SELECT player_id FROM profile WHERE id = ?)'
      )
      .get(res.ok ? res.profileId : 0) as { created_at: string };
    const profile = db
      .prepare('SELECT created_at FROM profile WHERE id = ?')
      .get(res.ok ? res.profileId : 0) as { created_at: string };
    const pick = db
      .prepare('SELECT created_at FROM pick WHERE id = ?')
      .get(res.ok ? res.pickId : 0) as { created_at: string };
    expect(player.created_at).toBe(NOW.toISOString());
    expect(profile.created_at).toBe(NOW.toISOString());
    expect(pick.created_at).toBe(NOW.toISOString());
  });
});
