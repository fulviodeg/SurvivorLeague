# Review indipendente — UAT Task 5: ambiente UAT (`.env.uat` reale)

- **Data:** 2026-08-17
- **Oggetto:** `.gitignore`, `.env.uat` / `.env.uat-replay` (reali, gitignored), `.env.uat.example` / `.env.uat-replay.example` (versionati), `.env.example` (aggiornato), `tests/unit/env-examples.test.ts` (nuovo), `docs/POC/POC_LLD.md` §4 — Task 5 del piano `tasks/plan-uat-calendario-sintetico.md`
- **Tipo:** verifica con evidenza (read-only) + smoke test CLI su DB dedicato; **nessun file di codice modificato** (gap bloccanti: 0)
- **Verdetto:** **PASS**

## Allineamento al piano (riassunto dell'intendimento)

Il Task 5 (scope Small, dipendente dai Task 0.1-0.4, 2, 4) consegna l'ambiente
UAT reale: file `.env.uat`/`.env.uat-replay` **gitignored** con credenziali reali
(Gmail condivisa + LLM), e i rispettivi `.example` **versionati senza segreti**.
La cadenza compressa (`MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`,
`DEADLINE_ADVANCE_MIN=30`) non deve produrre finestre TC sovrapposte, `LLM_MODEL`
degli esempi deve essere la **lista failover multi-modello** (non un singolo
placeholder), `.env.uat-replay` deve portare `TEST_OFFSET_DAYS` valorizzato con la
nota "solo replay 2025 su DB dedicato", e LLD §4 deve documentare i nuovi
parametri e il vincolo "mai `ENV_FILE`/`TEST_MODE` in produzione".

Questa verifica NON re-implementa nulla: accerta gli 8 acceptance criterion e gli
8 punti della checklist con evidenza concreta (contenuto file, timestamp, test
eseguito, smoke CLI), mai a fiducia. Gap bloccanti trovati: **0**; una difformità
documentale minore (non bloccante) è segnalata in §5.

## 1. Acceptance criteria — evidenza

| # | Criterion (Task 5) | Esito | Evidenza |
|---|---|---|---|
| 1 | `.gitignore` aggiornato (`.env.uat`, `.env.uat-replay`) PRIMA della creazione dei file reali | PASS | `.gitignore:6` `.env.uat`, `:7` `.env.uat-replay`; mtime `.gitignore` = 19:49 < file reali (19:51). Directory NON git: verifica per contenuto+mtime (vedi §2) |
| 2 | `.env.uat` documentato e funzionante; `.env.uat.example` versionato SENZA segreti (test di verifica) | PASS | `.env.uat` reale: header + 52 righe di commento, tutti i parametri valorizzati (vedi §4); `.env.uat.example` campi credenziali VUOTI (`:37,39,45,47,49,77`); test `env-examples.test.ts` **verde (11 test)** |
| 3 | `LLM_MODEL` degli esempi = lista failover multi-modello (non singolo placeholder) | PASS | `.env.uat.example:58` e `.env.uat-replay.example:60` = `nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free`; assert nel test `:37-42,78-89` |
| 4 | `ENV_FILE=.env.uat` attiva il test mode e la config UAT su DB dedicato | PASS | Smoke CLI §3: banner `TEST MODE` + log pino `testMode:true` + calendar da `DB_PATH=./data/uat-synthetic.db` |
| 5 | Config UAT → finestre TC non sovrapposte; `data:seed-synthetic` senza log `error` di sovrapposizione | PASS | `MATCH_DURATION_MIN=5`+`TC_CLOSE_SKEW_MIN=10`=15 ≤ spacing 90; smoke §3: seed → solo WARN (liv. 40) calendario misto, **nessun** log error (liv. 50) di sovrapposizione |
| 6 | Produzione invariata: senza `ENV_FILE` nessun parametro test attivo | PASS | `.env.example:104` `TEST_MODE=false`; `config.ts:163` default `false`; già coperto dai Task 0.1/0.4 (review-uat-tasks-0-4.md) |
| 7 | `data:refresh`/`scheduler:tick` in test mode non alterano il calendario sintetico (skip loggato, Task 4) | PASS | Prerequisito di config soddisfatto: `TEST_REFRESH_ALLOWED=false` in entrambi i file reali (§4); il comportamento skip è del Task 4 (review-uat-task-4.md) |
| 8 | `.env.uat-replay.example` versionato: `TEST_OFFSET_DAYS` valorizzato, nota "solo replay 2025 su DB dedicato" | PASS | `.env.uat-replay.example:112` `TEST_OFFSET_DAYS=365`; nota a `:6`, `:70`, `:111` |

## 2. `.gitignore` vs file reali (punto 2 e 8 della checklist)

- **Contenuto `.gitignore`** (7 righe): `node_modules/`, `dist/`, `data/`, `.env`,
  `.env.bak`, `.env.uat`, `.env.uat-replay`. I due file reali sono esclusi per
  voce esplicita (`:6-7`); la directory `data/` (`:3`) copre anche
  `data/uat-synthetic.db` e (futuro) `data/uat-replay.db`.
- **Precedenza temporale:** `.gitignore` mtime `2026-08-17 19:49`; file reali
  `.env.uat`/`.env.uat-replay` mtime `19:51`; esempi `.env.uat.example` `19:50`,
  `.env.uat-replay.example` `19:51`. L'aggiornamento di `.gitignore` **precede**
  la creazione dei file reali (evidenza da timestamp, unica disponibile senza git).
- **Gli `.example` NON sono ignorati:** nessun pattern `/.env.*` generico in
  `.gitignore`, quindi `.env.uat.example`/`.env.uat-replay.example` restano
  versionabili (corretto: si versionano solo gli esempi senza segreti).
- **Nessun git:** la directory non è un repository (`ls .git` → assente; la nota
  dell'ambiente è confermata). La verifica "non tracciati/non versionati" è quindi
  per contenuto di `.gitignore` + presenza su disco, come richiesto. `git
  status`/`git diff` non disponibili.

## 3. Smoke test CLI (punto 6)

Eseguito con `node` via nvm (`/home/fulvio/.nvm/versions/node/v24.19.0/bin`; non
nel `PATH` di default).

| # | Comando | Output reale / esito |
|---|---|---|
| 1 | `ENV_FILE=.env.uat npm run cli -- data:calendar` | prima riga `TEST MODE`; calendario sintetico R1–R7 (8 squadre, 28 partite, spacing 90 min) dal DB dedicato |
| 2 | `ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --force` | banner `TEST MODE` + log `{"level":40,...,"testMode":true,"msg":"--force without --clear on a non-empty match table: ..."}` + `Seed completato: 8 squadre, 7 giornate, 28 partite`; **nessun** log `error` (liv. 50) di sovrapposizione TC |
| 3 | `npm run typecheck` / `npm run lint` | exit 0, nessun errore |
| 4 | `npm run test -- tests/unit/env-examples.test.ts` | **11/11 verdi** (3 file × 3 assert segreti + 2 assert LLM_MODEL) |

Nota trasparenza: il comando #2 ha rieseguito l'upsert (idempotente sulla PK
`(round, home_team, away_team)`, seed 42) su `data/uat-synthetic.db` già popolato,
rigenerando le `match_date` (primo fischio spostato da 19:53Z a 20:06Z, spacing
invariato 90). Effetto atteso del seed su date "now-based", non un difetto: DB
UAT dedicato, nessun dato di produzione toccato.

## 4. Contenuto dei file reali (solo parametri NON segreti)

`grep` mirato, **senza mai stampare i valori dei segreti** (`IMAP_USER/PASS`,
`SMTP_USER/PASS`, `LLM_API_KEY`, `FOOTBALL_DATA_TOKEN` sono presenti e valorizzati:
lunghezze 27/16/27/16/73/32 in entrambi i file, non riportate qui).

- **`.env.uat`**: `TEST_MODE=true`, `TEST_OFFSET_DAYS=0`, `TEST_REFRESH_ALLOWED=false`,
  `DB_PATH=./data/uat-synthetic.db`, `SCHEDULER_ENABLED=true`,
  `MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`, `DEADLINE_ADVANCE_MIN=30`,
  `LLM_MODEL` = lista failover, `LLM_TIMEOUT_MS=15000`, `LLM_RETRIES=3`. Header e
  commenti completi (52 righe commento, AGENTS.md §5).
- **`.env.uat-replay`**: identico tranne `DB_PATH=./data/uat-replay.db` e
  `TEST_OFFSET_DAYS=365`. Header corretto: `ENV_FILE=.env.uat-replay` (`:6`).

## 5. LLD §4 (punto 7)

Completo: §4.1-§4.4 invariati; §4.5 (`POC_LLD.md:317-338`) documenta (a) il loader
`process.loadEnvFile(ENV_FILE ?? '.env')` con semantica **no-override** e **errore
esplicito** per `ENV_FILE` inesistente (`:321-324`); (b) la tabella dei parametri
test mode `TEST_MODE`/`TEST_OFFSET_DAYS`/`TEST_REFRESH_ALLOWED` (`:326-332`); (c) il
**gating a consumo** dei parametri test-only (`:334`); (d) l'import/refresh bloccato
in test mode (Task 4) (`:336`); (e) il vincolo "Mai `ENV_FILE`/`TEST_MODE` in
produzione" (`:338`). Coerente con `src/config.ts`.

## 6. Assenza di segreti nei file versionati (punto 8)

Grep mirato sui file nuovi/versionati — nessun match:
- `sk-[A-Za-z0-9_-]{8,}` su `.env.uat.example`, `.env.uat-replay.example`,
  `.env.example`, `tests/unit/env-examples.test.ts`, `docs/POC/POC_LLD.md` → 0.
- App Password Gmail `^[A-Z_]+=[a-z]{16,}$` sugli esempi → 0.
- Credenziali con valore non vuoto negli esempi → 0 (tutti `KEY=` vuoti).
- Grep esteso (`sk-…`, `glpat/ghp/xoxb/AIza-…`) su `docs/`, `tasks/`,
  `agent-context/` → 0.

## Osservazioni (non bloccanti)

1. **`.env.uat-replay.example:103`** — commento copia-incolla: «Caricato dal file
   env dedicato via `ENV_FILE=.env.uat`» mentre il file è il replay e dovrebbe
   dire `ENV_FILE=.env.uat-replay`. Il file REALE `.env.uat-replay:6` è corretto.
   Solo documentale, nessun effetto funzionale.
2. **`.env.example:50`** — `LLM_MODEL=gpt-4o-mini` (singolo placeholder), mentre il
   `.env` reale usa la lista failover. Fuori dallo scope del criterion 3 (che copre
   solo gli esempi `.env.uat*`): segnalato come incoerenza minore tra il template
   di produzione e l'adozione reale, non come difetto del Task 5.
3. **`.gitignore` senza pattern generico `/.env.*`** — il piano lo indicava come
   opzionale ("se coerente"); con le sole voci esplicite, un eventuale futuro
   `.env.<qualcosa>` non sarebbe ignorato automaticamente. Robustezza, non difetto.

## Conclusione

Task 5 **conforme al piano** su tutti gli 8 acceptance criterion, con evidenza
concreta (contenuto file, timestamp di precedenza, test eseguito e verde, smoke CLI
con banner `TEST MODE` e assenza di log `error` di sovrapposizione, LLD §4
completo, grep segreti pulito). `.gitignore` aggiornato prima dei file reali; i
file reali sono esclusi dal versionamento, gli esempi versionati sono privi di
segreti; `LLM_MODEL` è la lista failover multi-modello; `.env.uat-replay` porta
`TEST_OFFSET_DAYS=365` con la nota "solo replay 2025 su DB dedicato". Nessun file
di codice modificato. Unica difformità: un commento copia-incolla in
`.env.uat-replay.example:103` (non bloccante).
