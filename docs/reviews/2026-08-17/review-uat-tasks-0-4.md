# Review indipendente — Task 0.1-0.4 (test mode) del piano UAT

- **Data:** 2026-08-17
- **Ruolo:** review indipendente in sola lettura (nessun file modificato, nessun fix eseguito)
- **Scope:** `tasks/plan-uat-calendario-sintetico.md`, Task 0.1-0.4 + Checkpoint A
- **Metodo:** rilettura degli acceptance criteria, rilancio delle verifiche (`npm run test`, `npm run typecheck`, `npm run lint`), grep statiche, apertura a campione dei file modificati per area

> **Nota di conformità:** nessuna modifica apportata al repository durante la review.

---

## 0. Verifiche globali rilanciate

| Verifica | Comando | Esito |
|----------|---------|-------|
| Suite di test | `npm run test` | ✅ **318 test, 30 file, tutti verdi** (11.8s) |
| Typecheck | `npm run typecheck` | ✅ pulito (`tsc --noEmit`, 0 errori) |
| Lint | `npm run lint` | ✅ pulito (`eslint .`, 0 errori) |

### Grep Task 0.2 — `TEST_MODE=true` nei test
Criterio: nessun test *esistente* deve impostare `TEST_MODE=true` (per non rompere le asserzioni esatte sul body email).

- **Esito:** ✅ trovato solo `tests/unit/config.test.ts:133,143,144,157` e `tests/integration/email-process.test.ts:111`, ma **entrambi sono test NUOVI** del piano (Task 0.1/0.3):
  - `config.test.ts` verifica `parseConfig` **puro** (input un oggetto env, mai `process.env`, mai body email) — nessun impatto sulle asserzioni email.
  - `email-process.test.ts:111` costruisce la config via `parseConfig` in un harness isolato.
- **Nessun test muta `process.env.TEST_MODE`/`ENV_FILE`** (grep dedicata vuota): niente contaminazione globale tra file di test.

### Grep Task 0.3 — `now: new Date()` residui in `src/cli/commands/*`
Criterio D10: nessun `now: new Date()` in `src/cli/commands/*` **eccetto `simulate.ts`**.

- **Esito:** ✅ unica occorrenza `now: new Date()` → `src/cli/commands/simulate.ts:48` (lecita, D10).
- `src/cli/commands/llm.ts:143` usa `new Date(argv.deadline)` = parsing di **input utente** (legittimo, non è un clock) — coerente con la nota del piano.

---

## 1. Task per Task — evidenza concreta

### Task 0.1 — Loader e config del test mode ✅ **PASS**

| Acceptance | Evidenza |
|------------|----------|
| `ENV_FILE` assente → carica `.env` | `src/config.ts:233` `const envFile = process.env.ENV_FILE ?? '.env'`; test `config.test.ts:185-193` (ENOENT silenzioso col default) |
| `ENV_FILE=.env.uat` + `TEST_MODE=true` → `testMode=true` | `src/config.ts:219` `{ ...result.data, testMode: result.data.TEST_MODE }`; test `config.test.ts:133-137` |
| Parametri test-only gated a consumo | `clock.ts:34-38` `offsetMs` legge `config.testMode`; test `clock.test.ts:36-47` e `config.test.ts:124-169` |
| `TEST_MODE` assente/falso → comportamento identico | test `config.test.ts:125-131` (default `false`, offset 0, refresh `false`) |
| `ENV_FILE` inesistente → errore che nomina il path | `src/config.ts:239-242` `ConfigError` con `ENV_FILE ... Verifica il percorso`; test `config.test.ts:174-183` |
| `engines` = `>=20.12` | `package.json` `"engines": {"node":">=20.12"}` ✅ |
| `parseConfig` pura | `src/config.ts:201` prende `Record<string,string|undefined>`, nessun accesso a `process.env`/filesystem ✅ |
| Header file + parametri commentati | `config.ts:1-24` header; ogni parametro con commento italiano scopo/valori/effetto (es. `TEST_OFFSET_DAYS` righe 41-57) ✅ |

Documentazione LLD §4.5 e `.env.example`/`.env.uat.example` aggiornati con i nuovi parametri e la semantica no-override (verificati i file).

### Task 0.2 — Segnalazione test mode ✅ **PASS**

| Acceptance | Evidenza |
|------------|----------|
| Email inviata con banner; template LLM invariati | `src/channel/email-adapter/index.ts:106` `finalBody = this.testMode ? TEST_MODE_EMAIL_BANNER + body : body` — seam unico di invio (D2); il banner (riga 59) NON è nei template LLM. Test `email-adapter.test.ts:145-168` (con banner / senza banner) |
| Ogni output CLI testuale mostra TEST MODE; `--json` ha `testMode` | `src/cli/output.ts` `printTestModeBanner`/`jsonWithTestMode`; applicati in TUTTI i comandi (93 match). Test `output.test.ts:35-63` |
| Ogni riga pino con `testMode: true` | `src/logger.ts:41` `logger.child({ testMode: true })`; test `logger.test.ts:39-60` |
| `testMode=false`: nessuna modifica | test `email-adapter.test.ts:164-168`, `output.test.ts:36-40`, `logger.test.ts:52-60` (regressione) |
| Path ConfigError con logger senza binding | `createLogger(level, stream?, testMode=false)` — default `false` NON aggiunge binding (riga 41); il path `createLogger(level)` resta valido senza config (commenti `logger.ts:28-33`). L'entry `src/index.ts:20` stampa `ConfigError` via `console.error`, senza dipendere da config ✅ |
| Header file + commenti in italiano + log in inglese | `output.ts:1-15`, `logger.ts:1-13` header; commenti IT; messaggi log/pino in EN (es. banner `logger.ts`/email `index.ts:59`) ✅ |

### Task 0.3 — Offset orario unificato ✅ **PASS**

| Acceptance | Evidenza |
|------------|----------|
| `TEST_OFFSET_DAYS=0` → clock e receivedAt reali | `clock.ts:34-38` (`offsetMs` 0 → `makeNow` = `new Date()`, `shiftReceivedAt` = originale); test `clock.test.ts:44-76, 85-88` |
| Offset >0 → `now` shiftato in tutti i comandi (eccetto simulate) con stesso delta; `receivedAt` stesso delta in `processEmailBatch` | `makeNow(config)` usato da scheduler/winner/channel/pick/tournament/round (grep 9 usi); `shiftReceivedAt` in `email-processor.ts:362-365`. **Stesso delta garantito per costrutto**: entrambi chiamano `offsetMs(config)` (`clock.ts:34-46,58-61`) — unica fonte del delta (D9). Test `clock.test.ts:90-94` (shift esatto di 7 giorni) |
| Shift monotono (ordine preservato) | `clock.ts:57` `new Date(receivedAt.getTime() - delta)` — stessa sottrazione a tutti; test `clock.test.ts:96-102` |
| Guard RF-31 testata con offset 0 e >0 | `email-process.test.ts:398-432` (offset 0 → `after_kickoff` rifiutato; offset 1 → pick accettato grazie allo shift) |
| Scansione `now: new Date()` | ✅ solo `simulate.ts:48` (vedi §0) |
| Shift esattamente `TEST_OFFSET_DAYS` giorni, applicato **una sola volta** per messaggio | Shift applicato una sola volta all'ingresso di `processEmailBatch` (`email-processor.ts:362-365`, `.map` unico); il comando `channel.ts` NON lo riapplica (grep: `channel.ts` non importa `shiftReceivedAt`); i due call site di `processOne` (righe ~245 e ~292) ricevono `message.receivedAt` della **stessa** istanza già shiftata (riga 364 applica a `incoming`, poi riga 367 itera `incoming`) → nessun doppio shift ✅. Test `email-process.test.ts:414-432` ne dimostra l'applicazione singola col delta giusto |

### Task 0.4 — Risorsa alias sintetica ✅ **PASS**

| Acceptance | Evidenza |
|------------|----------|
| Risorsa sintetica creata (lista canonica Serie B + alias); `team-aliases.md` invariato | `src/llm/team-aliases-synthetic.md` presente (header con ruolo, sezione lista canonica + alias). Test pre-esistente `team-aliases.test.ts` (6 test) ancora verde → produzione intatta |
| In test mode il parser riceve risorsa sintetica + prompt chiarisce la lega; senza test mode produzione invariata | `parser.ts:78-80` `loadTeamAliasesFor(testMode)`; `parser.ts:92-94` contesto lega ("campionato sintetico di Serie B... NON Serie A") solo se `testMode`. Wiring in `channel.ts:126` e `llm.ts:56` con `config.testMode`; `parser.test.ts:195-222` |
| Test di coerenza della risorsa sintetica verde | `team-aliases-synthetic.test.ts` (5 test): 8 club senza duplicati, alias→canonico, ogni nome→almeno un alias, nessuna logica nel file, marcata "NON legata all'API" |
| Coincidenza con `SYNTHETIC_TEAMS` (Task 1) | ⏳ **rimandato al Checkpoint B** come previsto dal piano (Task 1 fuori scope della presente review) |

---

## 2. Verifica per area (a campione)

| Area | File aperti | Header | Param. commentati | Commenti IT | Log/messaggi EN | Solo file "Files likely touched" | `src/game/*` intatto |
|------|-------------|:------:|:-----------------:|:-----------:|:---------------:|:-------------------------------:|:--------------------:|
| **config** | `src/config.ts`, `package.json` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **logger** | `src/logger.ts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **channel** | `email-adapter/index.ts`, `email-processor.ts` | ✅ | ✅ | ✅ | ✅ (messaggi pino/log EN; commenti IT come da convenzione) | ✅ | ✅ |
| **llm/parser** | `parser.ts`, `team-aliases-synthetic.md` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **cli** | `output.ts`, `index.ts`, comandi | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

- `src/game/*` non toccato: grep su `testMode|TEST_MODE|makeNow|shiftReceivedAt|getConfig` in `src/game/` → solo commenti pre-esistenti in `context.ts` (nessuna logica test mode). ✅
- `parseConfig` pura ✅; `importMatches` (importer.ts:96) pura — nessun `getConfig()` nell'importer ✅.
- **Osservazione:** `src/cli/output.ts` e `src/clock.ts` sono NEW (non elencati esplicitamente ma coerenti con "src/cli/ (helper banner condiviso)" e "src/game/context.ts o nuovo modulo clock helper") — rientrano nello scope dichiarato.

## 3. Coerenza offset clock ↔ receivedAt ✅

- **Stesso delta:** `makeNow` (`clock.ts:46-49`) e `shiftReceivedAt` (`clock.ts:58-61`) usano entrambi `offsetMs(config)` → delta unico `TEST_OFFSET_DAYS × MS_PER_DAY` (garantito per costrutto, D9).
- **Stampo indietro di N giorni** con sottrazione, preserva l'ora del giorno.
- **Shift receivedAt applicato UNA sola volta per messaggio** (solo all'ingresso di `processEmailBatch`, non nel comando `channel.ts`).
- **`simulate/*` rimasti su `new Date()` reale** (D10) ✅.
- **`channel:email:fetch` RAW**: il fetch non applica lo shift (grep `shiftReceivedAt` solo in `email-processor.ts`) — coerente con la nota diagnostica del piano.

---

## 4. Verdetto Checkpoint A

| Voce Checkpoint A | Esito |
|-------------------|:-----:|
| `npm run test` verde (loader/config, banner email, CLI, log, offset, alias sintetica) | ✅ 318/318 |
| `npm run typecheck && npm run lint` puliti | ✅ |
| Senza `ENV_FILE` comportamento identico a oggi (inclusa risorsa alias produzione) | ✅ (test regressione: `config.test.ts:125`, `parser.test.ts:213-216`, `team-aliases.test.ts`, `output.test.ts:36`, `logger.test.ts:52`) |
| Con `ENV_FILE` di prova: banner CLI/log/email + parser con alias sintetica + contesto lega | ✅ (evidenze per area, §1/§2) |
| Revisione col commissioner | ⏳ dipende dal processo, non verificabile in sola lettura |

---

## 5. Problemi riscontrati

**Nessun problema bloccante né critico.** Solo osservazioni di valore basso (nessuna azione richiesta):

1. **`tests/unit/config.test.ts:133,143-148,156-163`** — questi test impostano `TEST_MODE=true`/`TEST_OFFSET_DAYS` come *input di `parseConfig` (puro)*. Rispettano il criterio di Task 0.2 (non toccano process.env né body email), ma un futuro lettore potrebbe interpretare il criterio "nessun test imposta TEST_MODE=true" alla lettera. **Non è un difetto**: la grep va letta come "nessun test esistente che afferma il body email".
2. **`tests/integration/email-process.test.ts:111`** — stessa natura: impostazione su config pura all'interno di un harness. Accettabile.
3. **Coincidenza `SYNTHETIC_TEAMS` ↔ alias sintetica** — non ancora testata (prevista al Checkpoint B); non è una regressione dello scope 0.1-0.4.

---

## 6. Verdetto complessivo

**PASS per i Task 0.1, 0.2, 0.3, 0.4 e per il Checkpoint A** (ad eccezione delle voci dipendenti dal processo "revisione col commissioner" e dal Checkpoint B, fuori scope).

Evidenza concreta per ciascun acceptance criterion (test, output, codice percorso) riportata nelle tabelle sopra — nessuna voce accettata "a fiducia".

---

*Report generato in sola lettura; nessun file del repository è stato modificato.*
