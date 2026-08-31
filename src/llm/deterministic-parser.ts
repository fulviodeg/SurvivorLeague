/**
 * Parser deterministico dell'INPUT email (email v3 Parte B, piano
 * `.kilo/plans/1787519052097-email-v3-deterministic-parser.md`).
 *
 * Ruolo: implementazione `LLMIntentClassifier` che classifica l'intento di un
 * messaggio email con FORMULE UNIVOCHE, senza chiamate di rete. Contratto
 * `{intent, pick, name}` identico all'LLM (mai eccezioni di contenuto, CS7).
 *
 * Formule riconosciute (nel subject `opts.subject` O nel corpo; il resto
 * dell'email è scartato):
 *   - `ISCRIZIONE [NOME]` → `subscribe` (nome = testo dopo la keyword, fine
 *     riga, trim, max ~40 char; vuoto → null → il sistema usa l'email RF-P1);
 *   - `DISISCRIZIONE` → `unsubscribe`;
 *   - `PARTECIPO` → `join` (ADR-019: partecipazione al torneo in corso, NON
 *     iscrizione alla piattaforma);
 *   - `<TEAM> <ESITO>` → `pick` (squadra = lista canonica + tabella alias,
 *     longest-match, normalizzazione minuscolo/trim/accenti; esito = sinonimi
 *     win/draw/lose);
 *   - qualunque altra cosa → `other` (→ chiarimento CL5, che insegna le
 *     formule).
 *
 * Le formule libere ("voglio iscrivermi", "mi iscrivo") NON sono riconosciute
 * (decisione 1 del piano: SOLO formule univoche). `partecipo` NON è più una
 * formula libera: è la formula univoca dell'intento `join` (ADR-019). Lista
 * squadre vuota → `other` deterministico senza chiamate. In modalità LLM
 * (`AI_EMAIL_PARSER=true`) il subject NON viene iniettato nel prompt: resta
 * un'ancora del solo parser deterministico.
 *
 * Invariati: interfacce (`LLMIntentClassifier`, `PickParseOptions`), Game
 * Engine, Platform Registry, Reply Cleaner.
 *
 * Termini squadra e normalizzazione: modulo condiviso `src/llm/team-terms.ts`
 * (Task 2, AGENTS.md §1.3: nessuna duplicazione — il filtro del classificatore
 * LLM riusa gli stessi termini per la soluzione alias, soluzione B).
 */
import type { IntentClassification, LLMIntentClassifier } from './intent-classifier.js';
import type { PickExtraction, PickParseOptions } from './parser.js';
import { LLMError } from './errors.js';
import type { WarnLogger } from './deterministic-generator.js';
import { buildTeamTerms, normalize, resolveTeam, type TeamTerm } from './team-terms.js';

/** Lunghezza massima del nome estratto dalla formula `ISCRIZIONE [NOME]`. */
const MAX_NAME_CHARS = 40;

/** Sinonimi esito (normalizzati: minuscolo, senza accenti). */
const WIN_WORDS = ['vince', 'vincera', 'vittoria', 'win'] as const;
const DRAW_WORDS = ['pareggia', 'pareggio', 'draw'] as const;
const LOSE_WORDS = ['perde', 'perdera', 'sconfitta', 'lose'] as const;

/** Esito con la posizione del primo sinonimo trovato (word boundary). */
function findOutcome(normalized: string): { outcome: PickExtraction['outcome']; index: number } | null {
  const patterns: Array<{ outcome: PickExtraction['outcome']; re: RegExp }> = [
    { outcome: 'win', re: new RegExp(`\\b(?:${WIN_WORDS.join('|')})\\b`) },
    { outcome: 'draw', re: new RegExp(`\\b(?:${DRAW_WORDS.join('|')})\\b`) },
    { outcome: 'lose', re: new RegExp(`\\b(?:${LOSE_WORDS.join('|')})\\b`) }
  ];
  let best: { outcome: PickExtraction['outcome']; index: number } | null = null;
  for (const { outcome, re } of patterns) {
    const match = re.exec(normalized);
    if (match !== null && (best === null || match.index < best.index)) {
      best = { outcome, index: match.index };
    }
  }
  return best;
}

/**
 * Riconosce la formula `<TEAM> <ESITO>`: l'esito delimita la fine, la squadra
 * è risolta per longest-match nel testo che PRECEDE l'esito (grammatica
 * team-prima). Esito assente o squadra non risolta → null.
 *
 * ADR-016 (win_only): quando `winOnly` è true il giocatore sceglie SOLO la
 * squadra — (a) una squadra NUDA senza esito registra `{team, 'win'}`
 * (decisione P1: nessuna formula esplicita richiesta); (b) l'esito `win`
 * presente → `{team, 'win'}`; (c) un esito esplicito `draw`/`lose` rende il
 * pick NON riconosciuto (null → chiarimento). In modalità classica il
 * comportamento resta invariato (esito obbligatorio win|draw|lose).
 *
 * Feature JOLLY (D4): quando `jollyEnabled` è true (win_only con jolly attivi)
 * la keyword "jolly" è riconosciuta OVUNQUE nel testo (word boundary,
 * case/accenti-insensibile), rimossa prima di risolvere squadra+esito, e
 * propagata come `PickExtraction.jolly = true`. Con `jollyEnabled` assente la
 * keyword è rumore ignorato (pick normale, identico a oggi).
 */
function resolvePick(
  text: string,
  terms: TeamTerm[],
  winOnly = false,
  jollyEnabled = false
): PickExtraction | null {
  const normalized = normalize(text);
  // Keyword "jolly": word boundary + case/accenti-insensibile (normalize
  // rimuove gli accenti e porta a minuscolo). "jollywood" NON matcha (nessun
  // boundary dopo "jolly"). La variante "jolli" è la forma italianizzata/
  // accentata di "jolly" dopo la normalizzazione ("jollì" → "jolli"): la
  // accettiamo perché il requisito è "case/accenti-insensibile". La keyword è
  // RIMOSSA dal testo di lavoro: la risoluzione squadra+esito resta quella
  // win_only (squadra nuda → win, draw/lose esplicito → null) — il jolly non
  // cambia MAI l'outcome.
  const jolly = jollyEnabled === true && /\bjoll[yi]\b/.test(normalized);
  const working = jolly ? normalized.replace(/\bjoll[yi]\b/, ' ').trim() : normalized;
  const outcome = findOutcome(working);

  if (winOnly) {
    // Esito draw/lose esplicito → non riconosciuto (il giocatore deve scegliere
    // solo la squadra vincente). Il sinonimo scatta anche su negazioni
    // ("Napoli non perde mai") — falso-negativo accettato, coerente con la
    // natura a formule esatte del parser deterministico (→ chiarimento).
    if (outcome !== null && outcome.outcome !== 'win') return null;
    // 'win' esplicito → squadra PRIMA dell'esito; squadra nuda → 'win' implicito.
    const team =
      outcome === null
        ? resolveTeam(working, terms)
        : resolveTeam(working.slice(0, outcome.index), terms);
    if (team === null) return null;
    return jolly ? { team, outcome: 'win', jolly: true } : { team, outcome: 'win' };
  }

  if (outcome === null) return null;
  const team = resolveTeam(working.slice(0, outcome.index), terms);
  if (team === null) return null;
  return jolly
    ? { team, outcome: outcome.outcome, jolly: true }
    : { team, outcome: outcome.outcome };
}

/**
 * Classifica il testo di una singola fonte (subject o corpo) con le formule
 * univoche; null se nessuna formula è riconosciuta. L'ordine conta:
 * `disiscrizione` PRIMA di `iscrizione` (la prima contiene la seconda), poi
 * `partecipo` (join, ADR-019), poi il pick.
 */
function classifyText(
  text: string,
  terms: TeamTerm[],
  winOnly = false,
  jollyEnabled = false
): IntentClassification | null {
  const normalized = normalize(text);

  if (normalized.includes('disiscrizione')) {
    return { intent: 'unsubscribe', pick: null, name: null };
  }

  // `ISCRIZIONE [NOME]`: il nome è estratto dal testo ORIGINALE (preserva le
  // maiuscole), fino a fine riga, trim e max ~40 char.
  const iscr = /iscrizione/i.exec(text);
  if (iscr !== null && iscr.index !== undefined) {
    const after = text.slice(iscr.index + iscr[0].length);
    const firstLine = after.split('\n')[0] ?? '';
    const name = firstLine.trim().slice(0, MAX_NAME_CHARS);
    return { intent: 'subscribe', pick: null, name: name !== '' ? name : null };
  }

  // `PARTECIPO` (join, ADR-019): partecipazione al torneo in corso. Formula
  // univoca, case/accenti-insensibile (normalize). DOPO iscrizione e PRIMA
  // del pick.
  if (normalized.includes('partecipo')) {
    return { intent: 'join', pick: null, name: null };
  }

  const pick = resolvePick(text, terms, winOnly, jollyEnabled);
  if (pick !== null) {
    return { intent: 'pick', pick, name: null };
  }

  return null;
}

/**
 * Classificatore di intento DETERMINISTICO (email v3 Parte B, decisione 1):
 * implementa `LLMIntentClassifier` con le formule univoche, riconosciute nel
 * subject (`opts.subject`) O nel corpo (il primo che combacia vince). ZERO
 * chiamate di rete, MAI eccezioni di contenuto; lista squadre vuota → `other`.
 */
export class DeterministicIntentClassifier implements LLMIntentClassifier {
  async classify(body: string, opts: PickParseOptions): Promise<IntentClassification> {
    if (opts.teams.length === 0) {
      return { intent: 'other', pick: null, name: null };
    }
    const terms = buildTeamTerms(opts.teams, opts.aliases);
    const winOnly = opts.winOnly === true;
    const jollyEnabled = opts.jollyEnabled === true;
    for (const source of [opts.subject, body]) {
      if (source === undefined) continue;
      const result = classifyText(source, terms, winOnly, jollyEnabled);
      if (result !== null) return result;
    }
    return { intent: 'other', pick: null, name: null };
  }
}

/**
 * Classificatore con fallback deterministico (modalità `AI_EMAIL_PARSER=true`,
 * decisione 2 + soluzione A del piano
 * `.kilo/plans/1788161325462-abbreviated-name-never-fail.md`): avvolge
 * l'`OpenAIIntentClassifier`. Su `LLMError` ripiega sul
 * `DeterministicIntentClassifier` e logga un warn pino `{reason: 'llm_error'}`
 * — il messaggio viene comunque classificato e il batch NON si ferma. Sugli
 * esiti di CONTENUTO "dubbiosi" (`other` o `pick:null` — bug UAT 2026-08-30:
 * l'LLM con successo può avere falsi negativi su nomi abbreviati validi) il
 * deterministico è consultato come SECONDA OPINIONE: se riconosce un pick,
 * vince lui con warn `{reason: 'llm_false_negative'}`; altrimenti resta
 * l'esito LLM. Regole: SOLO upgrade a pick (subscribe/unsubscribe/join restano
 * come classificati dall'LLM), MAI il contrario (doppia barriera D2/C: un pick
 * non viene mai accettato se il deterministico non lo conferma). Gli errori
 * NON-LLM sono rilanciati.
 */
export class FallbackIntentClassifier implements LLMIntentClassifier {
  private readonly llm: LLMIntentClassifier;
  private readonly deterministic: LLMIntentClassifier;
  private readonly logger: WarnLogger;

  constructor(llm: LLMIntentClassifier, deterministic: LLMIntentClassifier, logger: WarnLogger) {
    this.llm = llm;
    this.deterministic = deterministic;
    this.logger = logger;
  }

  async classify(body: string, opts: PickParseOptions): Promise<IntentClassification> {
    try {
      const llmResult = await this.llm.classify(body, opts);
      // Esito "dubbioso" dell'LLM: `other` o intento `pick` senza pick. Sono
      // i casi in cui un falso negativo su un nome abbreviato valido finirebbe
      // in clarification: il deterministico (formule univoche + alias) decide
      // se c'è davvero un pick riconoscibile.
      const doubtful =
        llmResult.intent === 'other' || (llmResult.intent === 'pick' && llmResult.pick === null);
      if (doubtful) {
        const det = await this.deterministic.classify(body, opts);
        if (det.intent === 'pick' && det.pick !== null) {
          this.logger.warn(
            { reason: 'llm_false_negative' },
            'LLM returned non-pick but deterministic classifier found a valid pick — using deterministic result'
          );
          return det;
        }
      }
      return llmResult;
    } catch (error) {
      if (error instanceof LLMError) {
        this.logger.warn(
          { reason: 'llm_error' },
          'LLM intent classification failed — falling back to deterministic classifier'
        );
        return await this.deterministic.classify(body, opts);
      }
      throw error;
    }
  }
}
