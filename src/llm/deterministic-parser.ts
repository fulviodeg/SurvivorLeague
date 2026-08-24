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
 *   - `<TEAM> <ESITO>` → `pick` (squadra = lista canonica + tabella alias,
 *     longest-match, normalizzazione minuscolo/trim/accenti; esito = sinonimi
 *     win/draw/lose);
 *   - qualunque altra cosa → `other` (→ chiarimento CL5, che insegna le
 *     formule).
 *
 * Le formule libere ("voglio iscrivermi", "mi iscrivo", "partecipo") NON sono
 * riconosciute (decisione 1 del piano: SOLO formule univoche). Lista squadre
 * vuota → `other` deterministico senza chiamate. In modalità LLM
 * (`AI_EMAIL_PARSER=true`) il subject NON viene iniettato nel prompt: resta
 * un'ancora del solo parser deterministico.
 *
 * Invariati: interfacce (`LLMIntentClassifier`, `PickParseOptions`), Game
 * Engine, Platform Registry, Reply Cleaner.
 */
import type { IntentClassification, LLMIntentClassifier } from './intent-classifier.js';
import type { PickExtraction, PickParseOptions } from './parser.js';

/** Lunghezza massima del nome estratto dalla formula `ISCRIZIONE [NOME]`. */
const MAX_NAME_CHARS = 40;

/** Sinonimi esito (normalizzati: minuscolo, senza accenti). */
const WIN_WORDS = ['vince', 'vincera', 'vittoria', 'win'] as const;
const DRAW_WORDS = ['pareggia', 'pareggio', 'draw'] as const;
const LOSE_WORDS = ['perde', 'perdera', 'sconfitta', 'lose'] as const;

/**
 * Normalizza un testo per il confronto: minuscolo, trim e rimozione degli
 * accenti (NFD + strip dei combining mark) — "vincerà" → "vincera",
 * "Catanzaro" → "catanzaro".
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Termine confrontabile (normalizzato) → nome canonico della squadra. */
interface TeamTerm {
  term: string;
  canonical: string;
}

/**
 * Costruisce i termini di squadra confrontabili: nomi canonici (da `teams`,
 * iniettati) + alias (parse della tabella markdown `aliases`, formato
 * `team-aliases.md`/`team-aliases-synthetic.md`). Le righe di intestazione e
 * separatore sono scartate perché il loro "canonico" non è in `teams`.
 * Ordinati per lunghezza DECRESCENTE per il longest-match.
 */
function buildTeamTerms(teams: string[], aliases: string): TeamTerm[] {
  const teamSet = new Set(teams);
  const terms: TeamTerm[] = [];
  for (const team of teams) {
    terms.push({ term: normalize(team), canonical: team });
  }
  for (const line of aliases.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((cell) => cell.trim());
    const aliasCell = cells[1];
    const canonical = cells[2];
    if (aliasCell === undefined || canonical === undefined) continue;
    if (!teamSet.has(canonical)) continue;
    for (const alias of aliasCell.split(',')) {
      const term = normalize(alias);
      if (term !== '') terms.push({ term, canonical });
    }
  }
  terms.sort((a, b) => b.term.length - a.term.length);
  return terms;
}

/** Risolve la squadra dal testo (longest-match): null se nessun termine combacia. */
function resolveTeam(text: string, terms: TeamTerm[]): string | null {
  const normalized = normalize(text);
  for (const { term, canonical } of terms) {
    if (normalized.includes(term)) return canonical;
  }
  return null;
}

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
 */
function resolvePick(text: string, terms: TeamTerm[]): PickExtraction | null {
  const normalized = normalize(text);
  const outcome = findOutcome(normalized);
  if (outcome === null) return null;
  const team = resolveTeam(normalized.slice(0, outcome.index), terms);
  if (team === null) return null;
  return { team, outcome: outcome.outcome };
}

/**
 * Classifica il testo di una singola fonte (subject o corpo) con le formule
 * univoche; null se nessuna formula è riconosciuta. L'ordine conta:
 * `disiscrizione` PRIMA di `iscrizione` (la prima contiene la seconda).
 */
function classifyText(text: string, terms: TeamTerm[]): IntentClassification | null {
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

  const pick = resolvePick(text, terms);
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
    for (const source of [opts.subject, body]) {
      if (source === undefined) continue;
      const result = classifyText(source, terms);
      if (result !== null) return result;
    }
    return { intent: 'other', pick: null, name: null };
  }
}
