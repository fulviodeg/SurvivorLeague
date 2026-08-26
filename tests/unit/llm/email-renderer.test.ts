/**
 * Test del renderer deterministico del canale email (email v3 + v4, Task 2).
 *
 * Funzione pura (`renderEmailV2`): nessun clock, nessun DB — date e fuso
 * iniettati. Il piano email-v3/v4 richiede gli OUTPUT ESATTI dei 17 template:
 * nessun riquadro ASCII (`╔ ═ ╗ ║ ╚ ─`), messaggio chiave `keyMessage` in
 * MAIUSCOLO, sezioni a righe con titolo emoji + MAIUSCOLO (esito ✅/❌,
 * deadline con data+countdown sulla stessa riga, partite/risultati, squadre
 * già usate "(Round N)", stato aggregato), elenco giocatori (ADR-015),
 * co-vincitori (ADR-015), storico torneo (ADR-015), CTA per tipo, chiusura
 * fissa dell'eliminato. Ogni `it` asserisce l'intero corpo per un tipo, con i
 * dati di esempio del piano.
 */
import { describe, expect, it } from 'vitest';

import { renderEmailV2 } from '../../../src/llm/email-renderer.js';
import { EMAIL_TYPES, type EmailContext, type EmailType } from '../../../src/llm/generator.js';

const ROME = 'Europe/Rome';

/** Deadline di esempio (sabato 19 settembre 2026, 17:30 a Roma — CEST). */
const DEADLINE = new Date('2026-09-19T15:30:00.000Z');
/** Riga deadline attesa: data it-IT + countdown sulla stessa riga. */
const DEADLINE_LINE = 'sabato 19 settembre 2026 alle ore 17:30 · Mancano circa 2 ore';

/** Coppia umana header (round del torneo 3 · turno di campionato 5). */
const HEADER = 'Round del torneo 3 · Turno di Campionato 5';

/** Partite in programma (senza punteggio) per le istruzioni pick. */
const UPCOMING_MATCHES = [
  { home: 'Cagliari', away: 'Genoa' },
  { home: 'Como', away: 'Venezia' },
  { home: 'Torino', away: 'Lecce' }
];

/** Risultati (con punteggio) per le mail di esito. */
const RESULT_MATCHES = [
  { home: 'Roma', away: 'Genoa', score: { home: 2, away: 1 } },
  { home: 'Cagliari', away: 'Como', score: { home: 0, away: 0 } },
  { home: 'Torino', away: 'Lecce', score: { home: 1, away: 3 } }
];

/** Squadre già usate dal giocatore. */
const BURNED = [
  { team: 'Roma', round: 1 },
  { team: 'Inter', round: 2 }
];

describe('renderEmailV2 (email v3/v4) — output esatto per i 17 template', () => {
  it('platform_registered', () => {
    const body = renderEmailV2(
      { type: 'platform_registered', playerName: 'Mario' },
      'Quando si apre il round riceverai le istruzioni per il pick.',
      ROME
    );
    expect(body).toBe(
      [
        'Ciao Mario!',
        'ISCRIZIONE CONFERMATA: SEI IN PIATTAFORMA!',
        'Quando si apre il round riceverai le istruzioni per il pick.',
        '',
        '➡️ COSA FARE ORA',
        'Non serve altro: aspetta la mail di apertura del round.'
      ].join('\n')
    );
  });

  it('platform_unsubscribe_confirm', () => {
    const body = renderEmailV2(
      { type: 'platform_unsubscribe_confirm' },
      'Rispondi a questa email con "confermo" per completare la disiscrizione.\n\nSe cambi idea, non fare nulla: resterai iscritto.',
      ROME
    );
    expect(body).toBe(
      [
        'CONFERMA LA DISISCRIZIONE?',
        'Rispondi a questa email con "confermo" per completare la disiscrizione.',
        '',
        'Se cambi idea, non fare nulla: resterai iscritto.'
      ].join('\n')
    );
  });

  it('platform_unsubscribed', () => {
    const body = renderEmailV2(
      { type: 'platform_unsubscribed' },
      'Non riceverai più comunicazioni. Per tornare, rispondi con "ISCRIZIONE [il tuo nome]" (nel subject o nel corpo).',
      ROME
    );
    expect(body).toBe(
      [
        'DISISCRIZIONE COMPLETATA',
        'Non riceverai più comunicazioni. Per tornare, rispondi con "ISCRIZIONE [il tuo nome]" (nel subject o nel corpo).'
      ].join('\n')
    );
  });

  it('platform_already_registered', () => {
    const body = renderEmailV2(
      { type: 'platform_already_registered', playerName: 'Mario' },
      "All'apertura del round riceverai le istruzioni per il pick.",
      ROME
    );
    expect(body).toBe(
      [
        'Ciao Mario!',
        'SEI GIÀ ISCRITTO: NON SERVE RE-ISCRIVERTI.',
        "All'apertura del round riceverai le istruzioni per il pick."
      ].join('\n')
    );
  });

  it('tournament_open', () => {
    const body = renderEmailV2(
      { type: 'tournament_open', playerName: 'Mario', platformCount: 18 },
      'Il round 1 parte a breve: stai pronto.',
      ROME
    );
    expect(body).toBe(
      [
        'Ciao Mario!',
        '🏆 TORNEO APERTO!',
        'Il round 1 parte a breve: stai pronto.',
        '',
        '⏳ COSA SUCCEDE ORA',
        'Le istruzioni con la scadenza del pick arriveranno con una mail dedicata.',
        '',
        '👥 Iscritti alla piattaforma: 18'
      ].join('\n')
    );
  });

  it('pick_instructions', () => {
    const ctx: EmailContext = {
      type: 'pick_instructions',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      deadline: DEADLINE,
      deadlineRemaining: '2 ore',
      matches: UPCOMING_MATCHES,
      burnedTeams: BURNED,
      inGameCount: 14,
      eliminatedWrong: 2,
      eliminatedMissing: 1
    };
    const body = renderEmailV2(ctx, "Scegli una squadra e l'esito (vittoria, pareggio, sconfitta).", ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        'ROUND APERTO: INVIA IL TUO PICK!',
        "Scegli una squadra e l'esito (vittoria, pareggio, sconfitta).",
        '',
        '⚽ PARTITE DEL ROUND',
        'Cagliari - Genoa',
        'Como - Venezia',
        'Torino - Lecce',
        '',
        '🔒 SQUADRE GIÀ USATE',
        'Roma (Round 1)',
        'Inter (Round 2)',
        '',
        '📊 STATO DEL TORNEO',
        'In gara: 14 · Eliminati: 3 (2 pick sbagliati · 1 senza pick)',
        '',
        '➡️ COSA FARE ORA',
        'Rispondi a questa email con squadra + esito prima della scadenza.',
        '',
        '⏰ DEADLINE PICK',
        DEADLINE_LINE
      ].join('\n')
    );
  });

  it('pick_confirmed', () => {
    const ctx: EmailContext = {
      type: 'pick_confirmed',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      deadline: DEADLINE,
      deadlineRemaining: '2 ore',
      team: 'Roma',
      outcome: 'win'
    };
    // D1: narrativa deterministica VUOTA → nessuna frase di correzione, solo
    // il messaggio chiave + deadline in coda.
    const body = renderEmailV2(ctx, '', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        'PICK REGISTRATO → ROMA → VITTORIA',
        '',
        '⏰ DEADLINE PICK',
        DEADLINE_LINE
      ].join('\n')
    );
  });

  it('pick_rejected', () => {
    const ctx: EmailContext = {
      type: 'pick_rejected',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      deadline: DEADLINE,
      deadlineRemaining: '2 ore',
      reason: 'squadra già usata'
    };
    const body = renderEmailV2(ctx, 'Riprova rispondendo con squadra + esito (win, draw, lose).', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        'PICK NON REGISTRATO: squadra già usata',
        'Riprova rispondendo con squadra + esito (win, draw, lose).',
        '',
        '⏰ DEADLINE PICK',
        DEADLINE_LINE
      ].join('\n')
    );
  });

  it('pick_missing_elimination', () => {
    const ctx: EmailContext = {
      type: 'pick_missing_elimination',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      inGameCount: 13
    };
    const body = renderEmailV2(ctx, 'Non è arrivato alcun pick entro la deadline.', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '',
        '❌ SEI STATO ELIMINATO!',
        'Non è arrivato alcun pick entro la deadline.',
        '',
        '📊 STATO DEL TORNEO',
        'In gara: 13',
        '',
        'Il torneo continua con 13 giocatori in gara. Grazie per essere stato con noi!'
      ].join('\n')
    );
  });

  it('round_result_correct', () => {
    const ctx: EmailContext = {
      type: 'round_result_correct',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      team: 'Roma',
      outcome: 'win',
      inGameCount: 13,
      matches: RESULT_MATCHES
    };
    const body = renderEmailV2(ctx, 'Roma → vittoria: indovinato (Roma 2-1 Genoa).', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '',
        '✅ SEI ANCORA IN GARA!',
        'Roma → vittoria: indovinato (Roma 2-1 Genoa).',
        '',
        '⚽ RISULTATI DEL ROUND',
        'Roma - Genoa: 2-1',
        'Cagliari - Como: 0-0',
        'Torino - Lecce: 1-3',
        '',
        '📊 STATO DEL TORNEO',
        'In gara: 13',
        '',
        '📌 PROSSIMO PASSO',
        "Le istruzioni per il prossimo pick arriveranno all'apertura del prossimo round."
      ].join('\n')
    );
  });

  it('round_result_wrong', () => {
    const ctx: EmailContext = {
      type: 'round_result_wrong',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      team: 'Roma',
      outcome: 'win',
      inGameCount: 13
    };
    const body = renderEmailV2(
      ctx,
      'Il tuo pick (Roma → vittoria) non si è avverato (Roma 1-2 Genoa).',
      ROME
    );
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '',
        '❌ SEI STATO ELIMINATO!',
        'Il tuo pick (Roma → vittoria) non si è avverato (Roma 1-2 Genoa).',
        '',
        '📊 STATO DEL TORNEO',
        'In gara: 13',
        '',
        'Il torneo continua con 13 giocatori in gara. Grazie per essere stato con noi!'
      ].join('\n')
    );
  });

  it('pick_postponed', () => {
    const ctx: EmailContext = {
      type: 'pick_postponed',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5
    };
    const body = renderEmailV2(ctx, 'Roma - Genoa (rinviata): il tuo pick resta in attesa.', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '',
        '⏸ PARTITA RINVIATA',
        'Roma - Genoa (rinviata): il tuo pick resta in attesa.',
        '',
        '📌 PROSSIMO PASSO',
        'Ti aggiorneremo appena la partita verrà giocata.'
      ].join('\n')
    );
  });

  it('round_closed_survived', () => {
    const ctx: EmailContext = {
      type: 'round_closed_survived',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      matches: RESULT_MATCHES,
      players: [
        { name: 'Mario Rossi', team: 'Roma', outcome: 'win', eliminated: false },
        { name: 'Sara Verdi', team: 'Inter', outcome: 'draw', eliminated: false },
        { name: 'Luca Bianchi', eliminated: true }
      ],
      inGameCount: 2,
      eliminatedWrong: 0,
      eliminatedMissing: 1
    };
    // Narrativa vuota → blocco omesso; elenco giocatori (ADR-015) tra risultati e stato.
    const body = renderEmailV2(ctx, '   ', ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '',
        'ROUND CHIUSO: SEI ANCORA IN GARA!',
        '',
        '⚽ RISULTATI DEL ROUND',
        'Roma - Genoa: 2-1',
        'Cagliari - Como: 0-0',
        'Torino - Lecce: 1-3',
        '',
        '👥 GIOCATORI DEL ROUND',
        'Mario Rossi — Roma · vittoria — ✅ ancora in gara',
        'Sara Verdi — Inter · pareggio — ✅ ancora in gara',
        'Luca Bianchi — nessun pick — ❌ eliminato',
        '',
        '📊 STATO DEL TORNEO',
        'In gara: 2 · Eliminati: 1 (1 senza pick)',
        '',
        '📌 PROSSIMO PASSO',
        "Le istruzioni per il prossimo pick arriveranno all'apertura del prossimo round."
      ].join('\n')
    );
  });

  it('tournament_won', () => {
    const ctx: EmailContext = {
      type: 'tournament_won',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5
    };
    const body = renderEmailV2(ctx, "Sei rimasto l'ultimo in gara: la vittoria è tutta tua.", ROME);
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '🏆 HAI VINTO IL TORNEO!',
        "Sei rimasto l'ultimo in gara: la vittoria è tutta tua.",
        '',
        '🎉 Festeggia, te la sei meritata!'
      ].join('\n')
    );
  });

  it('tournament_shared_win', () => {
    const ctx: EmailContext = {
      type: 'tournament_shared_win',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      coWinners: ['Sara Verdi', 'Luca Bianchi']
    };
    const body = renderEmailV2(
      ctx,
      'Insieme ai tuoi compagni di vetta avete portato a casa il torneo.',
      ROME
    );
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        '🏆 VITTORIA CONDIVISA!',
        'Insieme ai tuoi compagni di vetta avete portato a casa il torneo.',
        '',
        '🤝 HAI CONDIVISO LA VITTORIA CON',
        'Sara Verdi',
        'Luca Bianchi',
        '',
        '🎉 Festeggiate, ve lo siete meritato!'
      ].join('\n')
    );
  });

  it('clarification', () => {
    const ctx: EmailContext = {
      type: 'clarification',
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      deadline: DEADLINE,
      deadlineRemaining: '2 ore'
    };
    const body = renderEmailV2(
      ctx,
      'Puoi:\n1. Iscriverti: scrivi "ISCRIZIONE [il tuo nome]" (es. "ISCRIZIONE Mario") nel subject o nel corpo.\n2. Disiscriverti: scrivi "DISISCRIZIONE".\n3. Inviare un pick: scrivi squadra + esito (win, draw, lose).',
      ROME
    );
    expect(body).toBe(
      [
        HEADER,
        'Ciao Mario!',
        'NON HO CAPITO LA TUA RICHIESTA',
        'Puoi:',
        '1. Iscriverti: scrivi "ISCRIZIONE [il tuo nome]" (es. "ISCRIZIONE Mario") nel subject o nel corpo.',
        '2. Disiscriverti: scrivi "DISISCRIZIONE".',
        '3. Inviare un pick: scrivi squadra + esito (win, draw, lose).',
        '',
        '⏰ DEADLINE PICK',
        DEADLINE_LINE
      ].join('\n')
    );
  });

  it('tournament_closed', () => {
    const ctx: EmailContext = {
      type: 'tournament_closed',
      playerName: 'Mario',
      tournamentHistory: [
        {
          round: 1,
          championshipRound: 5,
          players: [
            { name: 'Mario Rossi', team: 'Roma', outcome: 'win', eliminated: false },
            { name: 'Sara Verdi', team: 'Inter', outcome: 'draw', eliminated: false },
            { name: 'Luca Bianchi', eliminated: true }
          ]
        },
        {
          round: 2,
          championshipRound: 6,
          players: [
            { name: 'Mario Rossi', team: 'Milan', outcome: 'win', eliminated: false },
            { name: 'Sara Verdi', team: 'Napoli', outcome: 'lose', eliminated: true }
          ]
        }
      ]
    };
    // Nessun header (senza round/championshipRound): il brand è nel separatore.
    const body = renderEmailV2(ctx, '', ROME);
    expect(body).toBe(
      [
        'Ciao Mario!',
        '',
        '🏆 TORNEO CONCLUSO!',
        '',
        '📜 STORICO DEL TORNEO',
        '',
        'Round del torneo 1 · Turno di Campionato 5',
        'Mario Rossi — Roma · vittoria — ✅ ancora in gara',
        'Sara Verdi — Inter · pareggio — ✅ ancora in gara',
        'Luca Bianchi — nessun pick — ❌ eliminato',
        '',
        'Round del torneo 2 · Turno di Campionato 6',
        'Mario Rossi — Milan · vittoria — ✅ ancora in gara',
        'Sara Verdi — Napoli · sconfitta — ❌ eliminato'
      ].join('\n')
    );
  });
});

describe('renderEmailV2 (email v3) — vincoli strutturali', () => {
  it('nessun carattere di riquadro ASCII negli output dei 17 tipi', () => {
    const contexts: Array<EmailContext> = [
      { type: 'platform_registered', playerName: 'Mario' },
      { type: 'platform_unsubscribe_confirm' },
      { type: 'platform_unsubscribed' },
      { type: 'platform_already_registered', playerName: 'Mario' },
      { type: 'tournament_open', playerName: 'Mario', platformCount: 18 },
      {
        type: 'pick_instructions',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        deadline: DEADLINE,
        deadlineRemaining: '2 ore',
        matches: UPCOMING_MATCHES,
        burnedTeams: BURNED,
        inGameCount: 14,
        eliminatedWrong: 2,
        eliminatedMissing: 1
      },
      {
        type: 'pick_confirmed',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        deadline: DEADLINE,
        deadlineRemaining: '2 ore',
        team: 'Roma',
        outcome: 'win'
      },
      {
        type: 'pick_rejected',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        deadline: DEADLINE,
        deadlineRemaining: '2 ore',
        reason: 'squadra già usata'
      },
      {
        type: 'pick_missing_elimination',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        inGameCount: 13
      },
      {
        type: 'round_result_correct',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        team: 'Roma',
        outcome: 'win',
        inGameCount: 13,
        matches: RESULT_MATCHES
      },
      {
        type: 'round_result_wrong',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        team: 'Roma',
        outcome: 'win',
        inGameCount: 13
      },
      { type: 'pick_postponed', playerName: 'Mario', round: 3, championshipRound: 5 },
      {
        type: 'round_closed_survived',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        inGameCount: 13,
        eliminatedWrong: 3,
        eliminatedMissing: 1
      },
      { type: 'tournament_won', playerName: 'Mario', round: 3, championshipRound: 5 },
      { type: 'tournament_shared_win', playerName: 'Mario', round: 3, championshipRound: 5 },
      {
        type: 'clarification',
        playerName: 'Mario',
        round: 3,
        championshipRound: 5,
        deadline: DEADLINE,
        deadlineRemaining: '2 ore'
      },
      {
        type: 'tournament_closed',
        playerName: 'Mario',
        tournamentHistory: [
          {
            round: 1,
            championshipRound: 5,
            players: [{ name: 'Mario Rossi', team: 'Roma', outcome: 'win', eliminated: false }]
          }
        ]
      }
    ];
    for (const ctx of contexts) {
      const body = renderEmailV2(ctx, 'narrativa di prova', ROME);
      expect(body, `tipo ${ctx.type}`).not.toMatch(/[╔═╗║╚─]/);
    }
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

  it('dato assente → blocco omesso (niente deadline senza tipo pick, niente stato senza conteggio)', () => {
    const withoutDeadline = renderEmailV2(
      { type: 'pick_instructions', round: 1, championshipRound: 1 },
      'narrativa',
      ROME
    );
    expect(withoutDeadline).not.toContain('DEADLINE PICK');

    const withoutState = renderEmailV2(
      { type: 'round_closed_survived', round: 1, championshipRound: 1 },
      'narrativa',
      ROME
    );
    expect(withoutState).not.toContain('STATO DEL TORNEO');
  });

  it('deadline in CODA (D6): il corpo TERMINA con la riga data+countdown per i 4 tipi con pick', () => {
    const base = {
      playerName: 'Mario',
      round: 3,
      championshipRound: 5,
      deadline: DEADLINE,
      deadlineRemaining: '2 ore'
    };
    const contexts: Array<EmailContext> = [
      { type: 'pick_instructions', ...base, matches: UPCOMING_MATCHES },
      { type: 'pick_confirmed', ...base, team: 'Roma', outcome: 'win' },
      { type: 'pick_rejected', ...base, reason: 'squadra già usata' },
      { type: 'clarification', ...base }
    ];
    for (const ctx of contexts) {
      const body = renderEmailV2(ctx, 'narrativa di prova', ROME);
      expect(body, `tipo ${ctx.type}`).toContain(`⏰ DEADLINE PICK\n${DEADLINE_LINE}`);
      expect(body.endsWith(DEADLINE_LINE), `tipo ${ctx.type}`).toBe(true);
    }
  });

  it('keyMessage MAIUSCOLO e primo dopo il saluto (D7) per i 17 tipi', () => {
    const base = { playerName: 'Mario', round: 3, championshipRound: 5 };
    // Riga chiave attesa per tipo: `resultLine` per le mail di esito,
    // `keyMessage(ctx)` per tutte le altre (con i dati iniettati sotto).
    const keyLines: Record<EmailType, string> = {
      platform_registered: 'ISCRIZIONE CONFERMATA: SEI IN PIATTAFORMA!',
      platform_unsubscribe_confirm: 'CONFERMA LA DISISCRIZIONE?',
      platform_unsubscribed: 'DISISCRIZIONE COMPLETATA',
      platform_already_registered: 'SEI GIÀ ISCRITTO: NON SERVE RE-ISCRIVERTI.',
      tournament_open: '🏆 TORNEO APERTO!',
      pick_instructions: 'ROUND APERTO: INVIA IL TUO PICK!',
      pick_confirmed: 'PICK REGISTRATO → ROMA → VITTORIA',
      pick_rejected: 'PICK NON REGISTRATO: squadra già usata',
      pick_missing_elimination: '❌ SEI STATO ELIMINATO!',
      round_result_correct: '✅ SEI ANCORA IN GARA!',
      round_result_wrong: '❌ SEI STATO ELIMINATO!',
      pick_postponed: '⏸ PARTITA RINVIATA',
      round_closed_survived: 'ROUND CHIUSO: SEI ANCORA IN GARA!',
      tournament_won: '🏆 HAI VINTO IL TORNEO!',
      tournament_shared_win: '🏆 VITTORIA CONDIVISA!',
      clarification: 'NON HO CAPITO LA TUA RICHIESTA',
      tournament_closed: '🏆 TORNEO CONCLUSO!'
    };
    for (const type of EMAIL_TYPES) {
      const ctx: EmailContext = {
        ...base,
        type,
        team: 'Roma',
        outcome: 'win',
        reason: 'squadra già usata'
      };
      const body = renderEmailV2(ctx, 'NARRATIVA DI PROVA', ROME);
      const lines = body.split('\n');
      const keyIndex = lines.indexOf(keyLines[type]);
      const narrativeIndex = lines.indexOf('NARRATIVA DI PROVA');
      // La riga chiave precede la narrativa (mai dopo di essa).
      expect(keyIndex, `tipo ${type}: riga chiave presente`).toBeGreaterThanOrEqual(0);
      expect(narrativeIndex, `tipo ${type}`).toBeGreaterThan(keyIndex);
      // La parte FISSA è in MAIUSCOLO; per `pick_rejected` il `reason` è un
      // dato dinamico verbatim (minuscolo): si verifica il solo prefisso.
      const fixedPart = type === 'pick_rejected' ? keyLines[type].split(':')[0] ?? keyLines[type] : keyLines[type];
      expect(fixedPart, `tipo ${type}: parte fissa MAIUSCOLA`).toBe(fixedPart.toUpperCase());
    }
  });
});
