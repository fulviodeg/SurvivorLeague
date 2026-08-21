# Piano: iscrizione a livello di piattaforma (POC)

> **Stato:** piano pronto per l'implementazione (da eseguire su un nuovo branch `feat/` da `main`, NON sul branch di analisi `docs/adr-platform-registration`).
> **Origine:** analisi `tasks/iscrizione-piattaforma/brainstorming-iscrizione-piattaforma.md` (2026-08-20) + review dell'utente. Le decisioni di quel documento (conflitti risolti, punti 1–12, trade-off SQLite) sono vincolanti per questo piano.
> **Relazione coi piani esistenti:** `tasks/plan.md` resta la roadmap generale. Questo piano copre la modifica "iscrizione a piattaforma"; la **chiusura automatica del torneo sul vincitore** (punto 8 della review) è un **task separato** successivo (vedi appendice), NON incluso qui.
> **Nota percorso:** il piano è scritto in `.kilo/plans/` (posizione autorizzata in plan mode); al termine della pianificazione va copiato in `tasks/` (richiesta dell'utente).

---

## 1. Contesto e obiettivo

Oggi l'iscrizione vive nel DB di torneo (`player` + `profile`, gated da `registration_open`, finestra `[apertura, deadline TT1]` — RF-22/RF-28, ADR-008). La modifica introduce un **modello a due livelli**:

1. **Piattaforma**: account persistente (storage separato `PLATFORM_DB_PATH`), `registerID` interno **stabile** (riusato alla re-iscrizione), email, status `active`/`pending_unsubscribe`/`unsubscribed` (soft-delete). Iscrizione/disiscrizione via email, sempre disponibili.
2. **Torneo**: `profile` resta la partecipazione al torneo. Un iscritto alla piattaforma può entrare nel torneo **solo entro la deadline del TT1** (primo pick = auto-join).

Scope **mono-torneo** confermato: tornei successivi, mai contemporanei. Le regole di gioco su `profile`/`pick` non cambiano.

## 2. Decisioni bloccate (fonte di verità per l'esecuzione)

1. **Due DB, due connessioni separate** (`DB_PATH` torneo + `PLATFORM_DB_PATH` piattaforma). Nessuna transazione cross-DB: la piattaforma è **solo letta** dai flussi di torneo (gate). Ogni scrittura resta in un singolo DB. Anche la futura quota (Fase 1) è un gate in **lettura** (`paid`) al pick/join, non una scrittura alla creazione del profilo.
2. **Nessuna migrazione dati**: il DB piattaforma parte vuoto; `player`/`profile` esistenti (sintetici/test) non vengono migrati.
3. **Soft-delete a due passi (barriera unsubscribe)**: status `active | pending_unsubscribe | unsubscribed`. Il primo messaggio di disiscrizione **non** elimina: imposta `pending_unsubscribe` e invia `platform_unsubscribe_confirm`. La disiscrizione effettiva (soft-delete `unsubscribed`) avviene solo su un **secondo** messaggio con intento `unsubscribe` o body nella lista di conferma (`confermo`/`sì`/`si`/`yes`). `subscribe`/`pick` mentre `pending_unsubscribe` → torna `active`. `unsubscribe` da `unsubscribed` o sconosciuto → **log silenzioso**. `registerID` ed email restano (re-iscrizione riusa lo stesso `registerID`; il sistema ricorda l'email).
4. **Anti-spam**: pick da mittente **sconosciuto** (mai iscritto o disiscritto) → **solo log interno, nessuna risposta**; il messaggio viene marcato letto.
5. **LLM per l'intento**: iscrizione/disiscrizione/pick sono classificati **dall'LLM** (come i pick oggi), non da keyword deterministiche. Una sola chiamata LLM per messaggio: intento + estrazione pick (le keyword `REGISTRATION_KEYWORDS` del router vengono rimosse; resta la normalizzazione dell'identità e il caso "corpo vuoto → unknown").
6. **Auto-join (sostituisce RF-27, confermato dalla review finale)**: il profilo nasce **al primo pick valido**. Un iscritto **senza profilo** che invia un pick nel **TT1** (round = `start_round`, round aperto, pick che passa l'accettazione RF-31) crea profilo + pick in un'unica transazione sul DB torneo; pick invalido → rollback, nessun profilo; la risposta all'auto-join è `pick_confirmed` (nessuna conferma di iscrizione separata). L'iscrizione alla piattaforma durante un torneo aperto NON crea subito il profilo; chi si iscrive e non invia mai un pick non è partecipante (non eliminato, nessuna email). Dopo il TT1: rifiuto con risposta (torneo iniziato). Un pick da sconosciuto NON auto-iscrive più.
7. **Notifiche**:
   - **Apertura torneo** (`tournament:start`): email `tournament_open` a **tutti gli iscritti attivi** della piattaforma (sostituisce l'invito `--contacts`).
   - **Apertura round** (`round:open`): email pick (istruzioni + squadre disponibili) ai **soli partecipanti attivi** (`eliminated = 0`).
   - **Chiusura round** (`round:score`, alla transizione `closed → scored`): email di **riepilogo** `round_closed_survived` **solo ai sopravvissuti** (`eliminated = 0`). Invio **unica volta**, guardia `round_state.summary_sent`.
   - Gli **eliminati** ricevono **solo** le notifiche puntuali: `pick_missing_elimination` (alla `round:close`) e `round_result_wrong` (allo `round:score`); **non** ricevono il riepilogo di chiusura. L'eliminazione a posteriori da Freeze produce **solo** `round_result_wrong` (coerente con PRD §5.4), nessun riepilogo.
   - Gli eliminati dei round precedenti non ricevono più email di round. Chi è iscritto ma non partecipa riceve solo l'apertura torneo (può disiscriversi). **Ogni email in uscita è filtrata sullo stato dell'account piattaforma al momento dell'invio: un account `unsubscribed` o `pending_unsubscribe` non riceve alcuna email.**
8. **Relazione dati**: `register_id` **replicato** su `player` e `profile` (colonne additive); `player` resta (giocatore nel torneo), `profile` resta (partecipazione).
9. **Eligibilità**: il seam `checkEligibility` (ADR-008) resta; l'implementazione POC diventa "account piattaforma attivo" (Fase 1: attivo + pagato). Il gate del pick = piattaforma attiva + profilo (o auto-join al TT1).
10. **Comandi piattaforma dedicati**: `platform:migrate` (schema DB piattaforma), `platform:register`, `platform:unregister`, `platform:list`. `db:migrate` resta solo torneo. `channel:email:process` migra entrambi i DB. `platform:register` è l'**unico** comando di creazione account; **non** crea profili (la partecipazione avviene solo via auto-join al TT1).
11. **Config**: nuova env `PLATFORM_DB_PATH` (default `./data/platform.db`), replicata in `.env.example`, `.env`, `.env.uat`, `.env.uat-replay` (`.env.uat` resta estensione di `.env`).
12. **Iniezione**: il contesto di gioco guadagna `platform?: PlatformRegistry` (interfaccia in `src/platform/registry.ts`, impl SQLite). Moduli puri: mai `getConfig()`; `created_at` sempre dal clock iniettato (RNF1) anche sul DB piattaforma.
13. **Deprecazioni**: `tournament:register:open/close`, `registration_open`, `registration_notified` (e azioni scheduler `register_close_auto`/`register_close_safety`); template `welcome`, `registration_open_invite`, `auto_registered`; RF-27. RF-22/RF-28 vengono **sostituiti** (non reinterpretati) dai nuovi RF-P del §3; non esiste più alcuna "finestra di iscrizione" da aprire/chiudere.
14. **Disiscrizione a torneo in corso (confermato dalla review finale)**: la disiscrizione NON tocca il profilo nel torneo (storico intatto): ferma solo comunicazioni e pick (pick da account `unsubscribed` = log silenzioso). Il profilo muore naturalmente alla prossima chiusura round (`missing_pick`, senza email al disiscritto). Se il giocatore si **re-iscrive prima della prossima deadline**, riprende a giocare con lo stesso `registerID` e lo stesso profilo.

## 3. Requisiti nuovi/modificati (da scrivere nei documenti)

**Nuovi RF (proposta di numerazione da PRD):**
- **RF-P1** — Iscrizione piattaforma via email (intento LLM): crea/riattiva l'account con `registerID` stabile; conferma via email. Già iscritto → risposta "già iscritto".
- **RF-P2** — Disiscrizione via email (intento LLM, barriera a due passi): primo messaggio → `pending_unsubscribe` + `platform_unsubscribe_confirm`; soft-delete (`unsubscribed`) solo su secondo messaggio con intento `unsubscribe` o body di conferma (`confermo`/`sì`/`si`/`yes`). Da mittente `unsubscribed` o non iscritto → log silenzioso.
- **RF-P3** — Re-iscrizione: stesso `registerID`; lo storico torneo (profili/pick) non è toccato.
- **RF-P4** — Pick da mittente non iscritto (mai o disiscritto) → log interno, nessuna risposta (anti-spam/privacy).
- **RF-P5** — Un iscritto può partecipare solo entro la deadline del TT1: primo pick nel TT1 → auto-join (profilo+pick atomici); dopo il TT1 → rifiuto con risposta; nessun profilo senza pick valido. Disiscritto a torneo in corso → profilo conservato, comunicazioni e pick fermati; re-iscrizione prima della prossima deadline → si riprende con lo stesso `registerID` e profilo.
- **RF-P6** — Notifiche: apertura torneo a tutti gli iscritti attivi; apertura round (pick) ai soli partecipanti attivi; chiusura round (riepilogo `round_closed_survived`) ai soli sopravvissuti; gli eliminati ricevono solo le notifiche puntuali (`pick_missing_elimination`, `round_result_wrong`).
- **RF-P7** — Persistenza piattaforma separata da `DB_PATH`, non eliminata col DB torneo; `register_id` replicato su `player`/`profile`.
- **RF-P8** — Determinismo: `created_at`/`unsubscribed_at` piattaforma scritti dal clock iniettato (RNF1).

**Nuovi CL:** disiscrizione a due passi con barriera di conferma e re-iscrizione (stesso registerID, storico intatto); pick da disiscritto (log silenzioso); iscritto senza profilo al TT1 (auto-join) e dopo TT1 (rifiuto); disiscrizione a torneo in corso (profilo conservato, comunicazioni ferme, niente email al disiscritto); eliminati esclusi dalle notifiche di round; riepilogo chiusura round ai soli sopravvissuti.
**Rimossi/riscritti:** RF-27 (auto-iscrizione) → sostituito da RF-P5; RF-22/RF-28 **sostituiti** (non reinterpretati) dai nuovi RF-P; US10 (iscrizione/ripristino manuale) **rimossa**; CL2/CL5 riscritti per il modello a due livelli; US1/US7/US8 riscritte (iscrizione piattaforma, nessuna finestra torneo).

**Nuovi `EmailType`:** `platform_registered`, `platform_unsubscribed`, `platform_unsubscribe_confirm`, `tournament_open`, `round_closed_survived`. **Rimossi:** `welcome`, `registration_open_invite`, `auto_registered`, `round_closed_eliminated`.

## 4. Task ordinati per dipendenza

### Task 1 — ADR-009
- **Contenuto:** registrare l'ADR "Iscrizione a livello di piattaforma" (append-only, formato ADR-001…008): modello a due livelli, mono-torneo sequenziale, storage separato con due connessioni (piattaforma solo letta), `registerID` stabile + soft-delete a due passi, log silenzioso anti-spam, classificazione intento via LLM, auto-join al TT1, matrice notifiche, deprecazioni.
- **File:** `docs/decisions/architecture-decisions.md` (+ indice ADR).
- **Verifica:** formato coerente; riferimenti alle decisioni §2 di questo piano.

### Task 2 — Allineamento PRD (v0.6.0)
- **Contenuto:** §2 glossario (account piattaforma, registerID, iscritto/partecipante, auto-join, soft-delete a due passi); §4.1 riscritto (iscrizione piattaforma sempre aperta; partecipazione gated dal TT1); §4.2/4.3 (notifiche: apertura torneo a tutti, round ai soli attivi, riepilogo chiusura ai soli sopravvissuti); §4.7 US1/US7/US8 riscritte e US10 (iscrizione/ripristino manuale) **rimossa**; RF-P1…P8 + CL nuovi; RF-27 deprecato, RF-22/RF-28 **sostituiti** (non reinterpretati) dai nuovi RF-P; §10/§1.1 (tornei successivi, mai contemporanei); changelog.
- **File:** `docs/POC/POC_PRD.md`.
- **Verifica:** tracciabilità RF↔US↔CL (§11); nessun riferimento residuo alla "finestra di iscrizione" come gate piattaforma; nessuna formulazione "restano validi reinterpretati" per RF-22/RF-28.

### Task 3 — Allineamento HLD (v0.5.0)
- **Contenuto:** §2.2/§5 nuovo componente **Platform Registry** (archivio account, sorgente degli iscritti); §5.3 Message Router → smistamento su intento LLM; §6.1/6.2 flussi riscritti (subscribe/unsubscribe a due passi/pick/silenzio, auto-join); §6.3 notifiche (broadcast apertura torneo, riepilogo chiusura ai sopravvissuti); diagrammi aggiornati.
- **File:** `docs/POC/POC_HLD.md`.
- **Verifica:** mermaid validi; coerenza con PRD v0.6.0 e ADR-009.

### Task 4 — Allineamento LLD (v0.5.0)
- **Contenuto:** §3 schema `platform_account` + colonne additive `player.register_id`, `profile.register_id`, `round_state.summary_sent`; §3.1 vincoli (gate piattaforma, auto-join TT1, riepilogo alla transizione `scored`); §4.2 `PLATFORM_DB_PATH`; §6 nuova interfaccia `PlatformRegistry` + `LLMIntentClassifier` (contratto, errori); §6.3 `EmailType` aggiornati; §7 nuovi comandi `platform:*`, modifiche `tournament:*`/`round:*`; §8 casi di test.
- **File:** `docs/POC/POC_LLD.md`.
- **Verifica:** coerenza ADR-009/PRD; nessun valore hardcodato.

### Task 5 — Config, schema piattaforma, PlatformRegistry
- **Contenuto:** `PLATFORM_DB_PATH` in `src/config.ts` (zod, default, commenti AGENTS.md §5) e `.env.example`; `src/db/platform-schema.ts` (DDL `platform_account`: `register_id INTEGER PK AUTOINCREMENT`, `email TEXT NOT NULL UNIQUE`, `status CHECK (active|pending_unsubscribe|unsubscribed)`, `created_at`, `unsubscribed_at`; migrazione idempotente); `src/platform/registry.ts` (interfaccia `PlatformRegistry`: `register`, `unregister` (soft-delete diretto, per CLI), `beginUnsubscribe` (→ `pending_unsubscribe`), `confirmUnsubscribe` (→ `unsubscribed`), `reactivate` (→ `active`), `find`, `activeEmails` (solo status `active`), `list` — tutti con `now` esplicito; impl `DbPlatformRegistry`); `src/cli/commands/platform.ts` (`platform:migrate`, `platform:register --email [--name] [--reason]`, `platform:unregister --email [--reason]`, `platform:list [--json]`); registrazione in `src/cli/index.ts`.
- **File:** `src/config.ts`, `.env.example`, `src/db/platform-schema.ts`, `src/platform/registry.ts`, `src/cli/commands/platform.ts`, `src/cli/index.ts`.
- **Verifica:** TDD — unit test del registry (register/unsubscribe a due passi/soft-delete/stesso registerID/clock iniettato); `npm test`, `npm run typecheck`, `npm run lint`; `tests/unit/env-examples.test.ts` verde.

### Task 6 — Classificatore di intento LLM
- **Contenuto:** `src/llm/intent-classifier.ts`: interfaccia `LLMIntentClassifier.classify(body, opts: PickParseOptions) → { intent: 'subscribe'|'unsubscribe'|'pick'|'other'; pick: PickExtraction | null }` in UNA chiamata (prompt aggiornato: intento + estrazione; stesso vincolo `json_object` e lista canonica iniettata, ADR-004); filtro deterministico esatto sul pick; errori di contenuto → `other`/`pick:null` (mai eccezioni), trasporto → `LLMError`. `OpenAIParser` resta per `llm:parse` (riusa internamente il classificatore dove possibile). Prompt/template aggiornati in `src/llm/templates.ts` (nuovi `EmailType` §3, rimossi i template deprecati; `Record<EmailType, string>` copre tutto). Nuovo comando CLI `llm:classify --input <json>` (output JSON `{ intent, pick }`), registrato in `src/cli/index.ts` (ADR-006: ogni componente espone un comando verificabile in modo indipendente).
- **File:** `src/llm/intent-classifier.ts`, `src/llm/parser.ts`, `src/llm/templates.ts`, `src/llm/generator.ts` (tipi), `src/cli/commands/llm.ts`, `src/cli/index.ts`.
- **Verifica:** contract test con fetch mockato (intento per classe di messaggi, CS7) + contract test dedicato per `llm:classify`; `npm test`, typecheck, lint.

### Task 7 — GameContext + eligibilità + auto-join
- **Contenuto:** `GameContext.platform?: PlatformRegistry` (opzionale, come channel/generator); `src/game/eligibility.ts`: `checkEligibility` usa il registry (account `active` → eligible); `src/game/registration.ts`: nuovo `autoJoinFromPick` (sostituisce `autoRegisterFromPick`): solo profilo + pick atomici, gate TT1 (round = start_round, round `open`) — pick invalido → rollback senza profilo; risposta all'auto-join = `pick_confirmed`. `registerPlayer`/`openRegistration`/`closeRegistration` NON vengono rimossi qui: restano **stub `@deprecated`** (nessuna scrittura cross-DB) e saranno eliminati nel Task 10 con la riscrittura di `simulation.ts`/`scheduler.ts` (build verde a ogni task). `pick:register` (CLI) risolve l'email del profilo e verifica che l'account piattaforma sia `active` (nessun bypass del gate). Rimozione gate `registration_open`; colonne additive in `src/db/schema.ts` (`player.register_id`, `profile.register_id`, `round_state.summary_sent`) con migrazione guardata.
- **File:** `src/game/context.ts`, `src/game/eligibility.ts`, `src/game/registration.ts`, `src/game/pick-processor.ts`, `src/db/schema.ts`.
- **Verifica:** TDD — unit test auto-join/eligibilità (registerID stabile, soft-delete, gate TT1, rollback, risposta `pick_confirmed`, `pick:register` verifica account attivo); aggiornare `tests/unit/game/registration.test.ts`, `tests/unit/game/tournament.test.ts`; build verde (stub `@deprecated` presenti).

### Task 8 — Message Router + email-processor
- **Contenuto:** router: rimuove `REGISTRATION_KEYWORDS`; produce `{ kind: 'classified', identity, body }` (la decisione di intento è dell'LLM); corpo/mittente vuoto → `unknown` (nessuna chiamata LLM). `email-processor.ts`: per messaggio → classificatore LLM → rami:
  - `subscribe` → nuovo: `register` + `platform_registered`; già `active` → risposta "già iscritto"; da `unsubscribed` o `pending_unsubscribe` → riattiva `active` (stesso `registerID`);
  - `unsubscribe` (primo, da `active`) → `pending_unsubscribe` + `platform_unsubscribe_confirm` (nessun soft-delete);
  - `unsubscribe` (secondo, da `pending_unsubscribe`, con intento `unsubscribe` o body nella lista `confermo`/`sì`/`si`/`yes`) → soft-delete (`unsubscribed`);
  - `unsubscribe` da `unsubscribed` o sconosciuto → **log silenzioso**;
  - `subscribe`/`pick` mentre `pending_unsubscribe` → riporta a `active`;
  - `pick` da iscritto `active` con profilo → cascata attuale;
  - `pick` da iscritto `active` senza profilo → `autoJoinFromPick` (TT1) o rifiuto (post-TT1);
  - `pick` da sconosciuto/disiscritto → **log interno, markSeen, nessuna risposta**;
  - `other` da noto → chiarimento; `other` da sconosciuto → log silenzioso.
  - **Ordine:** subscribe/unsubscribe gestiti PRIMA del gate `round_not_open` (indipendenti dai round, come l'odierna `registration`); il ramo pick richiede un round aperto. Ogni email in uscita è inviata SOLO ad account `active` al momento dell'invio (`unsubscribed`/`pending_unsubscribe` esclusi).
  - **Mittenti attivi rivalutati per messaggio (HIGH-2):** l'insieme degli account attivi NON è uno snapshot unico di inizio batch: va **ricomputato/aggiornato dopo ogni `subscribe`/`unsubscribe` elaborata** nel batch, così un `subscribe` seguito da un `pick` dello stesso mittente nello stesso batch vede il pick accettato. Coprire con test di integrazione subscribe+pick nello stesso batch.
  - `knownEmails` deriva dal registry; `LLMError` → stop batch invariato (D7).
- **File:** `src/channel/email-adapter/message-router.ts`, `src/channel/email-processor.ts`, `src/cli/commands/channel.ts` (wiring: aprire e migrare il DB piattaforma, iniettare registry).
- **Verifica:** TDD — integration test aggiornati/estesi (`tests/integration/email-process.test.ts`): subscribe/unsubscribe a due passi/silenzio/auto-join/post-TT1/ri-iscrizione/subscribe+pick stesso batch; `tests/unit/channel/message-router.test.ts` aggiornato.

### Task 9 — Notifiche (broadcast + riepilogo + filtro account attivo)
- **Contenuto:** iniettare il `PlatformRegistry` nel **Round Manager** e filtrare **TUTTI** i punti di notifica sullo stato `active` dell'account: un account `unsubscribed` o `pending_unsubscribe` non riceve alcuna email. In particolare:
  - `round:open` → `pick_instructions` ai soli partecipanti attivi (`eliminated = 0`) **e** account `active`;
  - `round:close` → `pick_missing_elimination` ai soli account `active`;
  - `round:score` → `round_result_correct`/`round_result_wrong` ai soli account `active`;
  - `round:score` alla transizione `closed→scored` (e solo lì): email `round_closed_survived` ai **soli sopravvissuti** (`eliminated = 0`) con account `active`, poi `summary_sent = 1` (migrazione Task 7); il riepilogo NON parte nelle riaperture di `round:score` (idempotente);
  - `tournament:start` → dopo le scritture atomiche, email `tournament_open` a tutti gli `activeEmails()` (canale+generatore iniettati; no-op se assenti — la CLI `tournament:start` cabla GIÀ le componenti email via `makeGameContext()`/`attachEmailToContext` in `src/cli/commands/tournament.ts`: serve solo iniettare il registry nel contesto e aggiungere il broadcast in `startTournament`).
  `getActiveProfiles`/`notify` diventano consapevoli del registry. `tournament:status` riallineato: niente "finestra di iscrizione", esposto il conteggio iscritti piattaforma dal registry.
- **File:** `src/game/tournament.ts`, `src/game/round-manager.ts`, `src/cli/commands/tournament.ts` (cablare email su `tournament:start`).
- **Verifica:** TDD — unit/integration: destinatari corretti (esclusi eliminati e non-partecipanti dai round; tutti gli iscritti attivi all'apertura; `unsubscribed` e `pending_unsubscribe` esclusi da OGNI email), unico invio del riepilogo, esito specificato; `npm test`, typecheck, lint.

### Task 10 — Scheduler + simulazione + env di test
- **Contenuto:** `src/game/scheduler.ts`: rimuovere azioni `register_close_auto`/`register_close_safety` e relativi rami (nessuna finestra di iscrizione) e **rimuovere qui** gli stub `@deprecated` `openRegistration`/`closeRegistration`/`registerPlayer` (ora che `simulation.ts`/`scheduler.ts` sono riscritti: build verde a ogni task); `scheduler:status` senza `registrationOpen` (o con conteggio iscritti dal registry). `src/game/simulation.ts` + `src/cli/commands/simulate.ts`: riscrivere `registerSimPlayers` — il seed crea gli **account piattaforma** (via registry su `PLATFORM_DB_PATH` dedicato), i **profili** nascono via **auto-join al primo pick** del round di avvio (TT1) in `simulateRound`, non più creati dal seed; `simulate:*` usa un `PLATFORM_DB_PATH` **dedicato e distinto** da quello di produzione (mai `./data/platform.db`). Aggiungere `PLATFORM_DB_PATH` dedicato ai file reali `.env.uat`/`.env.uat-replay` e agli esempi versionati `.env.uat.example`/`.env.uat-replay.example` (estensione di `.env`; `tests/unit/env-examples.test.ts` copre gli esempi); **guardia in `simulate:*`**: rifiutare/avvisare se `PLATFORM_DB_PATH` coincide col valore di produzione; il determinismo di `register_id` (RNF1) richiede un **DB piattaforma pulito** tra due run. `src/cli/email-wiring.ts`: esporre il wiring del registry.
- **File:** `src/game/scheduler.ts`, `src/cli/commands/scheduler.ts`, `src/game/simulation.ts`, `src/cli/commands/simulate.ts`, `.env.uat`, `.env.uat-replay`, `src/cli/email-wiring.ts`.
- **Verifica:** `tests/unit/scheduler.test.ts` e `tests/unit/cli/scheduler-tick.test.ts` aggiornati (niente azioni finestra, niente stub deprecati); `tests/integration/season-sim.test.ts` verde (export deterministi, RNF1, anche con registry e DB piattaforma pulito); test della guardia `simulate:*` (rifiuto/avviso su `PLATFORM_DB_PATH` di produzione).

### Task 11 — Test finale, stato progetto, env reali, documenti operativi
- **Contenuto:** copertura complessiva (regressione completa: le regole di gioco non cambiano); aggiornare `.env` reale (fuori git) con `PLATFORM_DB_PATH`; `AGENTS.md` §1.6/§1.7 (mappa documenti + stato) e `agent-context/current-status.md` (changelog); chiudere il punto 3 della review (riepilogo chiusura round). Aggiornare `docs/uat/guida-test-mode.md` (flusso di iscrizione piattaforma, nuovi `platform:*`, matrice notifiche, esempi copia-incolla SENZA `tournament:register:open/close`); aggiornare `docs/system-components.md` + `docs/system-components.excalidraw` (rinominare `autoRegisterFromPick` → `autoJoinFromPick`, rimuovere `REGISTRATION_KEYWORDS`/`openRegistration`/`closeRegistration`, aggiungere **Platform Registry** e **Intent Classifier**).
- **File:** `AGENTS.md`, `agent-context/current-status.md`, `.env`, `docs/uat/guida-test-mode.md`, `docs/system-components.md`, `docs/system-components.excalidraw`.
- **Verifica:** `npm test` (intera suite verde), `npm run typecheck`, `npm run lint`; smoke manuale su DB dedicati `/tmp` (subscribe→pick→close→score con riepilogo; replay 2025 con `.env.uat-replay`).

## 5. Rischi e mitigazioni

- **Nota informativa (HIGH-4):** nessun impatto su sistemi in esercizio — il sistema non è in produzione; non esistono tornei reali in corso né giocatori reali da ri-registrare al momento dell'upgrade.
- **Contratto LLM ampliato (intento)** — misclassificazione iscrizione/disiscrizione: mitigato da conferma via email + re-iscrizione banale (stesso `registerID`) + barriera deterministica sul pick (ADR-004) + **barriera a due passi per la disiscrizione** (decisione 3). Test contract per ogni intento.
- **Silenzio per sconosciuti** — nessun feedback: voluto (anti-spam), accettato dalla review.
- **Riepilogo alla transizione `scored`** — il riepilogo `round_closed_survived` va ai soli sopravvissuti; gli eliminati ricevono solo le email puntuali (`pick_missing_elimination`/`round_result_wrong`): nessuna duplicazione (decisione 7, opzione B della review).
- **Due connessioni** — rischio di dimenticare `platform` in qualche comando: `channel:email:process`/`simulate:*` lo richiedono (errore esplicito se assente); i comandi che non toccano la piattaforma restano invariati.
- **TEST_MODE** — DB piattaforma dedicato in `.env.uat`/`.env.uat-replay`; mai toccare la piattaforma reale in test.
- **Migrazione colonne** — solo `ALTER TABLE ADD COLUMN` guardato (pattern ADR-008); nessuna perdita dati su DB esistenti.
- **Disiscrizione a torneo in corso** — il profilo resta attivo ma "muto": se il giocatore non si re-iscrive, viene eliminato `missing_pick` alla chiusura del round; comportamento deterministico e coperto dai test del Task 8.

## 6. Fuori scope (esplicito)

- **Chiusura automatica del torneo sul vincitore** + email di riepilogo col nome del vincitore (punto 8 della review): task separato successivo (appendice).
- Quota/pagamento reale (Fase 1): solo la predisposizione del gate in lettura.
- Canali multipli, profili multipli, tornei contemporanei.
- Migrazione dati da DB torneo esistenti.

## 7. Domande aperte (per l'implementatore, non bloccanti)

- Nessuna decisione normativa aperta. Punto operativo: conferma con l'utente dei testi dei nuovi template.

## Appendice — Task separato (dopo questo piano): chiusura automatica sul vincitore

Quando il Winner Engine calcola uno o più vincitori, il torneo si chiude **immediatamente e automaticamente** e viene mandata una email di riepilogo col nome del vincitore a **tutti coloro che hanno inviato almeno un pick al torneo**. Da pianificare a parte, a chiusura del task principale.

---

## Note di processo

- **Branch:** implementare su un nuovo `feat/iscrizione-piattaforma` da `main` (AGENTS.md §7.3), NON sul branch `docs/adr-platform-registration`.
- **Nota worktree:** su `main` esiste una modifica non committata a `docs/uat/timeline-example.excalidraw` (non correlata): da separare/gestire prima del merge.
- **Convenzioni:** AGENTS.md §5 (commenti obbligatori su parametri/funzioni/file), §6 (skill TDD/incremental), log in inglese, nessun commit su `main`, test prima del commit.
