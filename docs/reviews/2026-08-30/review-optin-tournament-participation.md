# Revisione indipendente — Feature PARTECIPAZIONE OPT-IN (registration ≠ join)

- **Oggetto:** working tree NON committato del branch `feat/win-only-mode` = feature partecipazione opt-in (piano `.kilo/plans/1788106316564-optin-tournament-participation.md`, decisioni D1–D15, task T1–T9).
- **Contesto:** nel branch sono GIÀ committati `win_only` (ADR-016, `52c8cfc`), AUTO-PICK ON MISSING (ADR-017, `fefda56`) e JOLLY (ADR-018, `503e320`). L'ADR della feature è **ADR-019** (emenda ADR-009 decisioni 6/7 e RF-P5).
- **Revisore:** revisore indipendente (sola lettura; unica scrittura = questo report).
- **Data:** 2026-08-30.
- **Verifiche eseguite:** `git status`/`git diff`/`git log`/`git show` (sola lettura); lettura integrale di piano, ADR-019, tutti i sorgenti e i test modificati; `npm test` (742/742 verdi, 50 file), `npm run typecheck` (pulito), `npx eslint src tests` (pulito). Nota: `npm run lint` (che linta l'intera cartella, inclusi file gitignored) esce con 3 errori in `.tmp/imap-*.mjs` — file di scratch gitignored estranei alla feature (vedi LOW-3).

---

## 1. Verdetto

**PASS con raccomandazioni.**

L'implementazione è completa (T1–T9 tutte eseguite, D1–D15 tutte rispettate, Fase D di documentazione completata), architettonicamente coerente con AGENTS.md §1.3 (la decisione "chi partecipa" vive SOLO nel Game Engine: `registration.ts`/`tournament.ts`/`round-manager.ts`; parser/classificatore/email emettono SOLO dati; i due flag sono DATI di piattaforma, non logica), preserva il determinismo RNF1 e — punto critico dell'incarico — **risolve la collisione architetturale auto-join/auto-pick** senza regressioni su win_only (ADR-016), AUTO-PICK (ADR-017) e JOLLY (ADR-018). Nessun finding bloccante o high. 2 finding medium (commenti/documentazione stale sul concetto rimosso e comportamento di `platform:register` in ri-registrazione), 3 finding low, 1 osservazione. Suite 742 test verdi, typecheck pulito, lint pulito sui sorgenti/tests.

---

## 2. Completezza del piano (T1–T9) e decisioni (D1–D15)

Tutti i task sono implementati e verificati da test reali su DB in-memory:

| Task | Stato | Evidenza |
|---|---|---|
| T1 Schema piattaforma + Registry | ✅ | `src/db/platform-schema.ts:41-42` (2 colonne DDL `INTEGER NOT NULL DEFAULT 1`) e `:61-68` (ALTER guardato da `PRAGMA table_info`); `src/platform/registry.ts` (`PlatformAccount` con 2 flag `:51-65`, `ACCOUNT_COLUMNS` `:138`, `register` scrive `1,1` `:177`, `activeAccounts()` `:284-291` ordinato per `register_id`, `setPreferences()` `:302-322`); test `registry.test.ts` (6 nuovi) |
| T2 CLI piattaforma | ✅ | `src/cli/commands/platform.ts` (`platform:register --auto-join --receive-notifications` `:99-126`, `platform:preferences` `:235-280`, `platform:list` con flag `:207-214`) |
| T3 Auto-join a start + filtro `tournament_open` + join | ✅ | `src/game/registration.ts` (`createProfileForAccount` `:67-97`, `autoJoinProfilesAtStart` `:111-126`, `declareParticipation` `:149-199`); `src/game/tournament.ts` (`startTournament` auto-join bulk `:373-379`, broadcast filtrato `:384-409`, `autoJoined` `:84`) |
| T4 Intento `join` | ✅ | `src/llm/intent-classifier.ts` (`MessageIntent` += `'join'` `:37`, schema enum `:59`, prompt dedicato con "partecipo" spostato sotto `join` `:123-133`); `src/llm/deterministic-parser.ts` (formula `partecipo` → `join` `:208-213`, ordine disiscrizione→iscrizione→partecipo→pick) |
| T5 Wiring `channel:email:process` | ✅ | `src/channel/email-processor.ts` (ramo `join` `:380-449`; pick da attivo senza profilo → `tournament_join_rejected` `not_in_tournament` `:486-527`; `ProcessedAction` += `join_confirmed`/`join_rejected`/`already_joined` `:103-105`; chiarimento 4 opzioni `:604`) |
| T6 `round:open` senza eccezione TT1 | ✅ | `src/game/round-manager.ts` (blocco `registeredNotified` rimosso `:418-452`, campo tolto da `RoundOpenResult` `:192`); `src/cli/commands/round.ts:116-118` |
| T7 Simulazione | ✅ | `src/game/simulation.ts` (registrazione account PRIMA di `startTournament` `:323-333`; `simulateRound` invoca `autoJoinProfilesAtStart` `:394-398`; ramo TT1 speciale rimosso, unico loop sui profili `:231-262`) |
| T8 Email: 3 nuovi tipi + CTA | ✅ | `src/llm/generator.ts` (`EMAIL_TYPES` `:61-63`, `SUBJECT_LABELS` `:256-258`); `src/llm/templates.ts` (template + narrative deterministiche + `clarification` a 4 opzioni); `src/llm/email-renderer.ts` (`keyMessage` `:195-200`, `joinRejectedReasonText` `:141-149`, `tournament_join_confirmed` in `PICK_EMAIL_TYPES` `:211-214`, CTA `tournament_open` `:424-428`) |
| T9 Test | ✅ | `registration.test.ts` (riscritto: createProfileForAccount/autoJoinProfilesAtStart/declareParticipation, rimossi test `autoJoinFromPick`), `registry.test.ts`, `tournament.test.ts` (auto-join + filtro + CTA + `autoJoined`), `round-notifications.test.ts`, `tournament-closure.test.ts`, `deterministic-parser.test.ts`/`intent-classifier.test.ts`/`generator.test.ts`/`email-renderer.test.ts`, `email-process.test.ts` (ramo join + anti-spam), `round-flow.test.ts` |

**Decisioni D1–D15:** D1 (opt-in esplicito, auto-join al primo pick rimosso) ✅ · D2 (due flag default ON) ✅ · D3 (flag nel DB piattaforma, canale-agnostici) ✅ · D4 (flag SOLO via CLI, nessuna email) ✅ · D5 (snapshot a `tournament:start`) ✅ · D6 (auto-join bulk + dichiarazione, asimmetria) ✅ · D7 (blindatura post-TT1, override solo `--reason`) ✅ · D8 (idempotenza `already_joined`) ✅ · D9 (matrice notifiche) ✅ · D10 (override late CLI, `--reason` obbligatorio) ✅ · D11 (late registrant non auto-joinato) ✅ · D12 (CLI join senza email) ✅ · D13 (terminologia registration/join; `partecipo` spostato) ✅ · D14 (CTA `tournament_open` "rispondi con PARTECIPO") ✅ · D15 (nessuna rinomina `profile → tournament_profile`) ✅.

**Scostamenti dal piano:**
- Il piano T9 prevedeva il riallineamento di `tests/integration/season-sim.test.ts` al nuovo seed/RNG. Il file NON è stato modificato nel working tree, ma la suite resta verde (742/742): le asserzioni di `season-sim.test.ts` sono strutturali (round range, determinismo "due run identiche", conteggi) e non dipendono dalla sequenza esatta delle squadre, quindi il riallineamento non era necessario. Resta solo un tag `(RF-P5)` stale in un commento (vedi MEDIUM-1, punto 13).
- Nessun altro scostamento rilevato: struttura del codice, esiti `DeclareResult`, testi email, motivi di rifiuto, filtri notifiche e sequenza di simulazione corrispondono al piano.

---

## 3. Findings per severità

### BLOCKING

*Nessun finding bloccante.*

### HIGH

*Nessun finding high.* La correttezza del Game Engine è confermata da test reali: `createProfileForAccount` unica fonte di nascita profilo (riuso/backfill `player` legacy, `jollies_remaining` = `JOLLIES_PER_PLAYER`), `autoJoinProfilesAtStart` idempotente con guard `ctx.platform === undefined` → no-op, `declareParticipation` con cascata eligibility → `season_started` → finestra TT1 → `already_joined` → creazione, override `--reason` SOLO via CLI (il percorso email non passa mai `reason`).

### MEDIUM

#### MEDIUM-1 — Commenti sorgente stale che descrivono ancora RF-P5/auto-join-al-primo-pick come comportamento corrente
- **Riferimenti:** `src/db/schema.ts:37` · `src/game/eligibility.ts:4-5` · `src/game/pick-processor.ts:6,204,223` · `src/game/scheduler.ts:25` · `src/channel/email-processor.ts:8,147,226,642` · `src/llm/generator.ts:50` · `tests/integration/email-process.test.ts:12,393` · `tests/integration/season-sim.test.ts:190`.
- **Problema:** il piano §6 (Fase D) impone di "eliminare ogni riferimento al concetto 'auto-join al primo pick' (RF-P5)", e AGENTS.md Parte 2 §5 impone commenti aggiornati. La documentazione (PRD/HLD/LLD/ADR-019/current-status) è stata correttamente allineata (ogni occorrenza residua è un "RIMOSSO/emendata" o un changelog storico), ma **i commenti di sorgente sotto elencati** descrivono ancora l'auto-join al primo pick come meccanismo corrente, in file per lo più NON toccati dal working tree:
  1. `src/db/schema.ts:37` — "nasce per AUTO-JOIN al primo pick valido nel TT 1 (RF-P5)": il più fuorviante, perché descrive la DDL di `profile` con il vecchio modello.
  2. `src/game/eligibility.ts:4-5` — "ogni ingresso nel torneo (auto-join al TT1, RF-P5) passa da `checkEligibility`" (oggi gli ingressi sono `autoJoinProfilesAtStart`/`declareParticipation`).
  3. `src/game/pick-processor.ts:6` — "a cui delegano il Round Manager (Task 3.5) e l'auto-join (RF-P5, ADR-009)"; `:204` — "dall'auto-join RF-P5 (profilo+pick in un'unica transazione, ADR-009)"; `:223` — "(registerPick/autoJoinFromPick) nella stessa transazione" (`autoJoinFromPick` non esiste più).
  4. `src/game/scheduler.ts:25` — "la partecipazione è gated dalla deadline del TT1 (auto-join, RF-P5)".
  5. `src/channel/email-processor.ts:8` — l'intro dell'header elenca ancora "moduli di gioco (auto-join RF-P5, cascata pick)" (l'elenco dettagliato più sotto è stato aggiornato, l'intro no); `:147` — "risposte `pick_rejected`/`auto_rejected`" (azione `auto_rejected` rimossa); `:226` — "Testo del rifiuto 'torneo iniziato' (RF-P5, dal TT2)"; `:642` — "registerPick/autoJoinFromPick (che usano message.receivedAt…)".
  6. `src/llm/generator.ts:50` — "per l'auto-join è l'UNICO messaggio (RF-P5, D5)" su `pick_confirmed` (non è più la risposta dell'auto-join).
  7. `tests/integration/email-process.test.ts:12` — header "auto-join al TT1 (RF-P5, risposta pick_confirmed)"; `:393` — titolo describe "pick (RF-P4/P5, auto-join)".
  8. `tests/integration/season-sim.test.ts:190` — tag "(RF-P5)" nel commento su `start_round` (che è ADR-008; e l'auto-join oggi è `autoJoinProfilesAtStart`).
- **Impatto:** nessuno sul comportamento (sono commenti), ma contraddicono la feature e violano il requisito esplicito del piano; rischiano di fuorviare il prossimo agente/manutentore.
- **Correzione:** aggiornare i commenti elencati al nuovo modello (auto-join a `tournament:start` / dichiarazione `PARTECIPO`/`tournament:join`; `pick` non crea più profili), rimuovendo i riferimenti a `autoJoinFromPick`/`auto_rejected`/`auto-join al primo pick` come meccanismo corrente.

#### MEDIUM-2 — `platform:register` ri-assertisce i flag alla ri-registrazione, contraddicendo la garanzia "le riattivazioni NON toccano i flag"
- **Riferimento:** `src/cli/commands/platform.ts:120-125`.
- **Problema:** il comando chiama `registry.register(...)` e POI `registry.setPreferences(email, { tournamentAutoJoin: argv.autoJoin, receiveTournamentStartNotification: argv.receiveNotifications })` con default `true` per entrambi. La ri-registrazione (riattivazione di un account esistente via `platform:register`) quindi **resetta silenziosamente i flag a ON**, perdendo una preferenza precedente (es. un `--auto-join off` deliberato). Questo è in tensione con la garanzia documentata a livello registry ("le riattivazioni NON toccano i flag (restano registration-pure)", `src/platform/registry.ts` commento `register` e test `registry.test.ts` "le riattivazioni NON toccano i flag") — garanzia che però è vera SOLO per il metodo `registry.register()`, NON per il comando CLI (il test esercita il metodo, non il comando, quindi l'incoerenza non è catturata). Il piano §10 elenca esplicitamente il punto come rischio aperto ("se serve preservarli, applicarli SOLO alla prima creazione"), quindi la scelta è stata documentata, ma non risolta.
- **Correzione (raccomandata):** applicare i flag SOLO alla prima creazione (es. chiamare `setPreferences` solo quando `register` ha creato un account nuovo), oppure richiedere flag espliciti in ri-registrazione e documentare il reset nell'output/dalla ADR-019. In alternativa, rendere il comportamento esplicito nell'output del comando quando un account preesistente viene riattivato con flag ridefiniti.

### LOW

#### LOW-1 — Variante `tournament_started` di `DeclareResult` mai restituita
- **Riferimento:** `src/game/registration.ts:47`.
- **Problema:** il tipo `DeclareResult` dichiara il reason `'tournament_started'` (commento "TT 1 chiuso: partecipazione chiusa (ragione semantica)"), ma `declareParticipation` non lo restituisce MAI: a finestra chiusa senza `--reason` ritorna `late_requires_reason` (`:179-180`) e con `--reason` crea il profilo. La semantica "il torneo è iniziato" è prodotta dal wiring, che mappa `late_requires_reason` (e l'eventuale `tournament_started`) su `reason: 'tournament_started'` dell'email (`src/channel/email-processor.ts:443-450`). Nessun difetto di comportamento, ma la variante e il commento sono fuorvianti.
- **Correzione (opzionale):** rimuovere la variante `tournament_started` dal tipo (o documentare che è prodotta solo dal mapping email), per evitare che un futuro chiamante vi si appoggi.

#### LOW-2 — `already_joined` non raggiungibile a TT1 chiuso (ordine dei check)
- **Riferimento:** `src/game/registration.ts:177-194`.
- **Problema:** il check della finestra (`:179-180`) precede il check `already_joined` (`:194`), come prescritto dal piano (T3, cascata 3 → 4). Conseguenza: un partecipante GIÀ in gara (profilo esistente, es. auto-joinato) che invia `PARTECIPO` **dopo** la chiusura del TT1 riceve `late_requires_reason` → email "il torneo è iniziato" invece di "sei già in gara". Lo stesso identico messaggio durante la finestra TT1 dà `already_joined`. È un caso limite poco probabile e piano-conforme, ma la risposta è leggermente incoerente con la promessa di idempotenza D8 ("flag ON + PARTECIPO → già in gara").
- **Correzione (opzionale):** valutare se spostare il check `already_joined` PRIMA del check finestra, così un profilo esistente dà sempre `already_joined` (l'idempotenza D8 diventa incondizionata).

#### LOW-3 — `npm run lint` fallisce su file di scratch gitignored (non imputabile alla feature)
- **Riferimento:** `.tmp/imap-all.mjs:11`, `.tmp/imap-flags.mjs:11`, `.tmp/imap-sent.mjs:10` (errori `'e' is defined but never used`).
- **Problema:** `npm run lint` esegue `eslint .` sull'intera cartella e fallisce (exit 1) per 3 errori in file `.tmp/*.mjs` gitignored, preesistenti e NON toccati dalla feature (`git check-ignore` li conferma; non compaiono in `git status`). `npx eslint src tests` è pulito. Non è una regressione della feature, ma il protocollo "lint pulito" del piano §9 non è verificabile col comando pieno finché questi scratch restano.
- **Correzione:** cancellare i file `.tmp/*.mjs` (o escludere `.tmp/` dal lint) prima del commit, così `npm run lint` torna verde end-to-end.

### Osservazioni (non difetti)

- **OBS-1:** `tournament_join_confirmed` è in `PICK_EMAIL_TYPES` (`src/llm/email-renderer.ts:211-214`), quindi il box deadline compare in coda SOLO se un round è aperto — coerente con l'iniezione condizionale di `roundEmailContext` nel wiring (`src/channel/email-processor.ts:386-393`, che passa il contesto round solo quando `round !== null`). Verificato dal test esatto `email-renderer.test.ts` "tournament_join_confirmed con round aperto → messaggio chiave + deadline in coda".
- **OBS-2:** il broadcast `tournament_open` itera su `activeAccounts().filter(receiveTournamentStartNotification)` ma mantiene `platformCount = activeAccounts().length` (account ATTIVI, non destinatari), preservando la semantica di conteggio aggregato richiesta dall'ADR-011/convenzione 8 — verificato dal test `round-notifications.test.ts` e `tournament.test.ts` che asseriscono `platformCount === 2` con 1 solo destinatario.

---

## 4. OBIETTIVO 2 — Allineamento con WIN_ONLY (ADR-016), AUTO-PICK (ADR-017) e JOLLY (ADR-018)

Verifica esplicita punto per punto:

| # | Punto da verificare | Esito | Evidenza |
|---|---|---|---|
| 1 | **Collisione auto-join/auto-pick risolta** — il pick non crea più profili; profili nascono a `tournament:start` (flag ON) o per dichiarazione; l'autopick torna a coprire "in gara ma senza pick"; nessun residuo di RF-P5 nel motore/simulazione/wiring | ✅ CONFERMATO | `autoJoinFromPick` RIMOSSO (`src/game/registration.ts` non lo esporta più; unico riferimento residuale = commenti, vedi MEDIUM-1). Pick da attivo senza profilo → `tournament_join_rejected` `not_in_tournament` (`email-processor.ts:486-527`). Un auto-joinato che dimentica il pick resta "in gara" (profilo `eliminated=0`) e l'autopick (`closeRound`) lo copre con `pick_auto_assigned` (ramo invariato in `round-manager.ts`) |
| 2 | **JOLLY preservato** — `createProfileForAccount` inizializza `jollies_remaining`; cascata jolly e decremento atomico invariati | ✅ CONFERMATO | `createProfileForAccount` INSERT con `jollies_remaining = jolliesPerPlayer` (`registration.ts:93-97`, chiamato con `config.JOLLIES_PER_PLAYER` `:123,197`); `pick-processor.ts` NON modificato dal working tree (cascata `jolly_not_allowed`/`no_jollies_left` e `db.transaction` insert+decremento intatti); test `pick-processor.test.ts`/`registration.test.ts` verdi |
| 3 | **WIN_ONLY preservato** — rimozione auto-join non altera il pick win_only (squadra nuda → `win`); `pickFormula` win_only-aware; overlay clarification/narrativa win_only non rotti dai nuovi `EmailType`/testi | ✅ CONFERMATO | Risoluzione pick win_only invariata (`deterministic-parser.ts`/`parser.ts` non alterati nel cuore); `pickFormula(ctx.config.WIN_ONLY)` resta nei chiarimenti/rifiuti (`email-processor.ts:140-142,540,604`); `WIN_ONLY_NARRATIVE_OVERRIDES.clarification` aggiornato a 4 opzioni incl. PARTECIPO (`templates.ts:226-229`), senza rompere le narrative esistenti (test `email-renderer.test.ts` 48 verdi) |
| 4 | **`assertModeConsistent` NON toccata** — i flag vivono nel DB piattaforma, NON in `tournament_state`; nessun confronto aggiunto/rimosso | ✅ CONFERMATO | `src/game/mode.ts` non modificato (diff vuoto); `assertModeConsistent` chiamato dagli stessi punti (pick-processor/scheduler/round-manager/email-processor); le colonne flag esistono SOLO in `platform_account` (`platform-schema.ts:41-42`), mentre `tournament_state` conserva solo `win_only`/`autopick_on_missing`/`jollies_per_player` (`schema.ts:113-238`) |
| 5 | **Matrice notifiche (D9)** — `tournament_open` → solo `receive_tournament_start_notification=ON` con `platformCount` = attivi; `pick_instructions` → solo partecipanti (eccezione TT1 RF-P6 rimossa, `registeredNotified` eliminato); nessun iscritto senza profilo lasciato in silenzio (mail apertura insegna PARTECIPO, D14) | ✅ CONFERMATO | `tournament.ts:384-409` (filtro `receiveTournamentStartNotification`, `platformCount = activeAccounts().length`); `round-manager.ts:418-452` (blocco `registeredNotified` rimosso, `RoundOpenResult.registeredNotified` tolto `:192`); CTA `tournament_open` "Per partecipare al torneo, rispondi con \"PARTECIPO\"." (`email-renderer.ts:424-428`, `templates.ts` narrativa deterministica) |
| 6 | **Intento `join` separato da `subscribe` (D13)** — `partecipo` spostato in `join`; ordine disiscrizione→iscrizione→partecipo→pick; `join` da account inesistente = silent drop (mai registration, RF-P4); `pick` senza profilo → `not_in_tournament` (TT1) o `rejected_tt2` | ✅ CONFERMATO | `deterministic-parser.ts:208-213` (ordine corretto, `partecipo` dopo `iscrizione`); `intent-classifier.ts:123-133` (prompt: "partecipo" tolto da subscribe, `join` con descrizione dedicata); `email-processor.ts:382-395` (join da null/unsubscribed → `silent_other`+markSeen, nessuna `register`); `:486-527` (TT1 → `not_in_tournament`, TT2 → `rejected_tt2`) |
| 7 | **Determinismo RNF1** — `registerSimAccounts` PRIMA di `startTournament`; `simulateRound` invoca `autoJoinProfilesAtStart`; nessun `rng()` extra; sequenza cambiata ma deterministica | ✅ CONFERMATO | `simulation.ts:323-333` (registrazione prima di `startTournament`), `:394-398` (`autoJoinProfilesAtStart` esplicito in `simulateRound`), `:231-262` (loop unico sui profili, nessun ramo TT1); il test RNF1 "due run con stessa seed su DB freschi e stesso clock → export identici" (`season-sim.test.ts:119-126`) è VERDE |
| 8 | **Migrazioni additive idempotenti** — 2 colonne default 1 in DDL + ALTER guardato da `PRAGMA table_info`; nessun `RENAME`/dipendenza da `PRAGMA foreign_keys`; riuso player legacy con backfill `register_id` preservato | ✅ CONFERMATO | `platform-schema.ts:41-42` (DDL) e `:61-68` (ALTER guardati); `createProfileForAccount` riusa `player_id` e backfilla `register_id` (`registration.ts:71-81`); test `registry.test.ts` "migrazione additiva: un DB legacy…" e `registration.test.ts` "player legacy… riuso + backfill" verdi |
| 9 | **Idempotenza D8 e override late D10** — flag ON + PARTECIPO → `already_joined`; chiusura TT1 senza `--reason` → `late_requires_reason` (tradotto "il torneo è iniziato"); con `--reason` → creazione profilo pool intatto; `forceEligible` solo con `reason` | ✅ CONFERMATO (con LOW-2) | `declareParticipation` (`registration.ts:177-197`): `forceEligible` solo quando `opts.reason !== undefined` (`:158-163`); `late_requires_reason` → email `reason: 'tournament_started'` (`email-processor.ts:443-450`); override `--reason` crea profilo (`registration.ts:181` bypass) — test `registration.test.ts` "round 1 closed/scored CON reason → override late (crea profilo)" verde. LOW-2: a finestra chiusa senza reason un profilo GIÀ esistente dà `late_requires_reason` anziché `already_joined` (piano-conforme ma incoerente con D8) |
| 10 | **Documentazione** — nessun residuo del concetto "auto-join al primo pick"/RF-P5; ADR-019 append-only che emenda ADR-009 decisione 6/7 e registra i due flag, modello registration/join, matrice notifiche, default de-facto opt-out | ✅ CONFERMATO (con MEDIUM-1) | ADR-019 aggiunta append-only (`architecture-decisions.md:478-510`), ADR-009 decisioni 6/7 emendate (`:187-211`); PRD v0.6.2 (RF-P5/RF-P6/RF-10/glossario/changelog), HLD v0.6.0, LLD v0.6.2, cli-reference (`platform:preferences`, `tournament:join`, opzioni `platform:register`), manual, system-components, guida-test-mode, current-status tutte allineate (grep: nessun "auto-join al primo pick" come stato corrente — solo "RIMOSSO"/changelog storico). **MEDIUM-1:** i commenti di SORGENTE (non i doc) conservano riferimenti stale al concetto rimosso |

---

## 5. Correttezza del Game Engine e confini I/O (OBIETTIVO 1, punti 2–3)

- **Unica fonte di nascita profilo (AGENTS.md §1.3):** `createProfileForAccount` (`registration.ts:67-97`) è l'unico INSERT su `profile` nei flussi di partecipazione, usato da `autoJoinProfilesAtStart` e `declareParticipation`; l'auto-pick di `closeRound` NON crea profili (agisce solo su profili `eliminated=0` esistenti); `round-manager.ts` non inserisce profili. Confermato da `grep` su `INSERT INTO profile` (solo `registration.ts`).
- **Guard `platform === undefined` → no-op:** `autoJoinProfilesAtStart` (`registration.ts:113-114`) restituisce `[]` senza registry, coerente col guard del broadcast; test dedicato verde.
- **Cascata `declareParticipation`:** eligibility (`forceEligible` solo con `reason`) → `season_started` → stato `round_state[startRound]` (assente→`no_tournament`, pending/open→finestra, closed/scored→`late_requires_reason` senza reason) → `already_joined` → creazione. Il percorso email (`email-processor.ts:397`) non passa MAI `reason`; il percorso CLI `tournament:join` passa `reason: argv.reason` (`tournament.ts:171-173`).
- **Confini I/O:** parser (`deterministic-parser.ts`) e classificatore (`intent-classifier.ts`) emettono solo `{intent, pick, name}` (dati); l'`email-renderer`/`templates`/`generator` compongono solo testo dai contesti. I due flag sono colonne del DB piattaforma lette dal Game Engine; nessuna decisione di gioco vive nel canale/LLM. Nessuna scrittura cross-DB (la piattaforma è letta da `activeAccounts()`/`find()`, scritta solo da `registry`/CLI).
- **Determinismo RNF1:** `created_at` di player/profile sempre dal clock iniettato (`now`), auto-join in ordine `register_id` (`activeAccounts()` `ORDER BY register_id`), nessun `rng()` extra introdotto; il test "due run identiche" resta verde.

---

## 6. Punti da correggere prima del commit

1. **MEDIUM-1 (raccomandato, non bloccante):** aggiornare i commenti sorgente stale elencati in §3 (schema.ts:37, eligibility.ts:4-5, pick-processor.ts:6/204/223, scheduler.ts:25, email-processor.ts:8/147/226/642, generator.ts:50, email-process.test.ts:12/393, season-sim.test.ts:190) al modello opt-in (auto-join a `tournament:start` / dichiarazione), eliminando i riferimenti a `autoJoinFromPick`/`auto_rejected`/"auto-join al primo pick" come meccanismo corrente.
2. **MEDIUM-2 (raccomandato):** decidere e documentare il comportamento di `platform:register` in ri-registrazione: applicare i flag SOLO alla prima creazione (o richiedere flag espliciti), per non ripristinare silenziosamente le preferenze opt-out; allineare di conseguenza l'ADR-019 e il test.
3. **LOW-1/LOW-2 (opzionali):** rimuovere la variante morta `tournament_started` dal tipo `DeclareResult`; valutare di spostare il check `already_joined` prima della finestra.
4. **LOW-3:** cancellare `.tmp/*.mjs` (o escluderli dal lint) affinché `npm run lint` torni verde end-to-end (le 3 violazioni non sono della feature).

*Nessuno di questi punti è bloccante: il codice è funzionalmente corretto, la suite è verde (742/742), typecheck e lint su `src tests` puliti, e tutti i 10 punti dell'OBIETTIVO 2 sono confermati.*
