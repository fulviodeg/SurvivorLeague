# Review indipendente — UAT Task 4: refresh/import bloccati in test mode (guardia TEST_MODE)

- **Data:** 2026-08-17
- **Oggetto:** `src/config.ts` (parametro `TEST_REFRESH_ALLOWED`), `src/cli/commands/data.ts` (orchestratore `importMatchesWithGuard`), `src/cli/commands/scheduler.ts` (orchestratore `buildRefreshForTick`), `tests/unit/cli/data-refresh.test.ts` (nuovo), `tests/unit/cli/scheduler-tick.test.ts` (nuovo) — Task 4 del piano `tasks/plan-uat-calendario-sintetico.md`
- **Tipo:** verifica con evidenza + smoke test CLI su DB di prova; **nessun file di codice modificato** (gap trovati: 0)
- **Verdetto:** **PASS**

## Allineamento al piano (riassunto dell'intendimento)

Il Task 4 (scope Small, dipendenza Task 0.1) realizza la **guardia refresh/import
in test mode** derivata da `TEST_MODE` (l'opzione `SCHEDULER_REFRESH_ENABLED` NON
si implementa): il nuovo parametro test-only `TEST_REFRESH_ALLOWED` (default
`false`, validato sempre ma con effetto gated a consumo come `TEST_OFFSET_DAYS`)
è l'override esplicito per i casi che richiedono dati reali in test mode. La
matrice ha tre rami:

1. `TEST_MODE=true` con `TEST_REFRESH_ALLOWED` assente/falso (default):
   `data:refresh`/`data:import`/refresh dello scheduler NON chiamano l'API e non
   toccano la tabella `match`, con output e log pino espliciti in inglese;
   `scheduler:tick` non costruisce il refresh e prosegue con le azioni dovute.
2. `TEST_MODE=true` + `TEST_REFRESH_ALLOWED=true`: import/refresh eseguono
   normalmente con **log WARN di consenso a ogni operazione** (incluso il refresh
   dello scheduler a ogni tick), il WARN include il `DB_PATH`.
3. `TEST_MODE=false`: `TEST_REFRESH_ALLOWED` ignorato (gating a consumo),
   comportamento attuale invariato (import/refresh reali).

La guardia deve vivere nei comandi CLI (nessun `getConfig()` nei moduli:
`importMatches` resta pura), `src/game/scheduler.ts` NON deve essere modificato,
e le convenzioni di commento AGENTS.md §5 vanno rispettate (header e commenti in
italiano, parametri di configurazione documentati).

Il compito di questa verifica non è re-implementare la guardia (già presente), ma
verificarne l'adesione ai 3 acceptance criterion con evidenza di test e smoke CLI,
con ispezione a campione dei due moduli CLI toccati e conferma dello scope
("Files likely touched"). Gap trovati: **0**.

## 1. Acceptance criteria — evidenza

| # | Criterion (Task 4) | Esito | Evidenza |
|---|---|---|---|
| 1 | `TEST_MODE=true` (default): `data:refresh`/`data:import`/refresh scheduler non toccano API né DB; output e log espliciti (inglese) | PASS | `data.ts:120-123` (skip: `logger.info(SKIP_IMPORT_REFRESH_TEST_MODE)` + `{skipped:true, matches:0}`, nessuna chiamata a `importMatches`); `scheduler.ts:121-124` (`return undefined`, nessun refresh); test `data-refresh.test.ts:92-120` (default ed esplicito `false`: `spy.calls()===0`, `matchCount===0`, log info); test `scheduler-tick.test.ts:97-110` e `:162-187` (tick prosegue con `round_open`, nessun `refresh_failed`); smoke CLI §3 scenari 1 e 3 |
| 2 | `TEST_MODE=true` + `TEST_REFRESH_ALLOWED=true`: import/refresh eseguono con WARN di consenso a ogni operazione (incl. scheduler a ogni tick); WARN include `DB_PATH` | PASS | `data.ts:124-126` (`logger.warn({dbPath}, refreshAllowedWarnMessage(config.DB_PATH))` poi `importMatches`); `scheduler.ts:125-128` (stesso WARN, poi `() => importMatches`); `refreshAllowedWarnMessage` a `data.ts:84-86` include il `DB_PATH`; test `data-refresh.test.ts:124-145` (WARN livello 40, `msg===refreshAllowedWarnMessage`, contiene il path) e `scheduler-tick.test.ts:114-139`; smoke CLI §3 scenari 2 e 4 (WARN `dbPath` presente) |
| 3 | `TEST_MODE=false`: `TEST_REFRESH_ALLOWED` ignorato, comportamento invariato (import/refresh reali) | PASS | `data.ts:120-127` e `scheduler.ts:121-128` (entrambi i rami `config.testMode` falsi → si arriva a `importMatches` reale, nessun log di skip/WARN); test `data-refresh.test.ts:149-164` (`entries()===[]`, `spy.calls()===1`) e `scheduler-tick.test.ts:143-160`; smoke CLI §3 scenario 5 (nessun banner, nessun skip/WARN, tentativo reale di import) |

## 2. Rilancio comandi di verifica

| Comando | Esito | Dettaglio |
|---|---|---|
| `npm run test` | **PASS** | 34 file, **363 test verdi** (4 in `data-refresh.test.ts`, 4 in `scheduler-tick.test.ts`) |
| `npm run typecheck` | **PASS** | `tsc --noEmit`, exit 0 |
| `npm run lint` | **PASS** | `eslint .`, exit 0 |

Nota operativa: in questo ambiente `node`/`npm` non sono nel `PATH`; usato il
binario via `/app/bin/host-spawn bash -c "cd /home/fulvio/dev/SurvivorLeague && npm run ..."`.

## 3. Smoke test CLI su DB di prova (tre rami della matrice)

Eseguito su DB isolato `tmp/uat-*.db` (mai sui DB del repo `data/*`), con
`ENV_FILE` dedicato e `TEST_MODE`/`TEST_REFRESH_ALLOWED` variati. Risultati:

| # | Rami | Comando | Output reale / esito |
|---|---|---|---|
| 1 | test mode default (skip) | `ENV_FILE=tmp/uat-refresh-test.env npm run cli -- data:refresh` | log `{"level":30,"testMode":true,"msg":"import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled"}` + banner `TEST MODE` + output `import/refresh skipped: ...`, exit 0; **nessuna chiamata API** |
| 2 | test mode + `TEST_REFRESH_ALLOWED=true` | `ENV_FILE=... TEST_REFRESH_ALLOWED=true npm run cli -- data:refresh` | log `{"level":40,"testMode":true,"dbPath":".../uat-refresh-test.db","msg":"TEST_REFRESH_ALLOWED=true: import/refresh allowed in TEST MODE — operating on database ..."}` poi tentativo reale (`Risposta inattesa 400 da football-data.org`, token dummy) |
| 3 | test mode default (skip, scheduler) | `ENV_FILE=tmp/uat-tick-test.env npm run cli -- scheduler:tick` (con `SCHEDULER_ENABLED=true`) | log skip (level 30) + banner + `Tick completato — nessuna azione da eseguire` (nessuna chiamata API) |
| 4 | test mode + allow (WARN, scheduler) | `ENV_FILE=... TEST_REFRESH_ALLOWED=true npm run cli -- scheduler:tick` | log WARN livello 40 con `dbPath` a ogni tick, poi `refresh_failed` (import reale fallito col token dummy) |
| 5 | `TEST_MODE=false` (regressione) | `ENV_FILE=... TEST_MODE=false TEST_REFRESH_ALLOWED=true npm run cli -- data:refresh` | **nessun** banner TEST MODE, **nessun** skip/WARN, `Risposta inattesa 400 da football-data.org` (import reale tentato — `TEST_REFRESH_ALLOWED` ignorato) |

Lo scenario 5 conferma anche la semantica no-override di `loadEnvFile` (§0.2):
l'override inline `TEST_MODE=false` vince sul `TEST_MODE=true` del file.

## 4. Ispezione a campione di `src/cli/commands/data.ts`

- **La guardia vive NEL comando** (`importMatchesWithGuard`, `data.ts:114-129`),
  non nei moduli dati: prende `db`/`client`/`config`/`logger` come argomenti,
  decide lo skip/consenso, poi delega a `importMatches`. `importMatches`
  (`src/data/importer.ts:96-102`) resta pura (unico import `provider.js`, nessun
  `getConfig()`/`process.env`).
- **Matrice corretta** (`data.ts:120-127`): i due rami test-mode sono mutuamente
  esclusivi (`!TEST_REFRESH_ALLOWED` → skip; `TEST_REFRESH_ALLOWED` → WARN); il
  ramo `testMode=false` cade direttamente su `importMatches` (gating a consumo).
- **Messaggi in inglese**: `SKIP_IMPORT_REFRESH_TEST_MODE` (`data.ts:75-76`) e
  `refreshAllowedWarnMessage` (`data.ts:84-86`) — entrambi in inglese, il WARN
  include `DB_PATH` nel testo e nel campo strutturato `dbPath`.
- **Output CLI**: `runImport` (`data.ts:132-165`) usa `printTestModeBanner` e
  `jsonWithTestMode` (D3), e in caso di skip stampa il messaggio inglese nel testo
  e `{ mode, skipped: true }` in `--json` (senza `matches`).
- **Convenzione documentata** (AGENTS.md §5): il commento a `data.ts:96-104`
  esplicita che ogni futura chiamata a `importMatches` dai comandi deve passare
  dalla guardia.
- **Header/commenti in italiano** (`data.ts:1-24` e inline): conformi.

## 5. Ispezione a campione di `src/cli/commands/scheduler.ts`

- **La guardia vive NEL comando** (`buildRefreshForTick`, `scheduler.ts:115-129`):
  restituisce `undefined` (nessun refresh → nessuna chiamata API) in skip, oppure
  il WARN di consenso + `() => importMatches(db, client)`; il client è costruito
  dal handler (`scheduler.ts:155-161`) e iniettato, mai letto nei moduli.
- **`src/game/scheduler.ts` NON toccato**: nessun riferimento a `TEST_REFRESH_ALLOWED`
  o `testMode` (grep §6); `schedulerTick` riceve ancora il refresh come `deps.refresh`
  iniettato. Con la guardia attiva `deps.refresh` non viene passato → l'evento
  `refresh_failed` è irraggiungibile in test mode (comportamento atteso, citato nei
  commenti `scheduler.ts:107-113` e `:149-154`).
- **WARN a ogni tick**: `buildRefreshForTick` è invocato a ogni esecuzione del
  handler (`scheduler.ts:161`) e logga il WARN ogni volta che `TEST_REFRESH_ALLOWED=true`.
- **Messaggi inglesi / header italiano**: conformi (il WARN usa
  `refreshAllowedWarnMessage` condiviso con `data.ts`).

## 6. Assenza di modifiche fuori scope + "Files likely touched"

- **`getConfig()`** in `src/`: solo in `src/cli/commands/*` (strato CLI) e in
  `src/config.ts` (definizione). Nessun modulo `src/data/*`, `src/game/*`,
  `src/channel/*`, `src/llm/*` invoca `getConfig()` — verificato con grep.
- **`importMatches`**: 2 sole call-site in `src/`, entrambe guardate —
  `data.ts:127` (dentro `importMatchesWithGuard`) e `scheduler.ts:128` (dentro
  `buildRefreshForTick`). `src/game/scheduler.ts` la cita solo nei commenti.
- **`src/game/scheduler.ts`**: mtime **2026-08-14** (pre-Task 4) — non ritoccato.
- **`src/config.ts`**: mtime 2026-08-17 09:39 — contiene il parametro
  `TEST_REFRESH_ALLOWED` (`config.ts:67-71` parser tollerante + `:173` schema +
  commento `:59-66`), già introdotto con i parametri test-only del Task 0.1, come
  previsto dal piano (Task 4 dipende da Task 0.1 e ne riusa il parametro).
- **File toccati dal Task 4** (mtime 19:15–19:18 del 2026-08-17): `data.ts`,
  `scheduler.ts`, `data-refresh.test.ts` (nuovo), `scheduler-tick.test.ts` (nuovo).
  Coerenti al 100% con "Files likely touched" del piano (`:482-486`): nessun file
  in più, nessun file in meno.

**Caveat:** la directory **non è un repository git** (`git rev-parse` → "not a git
repository"), quindi la verifica di "non toccato" è per **mtime/grep**, non per diff.

## Osservazioni (non bloccanti)

1. **Migrazione/creazione DB prima della guardia.** In `runImport` (`data.ts:133-137`)
   `createConnection`+`migrate` girano PRIMA di `importMatchesWithGuard`: su un DB
   inesistente lo skip crea comunque il file SQLite con lo schema (tabelle vuote,
   **nessuna riga in `match`**). Non viola il criterion ("non toccano la tabella
   `match`"): il test asserisce `matchCount===0`, e sul calendario sintetico già
   seedato la migrazione è idempotente e non altera i dati `match`. È lo stesso
   pattern di tutti i comandi `data:*` (setup CLI standard, poi logica).
2. **Test su `scheduler:tick` quando `SCHEDULER_ENABLED=false`.** Il handler esce
   prima di costruire il refresh (`scheduler.ts:141-147`, LLD §7.12): la guardia è
   correttamente collocata DOPO il gate `SCHEDULER_ENABLED`, quindi non è
   esercitabile in quel ramo — ma è un comportamento voluto (in sviluppo il
   commissioner usa i comandi manuali), non un difetto.
3. **`refresh_failed` nei test con token reale.** Nello smoke §3 scenario 4 il
   `refresh_failed` appare solo perché il token è dummy (l'import reale fallisce):
   è la dimostrazione che il refresh è stato davvero costruito ed eseguito, non
   un problema della guardia.

## Conclusione

Task 4 **conforme al piano** su tutti i punti: la guardia TEST_MODE su
import/refresh vive nei comandi CLI (`importMatchesWithGuard` in
`src/cli/commands/data.ts`, `buildRefreshForTick` in `src/cli/commands/scheduler.ts`),
`importMatches` resta pura (nessun `getConfig()` nei moduli), `src/game/scheduler.ts`
non è stato toccato, i messaggi di skip/WARN sono in inglese e il WARN di consenso
include il `DB_PATH`, header e commenti sono in italiano (AGENTS.md §5). I tre rami
della matrice (skip default / consenso con `TEST_REFRESH_ALLOWED=true` / regressione
`TEST_MODE=false`) sono coperti sia dai test unit sia dalla prova manuale su DB
disposable. Test (363), typecheck e lint verdi. I file toccati coincidono con
"Files likely touched". **Nessun file di codice modificato** (gap: 0).
