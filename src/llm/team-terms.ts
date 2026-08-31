/**
 * Termini squadra condivisi (Task 2 del piano
 * `.kilo/plans/1788161325462-abbreviated-name-never-fail.md`; AGENTS.md §1.3:
 * nessuna duplicazione di logica tra i due classificatori).
 *
 * Ruolo: UNICA fonte della costruzione dei termini confrontabili di squadra
 * (nomi canonici + alias della tabella markdown `team-aliases*.md`) e della
 * risoluzione squadra→canonico. Riusato da:
 *
 *   - `DeterministicIntentClassifier` (src/llm/deterministic-parser.ts):
 *     `resolveTeam` per SOTTOSTRINGA nel testo dell'email (il testo libero
 *     può contenere la squadra ovunque, es. "la mia parma vince");
 *   - filtro del classificatore LLM (`OpenAIIntentClassifier`, soluzione B):
 *     `resolveTeamField` ESATTO sul campo strutturato `team` dell'output LLM
 *     (il campo JSON deve coincidere con un canonico o un alias; nessuna
 *     ricerca per sottostringa su un dato strutturato).
 *
 * Formato della risorsa alias (identico per `team-aliases.md` e
 * `team-aliases-synthetic.md`): righe markdown `| alias1, alias2 | Nome
 * canonico |`; intestazione e separatore scartati (il loro "canonico" non è
 * nella lista iniettata); gli alias sono separati da virgola. I termini sono
 * ordinati per lunghezza DECRESCENTE per il longest-match.
 *
 * Funzioni pure, confine I/O (ADR-004): nessun accesso a DB/config — lista
 * canonica e contenuto alias arrivano iniettati per chiamata
 * (`PickParseOptions.teams`/`aliases`).
 */

/** Termine confrontabile (normalizzato) → nome canonico della squadra. */
export interface TeamTerm {
  term: string;
  canonical: string;
}

/**
 * Normalizza un testo per il confronto: minuscolo, trim e rimozione degli
 * accenti (NFD + strip dei combining mark) — "vincerà" → "vincera",
 * "Catanzaro" → "catanzaro". L'apostrofo è preservato ("l'Inter" → "l'inter").
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Costruisce i termini di squadra confrontabili: nomi canonici (da `teams`,
 * iniettati) + alias (parse della tabella markdown `aliases`, formato
 * `team-aliases.md`/`team-aliases-synthetic.md`). Le righe di intestazione e
 * separatore sono scartate perché il loro "canonico" non è in `teams`.
 * Ordinati per lunghezza DECRESCENTE per il longest-match.
 */
export function buildTeamTerms(teams: string[], aliases: string): TeamTerm[] {
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

/**
 * Risolve la squadra dal testo LIBERO (longest-match per sottostringa): null
 * se nessun termine combacia. Uso: parser deterministico (il testo dell'email
 * contiene la squadra ovunque, con eventuale contesto attorno).
 */
export function resolveTeam(text: string, terms: TeamTerm[]): string | null {
  const normalized = normalize(text);
  for (const { term, canonical } of terms) {
    if (normalized.includes(term)) return canonical;
  }
  return null;
}

/**
 * Risolve il campo STRUTTURATO `team` dell'output LLM (confronto ESATTO sul
 * valore normalizzato: minuscolo/trim/accenti, apostrofo preservato): il
 * valore deve coincidere con un nome canonico o un alias → nome canonico;
 * altrimenti null (mai inventare nomi, nessuna ricerca per sottostringa su un
 * dato strutturato). Uso: filtro del classificatore LLM (soluzione B).
 */
export function resolveTeamField(team: string, terms: TeamTerm[]): string | null {
  const normalized = normalize(team);
  if (normalized === '') return null;
  for (const { term, canonical } of terms) {
    if (normalized === term) return canonical;
  }
  return null;
}
