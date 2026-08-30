# Revisione indipendente — Feature JOLLY (secondo incremento di `win_only`)

- **Oggetto:** working tree NON committato del branch `feat/win-only-mode` = feature JOLLY (piano `.kilo/plans/1788027046413-jolly-feature.md`, decisioni D1–D11, task T1–T13).
- **Contesto:** nel branch sono GIÀ committati `win_only` (ADR-016, `52c8cfc`) e AUTO-PICK ON MISSING (ADR-017, `fefda56`). L'ADR del Jolly è **ADR-018**.
- **Revisore:** revisore indipendente (sola lettura; unica scrittura = questo report).
- **Data:** 2026-08-30.
- **Verifiche eseguite:** `npm test` (710/710 verdi, 50 file), `npm run typecheck` (pulito), `npm run lint` (pulito), `git status`/`git diff`/`git show` (sola lettura), lettura integrale di piano, ADR-018, tutti i sorgenti e i test modificati.

---

## 1. Verdetto

**PASS con raccomandazioni.**

L'implementazione del Jolly è completa (T1–T13 tutte eseguite), fedele a tutte le decisioni D1–D11, architettonicamente coerente con i principi di AGENTS.md §1.3 (la decisione jolly vive SOLO nel Game Engine; parser/classificatore/email emettono SOLO dati), preserva il determinismo RNF1 e — punto critico dell'incarico — è **allineata senza conflitti né regressioni con entrambe le modalità già committate** (win_only ADR-016 e AUTO-PICK ADR-017), nonostante l'autopick sia stato implementato prima del jolly rispetto all'ordine dei piani. Nessun finding bloccante o high. Solo 3 finding low di manutenzione commenti/documentazione e 2 osservazioni. Suite 710 test verdi, typecheck e lint puliti.

---

## 2. Completezza del piano (T1–T13) e decisioni (D1–D11)

Tutti i task sono implementati e verificati da test reali:

| Task | Stato | Evidenza |
|---|---|---|
| T1 Config `JOLLIES_PER_PLAYER` | ✅ | `src/config.ts:159-173` (`z.coerce.number().int().nonnegative().default(1)`); `.env.example`/`.env.uat.example`/`.env.uat-replay.example`; test `config.test.ts` (default `1`, `0` accettato, negativo/non-intero rifiutati) |
| T2 `GameMode` estensibile | ✅ | `src/game/mode.ts:56-71` (`GameMode { winOnly, jollyEnabled }` + `modeFor`); refactor meccanico `winOnly: boolean` → `mode: GameMode` in `renderEmailV2`/`narrativeFor`/`templateFor`/`deterministicNarrative`/`OpenAIGenerator`/`DeterministicGenerator` e call-site (wiring/CLI con `modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER)`) |
| T3 Schema (3 colonne additive) + persistenza | ✅ | `src/db/schema.ts:46-49,67-70,132-134` (DDL) e `:233-252` (migrazioni idempotenti); `tournament.ts` `getTournamentState` (`:209-237`), `startTournament` UPSERT (`:341-353`), `tournamentExport` (`:579-583`); test `tournament.test.ts` |
| T4 Guardia `assertModeConsistent` | ✅ | `src/game/mode.ts:97-129` (confronto simmetrico di tutte e tre le chiavi + messaggi fatal nominati); test `mode.test.ts` (mismatch entrambi i versi, coincidenza, fatal strutturato) |
| T5 Motore: cascata + registrazione + decremento | ✅ | `errors.ts:24-25` (motivi in ordine di cascata); `pick-processor.ts` (`PickInput.jolly` `:62`, query profilo con `jollies_remaining` `:103`, gate 6bis DOPO `pick_already_exists` e PRIMA dei check temporali `:144-154`, `insertPendingPick(..., autoPick, jollyUsed)` `:221-246`, `registerPick` con `db.transaction` insert+decremento `:271-289`); `registration.ts` (INSERT profilo con `jollies_remaining` `:152-157`, decremento nel BEGIN/COMMIT `:184-190`); test `pick-processor.test.ts` (7 nuovi) e `registration.test.ts` (2 nuovi, incl. rollback con `JOLLIES_PER_PLAYER=0`) |
| T6 Parser/classificatore jolly-aware | ✅ | `parser.ts` (`PickExtraction.jolly` `:36-47`, `PickParseOptions.jollyEnabled` `:78-88`); `deterministic-parser.ts` (`\bjoll[yi]\b` word boundary, case/accenti-insensibile, rimozione prima della risoluzione `:150-151`); `intent-classifier.ts` (schema `jolly` `:67`, prompt `:111-124`, `parseClassification` gated su `jollyEnabled` `:225`); test 7+6 |
| T7 Scoring | ✅ | `round-manager.ts` (`PickRow.jolly_used` `:92`, `savedByJolly` `:745-748`, `ScoredPick` `:222-231`, payload email `:854-855`, `getRoundPlayers` `:178-179`, `getActiveProfiles` `:285-296`, `jolliesRemaining` nelle notify `:449,951`); test `round-flow.test.ts` (pareggio→correct senza eliminazione, sconfitta→wrong+eliminazione, vittoria→correct, marcatore nel riepilogo) |
| T8 Wiring email | ✅ | `email-processor.ts` (`jollyEnabled` nel classify `:271`, `jolly` a `registerPick` `:473`/`autoJoinFromPick` `:424`, conferme con `jollyUsed`+`jolliesRemaining` `:438-439,488-489`, motivi italiani `:142-151`); test `email-process.test.ts` (4 nuovi) |
| T9 Testi email | ✅ | `email-renderer.ts` (`resultLine` jolly `:97-104`, `pickConfirmedKey` `:131-133`, `jollyLines` `:354-370`, `playerResultRow` marcatore `:263`); `templates.ts` (`JOLLY_TEMPLATE_OVERRIDES` `:263-290`, `narrativeFor` con `savedByJolly` `:299-307`, `serializeEmailContext` `:384-387`); test 13+3+6 |
| T10 CLI | ✅ | `commands/pick.ts` (`--jolly` `:113-120`, propagazione `:133,191`); `commands/llm.ts` (`jollyEnabled`, output `jolly: true`, `--jolly-used`/`--jollies-remaining`, `modeFor` nei generatori); `email-wiring.ts` (`:109-114`) |
| T11 Simulazione | ✅ | `simulation.ts` (`jollyActive` gated `:210-211`, extra `rng()` short-circuit `:249,283-284`, UPSERT `simulateRound` con `jollies_per_player` `:415-419`); test `season-sim.test.ts` (2 nuovi, incl. "jolly off → nessun jolly, sequenza classica") |
| T12 Test | ✅ | Tutti i file indicati dal piano aggiornati (vedi §4); suite 710 verdi |
| T13 Documentazione | ✅ | ADR-018, LLD v0.6.1, technical-administrator-manual, cli-reference, guida-test-mode, system-components, current-status (vedi §6) |

**Decisioni:** D1 (riuso `status='correct'` + flag `jolly_used`, nessun nuovo `pick.status`) ✅ · D2 (persistenza simmetrica a `WIN_ONLY` in `tournament_state`) ✅ · D3 (contatore per-profilo, motore legge SOLO il contatore) ✅ · D4 (parsing gated su `jollyEnabled` per chiamata) ✅ · D5 (cascata: dopo `pick_already_exists`, prima dei check temporali) ✅ · D6 (atomicità decremento: `db.transaction` + BEGIN/COMMIT) ✅ · D7 (`GameMode` estensibile + `modeFor` pura) ✅ · D8 (testi email, chiave in MAIUSCOLO prima, riga jolly dopo) ✅ · D9 (marcatore "🎯 Jolly" in `playerResultRow`, speculare all'auto-pick) ✅ · D10 (seed jolly `rng()<0.25` gated su `jollyEnabled`, nessun extra rng quando off) ✅ · D11 (motivi jolly in italiano) ✅.

**Scostamenti dal piano:**
- L'ADR della feature è **018** e non 017 come scritto nel piano T13 ("nuova voce ADR-017") — corretto per la numerazione reale (ADR-017 già occupata dall'autopick); la stessa ADR-017 ne rende conto esplicitamente ("Il Jolly non è ancora implementato: questa ADR occupa ADR-017"). Nessuno scostamento di sostanza.
- Nessun altro scostamento rilevato: la struttura del codice, i testi email, i motivi, la propagazione e il seed di simulazione corrispondono al piano e alla tabella testi D8.

---

## 3. Findings per severità

### BLOCKING

*Nessun finding bloccante.*

### HIGH

*Nessun finding high.*

### MEDIUM

*Nessun finding medium.* La correttezza del Game Engine è confermata: cascata nell'ordine D5, atomicità del decremento (insert+update nella stessa transazione; rollback del profilo in auto-join su pick rifiutato), scoring `savedByJolly` esatto (`result==='wrong' && jolly_used===1 && actual==='draw'`), "il jolly non salva dalla sconfitta" e "bruciato alla dichiarazione" verificati con test su DB reale (`round-flow.test.ts`).

### LOW

#### LOW-1 — Commento intestazione `pick-processor.ts` non aggiornato con i passi jolly
- **Riferimento:** `src/game/pick-processor.ts:9-17`.
- **Problema:** il commento dell'header enumera la cascata in 7 passi e NON cita i due controlli jolly (`jolly_not_allowed`/`no_jollies_left`) che il codice ha aggiunto come passo 6bis (`:144-154`). AGENTS.md Parte 2 §5 richiede commenti aggiornati; inoltre `docs/system-components.md` parla ora di "cascata a 8 passi", quindi la numerazione del commento è disallineata anche con la documentazione.
- **Correzione:** aggiungere al commento dell'header la riga 6bis ("jolly → `jolly_not_allowed` | `no_jollies_left`", DOPO `pick_already_exists` e PRIMA dei check temporali).

#### LOW-2 — Commento stantio sul "seed" in `simulateRound`
- **Riferimento:** `src/game/simulation.ts:414`.
- **Problema:** il commento "Il seed dipende SOLO da config.WIN_ONLY" è rimasto invariato mentre la stessa UPSERT ora scrive anche `jollies_per_player` e il seed jolly (`rng()` extra) dipende da `jollyActive` (win_only **e** `JOLLIES_PER_PLAYER`). È ancora vero che senza jolly la sequenza classica è invariata, ma la frase "solo da config.WIN_ONLY" è oggi imprecisa.
- **Correzione:** riformulare il commento (es. "il seed dipende da config.WIN_ONLY e, per il solo extra-draw jolly, da config.JOLLIES_PER_PLAYER quando attivo; con jolly off la sequenza classica resta invariata").

#### LOW-3 — Terminologia "secondo/terzo incremento" tra i piani e l'ordine reale di implementazione
- **Riferimento:** ADR-018 `docs/decisions/architecture-decisions.md:448` ("secondo incremento di `win_only`, dopo l'auto-pick"); ADR-017 `:413` ("terzo incremento"); LLD v0.6.0/0.6.1 changelog.
- **Problema:** la numerazione "secondo incremento" (jolly) vs "terzo incremento" (autopick) riflette l'ORDINE DEI PIANI, mentre l'ordine REALE di implementazione è stato invertito (autopick prima del jolly). Le ADR raccontano correttamente l'ordine reale (ADR-017 dichiara "Il Jolly non è ancora implementato"; ADR-018 aggiunge "dopo l'auto-pick"), quindi non c'è alcuna affermazione fuorviante sull'ordine. Tuttavia la frase "secondo incremento di `win_only`, dopo l'auto-pick" in ADR-018 è internamente ambigua (se è il secondo incremento, perché "dopo l'auto-pick"?).
- **Correzione (opzionale):** chiarire in ADR-018 che "secondo incremento" è la designazione del piano, mentre l'ordine reale di atterraggio è stato autopick → jolly (motivo per cui l'ADR è la 018).

### Osservazioni (non difetti)

- **OBS-1:** `playerResultRow` (`src/llm/email-renderer.ts:263`) rende il marcatore "🎯 Jolly" quando `p.jolly === true` anche con `mode.jollyEnabled` falso. Non è un difetto: in classica il jolly non può MAI essere dichiarato (`jolly_not_allowed`), quindi `pk.jolly_used=1` non si verifica mai; la simmetria con il marcatore "🤖 Auto-assegnato" (stesso pattern, non gated) è coerente con D9 ("speculare all'auto-pick"). C'è un test che lo asserisce esplicitamente (`email-renderer.test.ts` "in modalità classica il marcatore '🎯 Jolly' segue la riga con esito").
- **OBS-2:** l'UPSERT locale di `simulateRound` (`src/game/simulation.ts:415-419`) non scrive `autopick_on_missing` (comportamento pre-esistente da ADR-017: nemmeno il commit `fefda56` lo scriveva). Con `season_started=0` la guardia è no-op e l'export può mostrare `autopick_on_missing=0` anche con la config a `true`; è fuori dallo scope del piano Jolly (che prevedeva solo `win_only` + `jollies_per_player`), ma essendo la stessa istruzione toccata dal Jolly sarebbe stato il momento opportuno per allinearla.

---

## 4. Qualità dei test

I test nuovi asseriscono **comportamento reale su DB in-memory e moduli veri** e non sono vacui. Evidenze:
- `pick-processor.test.ts`: ordine di cascata reale (jolly con pick già esistente → `pick_already_exists`), contatore decrementato/rifiutato con SELECT di verifica sul DB, nessun decremento su rifiuto.
- `registration.test.ts`: inizializzazione a `JOLLIES_PER_PLAYER` e decremento atomico; **rollback completo** (0 profili, 0 pick) su `no_jollies_left` in auto-join con `JOLLIES_PER_PLAYER=0`.
- `round-flow.test.ts`: pareggio+jolly → `correct` senza eliminazione e con flag runtime nelle mail; sconfitta+jolly → `wrong`+eliminazione; vittoria+jolly → `correct` con contatore già consumato; marcatore `jolly:true` nella riga del riepilogo per destinatario.
- `email-process.test.ts`: wiring reale (classificatore stub + FakeChannel/FakeGenerator) — "Napoli Jolly" con jolly attivo → `pick_confirmed` "CON JOLLY" + contatore; contatore 0 → "non hai più jolly disponibili"; jolly off → `jollyEnabled=false` e pick normale.
- `deterministic-parser.test.ts` / `intent-classifier.test.ts`: keyword ovunque (prima/dopo la squadra), case/accenti-insensibile, **word boundary** (`jollywood` non matcha), jolly off = rumore, esito draw/lose esplicito → non riconosciuto anche con jolly, schema zod (jolly non-booleano → `other` senza crash).
- `email-renderer.test.ts` / `deterministic-generator.test.ts` / `generator.test.ts`: testi esatti per ogni combinazione (salvato/vittoria/sconfitta/off), `narrativeFor` con `savedByJolly` (mai "hai indovinato"), `templateFor` con priorità overlay jolly, `serializeEmailContext`.
- `season-sim.test.ts`: con seed 42 e jolly on, `jolly_used>0` e contatori mai negativi; con `JOLLIES_PER_PLAYER=0` zero jolly e `jollies_per_player=0` (RNF1: nessun extra rng).

**Suite:** 710/710 test verdi, `npm run typecheck` e `npm run lint` puliti.

---

## 5. OBIETTIVO 2 — Allineamento con WIN_ONLY (ADR-016) e AUTO-PICK ON MISSING (ADR-017): verifica punto per punto

1. **`GameMode { winOnly, jollyEnabled }` + `modeFor(winOnly, jolliesPerPlayer)`** — ✅ `src/game/mode.ts:69-71`: `jollyEnabled = winOnly && jolliesPerPlayer >= 1`, esattamente come richiesto. Il refactor del booleano `winOnly` → `mode: GameMode` non ha rotto alcun comportamento win_only: tutte le funzioni toccate (`renderEmailV2`, `narrativeFor`, `templateFor`, `deterministicNarrative`, `OpenAIGenerator`, `DeterministicGenerator`) usano `mode.winOnly` dove prima usavano il booleano (verificato su tutti i call-site, nessun booleano passato a funzioni che ora attendono `GameMode`), e i test win_only esistenti passano invariati (`modeFor(true, 0)` nei test aggiornati). **L'autopick NON dipende da GameMode**: il suo gating è `config.WIN_ONLY && config.AUTOPICK_ON_MISSING` direttamente in `closeRound` (`src/game/round-manager.ts:543`), invariato.
2. **Guardia `assertModeConsistent` simmetrica su tutte e tre le chiavi** — ✅ `src/game/mode.ts:87-106`: confronta `win_only` (booleano), `autopick_on_missing` (booleano) e `jollies_per_player` (intero) in un'unica condizione AND; nessuna chiave dimenticata o confrontata male (i tipi sono separati: `===` per i due booleani derivati da `state.x === 1`, `===` numerico per i jolly). Messaggi fatal corretti e nominati (`src/game/mode.ts:109-129`: `WIN_ONLY`, `AUTOPICK_ON_MISSING`, `JOLLIES_PER_PLAYER` con valori persistiti vs configurati); il log `fatal` strutturato include tutte e sei le grandezze (`:133-146`). Testato per mismatch sui tre assi.
3. **`insertPendingPick` con i due flag (autoPick, jollyUsed)** — ✅ Nessuno scambio: firma `(db, profileId, round, team, outcome, createdAt, autoPick = 0, jollyUsed = 0)` (`src/game/pick-processor.ts:221-230`). Call-site: autopick `closeRound` → `insertPendingPick(db, profile.id, round, team, 'win', now.toISOString(), 1)` = autoPick=1, jollyUsed default 0 (`round-manager.ts:595`); jolly `registerPick` → `(..., 0, input.jolly === true ? 1 : 0)` (`pick-processor.ts:273-282`); jolly auto-join → `(..., 0, parsed.jolly === true ? 1 : 0)` (`registration.ts:174-183`).
4. **Interazione autopick-jolly allo scoring** — ✅ Un pick auto (`auto_pick=1`, `jolly_used=0`) non può essere salvato dal jolly: `savedByJolly` richiede `pick.jolly_used === 1` (`round-manager.ts:747`), quindi un pareggio su pick auto resta `wrong` → eliminazione. Testato in `autopick.test.ts` (pick auto su sconfitta → `wrong`+`jollyUsed:false, savedByJolly:false` e eliminazione).
5. **Email: marcatori "🤖 Auto-assegnato" e "🎯 Jolly" convivono** — ✅ `playerResultRow` (`email-renderer.ts:260-263`) calcola i due marker in modo indipendente e li concatena in CODA alla riga nell'ordine `auto` → `jolly` (` · 🤖 Auto-assegnato` poi ` · 🎯 Jolly`): nessuna sovrapposizione, nessuna duplicazione, ordine sensato; i testi win_only/autopick non sono alterati dal jolly (la riga win_only resta "`{name} — {team} — {status}`", i marker sono solo appendici). Verificato per iscritto e con i test di entrambi i marker.
6. **`JOLLIES_PER_PLAYER=0` ⇒ sistema identico a oggi** — ✅ (a) parser: keyword "jolly" è rumore ignorato (`deterministic-parser.ts:150`, `intent-classifier.ts:225`, `email-processor.ts:271` con `jollyEnabled=false`); (b) email: nessuna riga jolly (`email-renderer.ts` tutte le funzioni jolly gated su `mode.jollyEnabled`; test "pick_instructions con jolly disattivato → nessuna riga jolly" e "pick_confirmed jolly disattivato → chiave win_only normale"); (c) profili creati con `jollies_remaining=0` (test `registration.test.ts`); (d) guardia coerente (config 0 vs persistito 0 → no-op; test `mode.test.ts` "coincidente → no-op").
7. **Parser deterministico: `\bjoll[yi]\b` non interferisce** — ✅ la keyword è rimossa dal testo di lavoro PRIMA della risoluzione squadra+esito (`deterministic-parser.ts:150-151`), quindi la risoluzione win_only della squadra nuda resta invariata ("Roma Jolly" → `AS Roma`/`win`/`jolly:true`; "roma pareggia jolly" → non riconosciuto). L'autopick non tocca il parsing: il suo percorso è solo in `closeRound` con `getFirstAvailableTeamByShortName` (nessuna chiamata al parser).
8. **Simulazione: seed jolly non altera la sequenza quando off** — ✅ l'extra `rng()` è gated da short-circuit: `jollyActive && rng() < 0.25` (TT1, `simulation.ts:249`) e `jollyActive && profile.jollies_remaining > 0 && rng() < 0.25` (TT2+, `:283-284`); con jolly off `rng()` non viene mai chiamato → sequenza classica invariata (test `season-sim.test.ts` "jolly off → NESSUN extra rng"; i test RNF1 esistenti "due run stessa seed → export identici" passano). L'autopick non è esercitato in simulazione (nessun profilo mancante: tutti i pick sono registrati nel loop) e comunque non interferisce col seed jolly.
9. **Documentazione: ordine reale raccontato correttamente** — ✅ nessuna affermazione fuorviante: ADR-017 dichiara "Il Jolly non è ancora implementato: questa ADR occupa ADR-017"; ADR-018 aggiunge "dopo l'auto-pick" e spiega che il jolly è il secondo incremento per designazione del piano. La sola ambiguità terminologica è il LOW-3.

---

## 6. Documentazione

Coerente con il codice e tra loro:
- **ADR-018** (`docs/decisions/architecture-decisions.md:442-471`): append-only, status/date/riferimenti, contesto, decisione in 11 punti (uno per D1–D11), alternative considerate e conseguenze. Corrisponde al codice verificato.
- **LLD v0.6.1** (`docs/POC/POC_LLD.md`): env var `JOLLIES_PER_PLAYER` (§4.1, nota `.nonnegative()`), nota modello dati §3 con le tre colonne additive e i default legacy, changelog 0.6.1.
- **technical-administrator-manual.md**: regole jolly (salva dal pareggio, non dalla sconfitta, bruciato alla dichiarazione, `0`=off), matrice notifiche aggiornata, tabella env var, §6.8 guardia con le tre variabili.
- **cli-reference.md**: `pick:validate`/`pick:register --jolly`, `llm:parse`/`llm:classify` note jolly, `llm:generate --jolly-used/--jollies-remaining`.
- **guida-test-mode.md**: nota `<TEAM> Jolly` per il parser deterministico e attivazione `JOLLIES_PER_PLAYER` in UAT.
- **system-components.md**: `GameMode`/`modeFor` nella mappa, parametro, colonne, cascata a 8 passi, guardia sulle tre chiavi.
- **current-status.md**: timestamp bump (`2026-08-30T12:15:00Z`) + entry changelog ISO-8601 dettagliata per T1–T13 (AGENTS.md Parte 2 §0 rispettato; nessuna entry UAT spuria).
- **.env.example / .env.uat.example / .env.uat-replay.example**: `JOLLIES_PER_PLAYER=1` con commento; `env-examples.test.ts` verde (nessuna credenziale coinvolta).

Unico disallineamento minore: il commento intestazione di `pick-processor.ts` (LOW-1).

---

## 7. Conclusione — punti da correggere prima del commit

Nessun punto obbligatorio (nessun finding bloccante/high/medium). Raccomandati prima del commit, per sola qualità di manutenzione:

1. **LOW-1** — aggiornare il commento della cascata in `src/game/pick-processor.ts:9-17` con i passi jolly (6bis), per coerenza con `system-components.md` ("cascata a 8 passi") e AGENTS.md §5.
2. **LOW-2** — correggere il commento "Il seed dipende SOLO da config.WIN_ONLY" in `src/game/simulation.ts:414`.
3. **LOW-3** — (opzionale) chiarire in ADR-018 la distinzione "secondo incremento (designazione del piano)" vs "atterrato dopo l'auto-pick".

Osservazioni non bloccanti: OBS-1 (marcatore non gated in classica — difensivo, speculare all'auto-pick) e OBS-2 (`simulateRound` non scrive `autopick_on_missing`, pre-esistente e fuori scope).

Il working set è pronto per il commit: **PASS con raccomandazioni.**
