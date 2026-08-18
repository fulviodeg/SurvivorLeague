# Briefing di peer review — Piano UAT test mode + calendario sintetico

> **Ruolo del documento.** Peer review indipendente (Principal Product & System
> Architect) di `tasks/plan-uat-calendario-sintetico.md`, svolta PRIMA
> dell'esecuzione del piano e dell'implementazione delle modifiche previste.
> Obiettivo: elencare incongruenze, problemi, rischi di regressione e modifiche
> necessarie emerse dal confronto del piano con le spec (PRD/HLD/LLD) e con la
> codebase attuale. Bozza di lavoro in lingua italiana (convenzione briefing del
> repo). **Non esegue il piano e non modifica alcun file di produzione.**

> **Fonti verificate.** Piano: `tasks/plan-uat-calendario-sintetico.md`. Spec:
> `docs/POC/POC_PRD.md` (v0.5.2), `docs/POC/POC_HLD.md` (v0.4.2),
> `docs/POC/POC_LLD.md` (v0.4.0). Codice: `src/config.ts`, `src/logger.ts`,
> `src/cli/commands/*`, `src/cli/email-wiring.ts`, `src/channel/*`,
> `src/data/{provider,db-provider,importer}.ts`, `src/game/{context,pick-processor,
> scheduler}.ts`, `src/db/schema.ts`, `package.json`, `.gitignore`.
> Note: i documenti citati dal committente come `docs/prd.md`/`hld.md`/`lld.md`
> non esistono nel repo; la documentazione autorevole è in `docs/POC/`.

---

## 0. Sintesi esecutiva

Il piano è **architetturalmente sano** e coerente con i principi vincolanti del
progetto (AGENTS.md §1.3 «separazione di responsabilità» e il pattern «la CLI
inietta»): il Game Engine resta invariato, le modifiche vivono nei comandi CLI /
nei seam di I/O / nella config, il calendario sintetico è caricato nella tabella
`match` (unica fonte dati, ADR-007) tramite la stessa pipeline di `data:import`
(`upsertMatches`). Le decisioni D0–D9 sono per lo più ben argomentate.

Sono emersi però **6 findings di priorità alta** che richiedono correzione/decisione
prima dell'esecuzione, perché incidono su correttezza, regressione o sicurezza:

1. **Conflitto con correzioni memorizzate** (§1.A): la memoria di progetto
   registra che la guida `docs/uat/guida-test-mode.md` è stata eliminata e che il
   Task 6 non deve più riscriverla; il piano attuale invece **ricalcola il Task 6
   sulla guida** e mantiene la sezione «Requisiti aggiuntivi (riscrittura
   completa)». Da riconciliare con il committente.
2. **Log level "CRITICAL" non esiste in pino** (§1.E): `pino` non espone il
   livello `critical` di default; `logger.critical(...)` è undefined → uso di
   `error`/`fatal` o configurazione di livelli custom.
3. **Semantica di `process.loadEnvFile` non verificata** (§1.A): sovrascrive o
   no le variabili già presenti in `process.env`? Questa risposta decide
   l'affidabilità degli override inline e la scelta dei file env dedicati
   (Task 0.1/5). Da documentare con la versione runtime.
4. **`--clear` su DB con stato di gioco** (§1.E): il `DELETE FROM match`
   distruggerebbe il calendario lasciando `pick`/`round_state`/`tournament_state`
   orfani. Serve guardia (es. rifiuto se `season_started=1` o pick presenti).
5. **`.gitignore` non copre `.env.uat`/`.env.uat-replay`** (§1.H): i file env di
   test conterranno credenziali Gmail App Password + chiave LLM. L'update di
   `.gitignore` **deve precedere** la creazione dei file reali.
6. **RF-31 nel flusso sintetico con cron** (§2.A): in modalità cron il round si
   chiude alla deadline (`min(deadline, kickoff)` = deadline, visto che
   `DEADLINE_ADVANCE_MIN > 0`) → un pick tardivo riceve `round_not_open`, non
   `after_kickoff`. Il path specifico di RF-31 si esercita solo in modalità
   commissioner con round lasciato aperto oltre il kickoff, o con deadline NULL
   (CL17). Il piano lo claima in modo troppo ampio.

Viene inoltre segnalato un **worked example dei parametri UAT** (§2) che
quantifica la finestra di pick effettiva per i round 2+ e la cadenza, e
dimostra perché le scelte D8 sono coerenti con il vincolo «finestre ≥ 20 min»
 presente in memoria, **a condizione di usare `DEADLINE_ADVANCE_MIN` ridotto e
 punteggi pre-seedati (D5)**.

---

## 1. Analisi per task

### Legenda
- **Incongruenza**: scostamento piano vs spec/code.
- **Regressione**: rischio di rompere comportamento attualmente verde/verificato.
- **Modifica necessaria**: correzione/aggiunta richiesta dal finding.
- **Nota**: osservazione operativa, non bloccante.

### 1.A — Task 0.1: Loader e config del test mode

**Stato attuale della codebase.** `getConfig()` (`src/config.ts:166-177`) è lazy
+ cached, carica `.env` via `process.loadEnvFile()` **senza argomento** e silenzia
solo `ENOENT` (`src/config.ts:169-173`). `parseConfig(env)` (`src/config.ts:136`)
è pura (prende un `Record<string,string|undefined>`), validata con uno schema
`zod` **piatto** (`configSchema`, `src/config.ts:38-117`). `@types/node` è
`^20.14.0`, `engines` dice `>=20`.

- **[Incongruenza — LOAD] `loadEnvFile` e precedenza ambientale.** Il piano
  (Task 0.1) introduce `loadEnvFile(process.env.ENV_FILE ?? '.env')` e demanda a
  un'indagine «il file sovrascrive i valori dell'ambiente o no?». La semantica di
  Node è decisiva: `process.loadEnvFile` **NON sovrascrive** le variabili già
  presenti in `process.env` (comportamento equivalente a `dotenv` con
  `override:false`). Conseguenze:
  - un override inline `TEST_CLOCK_OFFSET_DAYS=5 npm run cli -- ...` viene letto
    da `process.env` PRIMA di `loadEnvFile`; se anche il file imposta la stessa
    variabile, **vince l'inline** (il file non sovrascrive). Mixare file dedicato
    + override inline produce quindi ombreggiature non intuitive.
  - La raccomandazione del piano (Task 5) di usare un file `.env.uat-replay`
    dedicato ed **evitare** gli override inline è quindi CORRETTA e va mantenuta,
    ma deve essere giustificata con la semantica sopra, non lasciata come nota
    lasca.
  - **Modifica necessaria:** documentare in LLD §4.5/`.env.example` il comportamento
    di `loadEnvFile` (no-override) e la versione minima runtime. `engines` dice
    `>=20` ma `process.loadEnvFile` è stabile da Node 20.12 (dietra flag in 20.6);
    il codice già lo usa, quindi **portare `engines` a `>=20.12`** per coerenza.
- **[Incongruenza — ERRORE] `ENV_FILE` esplicito ma file inesistente.** Oggi
  `ENOENT` è sempre silenzioso (`config.ts:170-173`). Il piano vuole errore
  esplicito **solo** quando `ENV_FILE` è impostato ma il path non esiste, e
  silenzioso per il default `.env` assente. **Modifica necessaria:** differenziare
  le due code-path: `if (path === '.env' && code==='ENOENT') silent; else throw`
  con messaggio che nomina il path. Verificare che il path `--help` (comandi senza
  config) resti funzionante: `getConfig` resta lazy, quindi OK.
- **[Incongruenza — SCHEMA] «Parametri test-only validati SOLO con `TEST_MODE=true`;
  ignorati con `TEST_MODE=false`».** Lo schema `zod` è piatto e valido sempre; con
  `.default()` i parametri sono sempre parsed. «Ignorati quando `TEST_MODE=false`»
  va inteso come **gating a consumo** (i consumer `makeNow`/guardia refresh
  leggono `config.testMode` e non applicano l'offset), NON come esclusione dallo
  schema. **Modifica necessaria:** chiarire nel piano che l'ignoramento è a
  consumo (approccio più semplice e testabile) e decidere esplicitamente se un
  parametro test-only **malformato** con `TEST_MODE=false` deve dar errore
  (raccomandazione: no — lasciar parseare con default e gateare a consumo; in
  caso alternativo, schema condizionale via `superRefine`).
- **[Regressione]** Test di regressione: `ENV_FILE` assente → `loadEnvFile('.env')`
  (default) → identico a oggi. I test unitari di `parseConfig` non toccano il
  loader (è separato e con side-effect su `process.env`); servirà un test del
  loader con `process.env` controllato o con mocking del filesystem/`loadEnvFile`.

### 1.B — Task 0.2: Segnalazione test mode (email, CLI, log)

**Stato attuale.** Invio email: `EmailAdapter.sendMessage` (`src/channel/email-adapter/
index.ts:81`) → `sendMail(transport, {from,to,subject,text})` (`smtp-client.ts:36`).
Logger: `createLogger(level, stream?)` (`src/logger.ts:26`) — `pino({level})`,
**nessun binding di default**. Il logger è costruito dai comandi e dal wiring
(`email-wiring.ts:46`); il commento (`logger.ts:8-10`) precisa che **non dipende
da config** per restare usabile anche con config invalida (es. per loggare il
`ConfigError`).

- **[Incongruenza — seam banner]** Il piano vuole il banner «al livello di invio
  (punto unico), mai nei template LLM». Il seam corretto è `sendMail`
  (`smtp-client.ts`) oppure `EmailAdapter.sendMessage` (`index.ts:81`). Notare che
  questo seam copre **tutti** gli invii: (ai) notifiche reali di `round:*`/
  `tournament:register:*` via `sendReply` (`email-processor.ts:114-125`) e
  Round Manager; (b) il helper di debug `channel:email:send` (`channel.ts:90`).
  Bannerare anche il helper di debug è accettabile e coerente. **Le email
  RICEVUTE non sono modificabili** (arrivano dai client): la scelta è corretta.
- **[Regressione — test esatti sul body]** I test del canale/wiring catturano gli
  argomenti di `sendMail` e talora asseriscono **uguaglianza esatta** con il body
  generato. Anteporre il banner a `text` romperebbe tali asserzioni. **Mitigazione
  già nel design:** il banner è gated su `config.testMode`; i test esistenti
  girano con `TEST_MODE=false` (`loadEnvFile('.env')` / nessun env di test) →
  banner disattivato → nessuna regressione. **Modifica necessaria:** verificare
  (grep) che NESSUN test esistente imposti `TEST_MODE=true`; aggiungere test
  nuovi CON `testMode=true` che asseriscano il banner presente e `testMode=false`
  che asseriscano banner assente (regressione esplicita).
- **[Incongruenza — logger binding]** Aggiungere `testMode: true` a **ogni riga**
  pino richiede `mixin` (pino aggiunge contesto statico/messo per evento via
  `mixin` o `bindings`). `createLogger` oggi prende solo `(level, stream?)`.
  **Modifica necessaria:** estendere la signature (es. `createLogger(level,
  {stream?, testMode?})`) e iniettare il binding solo quando `testMode` è
  disponibile. Cruciale: il path di **errore di config** (`getConfig` lancia
  `ConfigError`) usa un logger **senza binding** (config non validata →
  `testMode` sconosciuto): mantenere quel path libero, come da commento
  `logger.ts:8-10`. Non rompere il logger di emergenza.

### 1.C — Task 0.3: Offset clock e trasformazione receivedAt (opzionali)

**Stato attuale.** `now: new Date()` compare in: `scheduler.ts:62` e `:145`,
`simulate.ts:47`, `channel.ts:129`, `tournament.ts:53`, `round.ts:48`,
`pick.ts:34`, `winner.ts:42`. `message.receivedAt` (internaldate, ADR-001) è
passato a `registerPick`/`autoRegisterFromPick` in `email-processor.ts:243` e
`:302`. RF-31 (`after_kickoff`) è valutato in `checkAcceptance`
  (`pick-processor.ts:150-163`) **prima** del check di deadline.

- **[Incongruenza — scansione statica]** Il test di guardia «nessun `new Date()`
  diretto in `src/cli/commands/*`» (acc-criterion Task 0.3) è **troppo ampio** e
  produrrebbe falsi positivi legittimi: `llm.ts:139` fa `new Date(argv.deadline)`
  (parsing di una scadenza fornita dall'utente, NON un clock). **Modifica
  necessaria:** scansionare solo le costruzioni `now: new Date()` (clock del
  contesto), non ogni `new Date`. Tipicamente: `rg -n 'now: new Date\(\)'
  src/cli/commands`.
- **[Incongruenza — simulate e determinismo]** `simulate:full` è uno strumento di
  sviluppo (CS3/RNF1) che **deriva il proprio clock dai dati** (R2, commento
  `simulate.ts:38-41`) e NON è uno strumento UAT. Iniettare `makeNow` (offset
  test-only) in `simulate.ts` sposterebbe il `now` iniziale senza beneficio e
  potrebbe alterare la determinibilità (RNF1) se la simulazione usa `ctx.now` come
  seed. **Modifica necessaria:** esentare `simulate.ts` da `makeNow` (mantenere
  `now: new Date()` reale) e documentare nel piano perché: simulate non è UAT e
  derivia il clock dai dati. Aggiornare di conseguenza la lista «nessun `new
  Date()` diretto» (simulate è un'eccezione legittima).
- **[Incongruenza — trasformazione receivedAt, punto unico]** Il piano dichiara
  la trasformazione applicata in **un solo punto** dentro/nel seam del comando,
  prima di `registerPick`/`autoRegisterFromPick`, MAI anche nel comando (doppio
  shift). Oggi `message.receivedAt` è letto in **due** call site
  (`email-processor.ts:243` noto, `:302` auto-iscrizione) — sono percorsi
  mutualmente esclusivi (mittente noto vs ignoto), quindi non c'è doppio-applicazione
  sullo stesso messaggio, ma sono due punti. La vera garanzia contro il doppio
  shift è **non** applicarlo nel comando `channel.ts` (che costruisce il
  `message` via fetch) bensì dentro `processEmailBatch`. **Modifica necessaria:**
  applicare lo shift tramite un helper `shiftReceivedAt(receivedAt, config)` letto
  nei due call site (oppure mappare `messages` una sola volta all'ingresso di
  `processEmailBatch`), mantenendo `channel:email:fetch` RAW (stampa il
  `receivedAt` vero — `channel.ts:56`). Aggiungere test che lo shift = esattamente
  `TEST_RECEIVEDAT_OFFSET_DAYS` giorni e applicato 1×.
- **[Incongruenza — offset disallineati, alto]** Il piano dice solo di
  «documentare» che i due offset devono essere uguali. Con offset diversi il
  timeline si spezza: `now_finto` (clock shiftato) e `receivedAt_finto` (shift
  diverso)
  non appartengono più alla stessa linea temporale → RF-31 confronta un
  `receivedAt` shiftato a X con un kickoff (2025) valutato col clock shiftato a
  Y → incoerente. **Modifica necessaria:** rendere la coerenza una **validazione
  hard**: quando `TEST_MODE=true` e almeno uno tra `TEST_CLOCK_OFFSET_DAYS`/
  `TEST_RECEIVEDAT_OFFSET_DAYS` è >0, **devono essere uguali** (errore di
  config altrimenti), con test. Riduce il rischio «offset disallineati» della
  matrice da «mitigato dalla documentazione» a «impedito tecnicamente».

### 1.D — Task 0.4: Risorsa alias sintetica (test-only)

**Stato attuale.** `loadTeamAliases()` (`src/llm/parser.ts:63`) senza argomenti;
chiamata da `channel.ts:120` e `llm.ts:55`. Il prompt di sistema è statico
(`buildParseSystemPrompt`, `parser.ts:73-97`) e dichiara «torneo privato di
pronostici sulla **Serie A**» (`parser.ts:78`). La risorsa di produzione
`team-aliases.md` ha 20 nomi canonici Serie A 2025/26.

- **[Incongruenza — prompt statico]** In test mode la lista canonica è Serie B,
  ma il prompt di sistema continua a dire «Serie A». L'LLM potrebbe confondersi
  e ridurre la robustezza di parsing (CS7). **Nota/modifica da valutare:**
  iniettare il contesto lega nel prompt in test mode (es. «torneo privato basato
  su un campionato sintetico di Serie B») o almeno chiarire nella risorsa alias
  sintetica che i nomi NON sono di Serie A. Impatto su accuratezza LLM reale in
  UAT: medio. Decidere col committente.
- **[Regressione — coerenza risorsa]** Il test di coincidenza `SYNTHETIC_TEAMS`
  (Task 1) == lista canonica della risorsa alias sintetica è la garanzia; senza di
  esso la catena `seed → getTeams() → exact-match post-parse` si rompe in silenzio.
  **Modifica necessaria:** il test (Checkpoint B) è una dipendenza bloccante, non
  opzionale.
- **[Regressione — produzione invariata]** `team-aliases.md` NON deve essere
  toccato; senza `testMode` il parser riceve la risorsa di produzione. Aggiungere
  test di regressione esplicito. OK nel piano.

### 1.E — Task 1/2/3: Generatore, comando seed, guardia anti-sovrascrittura

**Stato attuale.** Tabella `match` PK `(round, home_team, away_team)`
(`schema.ts:59-68`). `upsertMatches` (`importer.ts:80`) è transazionale e **non
effettua mai DELETE** (`importer.ts:11`). `getTeams` deriva da `UNION` di
`home_team`/`away_team` (`db-provider.ts:94-105`) — **nessuna tabella `team`
separata**: il seed delle sole `match` è sufficiente. `getTotalRounds` = `MAX(round)`
(`db-provider.ts:108-113`).

- **[Incongruenza — round vs match spacing (cruciale per D8)]** Il Task 1 dice
  «Date future, distanziate di `spacingMin`» in modo **ambiguo**: si distanziano i
  singoli match o le round (matchday)? La rilevazione sovrapposizione (Task 2, D8)
  calcola `spaziatura < MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN` assumendo che
  **round consecutive distino 1 unità di `--spacing-min`**. Se invece il
  generatore distanzia ogni singolo match, una round di 8 squadre (4 partite) spans
  3×`spacingMin` e la formula di D8 è **sbagliata**. **Modifica necessaria
  (Task 1):** il generatore assegna **lo stesso kickoff a tutte le partite di una
  round** (semantica «matchday»: coerente col calcio reale e con
  `getFirstMatchDateTime` = `MIN(match_date)`); `--spacing-min` distanzia solo le
  round tra loro. Documentarlo e far dipendere il test di D8 dallo spacing
  round-to-round effettivo.
- **[Incongruenza — round > (squadre-1)]** Con `--teams 8` un round-robin
  completo ha 7 round; il default `--rounds 10` richiede round 8-10 che
  **ripetono accoppiamenti** di round precedenti (PK diversa per `round`, quindi
  ammissibile) ma ogni round deve comunque far giocare ogni squadra **esattamente
  una volta** (acc-criterion). **Modifica necessaria:** specificare il comportamento
  di wrap (es. circle method con rotazione che ricomincia) e un test che, con
  `teams=8, rounds=10`, non produced auto-match né duplicati intra-round. In
  alternativa abbassare il default `--rounds` a ≤ `teams-1` (es. 8→7) e
  documentare che valori maggiori ripetono accoppiamenti.
- **[Incongruenza — `--clear` distruttivo su stato di gioco (alto)]** `--clear` è
  `DELETE FROM match` (lo importer attuale **non ha DELETE**, `importer.ts:11`, e
  va aggiunto in Task 2). Su un DB con torneo in corso (`season_started=1`,
  `round_state`/`pick` presenti) il `DELETE` distruggerebbe il calendario
  **lasciando pick e round_state orfani** → stato inconsistente. **Modifica
  necessaria:** prima di `--clear`, rifiutare se `season_started=1` o esistono
  righe in `pick`/`round_state` (a meno di un ulteriore flag esplicito di reset
  completo). Documentare che `--clear` agisce solo sulla tabella `match`.
- **[Incongruenza — `--force` senza `--clear` su DB con dati reali]** Le righe
  reali 2025 residue restano → `getTeams()` ritorna squadre miste (Serie A + B) e
  `getTotalRounds() = MAX(round)` può essere 38(2025) anziché il max sintetico →
  confine girone derivato da 38, finestra `[start_round..N]` estesa. Il WARN del
  piano copre l'aspetto operativo ma non l'inconsistenza semantica con la risorsa
  alias sintetica (che copre solo Serie B). **Modifica necessaria:** nel WARN
  esplicitare che `getTeams()`/`getTotalRounds()` sono incoerenti con la risorsa
  sintetica; raccomandare `--clear` come via standard e `--force`-senza-`--clear`
  comeescape esperto.
- **[Incongruenza/bug — log level «CRITICAL» non esiste in pino (alto, §0.2)]**
  Il piano usa sistematicamente «log di livello **CRITICAL**». `pino` i livelli
  standard sono `fatal, error, warn, info, debug, trace`: **`critical` NON
  ESISTE**. `logger.critical(...)` è `undefined` → `TypeError` a runtime o
  silenzio. **Modifica necessaria:** usare `error` o `fatal` (p.es. SCHEDULER usa
  `warn` per le safety, `error` per `refresh_failed`: `scheduler.ts:80`),
  oppure configurare livelli custom in `createLogger`. Uniformare tutto il piano.
  Messaggi comunque in inglese (vincolo `log_messages_english`).
- **[Regressione — ENG_IDEMPOTENZA]** L'upsert è idempotente sulla PK: re-run non
  duplica. OK. Aggiungere integration test `seed → re-seed → count invariato`.

### 1.F — Task 4: Refresh/import bloccati in test mode

**Stato attuale.** `runImport` (`data.ts:63`) è condiviso da `data:import` e
`data:refresh`. In `scheduler:tick` il refresh è una closure passata come
`deps.refresh` (`scheduler.ts:104-112`); `schedulerTick` lo esegue solo
`if deps.refresh !== undefined` (`scheduler.ts:255`). Il modulo
`src/game/scheduler.ts` NON va modificato (il refresh è iniettato dalla CLI).

- **[Coerenza — OK]** Implementare la guardia **nei comandi** (`data.ts` per
  import/refresh; `scheduler.ts` handler per omettere `deps.refresh`). Con
  `testMode && !TEST_REFRESH_ALLOWED`: non costruire/passare il refresh, loggare
  lo skip, proseguire con le azioni dovute (sintetico con cron reale → le azioni di
  round vengono comunque eseguite). `refresh_failed` diventa irraggiungibile in
  test mode: coerente. Con `TEST_MODE=false`: import/refresh reali invariati.
- **[Rischio — `TEST_REFRESH_ALLOWED=true` su DB sintetico (alto, residual)]** La
  guardia è solo WARN; **nessun blocco tecnico** impedisce `TEST_REFRESH_ALLOWED=true`
  su un DB sintetico → `data:import` scaricherebbe la stagione 2025 reale nel DB
  sintetico (mixed), distruggendo la coerenza in modo **silenzioso tranne il WARN**.
  **Modifica necessaria/raccomandazione:** il WARN di consenso deve stampare il
  `DB_PATH` (così l'operatore vede su quale DB sta operando) ed essere emesso a
  ogni operazione (tick incluso, come da piano). Valutare con il committente una
  guardia più forte (es. rifiuto se il DB contiene marker sintetici); in assenza,
  il rischio resta affidato alla disciplina operativa (memoria
  `no_refresh_on_shifted_db`).
- **[Coerenza — `SCHEDULER_REFRESH_ENABLED` NON implementato]** Il piano
  correttamente **non** implementa `SCHEDULER_REFRESH_ENABLED` (deriva da
  `TEST_MODE`). Coerente con memoria `scheduler_refresh_enabled_semantics`.
  Aggiornare LLD §4 per non lasciare traccia di quel parametro abolito.

### 1.G — Task 5: Ambiente `.env.uat`

**Stato attuale.** `.gitignore` copre solo `.env` e `.env.bak` (righe 4-5):
`.env.uat`/`.env.uat-replay` **NON sono ignorati**.

- **[Sicurezza — alto, §0.5]** I file `.env.uat` reali conterranno credenziali
  Gmail App Password (`IMAP_PASS`/`SMTP_PASS`) e `LLM_API_KEY`. **Modifica
  necessaria (ordinamento):** aggiornare `.gitignore` (aggiungere `.env.uat`,
  `.env.uat-replay`) **PRIMA** di creare i file reali; versionare solo
  `.env.uat.example`/`.env.uat-replay.example` (senza segreti). Aggiungere un test
  che i `.example` non contengano segreti. (Memoria `env_mail_provider`: provider
  Gmail ok.)
- **[Coerenza — LLM_MODEL per UAT]** Il piano dice «LLM reali» senza specificare.
  Memoria `env_llm_model` (stress test 2026-08-15, 16/16 email, zero errori):
  modello consigliato `nvidia/nemotron-3-super-120b-a12b:free`; `gemma-*-31b:*`
  inutilizzabile per rate-limit 429. **Modifica necessaria:** il `LLM_MODEL` di
  `.env.uat.example`/`.env.uat-replay.example` deve essere la **lista failover
  multi-modello** prodotta dal piano LLM dedicato
  (`task:plan-failover-llm-multimodello.md`), non un singolo modello placeholder.
  Questo è un **punto di dipendenza** tra piani (memoria
  `uat_depends_on_llm_plan`).
- **[Parametri — finetra umana, §2]** `DEADLINE_ADVANCE_MIN=30`, `MATCH_DURATION_MIN=5`,
  `TC_CLOSE_SKEW_MIN=10`, `--spacing-min 45` (dimensionamento raccomandato da
  memoria) o default 90. Verificare con il worked example (§2) che la finestra di
  pick effettiva per i round 2+ sia **≥20 min** (vincolo
  `uat_human_time_constraint`).

### 1.H — Task 6: Guida operativa UAT

- **[Incongruenza con memoria — alto, §0.1]** La memoria di progetto contiene
  due correzioni esplicite:
  - `uat_guide_file` :: «La bozza della guida `docs/uat/guida-test-mode.md` è
    stata eliminata su richiesta dell'utente; non è più una risorsa del progetto.»
  - `uat_guide_rewrite_requirements` :: «Il Task 6 del piano UAT non deve più
    riscrivere la guida `docs/uat/guida-test-mode.md`; i riferimenti alla guida
    nel Task 6 sono stati rimossi.»

  Il piano attuale invece (a) definisce il Task 6 come **produzione/ri-scrittura**
  di `docs/uat/guida-test-mode.md` (righe 452-549, 596) e (b) mantiene la sezione
  «Requisiti aggiuntivi (riscrittura completa)» (7 punti, righe 478-531) che la
  memoria diceva di **rimuovere**. **Azione necessaria:** riconciliare col
  committente — la guida è **rientrata** nello scope (e va cancellata la
  correzione), oppure il Task 6 va nuovamente **depennato** (con conseguente
  ridefinizione di cosa produce la fase di documentazione: es. solo commenti nel
  codice + LLD §4, senza guida standalone). Fino a chiarimento, il Task 6 è in
  stato **indefinito** e i suoi acceptance criteria non sono valutabili.
- **[Nota]** A prescindere dall'esito sopra, gli acc-criterion «guida
  comprensibile da non-developer», «liste di comandi copiabili», «scope del test
  mode (dimost rabile/non)» sono buoni requisiti; se la guida resta, vanno
  conservati come specifica. Il vincolo «log in inglese» (`log_messages_english`)
  non si applica al testo della guida (è in italiano), mentre i **messaggi di log/
  banner** citati nella guida devono restare in inglese.

---

## 2. Worked example — parametri UAT, cadenza e copertura RF-31

Ipotesi (dimensionamento raccomandato da memoria + default piano):
`TEST_MODE=true`, `SCHEDULER_ENABLED=true`, clock reale e receivedAt reali
(offset 0, calendario sintetico strada 3.2), `DEADLINE_ADVANCE_MIN=30`,
`MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`, `--teams 8`, `--rounds 6`,
`--spacing-min 45`, `--first-kickoff-offset-min 120`, **punteggi pre-seedati (D5)**.

**Cadenza di una round (cron, score pre-seedato):**
1. `round:open` alla "apertura": registra `deadline = kickoff_N − 30 min` (RF-14).
2. Lo scheduler chiude al superamento della deadline (`now > deadline`,
   `scheduler.ts:185-188` → `round_close`). Accettazione = `min(deadline, kickoff)`
   = deadline (perché `DEADLINE_ADVANCE_MIN>0`). I pick sono accettati fino alla
   deadline.
3. `round:score` subito (score pre-seedato → nessun `pending` → `scored`).
4. La round N+1 si apre quando la N è `scored` (`scheduler.ts:181-184`):
   `prevScored`. Dato che N scorea subito dopo la chiusura (deadline), la N+1 si
   apre **alla deadline della N**.

**Finestra di pick effettiva (round 2+):**
`kickoff_{N+1} = kickoff_N + spacing`; `deadline_{N+1} = kickoff_{N+1} − 30`.
Apertura round N+1 ≈ `deadline_N = kickoff_N − 30`. Quindi:

```
finestra_pick(N+1) ≈ deadline_{N+1} − apertura_{N+1}
                   = (kickoff_N + spacing − 30) − (kickoff_N − 30)
                   = spacing
```

→ con `--spacing-min 45` → **~45 min di finestra di pick** per round 2+; con il
default `90` → ~90 min. **Entrambi ≥20 min**, quindi coerenti col vincolo
`uat_human_time_constraint`. **Condizione necessaria:** i punteggi devono essere
pre-seedati (D5); se immessi per round, `round:score` non completerebbe a
deadline e la round successiva non si aprirebbe fin dopo il `tcClose`, allungando
le finestre in modo imprevedibile. La D5 è quindi **strutturale** per la cadenza
compressa, non solo «comoda».

**Copratura RF-31 (`after_kickoff`) nel flusso sintetico:**
`checkAcceptance` controlla prima `receivedAt > kickoff` → `after_kickoff`
(pick-processor.ts:159), poi `receivedAt > deadline` → `after_acceptance`. Con
`deadline = kickoff − 30`, durante tutto il periodo `open` si ha `receivedAt ≤
deadline < kickoff` → RF-31 **non morde mai** (è ridondante, come da PRD: «con la
deadline nominale è ridondante»). In **modalità cron**, inoltre, subito dopo la
deadline lo scheduler **chiude** la round → un pick tardivo riceve `round_not_open`,
non `after_kickoff`. **Conseguenza:** il path specifico di RF-31 NON è esercitato
dal flusso sintetico standard. Per dimostrare `after_kickoff` in UAT serve
**una** di queste condizioni:
- modalità **commissioner** manuale con round lasciato **aperto oltre il kickoff**
  (non chiudere alla deadline), poi pick ricevuto dopo il kickoff reale;
- oppure **deadline NULL** (CL17): il round resta `open` oltre il kickoff e la
  safety close avviene al `tcClose` (`kickoff + MATCH_DURATION_MIN +
  TC_CLOSE_SKEW_MIN`); un pick in `[kickoff, tcClose]` riceve `after_kickoff`.

**Modifica necessaria/correzione al piano (§4 acc-criterion «Pick in ritardo dopo
il kickoff rifiutato con motivo — guard RF-31»):** riformulare come «rimane
dimostrabile in modalità commissioner lasciando la round aperta oltre il kickoff,
oppure con deadline NULL (CL17); nel flusso cron standard un pick tardivo
riceve `round_not_open` (la round è già chiusa alla deadline)». Evita di
promettere una copertura che la cadenza standard non produce.

**UAT esecuzione — dipendenza markSeen (pre-UAT, non in questo piano):** il digest
dell'ultima sessione (stress test email) mostra `markSeen` fallito su 2/20
(UID 130/131, `ETIMEDOUT` su IMAP, churn di connessioni per-messaggio). In UAT
con email reali, un `markSeen` fallito lascia il messaggio non letto → viene
riprocessato al tick successivo → **risposte duplicate**. Questo è il bug
`markSeen` richiamato dalla memoria `uat_depends_on_llm_plan`: va risolto **prima
dell'esecuzione UAT** (non dei Task 0-6). Segnalare come dipendenza del piano
dedicato di esecuzione.

---

## 3. Matrice dei rischi

| # | Rischio | Probabilità | Impatto | Dove | Mitigazione / stato |
|---|---------|-------------|---------|------|----------------------|
| R0 | Conflitto Task 6 con correzioni memorizzate | Alta | Alto | 1.H | Riconciliare col committente; blocca valutabilità del Task 6 |
| R1 | Livello «CRITICAL» inesistente in pino | Certa | Alto (runtime) | 1.E, §0.2 | Usare `error`/`fatal` o livelli custom; uniformare il piano |
| R2 | `--clear` su DB con stato di gioco (orfanizzazione pick/round) | Media | Alto | 1.E | Rifiutare se `season_started=1` o righe pick/round_state |
| R3 | `.env.uat` non gitignored → leak credenziali | Certa (se omesso) | Critico | 1.G, §0.5 | Aggiornare `.gitignore` PRIMA della creazione; test sui `.example` |
| R4 | RF-31 non coperto dal flusso cron sintetico | Alta (claim errato) | Medio | §2 | Riformulare acc-criterion; usare commissioner/CL17 per `after_kickoff` |
| R5 | Offset disallineati (clock ≠ receivedAt) | Bassa | Alto | 1.C | Validazione hard: errore se ≠ quando >0 |
| R6 | `TEST_REFRESH_ALLOWED=true` su DB sintetico | Bassa (misconfig) | Alto | 1.F | WARN con `DB_PATH` ad ogni op; valutare guardia più forte |
| R7 | Banner email rompe test esatti sul body | Media | Medio | 1.B | Gating `testMode=false` nei test; grep che nessun test imposta `TEST_MODE=true` |
| R8 | Prompt «Serie A» con squadre Serie B | Media | Medio | 1.D | Iniettare contesto lega in test mode; chiarire nella risorsa sintetica |
| R9 | Generatore spacing match-vs-round ambiguo (D8 sbagliata) | Alta | Medio | 1.E | Same kickoff per matchday; spacing round-to-round; test D8 |
| R10 | `--rounds > teams-1` (accoppiamenti ripetuti) | Alta (default 10>7) | Basso | 1.E | Documentare wrap o abbassare default; test anti-auto-match |
| R11 | Scansione statica `new Date()` falsi positivi (`llm.ts:139`, `simulate.ts`) | Certa | Basso | 1.C | Scansionare solo `now: new Date()`; exempt simulate |
| R12 | `simulate.ts` con `makeNow` altera determinismo RNF1 | Media | Medio | 1.C | Exempt simulate da `makeNow` |
| R13 | `loadEnvFile` no-override non documentato | Alta | Medio | 1.A | Documentare semantica; `engines` → `>=20.12` |
| R14 | marcaSeen non affidabile → risposte duplicate in UAT | Alta | Alto | §2 | Dipendenza esterna (piano LLM); risolvere pre-esecuzione UAT |
| R15 | `LLM_MODEL` di `.env.uat` non allineato al failover testato | Media | Medio | 1.G | Usare la lista failover del piano LLM (memoria `env_llm_model`) |

---

## 4. Decisioni residue da confermare

- **D5 (punteggi pre-seedati):** confermata e **strutturale** per la cadenza
  compressa (vedi §2) — non solo «comoda». Mantenere.
- **D6 (seed su DB popolato):** rafforzare l'acc-criterion di `--clear` con la
  guardia su stato di gioco (R2).
- **D7 (nomi Serie B + risorsa separata):** confermata; aggiungere la
  considerazione del prompt statico «Serie A» (R8).
- **D8 (finestre non sovrapposte):** confermata; **specificare** che lo spacing è
  round-to-round con matchday simultaneo (R9); log level `error`/`fatal` (R1).
- **D9 (nomi parametri):** confermati; aggiungere validazione hard di uguaglianza
  offset (R5).
- **Nuova decisione proposta (D10):** exempt `simulate:*` da `makeNow` (R12) e
  scoping della scansione statica a `now: new Date()` (R11).

---

## 5. Raccomandazioni pre-esecuzione (checklist non invasiva)

1. Confermare con il committente lo stato del **Task 6** (rientro o depennamento
   della guida) — R0.
2. Sostituire ogni occorrenza di «log CRITICAL» con `error`/`fatal` pino — R1.
3. Aggiornare `.gitignore` (`.env.uat`, `.env.uat-replay`) **prima** di creare i
   file reali — R3.
4. Adeguare `engines` a `>=20.12` e documentare la semantica no-override di
   `loadEnvFile` in LLD §4.5/`.env.example` — R13.
5. Specificare nel Task 1: stesso kickoff per matchday, spacing round-to-round,
  test di wrap per `--rounds > teams-1` — R9/R10.
6. Aggiungere guardia `--clear` su `season_started`/pick/round_state — R2.
7. Aggiungere validazione hard di uguaglianza offset (`TEST_CLOCK_OFFSET_DAYS` ==
   `TEST_RECEIVEDAT_OFFSET_DAYS` quando >0) — R5.
8. Riformulare l'acc-criterion RF-31 del §4 (cron vs commissioner) — R4.
9. Allineare `LLM_MODEL` di `.env.uat*.example` alla lista failover del piano LLM
   dedicato — R15.
10. Esentare `simulate:*` da `makeNow` e scoping della scansione statica — R11/R12.

---

## 6. Note di metodo

- Le modifiche proposte **non intaccano il Game Engine** (`src/game/*`): tutte
  risiedono in `src/config.ts`, `src/logger.ts`, `src/cli/commands/*`,
  `src/cli/email-wiring.ts`, `src/channel/email-adapter/*`, `src/llm/parser.ts`+
  nuova risorsa, `src/data/synthetic-season.ts` (nuovo) e `src/data/importer.ts`
  (solo per l'aggiunta del `DELETE` in `--clear`, da mantenere ben isolata e
  commentata per non violare il contratto «nessuna DELETE» dell'importer base).
- Il principio «la CLI inietta» è rispettato: `makeNow(config)` e la guardia
  refresh vivono nei comandi, i moduli restano puri. `importMatches` resta pura
  (la guardia è nei comandi che la chiamano).
- Nessuna considerazione di sicurezza oltre R3/R6: i nuovi parametri test-only
  non espongono superficie aggiuntiva se `TEST_MODE` è striict gated a consumo.