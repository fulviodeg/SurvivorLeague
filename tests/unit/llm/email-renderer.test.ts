/**
 * Test del renderer deterministico del canale email (ADR-011, Task 4).
 *
 * Funzione pura (`renderEmailV2`): nessun clock, nessun DB — date e fuso
 * iniettati. Coprono: box ASCII esatti (esito ✅/❌, deadline+countdown,
 * bruciate), ordine dei blocchi (box deadline = elemento n.1 nelle mail che
 * richiedono un pick; box esito subito dopo l'header), omissione dei blocchi
 * quando i dati mancano ("se un dato è assente, non inventarlo"), MAI
 * elenchi nominativi di partecipanti (solo conteggi), date it-IT nel fuso
 * iniettato, chiusura fissa dell'eliminato (mai "grazie per averci
 * giocato"), CTA per tipo e formula di iscrizione col nome nella mail di
 * chiarimento (convenzione 7).
 */
import { describe, expect, it } from 'vitest';

import { renderEmailV2 } from '../../../src/llm/email-renderer.js';
import type { EmailContext } from '../../../src/llm/generator.js';

const ROME = 'Europe/Rome';

describe('renderEmailV2 — header e saluto', () => {
  it('header con coppia UMANA "Round N · Turno di campionato M" (mai sigle TT/TC)', () => {
    const body = renderEmailV2(
      { type: 'pick_instructions', round: 2, championshipRound: 7, playerName: 'Aldo' },
      'narrativa',
      ROME
    );
    expect(body).toContain('Round 2 · Turno di campionato 7');
    expect(body).not.toContain('TT');
    expect(body).not.toContain('TC');
    expect(body).toContain('Ciao Aldo!');
  });

  it('senza coppia → header brand; senza nome → nessun saluto (dato assente: ometti)', () => {
    const body = renderEmailV2({ type: 'tournament_open', platformCount: 3 }, 'narrativa', ROME);
    expect(body.startsWith('Survivor League')).toBe(true);
    expect(body).not.toContain('Ciao');
  });
});

describe('renderEmailV2 — box deadline (convenzione 2: elemento n.1 con countdown)', () => {
  const ctx: EmailContext = {
    type: 'pick_instructions',
    round: 1,
    championshipRound: 1,
    deadline: new Date('2026-09-12T15:30:00.000Z'),
    deadlineRemaining: '20 ore e 15 minuti'
  };

  it('box ASCII con data it-IT nel fuso iniettato e countdown del SISTEMA', () => {
    const body = renderEmailV2(ctx, 'narrativa', ROME);
    expect(body).toContain('╔══');
    expect(body).toContain('⏰ DEADLINE PICK');
    expect(body).toContain('sabato 12 settembre 2026 alle ore 17:30'); // 15:30Z = 17:30 a Roma (CEST)
    expect(body).toContain('Mancano circa 20 ore e 15 minuti');
    // Il box deadline viene PRIMA della narrativa (elemento n.1).
    expect(body.indexOf('DEADLINE PICK')).toBeLessThan(body.indexOf('narrativa'));
    expect(body).toContain('╚══');
  });

  it('il fuso sposta SOLO la data mostrata (America/New_York → 11:30 EDT)', () => {
    const body = renderEmailV2(ctx, 'narrativa', 'America/New_York');
    expect(body).toContain('sabato 12 settembre 2026 alle ore 11:30');
  });

  it('senza countdown → solo la data; senza deadline → box OMESSO', () => {
    const withoutCountdown = renderEmailV2(
      { ...ctx, deadlineRemaining: undefined },
      'narrativa',
      ROME
    );
    expect(withoutCountdown).toContain('DEADLINE PICK');
    expect(withoutCountdown).not.toContain('Mancano circa');

    const withoutDeadline = renderEmailV2(
      { type: 'pick_instructions', round: 1, championshipRound: 1 },
      'narrativa',
      ROME
    );
    expect(withoutDeadline).not.toContain('DEADLINE PICK');
  });
});

describe('renderEmailV2 — box esito (convenzione 5: testi esatti, subito dopo l’header)', () => {
  it('corretto → "✅ SEI ANCORA IN GARA — Hai indovinato! {squadra} → {esito}"', () => {
    const body = renderEmailV2(
      {
        type: 'round_result_correct',
        round: 2,
        championshipRound: 7,
        playerName: 'Aldo',
        team: 'Juventus FC',
        outcome: 'win'
      },
      'narrativa',
      ROME
    );
    expect(body).toContain('✅ SEI ANCORA IN GARA — Hai indovinato! Juventus FC → vittoria');
    expect(body).toContain('ESITO DEL ROUND');
    // Subito dopo l'header/saluto, prima della narrativa.
    expect(body.indexOf('ESITO DEL ROUND')).toBeLessThan(body.indexOf('narrativa'));
  });

  it('sbagliato → "❌ SEI STATO ELIMINATO — Il tuo pick (...) non si è avverato" + chiusura fissa', () => {
    const body = renderEmailV2(
      {
        type: 'round_result_wrong',
        round: 2,
        championshipRound: 7,
        team: 'Juventus FC',
        outcome: 'draw',
        inGameCount: 47
      },
      'narrativa',
      ROME
    );
    expect(body).toContain('❌ SEI STATO ELIMINATO — Il tuo pick (Juventus FC → pareggio) non si è avverato');
    // Convenzione 10: chiusura fissa, MAI "grazie per averci giocato".
    expect(body).toContain('Il torneo continua con 47 giocatori in gara. Grazie per essere stato con noi!');
    expect(body).not.toContain('averci giocato');
  });

  it('mancante → "❌ SEI STATO ELIMINATO — Non è arrivato alcun pick entro la deadline"', () => {
    const body = renderEmailV2(
      { type: 'pick_missing_elimination', round: 1, championshipRound: 1 },
      'narrativa',
      ROME
    );
    expect(body).toContain('❌ SEI STATO ELIMINATO — Non è arrivato alcun pick entro la deadline');
  });

  it('esito con squadra/esito assenti → forma generica senza inventare dati', () => {
    const body = renderEmailV2(
      { type: 'round_result_correct', round: 2, championshipRound: 7 },
      'narrativa',
      ROME
    );
    expect(body).toContain('✅ SEI ANCORA IN GARA — Hai indovinato!');
    expect(body).not.toContain('→');
  });

  it('chiusura eliminato OMESSA senza inGameCount (dato assente: ometti)', () => {
    const body = renderEmailV2(
      { type: 'round_result_wrong', round: 2, championshipRound: 7 },
      'narrativa',
      ROME
    );
    expect(body).not.toContain('Grazie per essere stato con noi');
  });
});

describe('renderEmailV2 — box bruciate (convenzione 3) e sezioni dati', () => {
  it('box bruciate con round di utilizzo nelle istruzioni pick', () => {
    const body = renderEmailV2(
      {
        type: 'pick_instructions',
        round: 3,
        championshipRound: 3,
        burnedTeams: [
          { team: 'Juventus FC', round: 1 },
          { team: 'AC Milan', round: 2 }
        ]
      },
      'narrativa',
      ROME
    );
    expect(body).toContain('🔒 SQUADRE BRUCIATE');
    expect(body).toContain('Juventus FC — Round 1');
    expect(body).toContain('AC Milan — Round 2');
  });

  it('box bruciate OMESSO senza bruciate o su altri tipi', () => {
    const body = renderEmailV2({ type: 'pick_instructions', round: 3, championshipRound: 3 }, 'narrativa', ROME);
    expect(body).not.toContain('SQUADRE BRUCIATE');
    const other = renderEmailV2(
      { type: 'pick_confirmed', round: 3, championshipRound: 3, burnedTeams: [{ team: 'AC Milan', round: 2 }] },
      'narrativa',
      ROME
    );
    expect(other).not.toContain('SQUADRE BRUCIATE');
  });

  it('sezione partite/risultati: punteggi, rinviate, MAI elenchi nominativi di giocatori', () => {
    const body = renderEmailV2(
      {
        type: 'round_closed_survived',
        round: 1,
        championshipRound: 1,
        matches: [
          {
            home: 'FC Internazionale Milano',
            away: 'AC Milan',
            score: { home: 2, away: 1 }
          },
          {
            home: 'Juventus FC',
            away: 'AS Roma',
            postponed: true
          }
        ],
        inGameCount: 47,
        eliminatedWrong: 2,
        eliminatedMissing: 1
      },
      'narrativa',
      ROME
    );
    expect(body).toContain('⚽ PARTITE DEL ROUND');
    expect(body).toContain('FC Internazionale Milano - AC Milan: 2-1');
    expect(body).toContain('Juventus FC - AS Roma (rinviata)');
    // Convenzione 6: SOLO conteggi aggregati.
    expect(body).toContain('📊 STATO DEL TORNEO');
    expect(body).toContain('In gara: 47 · Eliminati: 3 (2 pick sbagliati · 1 senza pick)');
  });

  it('stato aggregato: parti omesse quando i conteggi mancano', () => {
    const body = renderEmailV2(
      { type: 'round_closed_survived', round: 1, championshipRound: 1, inGameCount: 5 },
      'narrativa',
      ROME
    );
    expect(body).toContain('In gara: 5');
    expect(body).not.toContain('Eliminati');
  });
});

describe('renderEmailV2 — CTA per tipo e annuncio apertura torneo', () => {
  it('pick_instructions: invito al pick con formato', () => {
    const body = renderEmailV2({ type: 'pick_instructions', round: 1, championshipRound: 1 }, 'narrativa', ROME);
    expect(body).toContain('➡️ COSA FARE ORA');
    expect(body).toContain('squadra ed esito (win, draw, lose)');
  });

  it('tournament_open: SOLO annuncio — "il round 1 parte a breve", iscritti aggregati, nessuna data', () => {
    const body = renderEmailV2(
      { type: 'tournament_open', platformCount: 12 },
      'narrativa',
      ROME
    );
    expect(body).toContain('Il round 1 parte a breve: stai pronto!');
    expect(body).toContain('👥 Iscritti alla piattaforma: 12');
    expect(body).not.toContain('DEADLINE');
  });

  it('clarification: 3 opzioni + formula iscrizione col nome (convenzione 7)', () => {
    const body = renderEmailV2({ type: 'clarification' }, 'narrativa', ROME);
    expect(body).toContain('🤔 COSA PUOI FARE');
    expect(body).toContain('1. Iscriverti: dimmi il tuo nome e scrivi "voglio iscrivermi".');
    expect(body).toContain('2. Disiscriverti: scrivi "voglio disiscrivermi".');
    expect(body).toContain('3. Inviare un pick: scrivi squadra + esito (win, draw, lose).');
  });

  it('vincitore: chiusura festosa senza riferimento a round successivi', () => {
    const won = renderEmailV2({ type: 'tournament_won', playerName: 'Aldo' }, 'narrativa', ROME);
    expect(won).toContain('🏆 Complimenti campione!');
    const shared = renderEmailV2({ type: 'tournament_shared_win', playerName: 'Aldo' }, 'narrativa', ROME);
    expect(shared).toContain('🏆 Complimenti campioni!');
  });
});

describe('renderEmailV2 — narrativa e determinismo', () => {
  it('narrativa vuota → blocco omesso (mai testo inventato)', () => {
    const body = renderEmailV2(
      { type: 'pick_instructions', round: 1, championshipRound: 1 },
      '   ',
      ROME
    );
    expect(body).not.toContain('   ');
  });

  it('stesso contesto e fuso → output identico (determinismo RNF1)', () => {
    const ctx: EmailContext = {
      type: 'round_result_correct',
      round: 2,
      championshipRound: 7,
      playerName: 'Aldo',
      team: 'AC Milan',
      outcome: 'lose',
      inGameCount: 3
    };
    expect(renderEmailV2(ctx, 'narrativa', ROME)).toBe(renderEmailV2(ctx, 'narrativa', ROME));
  });
});
