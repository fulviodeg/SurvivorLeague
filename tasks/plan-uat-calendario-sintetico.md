# Piano — Test mode + calendario sintetico per UAT (strade 3.1 + 3.2)

> Ruolo: piano di implementazione (bozza di lavoro, convenzione briefing, lingua
> italiana) per realizzare nel sistema il **test mode** (segnalazione + offset
> orario configurabile) e il **calendario sintetico** con date future caricato
> nella tabella `match` via comando seed. L'orologio resta reale per default: il
> calendario sintetico (strada 3.2) rende l'UAT con giocatori veri fattibile in
> 1-2 giorni (round a 1-2 ore) e testa il guard anti-frode su timestamp veri
> (internaldate IMAP); l'offset orario unificato (strada 3.1) È UN'OPZIONE del
> test mode, disattivata di default, per il caso "replay 2025 con giocatori
> veri": sposta di uno stesso delta sia l'orologio del sistema sia il timestamp
> di ricezione delle email.
> Il piano si FERMA all'implementazione (Task 0-6): l'esecuzione dell'UAT è
> descritta nella sezione 4 ma sarà oggetto di una pianificazione dedicata
> successiva, dipendente dall'esito di questo piano. La guida operativa per
> pianificare ed eseguire i test UAT è prodotta dal Task 6 e resta come
> riferimento durevole per amministratori, PO e agenti.
> Non sostituisce `tasks/plan.md` (roadmap della POC): è un piano di attività
> aggiuntive pre-produzione.
> Stato: revisionato post peer review (2026-08-16); dipendenze esterne risolte;
> decisioni del commissioner del 2026-08-17 incorporate (D4 confermata, mailbox
> unica); pronto per l'esecuzione.

---

> **Nota di conformità — AGENTS.md Parte 2, regola 5 (Documentation standards,
> mandatory).** Per questo piano la regola 5 è ancora più importante del solito:
> ogni parametro di configurazione nuovo o modificato deve avere un commento
> esplicito (scopo, valori ammessi, effetto del cambiamento), ogni file un
> header che ne descrive il ruolo, e ogni modifica alla CLI (nuovo comando
> `data:seed-synthetic`, banner TEST MODE, campo `testMode` negli output
> `--json`, opzioni del seed, guardia import/refresh in test mode) deve essere
> documentata nei commenti del codice e nelle descrizioni yargs (`describe`).
> La guida operativa (Task 6) è il riferimento per gli utilizzatori; il codice
> commentato resta la fonte primaria per sviluppatori e agenti.

## 0. Decisioni

### 0.1 Confermate (Q&A 2026-08-15 + peer review 2026-08-16)

| # | Decisione | Esito |
|---|-----------|-------|
| D0 | Attivazione test mode | Loader `loadEnvFile(process.env.ENV_FILE ?? '.env')`; il file di test (`.env.uat`) contiene `TEST_MODE=true`; parametri test-only validati solo in test mode (gating a consumo, vedere §0.3) |
| D1 | Portata del test mode | Segnalazione (banner/log/CLI) **+** offset orario unificato come opzione configurabile dal file di test, disattivato di default |
| D2 | Banner email | A livello di invio (punto unico nel canale di invio), mai nei template LLM |
| D3 | Dicitura commissioner | In TUTTI gli output CLI: banner nel testo + campo `testMode` negli output `--json` |
| D4 | Guardrail anti-produzione | Segnalazione visibile (banner/log/CLI); nessun blocco tecnico; vincolo documentato: mai `ENV_FILE`/`TEST_MODE` in produzione. **Confermata dal commissioner il 2026-08-17:** la sola segnalazione è la scelta voluta per la POC privata (riduzione consapevole rispetto al brainstorming 3.1) |
| D5 | Punteggi della stagione sintetica | Pre-seedati nel seed (strutturali per la cadenza compressa: vedere §3 worked example); `round:score` valuta subito dopo la chiusura del round |
| D6 | Seed su DB già popolato | Rifiuto senza `--force` (protezione da sovrascrittura accidentale); con `--force` le righe esistenti restano (upsert, nessuna DELETE) con WARN di calendario misto (e incoerenza con la risorsa alias sintetica); `--force --clear` svuota e ri-seeda con guardia su stato di gioco (Task 3) |
| D7 | Nomi squadre sintetiche | Nomi reali di club di Serie B in una RISORSA ALIAS SEPARATA, usata SOLO in test mode (`src/llm/team-aliases-synthetic.md`); la risorsa di produzione `team-aliases.md` resta intatta; il Parser sceglie la risorsa in base a `testMode`. La differenza lega (Serie A vs B) va chiarita nel prompt in test mode (Task 0.4) |
| D8 | Finestre TC non sovrapposte | Config UAT: `MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`, `DEADLINE_ADVANCE_MIN=30`, spaziatura tra giornate ≥ 45 min. **Alla rilevazione di una sovrapposizione (spaziatura tra giornate < `MATCH_DURATION_MIN` + `TC_CLOSE_SKEW_MIN`), log di livello `error` pino (messaggio in inglese) con il suggerimento di verificare i valori dei parametri coinvolti (`MATCH_DURATION_MIN`, `TC_CLOSE_SKEW_MIN`, `--spacing-min`)** |
| D9 | Parametri test | `TEST_OFFSET_DAYS` (intero, 0 = disattivato) — offset UNIFICATO applicato sia al clock (`makeNow`) sia al `receivedAt` (shift monotono) + `TEST_REFRESH_ALLOWED` (bool, default `false`) |
| D10 | `simulate:*` esentato | I comandi `simulate:full`/`simulate:round` NON usano `makeNow`: la simulazione deriva il clock dai dati (R2 briefing Fase 7) ed è deterministica (RNF1); `now` resta `new Date()` reale. La scansione statica "nessun `new Date()` diretto" si limita a `now: new Date()` e non a ogni `new Date(...)` (esclusi i parsing di input utente) |

### 0.2 Semantica del loader (vincoli da documentare nel codice/spec)

- **`process.loadEnvFile` NON sovrascrive** le variabili già presenti in
  `process.env` (comportamento equivalente a `dotenv` senza `override`). Conseguenza:
  un **override inline** `VAR=x npm run cli -- ...` viene letto da `process.env`
  PRIMA del file; se il file imposta la stessa variabile, **vince l'inline**.
  Motivo reale per cui gli scenari di test useranno **file env dedicati** e NON
  override inline: riproducibilità e auditabilità (Task 5).
- **`engines`** in `package.json` passa da `>=20` a `>=20.12` (stabilità di
  `process.loadEnvFile`).
- **Errore esplicito** solo quando `ENV_FILE` è impostato ma il path non esiste
  (messaggio che nomina il path); il caso "nessun `.env`" resta silenzioso (come
  oggi: le variabili possono arrivare dall'ambiente del cron).

### 0.3 Gating dei parametri test-only

I parametri test-only (`TEST_OFFSET_DAYS`, `TEST_REFRESH_ALLOWED`) sono sempre
parsati dallo schema `zod` (con default `0`/`false`); il loro **effetto** è gated
a consumo: i consumer (`makeNow`, guardia refresh, banner) leggono
`config.testMode` e applicano l'offset/l'azione solo quando `TEST_MODE=true`.
Con `TEST_MODE=false` il comportamento è identico a oggi (nessun parametro test
attivo), anche se i parametri sono presenti nell'ambiente (es. copiati per
sbaglio). Un parametro test-only **malformato** con `TEST_MODE=false` NON dà
errore (approccio più semplice e testabile): resta il default.

## 1. Contesto

La POC è completa (280 test). Per l'UAT end-to-end con giocatori
veri servono due cose: (a) un **test mode** esplicito nel sistema — segnalazione
ovunque + possibilità di spostare il tempo se serve (replay 2025) — e (b) una
**stagione sintetica** con date future nella tabella `match` (unica fonte dati,
ADR-007). `DbSeasonDataProvider` e tutto il Game Engine restano invariati: "la
CLI inietta". Vincolo assoluto: nessun `data:refresh` dall'API reale su DB
sintetico (riporterebbe la stagione 2025/26).

## 2. Task

### Task 0.1 — Loader e config del test mode

**Description:** Modifica a `src/config.ts`: il loader diventa
`process.loadEnvFile(process.env.ENV_FILE ?? '.env')` (comportamento invariato
se `ENV_FILE` assente); nuovo parametro `TEST_MODE` (default `false`,
`boolParam`); quando `TEST_MODE=true` la config espone `testMode` e i
parametri test-only (`TEST_OFFSET_DAYS`, intero default 0; `TEST_REFRESH_ALLOWED`,
bool default `false` — vedere Task 0.3 e Task 4). Differenzia l'errore:
`ENV_FILE` esplicito ma inesistente → errore che nomina il path; nessun `.env` →
silenzioso (come oggi). Documentare in LLD §4.5 la semantica no-override di
`loadEnvFile` (§0.2) e il gating a consumo (§0.3). Aggiornare `.env.example` e
`engines` (`>=20.12`).

**Acceptance criteria:**
- [ ] `ENV_FILE` assente → carica `.env` (comportamento attuale, test di regressione)
- [ ] `ENV_FILE=.env.uat` con `TEST_MODE=true` → `config.testMode=true`
- [ ] Parametri test-only gated a consumo: effetto attivo solo con `TEST_MODE=true`; con `TEST_MODE=false` nessun effetto (regressione)
- [ ] `TEST_MODE` assente/falso → comportamento identico a oggi
- [ ] `ENV_FILE` puntato a un file inesistente → errore esplicito che nomina il path (distinto dal caso "nessun `.env`", silenzioso)
- [ ] `engines` in `package.json` = `>=20.12`

**Verification:**
- [ ] `npm run test` (unit test loader/config con `process.env` controllato)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** None

**Files likely touched:**
- `src/config.ts`
- `.env.example`, `.env.uat.example` (nuovo, senza segreti)
- `package.json` (`engines`)
- `docs/POC/POC_LLD.md` (§4.5)
- `tests/unit/config.test.ts` (nuovo o esteso)

**Estimated scope:** Small

---

### Task 0.2 — Segnalazione test mode (email, CLI, log)

**Description:** Quando `config.testMode=true`: (a) ogni email INVIATA dal
sistema riceve un banner "TEST MODE" anteposto a livello di invio (seam unico
in `EmailAdapter.sendMessage` / `sendMail` — mai nei template LLM, D2); (b)
ogni output CLI testuale mostra la dicitura TEST MODE e ogni output `--json`
include il campo `testMode: true` (D3); (c) ogni riga di log pino porta il campo
strutturato `testMode: true` (binding via `mixin`/`bindings` del logger). Le
email RICEVUTE non sono modificabili: il banner vale solo sulle inviate.

**Accorgimenti (da seguire per evitare regressioni):**
- Estendere la signature di `createLogger` (`src/logger.ts`) per accettare un
  `testMode` opzionale (binding); **mantenere il path di emergenza**: il
  `ConfigError` viene loggato con un logger **senza binding** (config non ancora
  validata → `testMode` sconoscito), come da commento `logger.ts:8-10`. Non
  rompere il logger usato quando la config è invalida.
- Verificare (grep) che NESSUN test esistente imposti `TEST_MODE=true` (i test
  correnti girano con `.env` / nessun env di test → banner disattivato → nessuna
  regressione sulle asserzioni esatte sul body email).

**Acceptance criteria:**
- [ ] Con `testMode=true`: email inviata via canale reale (fake nei test) contiene il banner; template LLM invariati
- [ ] Con `testMode=true`: ogni output CLI testuale mostra TEST MODE; ogni output `--json` contiene `testMode`
- [ ] Con `testMode=true`: ogni riga pino contiene `testMode: true`
- [ ] Con `testMode=false`: nessuna modifica a email/CLI/log (regressione)
- [ ] Il path di `ConfigError` (config invalida) usa un logger senza binding `testMode` (mantenuto)

**Verification:**
- [ ] Grep: nessun test esistente imposta `TEST_MODE=true`
- [ ] `npm run test` (unit test banner email CON banner, CLI, logger + banner ASSENTE con `testMode=false`)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 0.1

**Files likely touched:**
- `src/channel/email-adapter/index.ts` o `src/channel/email-adapter/smtp-client.ts` (seam banner)
- `src/logger.ts`
- `src/cli/` (helper banner condiviso + applicazione nei comandi)
- `tests/unit/` (banner email, logger, CLI)

**Estimated scope:** Medium

---

### Task 0.3 — Offset orario unificato (opzionale, test-only)

**Description:** Applicazione dell'offset test-only `TEST_OFFSET_DAYS` (D9),
disattivato di default (0): un SINGOLO delta (intero giorni) sposta sia
l'orologio del sistema sia il timestamp di ricezione delle email, eliminando per
costrutto la classe di errore "offset disallineati". Implementazione:
- **(a) offset clock** — helper condiviso `makeNow(config)` (es. in
  `src/game/context.ts` o modulo dedicato) che applica `TEST_OFFSET_DAYS` quando
  `testMode` e offset > 0 (`now_finto = now_reale − N×86400000ms`, in giorni
  per preservare l'ora del giorno); usato da TUTTI i contesti CLI che oggi fanno
  `now: new Date()` **eccetto `simulate:*`** (D10: la simulazione deriva il clock
  dai dati ed è deterministica; `now` resta `new Date()` reale). Moduli da
  convertire: `scheduler.ts` (`makeSchedulerContext` e `scheduler:status`),
  `channel.ts` (contesto del batch `channel:email:process`), `tournament.ts`,
  `round.ts`, `pick.ts`, `winner.ts`. La scansione statica si limita a cercare
  `now: new Date()` (NON ogni `new Date(...)`: `llm.ts` fa `new Date(argv.deadline)`
  per parsare un input utente, non è un clock).
- **(b) offset receivedAt** — funzione pura `shiftReceivedAt(receivedAt, config)`
  che shiftai `message.receivedAt` di `TEST_OFFSET_DAYS` giorni quando abilitata,
  preservando l'ordine di arrivo (shift monotono). Applicata in UN SOLO punto:
  dentro `processEmailBatch` (o nel seam del comando), mappando `messages` una
  sola volta all'ingresso, prima di `registerPick`/`autoRegisterFromPick`; MAI
  anche nel comando `channel.ts` (doppio shift). I due call site del processor
  (`email-processor.ts:243` noto e `:302` auto-iscrizione) sono percorsi mutually
  esclusivi → non c'è doppio-applicazione sullo stesso messaggio, ma lo shift va
  applicato una sola volta tramite l'helper prima della cascata.
- `channel:email:fetch` resta RAW (mostra il `receivedAt` vero): in replay 2025
  fetch e process mostrano timestamp diversi per lo stesso messaggio — nota
  diagnostica da citare nella guida (Task 6).

Documentare: offset applicato con lo stesso valore a clock e receivedAt (garantito
per costrutto dal parametro unificato); con `receivedAt` trasformato l'evidenza
anti-frode è derivata, non grezza (accettabile solo per il replay 2025, MAI per
l'UAT su calendario sintetico).

**Acceptance criteria:**
- [ ] `TEST_OFFSET_DAYS=0` (default) → clock reale e receivedAt reale ovunque (regressione)
- [ ] Offset > 0 → `now` shiftato in TUTTI i comandi CLI (eccetto `simulate:*`) con lo stesso delta; `receivedAt` shiftato dello STESSO delta dentro `processEmailBatch`
- [ ] Shift monotono: l'ordine di arrivo è preservato; engine invariato
- [ ] Guard RF-31 testata con offset 0 (timestamp veri) e con offset > 0 (replay)
- [ ] Test di guardia: scansionando solo `now: new Date()`, NESSUN residua in `src/cli/commands/*` ECCETTO `simulate.ts`; `llm.ts` (`new Date(argv.deadline)`) è legittimo e nonConta
- [ ] Test: lo shift di `receivedAt` è esattamente `TEST_OFFSET_DAYS` giorni, applicato una sola volta (per messaggio)

**Verification:**
- [ ] `npm run test` (unit test helper clock + transform; regressione guard)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 0.1

**Files likely touched:**
- `src/game/context.ts` o nuovo modulo clock helper
- `src/cli/commands/*` (uso dell'helper nel contesto, eccetto `simulate.ts`)
- `src/channel/email-processor.ts` (helper receivedAt)
- `tests/unit/`

**Estimated scope:** Medium

---

### Task 0.4 — Risorsa alias sintetica (test-only)

**Description:** Nuova risorsa del prompt `src/llm/team-aliases-synthetic.md`:
lista canonica dei club di Serie B usati dal calendario sintetico + alias
editoriali, marcata esplicitamente come "non legata all'API" (il vincolo di
correttezza di `team-aliases.md` vale solo per la Serie A). La risorsa di
produzione `team-aliases.md` NON viene toccata (test esistente resta verde).

Selezione in base al test mode (D7): helper nel Parser
(`loadTeamAliasesFor(testMode: boolean)`) che restituisce la risorsa sintetica
se `testMode`, altrimenti quella di produzione; i comandi
`channel:email:process` e `llm:parse` (wiring, "la CLI inietta") scelgono tramite
`config.testMode`.

**Prompt in test mode (D7 — chiarimento lega):** il prompt di sistema del Parser
(`buildParseSystemPrompt`, `src/llm/parser.ts`) dichiara oggi "torneo privato di
pronostici sulla **Serie A**". In test mode la lista canonica è Serie B: va
chiarito nel prompt (o nella risorsa alias sintetica) che i nomi NON sono di
Serie A, per non confondere l'LLM reale e non compromettere la robustezza CS7.
Approccio: iniettare un contesto lega (es. "torneo privato basato su un
campionato sintetico di Serie B") in test mode tramite il selector del prompt,
senza toccare il prompt di produzione.

Test: coerenza della nuova risorsa (nessuna logica nel file, ogni alias → nome
canonico della lista, ogni nome con almeno un alias — speculare a
`team-aliases.test.ts`) e selezione in base a `testMode` (unit, con regressione:
senza test mode il parser riceve la risorsa di produzione invariata). La lista
canonica della risorsa deve coincidere con la costante `SYNTHETIC_TEAMS` del
generatore (Task 1): test di coincidenza che gira al Checkpoint B.

**Acceptance criteria:**
- [ ] Risorsa sintetica creata con lista canonica Serie B + alias; `team-aliases.md` invariato (test esistente resta verde)
- [ ] In test mode il Parser riceve la risorsa sintetica E il prompt chiarisce la lega; senza test mode riceve quella di produzione invariata (regressione)
- [ ] Test di coerenza della risorsa sintetica verde (alias coerenti, nessuna logica nel file)

**Verification:**
- [ ] `npm run test` (unit selezione + coerenza risorsa; coincidenza con `SYNTHETIC_TEAMS` a Checkpoint B)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 0.1 (testMode in config); test di coincidenza con Task 1 (Checkpoint B)

**Files likely touched:**
- `src/llm/team-aliases-synthetic.md` (nuovo)
- `src/llm/parser.ts` (helper di selezione + contesto lega in test mode)
- `src/cli/commands/channel.ts`, `src/cli/commands/llm.ts` (wiring con `config.testMode`)
- `tests/unit/llm/parser.test.ts` (selezione), `tests/integration/team-aliases-synthetic.test.ts` (nuovo)

**Estimated scope:** Small

---

### Task 1 — Generatore stagione sintetica

**Description:** Modulo puro `src/data/synthetic-season.ts` che genera un
`Match[]` a partire da parametri: lista squadre, numero round, spaziatura tra
le giornate (minuti), primo fischio (`Date`), seed per i punteggi (D5). Calendario
round-robin (ogni squadra gioca una volta per round, mai contro sé stessa),
`match_date` canoniche ISO-8601 UTC (`toISOString()`), punteggi presenti e
deterministici a parità di seed, `postponed=false`.

**Semantica spacing (D8 — risoluzione ambiguità):** tutte le partite di una
stessa giornata (matchday) hanno lo **stesso orario** (come nel calcio reale, e
coerente con `getFirstMatchDateTime` = `MIN(match_date)`); `--spacing-min`
distanzia **solo le giornate tra loro** (NON le singole partite). Così la formula
di allarme sovrapposizione del Task 2 è corretta: spaziatura tra giornate <
`MATCH_DURATION_MIN` + `TC_CLOSE_SKEW_MIN` → allarme.

**Comportamento di wrap (D8):** con `--teams 8` un round-robin completo ha 7
giornate; valori di `--rounds` maggiori di `teams-1` ripetono accoppiamenti di
giornate precedenti (la PK `(round, home_team, away_team)` resta diversa perché
cambia `round`). Ogni giornata deve comunque far giocare ogni squadra
esattamente una volta (nessun auto-match, nessun duplicato intra-giornata). Il
generatore applica il circle method ciclicamente; documentare il wrap.

Il modulo espone la costante `SYNTHETIC_TEAMS` (nomi canonici di club di Serie
B, D7) da cui il seed (Task 2) prende la rosa delle squadre; la coerenza con la
risorsa alias sintetica (Task 0.4) è verificata da un test di coincidenza
(Checkpoint B).

**Acceptance criteria:**
- [ ] Round-robin corretto: per ogni giornata ogni squadra gioca esattamente una partita; nessun auto-match; nessun duplicato intra-giornata
- [ ] Tutte le partite di una giornata hanno lo stesso orario; le giornate sono distanziate di `--spacing-min`
- [ ] Date future, formato canonico ISO-8601 UTC (suffisso Z)
- [ ] Punteggi presenti su tutte le partite e deterministici a parità di seed
- [ ] Numero round e squadre configurabili; parametri validati (errori chiari su input invalidi); `--rounds > teams-1` wrap senza auto-match (caso test)
- [ ] `SYNTHETIC_TEAMS` espone ≥ 8 nomi canonici validi (club di Serie B), senza duplicati

**Verification:**
- [ ] `npm run test` (unit test del generatore, incluso wrap `teams=8, rounds=10`)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** None (usa solo `Match` di `src/data/provider.ts`)

**Files likely touched:**
- `src/data/synthetic-season.ts` (nuovo)
- `tests/unit/data/synthetic-season.test.ts` (nuovo)

**Estimated scope:** Small

---

### Task 2 — Comando CLI `data:seed-synthetic`

**Description:** Nuovo comando in `src/cli/commands/data.ts` (registrato in
`src/cli/index.ts`): genera la stagione sintetica (Task 1) e la carica nella
tabella `match` con `upsertMatches` (stessa pipeline di `data:import`,
ADR-007). Opzioni: `--teams <n>` (default 8, nomi canonici di club di Serie B
dalla costante `SYNTHETIC_TEAMS`, D7), `--rounds <n>` (default 7 — round-robin
completo per 8 squadre; valori maggiori ripetono accoppiamenti, vedere Task 1),
`--spacing-min <n>` (default 90, distanza tra giornate), `--first-kickoff-offset-min
<n>` (default 120), `--seed <n>` (default 42), `--json`. Output riepilogo
(round, partite, primo/ultimo fischio).

**Rilevazione sovrapposizione (D8):** prima di scrivere, il comando calcola le
finestre TC dalla config (`MATCH_DURATION_MIN`, `TC_CLOSE_SKEW_MIN`) e dalla
spaziatura tra giornate richiesta (`--spacing-min`); se una finestra risulterebbe
sovrapposta (spaziatura tra giornate < durata + scarto), logga a livello **`error`**
pino — messaggio in inglese — con il suggerimento di verificare i valori dei
parametri coinvolti. (NON `critical`: pino non ha quel livello; vedi §0.1 D8.)

Opzione `--clear` (default `false`): svuota TUTTE le righe della tabella `match`
prima di seminare (operazione distruttiva: richiede anche `--force` come doppia
conferma). Per il `DELETE FROM match` va aggiunto un helper isolato in
`src/data/importer.ts`, mantenendo ben commentato che l'import base non famai DELETE.
**Guardia stato di gioco (Task 3):** con `--clear`, rifiutare se
`tournament_state.season_started=1` o esistono righe in `pick`/`round_state`
(a meno di un flag esplicito futuro di reset completo). Documentare che
`--clear` agisce solo sulla tabella `match`.

**Warning senza `--clear`:** con `--force` su tabella non vuota le righe esistenti
NON vengono cancellate (l'upsert non fa DELETE) → calendario MISTO; log WARN pino
(inglese) + output CLI con suggerimento `--clear`. Il WARN esplicita anche che
`getTeams()`/`getTotalRounds()` diventano incoerenti con la risorsa alias
sintetica (Serie A + B) e il confine girone viene derivato dal `MAX(round)` reale.

**Gate test-only (WARN, non blocco):** con `TEST_MODE=false` il comando procede
ma emette log WARN pino (inglese, "test-only command") e dicitura nell'output —
il seed è uno strumento del test mode e non va usato in produzione.

**Acceptance criteria:**
- [ ] Comando registrato e funzionante su `DB_PATH` configurato
- [ ] Upsert idempotente sulla PK `(round, home_team, away_team)` (re-run non duplica)
- [ ] Output riepilogo e supporto `--json` (convenzione LLD §7.13)
- [ ] I nomi delle squadre sintetiche provengono da `SYNTHETIC_TEAMS` (coerenza con la risorsa alias garantita dal test di coincidenza del Task 0.4)
- [ ] Se il calendario generato produce finestre TC sovrapposte (spaziatura tra giornate < `MATCH_DURATION_MIN` + `TC_CLOSE_SKEW_MIN`), il comando logga a livello **`error`** con messaggio in inglese e suggerimento di verificare i valori dei parametri coinvolti (D8)
- [ ] `--force` senza `--clear` su tabella non vuota → WARN esplicito (inglese): righe esistenti non cancellate, calendario misto possibile, `getTeams()`/`getTotalRounds()` incoerenti con la risorsa sintetica
- [ ] `--force --clear` su tabella non vuota → (previa guardia stato di gioco, Task 3) tabella `match` svuotata e ri-seedata (zero righe residue)
- [ ] `--clear` senza `--force` → rifiuto (doppia conferma)
- [ ] `TEST_MODE=false` → il seed procede con WARN (inglese) nell'output e nel log

**Verification:**
- [ ] `npm run test` (test del comando su DB in-memory)
- [ ] Prova manuale: `data:seed-synthetic` poi `data:calendar` mostra la stagione sintetica
- [ ] Prova manuale con `--spacing-min` inferiore a durata+skew: log **`error`** di sovrapposizione (messaggio in inglese) con suggerimento dei parametri coinvolti
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 1

**Files likely touched:**
- `src/cli/commands/data.ts`
- `src/data/importer.ts` (helper `DELETE FROM match` isolato e commentato per `--clear`)
- `src/cli/index.ts`
- `tests/integration/seed-synthetic.test.ts` (nuovo)

**Estimated scope:** Small

---

### Task 3 — Guardia anti-sovrascrittura del seed e guardia stato di gioco

**Description:** Due guardie distinte:
1. **Anti-sovrascrittura (base):** il seed rifiuta (senza effetti) se la tabella
   `match` è già popolata, salvo `--force` (D6). Il `--force` NON cancella i dati
   esistenti (l'upsert non fa DELETE): con `--force` senza `--clear` le righe
   pre-esistenti restano e il calendario può diventare MISTO (WARN, Task 2); per
   svuotare e ri-seedare serve `--force --clear` (Task 2). Protegge dal
   sovrascrivere un DB con dati reali (produzione o import 2025/26) e previene
   errori d'uso in fase UAT.
2. **Stato di gioco (per `--clear`):** prima di eseguire il `DELETE FROM match`
   con `--force --clear`, rifiutare se `tournament_state.season_started=1` o se
   esistono righe in `pick`/`round_state`. Motivazione: il `DELETE` distruggerebbe
   il calendario **lasciando orfani** i pronostici e lo stato dei round → DB
   inconsistente. La guardia previene il caso peggiore (un `--clear` lanciato su
   un DB con torneo in corso).

**Acceptance criteria:**
- [ ] `data:seed-synthetic` su tabella `match` non vuota → errore chiaro, nessuna modifica
- [ ] `--force` senza `--clear` supera la guardia ma NON cancella le righe esistenti (WARN di calendario misto, Task 2)
- [ ] `--force --clear` su tabella vuota → svuota (no-op) e ri-seeda
- [ ] `--force --clear` su tabella non vuota CON `season_started=1` o righe in `pick`/`round_state` → rifiuto esplicito con il motivo (stato di gioco presente)
- [ ] `--force --clear` su tabella non vuota SENZA stato di gioco → tabella `match` svuotata e ri-seedata (zero righe residue)

**Verification:**
- [ ] `npm run test` (casi guardia/force + guardia stato di gioco)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 2

**Files likely touched:**
- `src/cli/commands/data.ts` (o il modulo generatore)
- `tests/integration/seed-synthetic.test.ts`

**Estimated scope:** XS

---

### Task 4 — Refresh/import bloccati in test mode (guardia TEST_MODE)

**Description:** La protezione è derivata da `TEST_MODE` (l'opzione
`SCHEDULER_REFRESH_ENABLED` NON si implementa). Nuovo parametro test-only
`TEST_REFRESH_ALLOWED` (default `false`, validato sempre ma effetto gated a
consumo come `TEST_OFFSET_DAYS`) come override esplicito per i casi che
richiedono dati reali in test mode (es. UAT 3.3 con fixtures reali 2026/27).
Comportamento:
- `TEST_MODE=true` con `TEST_REFRESH_ALLOWED` assente/falso (default):
  - `data:refresh` e `data:import` NON chiamano l'API e non toccano la tabella
    `match`: output esplicito ("operazione saltata: TEST MODE", in inglese) +
    log pino dello skip (in inglese, vincolo `log_messages_english`);
  - `scheduler:tick` NON costruisce il refresh (nessuna chiamata API) e
    prosegue con le azioni dovute, loggando lo skip;
- `TEST_MODE=true` + `TEST_REFRESH_ALLOWED=true`: import/refresh eseguono
  normalmente, con **log WARN di consenso a OGNI operazione** (data:import,
  data:refresh e ogni tick dello scheduler che esegue il refresh). Il WARN
  include il `DB_PATH` (così l'operatore vede su quale DB sta operando) —
  configurazione pericolosa su DB sintetico, da rimuovere a fine UAT 3.3
  (responsabilità dell'operatore: si usa SOLO su DB con dati reali, MAI su
  calendario sintetico);
- `TEST_MODE=false`: `TEST_REFRESH_ALLOWED` ignorato (gating a consumo),
  comportamento attuale invariato (import/refresh reali);
- la guardia vive nei comandi CLI (niente `getConfig()` nei moduli:
  `importMatches` resta pura); qualsiasi futura chiamata a `importMatches` dai
  comandi deve applicare la stessa guardia (convenzione da documentare nei
  commenti, AGENTS.md §5);
- nota: `src/game/scheduler.ts` NON viene modificato — con la guardia attiva il
  `deps.refresh` non viene passato e l'evento `refresh_failed` è irraggiungibile
  in test mode (comportamento atteso, da citare nella guida Task 6).

**Acceptance criteria:**
- [ ] `TEST_MODE=true` (default): `data:refresh`/`data:import` e refresh dello scheduler non toccano API né DB; output e log espliciti (in inglese)
- [ ] `TEST_MODE=true` + `TEST_REFRESH_ALLOWED=true`: import/refresh eseguono normalmente con log WARN di consenso a ogni operazione (incluso il refresh dello scheduler a ogni tick); il WARN include il `DB_PATH`
- [ ] `TEST_MODE=false`: `TEST_REFRESH_ALLOWED` ignorato, comportamento attuale invariato (import/refresh reali) (regressione)

**Verification:**
- [ ] `npm run test` (unit test CLI: skip di default, consenso WARN con flag, regressione senza test mode)
- [ ] Prova manuale: `data:refresh` e `scheduler:tick` su DB sintetico non alterano le `match_date` (skip loggato); con `TEST_REFRESH_ALLOWED=true` eseguono con log WARN di consenso (incluso `DB_PATH`)
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 0.1

**Files likely touched:**
- `src/config.ts` (parametro `TEST_REFRESH_ALLOWED`)
- `src/cli/commands/data.ts`
- `src/cli/commands/scheduler.ts`
- `tests/unit/cli/data-refresh.test.ts` (nuovo), `tests/unit/cli/scheduler-tick.test.ts` (nuovo)

**Estimated scope:** Small

---

### Task 5 — Ambiente UAT (`.env.uat` reale)

**Description:** File `.env.uat` (gitignored, come `.env`; esempio versionato in
`.env.uat.example`, **senza segreti**): `TEST_MODE=true`, `DB_PATH` dedicato
(es. `data/uat-synthetic.db`), `SCHEDULER_ENABLED=true`,
`MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`, `DEADLINE_ADVANCE_MIN=30`,
`TEST_OFFSET_DAYS=0` (calendario sintetico con clock e receivedAt REALI),
`TEST_REFRESH_ALLOWED=false` (default; riga commentata in `.env.uat.example`
con nota "solo per UAT su dati reali, es. 3.3 — mai su calendario sintetico"),
credenziali Gmail della casella del progetto e LLM reali. **Mailbox
(decisione 2026-08-17):** si usa la STESSA casella Gmail del progetto per test
e produzione (niente seconda casella dedicata; supera la proposta 3.6 del
brainstorming); cleanup della casella quando serve, con procedura descritta
nella guida (Task 6). Attivazione in pratica:
`ENV_FILE=.env.uat` nell'ambiente della shell o del cron.

**`.gitignore` (precedenza):** l'aggiornamento di `.gitignore` (aggiungere
`.env.uat`, `.env.uat-replay`) **precede** la creazione dei file reali, per
evitare leak di credenziali (la password App Gmail e la chiave LLM sono
segreti). Versionare solo i `.env.uat.example`/`.env.uat-replay.example` senza
segreti; aggiungere un test che gli esempi non contengono segreti.

**`LLM_MODEL` (allineamento):** il `LLM_MODEL` degli esempi
(`.env.uat.example`/`.env.uat-replay.example`) è la **lista failover
multi-modello** prodotta dal piano LLM dedicato (`tasks/plan-failover-llm-multimodello.md`);
non un singolo modello placeholder. Motivazione: lo stress test del 2026-08-15
ha confermato `nvidia/nemotron-3-super-120b-a12b:free` (16/16, zero errori) e
scartato i modelli `gemma-3`-family per rate-limit 429. Il fallimento LLM in UAT
è un rischio concreto per la robustezza CS7. **Nota (2026-08-16T20:34Z):** la
lista è già adottata in `.env`
(`nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free`,
`LLM_TIMEOUT_MS=15000`, `LLM_RETRIES=3` — report
`docs/uat/stress-test-report-2026-08-16.md`); gli esempi `.env.uat*` riusano
questa lista.

Aggiornare `.env.example` e LLD §4 con i nuovi parametri (0.1, 4), la nota "mai
`ENV_FILE`/`TEST_MODE` in produzione", la semantica no-override di `loadEnvFile`
(Task 0.1) e il comportamento di import/refresh bloccati in test mode (Task 4).

Per lo scenario 3.1 (replay 2025, sez. 4) usare un file env DEDICATO (es.
`.env.uat-replay`, gitignored; esempio versionato in `.env.uat-replay.example`,
senza segreti) con `TEST_OFFSET_DAYS` valorizzato, invece di override inline
`VAR=x npm run cli -- ...`: la precedenza no-override di `loadEnvFile` (Task 0.1)
rende inaffidabili gli override inline, e un file dedicato è riproducibile e
auditabile.

**Acceptance criteria:**
- [ ] `.gitignore` aggiornato (`.env.uat`, `.env.uat-replay`) PRIMA della creazione dei file reali
- [ ] `.env.uat` documentato e funzionante (ogni parametro con scopo/valori/effetto, regola AGENTS.md §5); `.env.uat.example` versionato SENZA segreti (test di verifica)
- [ ] `LLM_MODEL` degli esempi = lista failover multi-modello del piano LLM dedicato (non singolo placeholder)
- [ ] `ENV_FILE=.env.uat` attiva il test mode e la config UAT su DB dedicato
- [ ] Con la config UAT le finestre TC non si sovrappongono (spaziatura tra giornate ≥ durata+skew); `data:seed-synthetic` non emette log **`error`** di sovrapposizione (Task 2, D8)
- [ ] Produzione invariata: senza `ENV_FILE` nessun parametro di test è attivo
- [ ] `data:refresh` e `scheduler:tick` in test mode non alterano il calendario sintetico (skip loggato, Task 4)
- [ ] `.env.uat-replay.example` versionato (se applicabile): `TEST_OFFSET_DAYS` valorizzato, nota "solo replay 2025 su DB dedicato"

**Verification:**
- [ ] `ENV_FILE=.env.uat npm run cli -- data:seed-synthetic` + `data:calendar` → stagione sintetica, banner TEST MODE visibile
- [ ] `round:deadline`/`round:status` su DB seedato mostrano finestre coerenti
- [ ] `npm run typecheck && npm run lint`

**Dependencies:** Task 0.1, 0.2, 0.3, 0.4, Task 2, Task 4

**Files likely touched:**
- `.env.uat` (nuovo, gitignored), `.env.uat.example` (nuovo), `.env.uat-replay` (nuovo, gitignored), `.env.uat-replay.example` (nuovo)
- `.env.example`
- `.gitignore` (`.env.uat`, `.env.uat-replay` + patterngenerici `/.env.*` se coerente)
- `docs/POC/POC_LLD.md` (§4)

**Estimated scope:** Small

---

### Task 6 — Guida operativa UAT (test mode)

> La guida `docs/uat/guida-test-mode.md` è **rientrata** nello scope (decisione
> del committente del 2026-08-16; le precedenti note di eliminazione sono
> superate).

**Description:** Documento di riferimento durevole
`docs/uat/guida-test-mode.md` su come pianificare ed eseguire i test UAT con il
sistema in test mode, scritto partendo dall'implementazione reale (nomi di
parametri e comandi effettivi, esiti del quickstart) e integrando i requisiti
sotto. Destinatari: amministratori, PO e operatori umani con media comprensione
del linguaggio tecnico (NON developer) e agenti. La guida NON assume conoscenza
del codice: spiega i concetti necessari (cos'è un round/deadline/seed/cron, cosa
cambia col test mode), tutti i parametri di configurazione rilevanti con scopo,
valori ammessi ed effetto, e copre ENTRAMBE le modalità operative:
- **modalità commissioner** — flusso a comandi manuali (seed → start → open →
  pick → close → score), quando usarla e come;
- **modalità cron** — scheduler attivo con `ENV_FILE=.env.uat`, quando usarla,
  esempio di riga crontab, vincolo "mai `data:refresh` su DB sintetico".

Contenuti richiesti: spiegazione dei parametri di configurazione (tabella con
scopo/valori/effetto), guide passo-passo, esempi di comandi pronti all'uso,
suggerimenti (es. come verificare che il test mode sia attivo: banner in
CLI/log/email), quickstart (percorso minimo per far partire il sistema in test
mode in pochi minuti). La guida usa i nomi reali di parametri e comandi
dell'implementazione (Task 0.x, 1-5) e cita i casi limite documentati (offset
solo per calendari passati, guardia `--force`/`--clear` e calendario misto,
WARN seed fuori test mode, refresh disattivato).

**Requisiti aggiuntivi (da includere nella guida):**
1. **Liste di comandi CLI copiabili per ogni esempio di esecuzione:** per
   ciascun esempio di timeline (2h, ~4h30, ~6h30) la guida riporta la lista
   step-by-step dei comandi CLI da incollare nel terminale (seed, avvio,
   processazione email/tick, chiusure, verifica finale), con i valori
   dell'esempio già compilati e il prefisso `ENV_FILE=.env.uat` dove serve.
2. **Sezione "Scope del test mode":** cosa si può dimostrare/testare con il
   test mode e cosa NO, con esempi concreti. Dimostrabile: flusso email
   completo (iscrizione/pick/conferma/rifiuto), guard anti-frode su timestamp
   veri (pick in ritardo), eliminazioni, reset del pool, vincitore, banner e
   segnalazione ovunque. **NOTA sul path specifico della guard anti-frode RF-31
   (`after_kickoff`):** nel flusso cron standard un pick tardivo riceve
   `round_not_open` (il round è già chiuso alla deadline, che precede il
   fischio); per dimostrare `after_kickoff` serve la **modalità commissioner**
   (round lasciata aperta oltre il kickoff) oppure una **deadline NULL (CL17)**
   (round resta aperto fino alla chiusura del TC). Non promettere copertura
   impossibile nel flusso cron. NON dimostrabile (scenari fuori dal calendario
   sintetico con punteggi pre-seedati): pick congelati (freeze), recupero di
   partite rinviate (dentro/fuori finestra), deadline non registrata (NULL,
   tranne il case CL17 sopra), anticipo di calendario dopo l'apertura del
   round, chiusura di sicurezza, anomalie `warn_not_calculable`, flusso dati
   reale (refresh dall'API) — questi restano coperti dai test automatici.
3. **Assunzione esplicita dei giocatori di test:** esempi e intera guida
   presuppongono giocatori di TEST — persone consapevoli di collaudare il
   sistema, collaborative, con la casella email aperta, pronte a operare
   secondo le esigenze dei test (es. inviare il pick in ritardo quando
   richiesto, rispondere entro finestre brevi). La guida deve dichiararlo
   all'inizio e nei singoli esempi.
4. **Manuale operativo del TEST_MODE:** l'intera guida è concepita come un
   "libretto di istruzioni" della modalità TEST_MODE — manuale operativo
   completo, non solo esempi: come si attiva, come si usa, come si disattiva,
   come si verifica che sia attiva (banner in CLI/log/email), cosa fare e cosa
   NON fare (vincoli: mai `data:refresh` su DB sintetico, offset solo per
   calendari passati, mai in produzione), procedure standard (avvio del test,
   operazioni per round, conclusione e verifica finale) e comandi di
   verifica/controllo in ogni fase.
5. **Sezione introduttiva "Cos'è il test mode" (all'inizio della guida):**
   sezione dedicata che spiega, in linguaggio non-tecnico: che cos'è il test
   mode, a cosa serve, quali sono le implicazioni del suo uso, cosa cambia nel
   sistema quando è attivo, **quali componenti e funzioni modificano il loro
   comportamento rispetto alla produzione** (loader/config: file env
   selezionabile e parametri test-only; canale email: banner sulle email
   inviate; CLI: dicitura TEST MODE e campo `testMode` negli output JSON;
   logger: campo `testMode` nei log; parser LLM: risorsa alias sintetica
   (Serie B) al posto di quella di produzione e contesto lega nel prompt;
   clock e receivedAt: spostabili SOLO se configurati, per calendari passati;
   scheduler: refresh disattivabile) e
   **quali parametri sono stati aggiunti e perché** (tabella parametri test
   con motivazione, non solo scopo/valori).
6. **Seed: `--force`, `--clear` e avvisi (Task 2/3):** spiegazione in
   linguaggio semplice di cosa fa il seed (aggiunge/aggiorna, non cancella
   mai), della guardia `--force`, del perché `--force` senza `--clear` può
   produrre un calendario MISTO (e incoerenza con la risorsa alias sintetica) e
   di quando usare `--force --clear`; avviso che `--clear` è rifiutato se il
   torneo è avviato o ci sono pronostici/stato round; avviso che con
   `TEST_MODE=false` il comando emette un WARN (è uno strumento del test mode).
7. **Replay 2025 (scenario 3.1):** istruzioni per l'esecuzione con file env
   dedicato `.env.uat-replay` (Task 5); nota diagnostica che
   `channel:email:fetch` mostra timestamp REALI anche in replay (il
   `receivedAt` shiftato è visibile solo nel processamento).
8. **Cleanup della casella Gmail condivisa (decisione 2026-08-17):** poiché
   test e produzione usano la stessa casella, la guida include la procedura
   per riconoscere le email di test (banner "TEST MODE" sulle email inviate
   dal sistema) e ripulire la casella — a fine di ogni sessione UAT e
   comunque prima del go-live reale.

**Acceptance criteria:**
- [ ] Guida scritta, coerente con l'implementazione (stessi nomi di parametri e comandi, verifica incrociata con `.env.uat` e CLI)
- [ ] Guida comprensibile da operatori NON developer: glossario dei termini, niente codice TS, esempi pronti all'uso
- [ ] Ogni esempio di esecuzione (2h, ~4h30, ~6h30) include la lista di comandi CLI copiabili passo-passo
- [ ] Sezione "Scope del test mode" presente, con elenco dimostrabile/non dimostrabile e, in particolare, la nota su RF-31 (`after_kickoff` solo in commissioner/CL17, non nel flusso cron standard)
- [ ] Assunzione dei giocatori di test dichiarata all'inizio della guida e nei singoli esempi
- [ ] La guida è un manuale operativo completo ("libretto di istruzioni") del TEST_MODE: attivazione/uso/disattivazione, verifica di stato, procedure standard, cosa fare e cosa NON fare
- [ ] Sezione introduttiva "Cos'è il test mode" presente: scopo, implicazioni, differenze vs produzione (componenti/funzioni che cambiano comportamento, incluso il contesto lega nel prompt), parametri aggiunti e perché
- [ ] Copre entrambe le modalità: commissioner (comandi manuali) e cron (scheduler)
- [ ] Sezione seed (`--force`, `--clear`, WARN fuori test mode, calendario misto, guardia stato di gioco) presente e comprensibile da non-developer
- [ ] La guida include la procedura di cleanup della casella Gmail condivisa (test/produzione), con riconoscimento delle email di test tramite banner
- [ ] Revisionata da un lettore non-developer (o almeno dal commissioner)

**Verification:**
- [ ] Prova pratica: il quickstart della guida eseguito dall'inizio alla fine su un DB di prova (banner TEST MODE visibile, torneo avviato)
- [ ] Ogni lista di comandi degli esempi eseguita da capo a fine senza errori su DB di prova
- [ ] Coerenza nomi/parametri con `.env.uat` e comandi CLI
- [ ] Guida collegata nella mappa documenti (AGENTS.md §1.6) se applicabile

**Dependencies:** Task 0.1-0.3, Task 1-5 (documenta ciò che è stato implementato)

**Files likely touched:**
- `docs/uat/guida-test-mode.md` (nuovo)
- `agent-context/current-status.md` (changelog al completamento)

**Estimated scope:** Medium

---

## 3. Checkpoint e worked example

### Worked example — parametri UAT, cadenza e copertura RF-31

Ipotesi (dimensionamento raccomandato + default piano): `TEST_MODE=true`,
`SCHEDULER_ENABLED=true`, clock reale e receivedAt reali (`TEST_OFFSET_DAYS=0`,
calendario sintetico strada 3.2), `DEADLINE_ADVANCE_MIN=30`,
`MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`, `--teams 8`, `--rounds 6`,
`--spacing-min 45`, `--first-kickoff-offset-min 120`, **punteggi pre-seedati (D5)**.

**Cadenza di una giornata (cron, score pre-seedato):**
1. `round:open`: registra `deadline = kickoff_N − 30 min` (RF-14).
2. Lo scheduler chiude al superamento della deadline (`now > deadline`, →
   `round_close`). Accettazione = `min(deadline, kickoff)` = deadline (perché
   `DEADLINE_ADVANCE_MIN>0`). I pick sono accettati fino alla deadline.
3. `round:score` subito (score pre-seedato → nessun `pending` → `scored`).
4. La giornata N+1 si apre quando la N è `scored` (`prevScored`): dato che N
   scorea subito dopo la chiusura (deadline), la N+1 si apre **alla deadline
   della N**.

**Finestra di pick effettiva (giornate 2+):**
`kickoff_{N+1} = kickoff_N + spacing`; `deadline_{N+1} = kickoff_{N+1} − 30`;
apertura N+1 ≈ `deadline_N = kickoff_N − 30`. Quindi:

```
finestra_pick(N+1) ≈ deadline_{N+1} − apertura_{N+1}
                   = (kickoff_N + spacing − 30) − (kickoff_N − 30)
                   = spacing
```

→ con `--spacing-min 45` → **~45 min di finestra di pick** per giornate 2+; con
il default `90` → ~90 min. **Entrambi ≥ 20 min**, coerenti col vincolo di
progetto (finestre umane mai sotto i 20 min). **Condizione necessaria:** i
punteggi devono essere pre-seedati (D5); se immessi per round, `round:score` non
completerebbe a deadline e la giornata successiva non si aprirebbe fin dopo il
`tcClose`, allungando le finestre in modo imprevedibile. **D5 è quindi
strutturale** per la cadenza compressa, non solo "comoda".

**Copratura RF-31 (`after_kickoff`) nel flusso sintetico:**
`checkAcceptance` controlla prima `receivedAt > kickoff` → `after_kickoff`, poi
`receivedAt > deadline` → `after_acceptance`. Con `deadline = kickoff − 30`,
durante tutto il periodo `open` si ha `receivedAt ≤ deadline < kickoff` → RF-31
**non morde mai** (ridondante, come da PRD). In **modalità cron**, subito dopo la
deadline lo scheduler **chiude** la giornata → un pick tardivo riceve
`round_not_open`, non `after_kickoff`. **Conseguenza:** il path specifico di
RF-31 NON è esercitato dal flusso sintetico standard. Per dimostrare
`after_kickoff` in UAT serve:
- modalità **commissioner** manuale con giornata lasciata **aperta oltre il
  kickoff** (non chiudere alla deadline), poi pick ricevuto dopo il kickoff
  reale; oppure
- **deadline NULL** (CL17): la giornata resta `open` oltre il kickoff e la
  safety close avviene al `tcClose` (`kickoff + MATCH_DURATION_MIN +
  TC_CLOSE_SKEW_MIN`); un pick in `[kickoff, tcClose]` riceve `after_kickoff`.

Questo è riflesso nell'acc-criterion del Task 6 (scope del test mode).

### Checkpoint A — dopo Task 0.1-0.4 (test mode)
- [ ] `npm run test` verde (loader/config, banner email, CLI, log, offset unificato, risorsa alias sintetica)
- [ ] `npm run typecheck && npm run lint` puliti
- [ ] Senza `ENV_FILE` il comportamento è identico a oggi (regressione, inclusa la risorsa alias di produzione)
- [ ] Con `ENV_FILE` di prova: banner TEST MODE in CLI/log/email inviata; parser LLM con risorsa alias sintetica e contesto lega chiarito
- [ ] Revisione col commissioner

### Checkpoint B — dopo Task 1-3 (seed)
- [ ] `data:seed-synthetic` + `data:calendar` funzionano da CLI su DB di prova
- [ ] Guardia anti-sovrascrittura verificata (rifiuto senza `--force`)
- [ ] `--force` senza `--clear` su DB popolato → WARN calendario misto; `--force --clear` → (se nessuno stato di gioco) tabella svuotata e ri-seedata
- [ ] `--force --clear` rifiutato se `season_started=1` o righe in `pick`/`round_state`
- [ ] Generatore: tutte le partite di una giornata stesso orario; `--rounds > teams-1` wrap senza auto-match (test)
- [ ] `npm run test`, typecheck e lint verdi

### Checkpoint C — dopo Task 4-5 (ambiente UAT pronto)
- [ ] `data:refresh` e `scheduler:tick` in test mode non alterano il calendario sintetico (skip loggato)
- [ ] `ENV_FILE=.env.uat` → test mode attivo, stagione sintetica, cron collaudabile
- [ ] `.gitignore` aggiornato PRIMA della creazione dei file reali; `.env.uat.example`/`.env.uat-replay.example` senza segreti (test)
- [ ] `LLM_MODEL` degli esempi = lista failover multi-modello del piano LLM dedicato

### Checkpoint D — dopo Task 6 (guida operativa)
- [ ] Guida scritta e coerente con l'implementazione (stessi nomi di parametri e comandi)
- [ ] Quickstart verificato dall'inizio alla fine su DB di prova
- [ ] Nota su RF-31 (`after_kickoff` in commissioner/CL17, non nel flusso cron) presente
- [ ] Revisione finale col commissioner PRIMA di pianificare l'UAT (sezione 4)

**Conclusione dell'implementazione:** al completamento dei Task 0-6,
aggiornare `agent-context/current-status.md` (timestamp + changelog ISO-8601,
regola AGENTS.md §0) e verificare la coerenza della mappa documenti (AGENTS.md
§1.6). L'esecuzione dell'UAT NON fa parte di questo piano.

## 4. UAT — sezione esecuzione (pianificazione dedicata futura)

Questa sezione descrive COME verrà eseguito l'UAT e cosa lo abilita; la
pianificazione dettagliata (task, date, partecipanti, checklist) sarà fatta in
un piano dedicato, DIPENDENTE dall'esecuzione e dall'esito del presente piano
(Task 0-6 completati e verificati). Il riferimento operativo passo-passo per
l'esecuzione è la guida prodotta dal Task 6 (`docs/uat/guida-test-mode.md`);
questa sezione ne delinea gli scenari e i criteri di accettazione.

**Prerequisito (oggetto di questo piano):** test mode operativo (0.1-0.3),
comando seed (1-3), scheduler senza refresh su DB sintetico (4), ambiente
`.env.uat` pronto (5).

**Dipendenze esterne — STATO: RISOLTE (aggiornamento 2026-08-16T20:34Z):**

> **Nota di aggiornamento (2026-08-16T20:34Z):** entrambe le dipendenze esterne
> sono state risolte con l'esecuzione del piano
> `tasks/plan-failover-llm-multimodello.md` e sono verificate nel report
> `docs/uat/stress-test-report-2026-08-16.md`. I testi sotto restano come
> contesto storico dei problemi.

- **Bug `markSeen` (churn/ETIMEDOUT) — RISOLTO (2026-08-16):** il problema
  registrato nel digest dello stress test 2026-08-15 (`markSeen` fallito su
  2/20 messaggi, UID 130/131, con `ETIMEDOUT` su IMAP connect per il churn di
  connessioni per-messaggio — una nuova connessione IMAP per ogni `markSeen`
  via `createImap()` in `index.ts:96-110`) è stato chiuso con un fix di
  robustezza applicato in `src/channel/email-adapter/index.ts` (retry fino a
  `MARK_SEEN_ATTEMPTS=3` con connessione NUOVA per tentativo e pausa
  `MARK_SEEN_RETRY_DELAY_MS=1000`; flag `\Seen` idempotente; `EmailAdapterError`
  solo a esaurimento) e in `imap-client.ts` (STORE `false` → errore esplicito).
  Ri-validazione dal vivo: **20/20 processati, 20/20 `seen` persistiti, 0
  errori, 0 duplicati** (addendum del report). 280 test verdi, typecheck/lint
  puliti. Il fix precedente (mailbox aperta prima del STORE) resta applicato.
- **Lista failover LLM multi-modello — RISOLTA e ADOTTATA (2026-08-16):**
  implementata dal piano `tasks/plan-failover-llm-multimodello.md` e **adottata
  in `.env`**: `LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free`,
  `LLM_TIMEOUT_MS=15000`, `LLM_RETRIES=3`. Stress test parser 16/16 senza
  blocchi (zero 429 nella finestra; primario vincente sempre). È la lista da
  riusare per `.env.uat`/`.env.uat-replay` (Task 5).

**Scenari UAT previsti:**
1. **UAT principale — calendario sintetico (strada 3.2):** `ENV_FILE=.env.uat`,
   DB sintetico seedato, orologio e receivedAt REALI (`TEST_OFFSET_DAYS=0`),
   giocatori veri, Gmail reale (IMAP/SMTP), LLM reale, scheduler via cron. Guard
   anti-frode su timestamp veri. Durata 1-2 giorni (giornate a 1-2 ore).
   Checklist CS1–CS7 del checkpoint finale di `tasks/plan.md`.
2. **Replay 2025 con giocatori veri (strada 3.1, opzionale):** stessa
   infrastruttura ma con `TEST_OFFSET_DAYS` > 0, attivato via file env dedicato
   `.env.uat-replay` (Task 5, non override inline): evidenza anti-frode derivata
   — ammessa solo su DB dedicato, con banner/log in test mode.
3. **Verifica alternativa 3.3 (fixtures reali 2026/27 su football-data.org):**
   da valutare col commissioner prima dell'UAT sintetico: se disponibili,
   restano l'opzione a fedeltà massima (zero finzioni). Con test mode attivo e
   refresh dei risultati live necessari: `TEST_REFRESH_ALLOWED=true` (DB con
   dati reali, mai sintetico). **Nota (2026-08-17):** il commissioner ha
   confermato la priorità allo smoke test su calendario sintetico (3.2) prima
   di qualsiasi test su dati reali, anche perché il deploy non è ancora
   avvenuto; il check dei fixtures 2026/27 resta opzionale e gratuito (un
   comando `data:import` su DB di prova), da fare quando si pianifica
   l'esecuzione dell'UAT.

**Criteri di accettazione dell'UAT (da dettagliare nel piano dedicato):**
- Profilo completo via email reale (CS1): iscrizione → pick → conferma → valutazione
- Pick in ritardo rifiutato con motivoanti-frode:
  - nel **flusso cron standard** un pick tardivo riceve `round_not_open` (la
    giornata è già chiusa alla deadline, che precede il fischio);
  - per dimostrare `after_kickoff` (RF-31) serve la **modalità commissioner**
    (giornata aperta oltre il kickoff) o una **deadline NULL (CL17)**.
- Stagione sintetica completata o interrotta deliberatamente, senza interventi
  manuali oltre al cron
- Esito e rettifiche documentati; eventuali bug registrati e corretti

**Dipendenze del piano dedicato:** esecuzione di questo piano (Checkpoint C),
conferma dei parametri UAT (Task 5/D5-D9), casella Gmail di test e numero di
giocatori reali. (Bug `markSeen` e lista failover LLM: **RISOLTI il 2026-08-16**,
vedi sopra.)

## 5. Rischi e mitigazioni

| Rischio | Impatto | Mitigazione |
|---------|---------|-------------|
| Test mode lasciato attivo in produzione | Alto | D4: segnalazione visibile (banner in email/CLI/log, campo `testMode`); vincolo documentato; `ENV_FILE`/`TEST_MODE` mai in produzione |
| `receivedAt` trasformato falsifica l'evidenza anti-frode | Alto (solo se usato) | Disattivato di default (`TEST_OFFSET_DAYS=0`); offset unificato (impossibile disallineare, D9); usato solo per replay 3.1 su DB dedicato; guard RF-31 su timestamp veri coperta dall'UAT sintetico e dai test automatici |
| `data:refresh`/scheduler distrugge il calendario sintetico | Alto | Task 4 (guardia TEST_MODE: import/refresh bloccati e loggati in test mode) + vincolo documentato; guardia Task 3 |
| `TEST_REFRESH_ALLOWED=true` lasciato attivo su DB sintetico | Alto | Default `false`; log WARN di consenso a ogni operazione che esegue import/refresh in test mode (incluso `DB_PATH`); vincolo documentato (solo DB con dati reali); da rimuovere a fine UAT 3.3 |
| Seed eseguito per errore su DB reale | Alto | Guardia anti-sovrascrittura (Task 3): rifiuto senza `--force`; WARN seed fuori test mode e `--clear` con doppia conferma (Task 2) |
| `--force --clear` su DB con torneo in corso (orfanizzazione pick/round_state) | Alto | Guardia stato di gioco (Task 3): rifiuto se `season_started=1` o righe in `pick`/`round_state` |
| `--force` senza `--clear` su DB popolato produce calendario misto | Medio | WARN esplicito al seed (Task 2) + documentazione (Task 3/6); incoerenza `getTeams()`/`getTotalRounds()` con la risorsa alias sintetica segnalata nel WARN |
| Finestre TC sovrapposte con round ravvicinati | Medio | D8: durata/skew ridotti in config UAT (Task 5), spaziatura tra giornate ≥ durata+skew; log **`error`** alla rilevazione (Task 2), messaggio in inglese con suggerimento di verificare `MATCH_DURATION_MIN`, `TC_CLOSE_SKEW_MIN`, `--spacing-min` |
| LLM reale non risolve i nomi squadra sintetici / confonde Serie A vs B | Medio | D7: nomi canonici reali Serie B + contesto lega chiarito nel prompt in test mode (Task 0.4); `LLM_MODEL` allineato al failover testato (Task 5, memoria `env_llm_model`) |
| UAT con orologio reale richiede attese (giornate a 1-2h) | Medio | Spaziatura e numero giornate scelti per stare in 1-2 giorni; commissioner può chiudere forzatamente (RF-29) |
| `.env.uat`/`.env.uat-replay` con segreti committati per errore | Critico | `.gitignore` aggiornato PRIMA della creazione dei file reali (Task 5); test che gli `.example` non contengono segreti |
| `markSeen` non affidabile → risposte duplicate in UAT | Alto | **RISOLTO (2026-08-16):** fix di robustezza applicato (retry ×3 con connessione nuova + STORE `false` → errore esplicito) e validato dal vivo 20/20 `seen` persistiti, 0 duplicati (addendum `docs/uat/stress-test-report-2026-08-16.md`; 280 test verdi) |
| Livello log "CRITICAL" inesistente in pino | Alto (runtime) | D8/Task 2: usare `error` pino; uniformato in tutto il piano |
| `simulate:*` con `makeNow` altera determinismo RNF1 | Medio | D10: `simulate:*` esentato; `now` reale; scansione statica limitata a `now: new Date()` |
| `loadEnvFile` no-override non documentato → override inline non affidabili | Medio | Task 0.1: semantica documentata in LLD §4.5/`.env.example`; `engines` → `>=20.12`; file env dedicati (Task 5) |

## 6. Domande aperte residue

- Parametri UAT (Task 5): il numero di squadre e giornate è **variabile** e
  dipende dall'esecuzione UAT; la guida (Task 6) riporta più esempi di timeline
  (più brevi, 2h; medie, ~4h30; più lunghe, ~6h30), ciascuno con i valori di
  `--teams`/`--rounds`/`--spacing-min` già compilati. Dimensionamento di default
  suggerito: 8 squadre (round-robin di 7 giornate; per stagioni più brevi usare
  `--rounds < teams-1`); `--spacing-min 45` per finestre di pick ~45 min (sopra i
  20 min minimi). Casella Gmail di test **confermata**: `survivorleague755@gmail.com`
  (memoria `env_mail_provider`).
- Strada 3.3 (fixtures reali 2026/27 su football-data.org): **verifica
  preliminare fattibile** scelta come scenario opzionale valutabile prima
  dell'UAT sintetico; se le fixtures sono disponibili restano l'opzione a
  fedeltà massima (zero finzioni) e richiedono `TEST_REFRESH_ALLOWED=true` su DB
  con dati reali. Altrimenti si parte col sintetico (strada 3.2).
- Rosa Serie B per `SYNTHETIC_TEAMS` (Task 1) e risorsa alias sintetica
  (Task 0.4): **verificata e fissata**. Lista di 8 nomi canonici di club cadetti
  (Serie B 2025/26) con alias editoriali, da usare per generatore e risorsa
  alias sintetica (coincidenza garantita dal test di Checkpoint B):

  | # | Nome canonico (Serie B) | Alias |
  |---|--------------------------|-------|
  | 1 | US Cremonese | cremonese, grigiorossi |
  | 2 | Brescia Calcio | brescia, rondinelle, biancazzurri |
  | 3 | SSC Bari | bari, galletti, biancorossi |
  | 4 | US Catanzaro | catanzaro, giallorossi calabresi, aquile |
  | 5 | SSC Palermo | palermo, rosanero, aquile siciliane |
  | 6 | Spezia Calcio | spezia, aquiligialle |
  | 7 | UC Sampdoria | sampdoria, blucerchiati, samp, doria |
  | 8 | Pisa Sporting Club | pisa, nerazzurri toscani |

  (Nomi in forma editoriale; il generatore usa i nomi canonici come
  `home_team`/`away_team`; la risorsa alias sinteticaifica gli alias come
  serie A. Se si vogliono più/meno squadre cambiare insieme generatore, risorsa
  alias e test di coincidenza.)

### Dipendenze esterne — RISOLTE (aggiornamento 2026-08-16T20:34Z, dettagli in §4)

Le dipendenze esterne erano state rinviate a §4: entrambe risultano **RISOLTE**
il 2026-08-16 con l'esecuzione del piano `tasks/plan-failover-llm-multimodello.md`
e la ri-validazione dal vivo (report `docs/uat/stress-test-report-2026-08-16.md`,
addendum incluso):
- **Bug `markSeen` (churn/ETIMEDOUT):** RISOLTO — fix di robustezza applicato
  (retry ×3 con connessione nuova; STORE `false` → errore esplicito); validato
  dal vivo 20/20 `seen` persistiti, 0 duplicati; 280 test verdi.
- **Lista failover LLM multi-modello:** RISOLTA e adottata in `.env`
  (`nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free`;
  `LLM_TIMEOUT_MS=15000`, `LLM_RETRIES=3`) — da riusare per `.env.uat` (Task 5).

## 7. Decisioni chiuse e stato del piano (peer review 2026-08-16)

Tutte le decisioni editoriali del piano sono **chiuse** dopo la peer review del
2026-08-16 (vedi `tasks/briefing-plan-uat-calendario-sintetico.md` per il
rationale completo). Stato:

- **D5 (punteggi pre-seedati):** confermato e **strutturale** per la cadenza
  compressa (vedi §3 worked example) — non solo "comodo".
- **D6 (seed su DB popolato):** confermato; rafforzato dalla guardia stato di
  gioco (Task 3) sul `--clear`.
- **D7 (nomi Serie B + risorsa separata + contesto lega nel prompt):** confermato.
- **D8 (finestre non sovrapposte):** confermato; specificato spacing tra
  giornate (matchday simultanea); log `error` pino (non `critical`).
- **D9 (`TEST_OFFSET_DAYS` unificato):** confermato; un solo delta per clock e
  receivedAt (elimina per costrutto la disiguaglianza offset).
- **D10 (`simulate:*` exempt + scan statica):** confermato.
- **Casella Gmail di test:** confermata `survivorleague755@gmail.com`.
- **Strada 3.3:** verifica preliminare fattibile, scenario opzionale (vedi §4).
- **Rosa Serie B:** fissata in §6 sopra (8 club cadetti).
- **Guida operativa (Task 6):** **rientrata** nello scope (correzione memoria).

**Conclusione:** il piano è **pronto per l'implementazione** dei Task 0-6. Non
rimangono decisioni editoriali aperte. Le dipendenze esterne di §4 (`markSeen`
churn, lista failover LLM) sono **RISOLTE** (aggiornamento 2026-08-16T20:34Z):
l'esecuzione UAT resta subordinata solo all'esecuzione di questo piano
(Checkpoint C) e alla pianificazione dedicata successiva.