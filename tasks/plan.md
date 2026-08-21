# Piano di implementazione POC — Survivor League

## Contesto

Implementazione della POC secondo PRD v0.5.2 / HLD v0.4.2 / LLD v0.4.0. La verifica di coerenza dei tre documenti ha evidenziato 3 gap funzionali, 4 ambiguità e disallineamenti minori: tutti risolti dalle decisioni sottostanti, applicate ai documenti nel Task 0.

Dal **2026-08-14** questo piano integra anche i requisiti dell'**aggancio asincrono del torneo** (ADR-008, RF-20…31, CL11–18), definiti nel piano dedicato `tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md` — questa è la **sorgente dei nuovi requisiti**; il documento `plan.md` resta l'unica roadmap di implementazione. I documenti sono già allineati (PRD 0.5.2, HLD 0.4.2, LLD 0.4.0) e la **migrazione `tournament_state.start_round`** è già applicata in `src/db/schema.ts` (migrazione additiva idempotente, verificata su DB pre-esistente). I moduli torneo/registrazione non sono ancora implementati: i requisiti sono fusi nei Task sotto senza rework.

## Decisioni confermate (2026-08-13)

1. **Codice nella root del repo** `/home/fulvio/dev/SurvivorLeague` (la radice `survivor-league/` dell'albero LLD §5 = root del repo).
2. **Dati stagione via API football-data.org**: niente file statici pre-scaricati. `data:import`/`data:refresh` chiamano l'API (header `X-Auth-Token`, token in env `FOOTBALL_DATA_TOKEN`) e fanno upsert nella tabella `match`. Il Game Engine legge **solo dal DB** tramite un'unica implementazione `DbSeasonDataProvider` dell'interfaccia `SeasonDataProvider` (LLD §6.1): il client API (`FootballDataClient`) è usato solo dai comandi `data:*`. Niente `StaticProvider`. Registrare **ADR-007** (append-only) per questo cambio rispetto ad ADR-005.
3. **Cleanup**: eliminare `serie_a_2025_26.json`, `fetch_serie_a.py`, `footballdata.org` (quest'ultimo contiene il token in chiaro: salvare prima i link utili alla documentazione in LLD §6.1). Il **token football-data.org verrà fornito dal PO** come env var `FOOTBALL_DATA_TOKEN` al momento dell'uso; `.env` è in `.gitignore` fin dal Task 1.1. **Git**: il repo viene inizializzato solo a fine piano (primo commit alla conclusione dell'iterazione); al checkpoint finale verificare che `.gitignore` escluda `.env`, `data/`, `node_modules/`.
4. **Frozen re-score (gap 1)**: `round:score` processa, oltre ai pick `pending`, anche i pick `frozen` la cui partita ora ha punteggio (→ `correct`/`wrong`, eliminazione a posteriori). Lo scheduler a ogni tick esegue `data:refresh` e invoca `round:score` sui round `closed` e sui round `scored` con pick `frozen` (`SELECT DISTINCT round FROM pick WHERE status='frozen'`). Nessuna data di recupero, nessuna nuova tabella.
5. **Risoluzione nomi squadra via LLM (gap 2), responsabilità del Parser (I/O, ADR-004)** — niente alias map in codice:
   - Il prompt del Parser include: testo email + **lista canonica delle squadre da `SeasonDataProvider.getTeams()`** (data-driven: i cambi di squadra stagionali non richiedono modifiche al codice) + contenuto di `src/llm/team-aliases.md` (file Markdown **editabile a mano** con alias noti: "Juve → Juventus FC", ecc.).
   - L'LLM restituisce `team` come **esatto nome canonico dalla lista** (JSON schema/enum se supportato); ambiguo/non riconducibile → `null`.
   - **Check deterministico post-parse**: il Game Engine accetta solo exact-match sulla lista canonica; altrimenti tratta come `null` (rifiuto con richiesta di chiarimento, CS7). L'LLM propone, il check dispone: nessun nome inventato entra nello stato di gioco.
6. **Export/audit (gap 3)**: `tournament:export` minimale — dump JSON di tutte le tabelle + metadati (timestamp, parametri derivati). Usi: verifica determinismo simulazione (diff tra run), trasparenza verso giocatori, audit pre/post correzioni.
7. **Registrazione pick (ambiguità 4)**: il pick è registrato e la squadra bruciata **all'invio valido** (PRD §4.3); `round:close` *consolida* (elimina i mancanti, notifica) senza registrare nulla. Correggere PRD §4.4 passo 2 e HLD §6.3.
8. **Rinvii in POC (ambiguità 5)**: niente `rescheduled_date`; regola operativa = nota CRITICAL-02 (punteggio presente → contabilizza; `postponed` senza punteggio → frozen; altrimenti resta `pending`). CL7 emerge dai dati (recupero giocato appare col punteggio). Dichiararlo esplicitamente in LLD §3.1.
9. **`pick:register` (ambiguità 6)**: valida sempre (stesse regole dei pick automatici, US10); rimuovere la nota "salta validazione se già fatta".
10. **Eliminazione (ambiguità 7)**: aggiungere a `profile` le colonne `eliminated_at TEXT` e `eliminated_reason TEXT` ('missing_pick' | 'wrong_pick'); `elimination:list` le espone.
11. **Simulazione**: giocatori simulati con pick **deterministici seeded** (RNG mulberry32; squadra random tra le disponibili, esito random); numero profili configurabile (env `SIM_PLAYERS`, default 10); `receivedAt` forzabile per scavalcare la deadline.
12. **Default adottati per domande aperte PRD §13** (modificabili): ~~apertura primo TT manuale via `round:open`~~ → **superata (2026-08-14, ADR-008/RF-23): il primo TT si apre all'apertura del torneo, domanda §13.1 risolta**; email di apertura round con **solo squadre disponibili** del profilo; passaggio a Freeze **notificato** con template `pick_postponed` (già previsto in LLD §6.3).

## Decisioni aggancio asincrono (ADR-008, 2026-08-14) — fonte: tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md

Sintesi delle 8 decisioni bloccate (dettaglio in ADR-008, PRD v0.5.2 RF-20…31/CL11–18, LLD v0.4.0):

1. **Override US10 auditato**: iscrizione/pick manuali fuori finestra solo con `--reason` obbligatorio (log strutturato); pick manuale solo su round corrente non contabilizzato; round `scored` → flusso CL9; nessuna retroattività; nuovo iscritto parte dal round corrente con pool intatto (fairness dichiarata).
2. **Dati full-season**: derivazioni data-driven sull'intera stagione; la finestra torneo `[start_round..N]` è un filtro logico.
3. **CL12** (aggancio all'ultimo TC): ammesso con warning informativo a `tournament:start`; i 3 casi di vittoria collassano.
4. **Mappatura derivata**: `tournament_state.start_round INTEGER NULL` (NULL = TC1 legacy); `TT = TC − start_round + 1`; nessuna colonna `tt`.
5. **Token `TTnTCm`**: oggetto/CLI compatti; corpo email esteso; log `{tt, tc}`; coppia **iniettata deterministicamente** nei template, mai dall'LLM (ADR-004).
6. **Chiusure con fallback**: iscrizione auto-chiusa alla deadline del TT1 (RF-22) + chiusura forzata `tournament:register:close --reason` (RF-28); `round:close --force --reason` (RF-29, stessa semantica consolidamento); **chiusura di sicurezza** allo scadere del TC se deadline NULL (`safety_close`, RF-30); **invariante anti-frode**: accettazione = `min(deadline, kickoff effettivo)` (RF-31, prevale su RF-14 in caso di anticipo, CL18).
7. **Auto-iscrizione RF-27**: nel TT1 un pick interpretabile da mittente sconosciuto → profilo+pick atomici; non interpretabile → chiarimento senza registrazione (CL5); dal TT2 → rifiuto senza registrazione (RF-24).
8. **Seam eligibilità**: `checkEligibility(ExternalIdentity) → {eligible, reason?}` gate pre-registrazione; impl POC sempre `true` + log; Fase 1 quota (`ENTRY_FEE_EUR`); "identità fornita dal canale" invece di "email = identificativo".

## Impatto del piano "aggancio asincrono" su questa roadmap (revisione 2026-08-14)

Esito della revisione della roadmap alla luce del piano aggancio (`tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md`):

- **Riordino / dipendenze — nessun riordino necessario.** I requisiti aggancio toccano moduli non ancora implementati (Fase 3-7), il cui ordine resta invariato. La migrazione `start_round` (già applicata) estende il Task 1.3 completato senza nuove dipendenze; il solo prerequisito tecnico nuovo (kickoff effettivo per il guard RF-31) è già coperto da `getFirstMatchDateTime()` nel Task 2.2.
- **Nuove attività — assorbite nei Task esistenti** (nessun nuovo numero di task): guard anti-frode RF-31 e auto-iscrizione RF-27 (Task 3.2/4.2/6.2); chiusure forzate `round:close --force --reason` (3.5) e `tournament:register:close --reason` (4.2); finestra iscrizione ancorata al TT1 (4.2); seam eligibilità (4.2, §6.5 LLD); coppia TT/TC iniettata (3.5/4.1/5.2/6.1); simulazione con offset `--start-round` (7.1); scheduler con finestra `[start_round..N]` e chiusura di sicurezza RF-30 (7.2); casi di test in LLD §8.1.
- **Impatti sui task già pianificati:** Fase 1-2 invariate (solo la colonna già migrata); Fase 3-7 estese come sopra; risk register e tabella mock/UAT aggiornati; checkpoint 1/3/finale estesi.
- **Regressioni:** nessuna sul flusso legacy — vincolo di regressione esplicito al Task 7.1 (`simulate:full` da TC1 invariato, CS3/RNF1); migrazione additiva provata no-op su DB senza colonna.
- **Coerenza:** versioni documenti allineate (PRD 0.5.2 / HLD 0.4.2 / LLD 0.4.0); la decisione 12 del 2026-08-13 è parzialmente superata (apertura primo TT, RF-23).

---

## Task 0 — Allineamento documenti e cleanup

**Descrizione:** applicare le decisioni 1-12 ai documenti prima di scrivere codice; eliminare i file di prova.

- LLD: §1.1 (round:score esteso ai frozen; contratto Parser con lista canonica + check esatto post-parse), §1.4 (tick: `data:refresh` + round `closed` e `scored`-con-frozen), §3 (colonne `eliminated_at`/`eliminated_reason`; nota rinvii POC), §4.3 (env: `FOOTBALL_DATA_TOKEN`, `FOOTBALL_DATA_BASE_URL`, `FOOTBALL_DATA_COMPETITION=SA`, `FOOTBALL_DATA_SEASON=2025`; rimuovere `CALENDAR_PATH`/`RESULTS_PATH`), §5 (radice = root repo; fix indentazione `tournament.ts`), §6.1 (`DbSeasonDataProvider` + `FootballDataClient`; rimuovere `StaticProvider`; link documentazione provider), §6.2 (prompt Parser con lista canonica da `getTeams()` + `team-aliases.md`; output vincolato; check deterministico post-parse), §7.2 (`data:import`/`data:refresh` da API), §7.3 (nota frozen su `round:score`), §7.4 (validazione sempre attiva), §7.10 (aggiungere `tournament:export`), §8 (distinzione mock solo nei test automatizzati / UAT senza mock), refuso "Deadine".
- PRD: §4.4 passo 2 (registrazione all'invio; alla deadline si consolida), fig. 4.5a (etichette coerenti).
- HLD: §6.3 (close consolida, non registra), §6.4 (frozen rivalutati da round:score), §3 refuso "CLU", §7.1 (provider in POC).
- ADR: append **ADR-007** (import dati via API football-data.org nella POC; `DbSeasonDataProvider` unica implementazione; `FootballDataClient` con gestione throttling header).
- AGENTS.md: "Stato attuale" → POC in implementazione; riferimenti versioni documenti (PRD 0.5.0, HLD 0.4.0, LLD 0.2.0+); stack invariato.
- Eliminare `serie_a_2025_26.json`, `fetch_serie_a.py`, `footballdata.org`.

> **Estensione (2026-08-14):** l'allineamento documenti è stato completato in due passate: Task 0 sopra (decisioni 1-12) e, successivamente, l'allineamento all'aggancio asincrono eseguito dal piano `tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md` — ADR-008, PRD 0.5.2 (RF-20…31/CL11–18), HLD 0.4.2, LLD 0.4.0; colonna `tournament_state.start_round` migrata in `src/db/schema.ts` (migrazione additiva idempotente, Task 1.5 del piano aggancio — già applicata).

**Verifica:** grep senza risultati per `StaticProvider`, `CALENDAR_PATH`, `calendar.json` nei documenti aggiornati; documenti internamente coerenti.

---

## Fase 1 — Scheletro del sistema

### Task 1.1 — Bootstrap progetto
package.json alla root (script: `cli`, `build`, `test`, `lint`, `typecheck`), TypeScript strict, eslint+prettier, vitest, yargs bootstrap, `.env.example`, `.gitignore` (`node_modules/`, `data/`, `.env`), directory tree `src/` e `tests/` secondo LLD §5 aggiornato.
**Verifica:** `npm run typecheck`, `npm run lint`, `npm test` (vuoto, verde), `npm run cli -- --help` risponde.

### Task 1.2 — Configurazione e logging
`src/config.ts` con zod (tutte le env di LLD §4 aggiornate, incluse `FOOTBALL_DATA_*`, `SIM_PLAYERS`); fallimento esplicito all'avvio se manca una richiesta. Logger pino.
**Verifica:** unit test config (default applicati; variabile richiesta mancante → errore chiaro).

### Task 1.3 — Database
`src/db/connection.ts` (better-sqlite3), `src/db/schema.ts` (DDL: `player`, `profile` + `eliminated_at`/`eliminated_reason`, `pick`, `match`, `round_state`, `tournament_state`), comando `db:migrate`.
**Verifica:** migrate crea il DB; test integrazione: `UNIQUE(profile_id, round)` su `pick` respinge il duplicato (base CL6).

> **Estensione (aggancio, ADR-008):** lo schema include `tournament_state.start_round INTEGER` (NULL = TC1 legacy) con **migrazione additiva** idempotente (`ALTER TABLE … ADD COLUMN` condizionato da `PRAGMA table_info`): un DB pre-esistente la riceve senza perdere dati. **Già applicata** in `src/db/schema.ts` (Task 1.5 del piano aggancio) con test dedicati.

**Checkpoint 1:** typecheck/lint/test verdi; CLI risponde; DB creato da migrazione; colonna `start_round` presente.

---

## Fase 2 — Dati stagione

### Task 2.1 — FootballDataClient
Client HTTP per `GET /v4/competitions/{competition}/matches?season={season}` (competizione/stagione da `FOOTBALL_DATA_*`, mai `SA`/`2025` hardcodati): header `X-Auth-Token`; gestione throttling (legge `X-RequestsAvailable`, su 429 attende `X-RequestCounter-Reset` — espresso in **secondi** → ×1000 ms — max 3 retry); parsing risposta → `Match[]`. Mapping status completo (l'API v4 espone `matchday`, non `round`: mappatura `matchday → round`): `POSTPONED`/`SUSPENDED`/`CANCELLED` → `postponed=true`; `FINISHED`/`AWARDED` → punteggi da `score.fullTime`; `SCHEDULED`/`TIMED`/`IN_PLAY`/`PAUSED`/`EXTRA_TIME`/`PENALTY_SHOOTOUT` → `postponed=false` senza punteggio (mai crash). Retry SOLO su 429/5xx/errore di rete, **MAI** su 400/401/403; timeout massimo per richiesta (per non bloccare `data:refresh` dello scheduler); errore → eccezione chiara `FootballDataError` (con status).
**Verifica:** unit test con fetch mockato (200 normale; 429 con header throttling → attesa in secondi; 5xx → retry; 401/403 → errore senza retry; body malformato / chiave `matches` mancante → errore chiaro; timeout).

### Task 2.2 — DbSeasonDataProvider
Implementazione dell'interfaccia `SeasonDataProvider` (LLD §6.1) che legge dalla tabella `match`: `getCalendar`, `getMatchesForRound(round)` (primario per il Round Manager — `getResults(round)` è stata **rimossa** dall'interfaccia perché ridondante, LLD §6.1), `getFirstMatchDateTime(round)`, `getTeams` (UNION di home/away), `getTotalRounds`. `getFirstMatchDateTime(round)` serve sia per la deadline sia per il **kickoff effettivo** del guard anti-frode (RF-31): semantica per i match rinviati (fissata in Fase 2) = `MIN(match_date)` **tra i match NON rinviati** del round; se tutte rinviate → `MIN` programmato dell'intero round (fallback documentato: kickoff effettivo non noto a priori, il caso non calcolabile è coperto dalla chiusura di sicurezza RF-30/CL17); round senza partite → `SeasonDataError` (briefing §3-B).
**Verifica:** unit test su SQLite in-memory con le fixture sintetiche di `tests/fixtures/` (loader e mini-stagione base creati in questo task; il Task 2.5 estende con le varianti rinvii — ordine allineato al briefing §3-F).

> **Nota aggancio (ADR-008):** import e derivazioni operano **sull'intera stagione**; la finestra torneo `[start_round..N]` è un filtro logico (LLD §3.2), quindi non cambiano né query né confini.

### Task 2.3 — Comandi data:*
`data:import` (fetch API → upsert `match`, idempotente), `data:refresh` (stessa logica, per aggiornare risultati durante il gioco), `data:calendar`, `data:results --round <n>`.
**Verifica:** test integrazione con client mockato: import popola N righe; secondo import senza duplicati né modifiche; refresh che aggiunge un punteggio aggiorna la riga.

### Task 2.4 — Alias squadre (risorsa del Parser)
`src/llm/team-aliases.md`: alias italiani noti per le 20 squadre 2025/26 (es. "roma"→"AS Roma", "inter"/"l'inter"→"FC Internazionale Milano", "juve"→"Juventus FC"), in Markdown editabile a mano. Il file è una **risorsa del prompt**, non codice: la risoluzione vera la fa l'LLM (Task 5.1); il check esatto post-parse resta deterministico.
**Verifica:** il file copre tutte le 20 squadre canoniche (nomi `name` dell'API, non `shortName`/`tla`); caricabile e iniettabile nel prompt; test che i nomi canonici coincidano con `getTeams()` del DB importato (fixture con nomi reali, Task 2.5).

### Task 2.5 — Fixture sintetiche per i test
`tests/fixtures/`: mini-stagione (4 squadre, 6 round, date fittizie) + varianti con rinvii: recupero giocato (CL7), recupero fuori finestra non ancora giocato (CL1), UPP rinviata (CL8), recupero giocato dopo chiusura TT (frozen→valutato).
**Verifica:** le fixture si caricano nel DB in-memory dei test.

**Checkpoint 2:** import da API (mock) → DB → provider funzionante; alias e fixture pronte.

---

## Fase 3 — Game Engine (TDD)

### Task 3.1 — Rules Engine
Parametri data-driven (LLD §3.2), confine girone `ceil(N/2)`, squadre bruciate/disponibili per profilo+girone (i `frozen` contano come bruciate), `check-half`. Comandi `rules:*`.
**Verifica:** unit test: confine andata/ritorno, azzeramento pool al ritorno, RF-19 (nessuna costante hardcodata).

### Task 3.2 — Pick Processor
Validazione a cascata con motivo dedicato (profilo iscritto e attivo, o **auto-iscrizione RF-27 nel TT1** se il mittente è sconosciuto; **nome squadra canonico** dal Parser, verificato con exact-match sulla lista canonica da `getTeams()`; squadra in partita nel round; non bruciata nel girone; esito valido; nessun pick esistente per profilo+round; `receivedAt <= deadline`). **Guard anti-frode (RF-31):** l'accettazione è `min(deadline registrata, fischio d'inizio effettivo della prima partita del TC)` — un pick oltre il kickoff effettivo è rifiutato (CL17/CL18) con motivo esplicito; rimedio = override US10 con `--reason`. Il kickoff effettivo viene da `getFirstMatchDateTime(round)`, che esclude i match rinviati (`MIN(match_date)` dei non rinviati; semantica fissata in Fase 2, Task 2.2). `register` atomico (vincolo UNIQUE). Comandi `pick:*`.
**Verifica:** unit test per ogni motivo di rifiuto (CL3/CL4/CL5/RF-08/RF-10/RF-11); test concorrenza CL6 (due insert, uno solo passa); CS4 (`receivedAt` forzato).

### Task 3.3 — Elimination Engine
Eliminazione per pick mancante (alla chiusura) e pick sbagliato (alla contabilizzazione), con `eliminated_at`/`eliminated_reason`. Comandi `elimination:*`.
**Verifica:** unit test entrambi i casi; profilo eliminato non può più inviare pick.

### Task 3.4 — Winner Engine
Tre casi di fine torneo (PRD §4.6); profilo con frozen non contabilizzato resta in gara. Comando `winner:check`.
**Verifica:** unit test dei tre casi + caso frozen a fine stagione (CS6).

### Task 3.5 — Round Manager
`round:open` (deadline = `MIN(match_date)` del round − anticipo, **fissa**; crea `round_state`; invia email pick ai profili attivi via ChannelAdapter+LLM **mockati**), `round:close` (elimina mancanti + notifica; consolida), `round:score` (incrementale: `pending` con punteggio → `correct`/`wrong`; `postponed` senza punteggio → `frozen`; `frozen` con punteggio ora disponibile → valutato, eliminazione a posteriori; round → `scored` quando nessun `pending`), `round:status`, `round:deadline`. Email di riepilogo a ogni valutazione.
**Aggancio (ADR-008):** `round:close --round <n> --force --reason <motivo>` con **stessa semantica di consolidamento** (elimina i mancanti + notifiche; non esiste "chiudi senza eliminare"; RF-29); la deadline del TT 1 chiude anche la finestra di iscrizione (RF-22); `round:deadline` espone deadline e kickoff effettivo (istante di accettazione, RF-31); email con coppia TT/TC iniettata (RF-25).
**Verifica:** `tests/integration/round-flow.test.ts` (open → pick → close → score) su DB in-memory; idempotenza di `round:score` ripetuto (RF-17); CL1/CL7/CL8 sulle fixture sintetiche; frozen valutato a recupero concluso (Task 2.5); chiusura forzata con/senza `--reason` (RF-29).

**Checkpoint 3:** engine completo, CS2/CS4/CS5/CS6 verdi; **guard anti-frode RF-31 unit testati (pick oltre kickoff effettivo rifiutati)**; logica di gioco interamente fuori da canale e LLM (mock).

---

## Fase 4 — Torneo (vista aggregata)

### Task 4.1 — Avvio stagione e stato
`tournament:start [--start-round <n>]` (verifica calendario presente/completo/coerente; deriva parametri; inizializza `round_state` pending; `season_started=1`; fallisce senza stato parziale), `tournament:status`, `tournament:history <email>`, `tournament:leaderboard`, `tournament:export` (dump JSON tabelle + metadati).
**Aggancio (ADR-008):** `--start-round <n>` (default 1) fissa `tournament_state.start_round`; validazioni RF-21 (TC esistente, con partite, deadline TT1 futura → rifiuto **atomico** senza stato parziale; aggancio all'ultimo TC → warning informativo CL12); da `start_round` si deriva la mappatura `TT = TC − start_round + 1` usata in output/email/log (RF-20/25); `tournament:status` espone anche le anomalie delle chiusure di sicurezza non applicabili (RF-30).
**Verifica:** avvio con calendario incoerente → errore e DB invariato (US6); export completo e rileggibile; aggancio valido/invalido su fixture (CL11/CL12/CL13/CL14, RF-21).

### Task 4.2 — Fase di iscrizione e auto-iscrizione
`tournament:register:open [--contacts <file>]` (notifica best-effort alla lista, una sola volta), `tournament:register:close [--reason <motivo>]`, `tournament:register --email [--name] [--reason <motivo>]` (manuale, univocità email/profilo). **Finestra agganciata (ADR-008/RF-22):** il gate è `registration_open=1` sull'intervallo `[apertura torneo, deadline TT1]`; auto-chiusura alla deadline del TT1; chiusura forzata anticipata o con deadline TT1 assente via `--reason` (RF-28, obbligatorio e auditato; finestre iscrizione/pick indipendenti). **Auto-iscrizione (RF-27):** nel TT1 un pick interpretabile da mittente sconosciuto → creazione profilo + validazione pick **atomiche**; non interpretabile → chiarimento senza profilo (CL5); dal TT2 → rifiuto senza registrazione (RF-24). **Eligibilità (ADR-008):** `checkEligibility(ExternalIdentity)` invocata a ogni registrazione (impl POC `true` + log); override passa per la stessa funzione con esito forzabile + motivo.
**Verifica:** test CL2 (auto-iscrizione TT1 / rifiuto dal TT2), CL5 (nessun profilo creato), CL10/CL16; auto-chiusura alla deadline TT1; chiusura forzata con/senza `--reason`; univocità su invii concorrenti (RNF2); eligibilità loggata.

---

## Fase 5 — LLM Adapter

> **Decisioni D1–D9 applicate (2026-08-14, briefing-fase-5-6.md §0):** D1 subject opzionale (`sendMessage(to, body, subject?)` + `EmailContext.subject?` + helper deterministico `subjectFor`); D2 interfaccia Parser con `{teams, aliases}` per chiamata e `PickExtraction` unica in `src/llm/parser.ts`; D3 `LLMError` (trasporto/HTTP/timeout) ≠ `null` (contenuto); D4 segnaposto `{{TT_TC}}`/`{{TTTC}}` nei template, sostituzione post-generazione (mai numeri nel prompt, RF-25); D9 formato date it-IT / fuso fisso Europe/Rome.

### Task 5.1 — LLM Parser
Client API OpenAI-compatibile (modulo condiviso `src/llm/openai-client.ts` con Parser e Generator, `LLMError` per trasporto/HTTP/timeout — D3); prompt di sistema per estrazione `{team, outcome}` che include: lista canonica delle squadre (da `getTeams()`, **iniettata per chiamata** — D2) + contenuto di `team-aliases.md`; output validato zod con `team` vincolato alla lista (JSON schema/enum se supportato); `null` su ambiguo/irriconoscibile (mai eccezioni per il contenuto, CS7); **filtro deterministico esatto nel Parser** (squadra fuori lista → `null`) come prima barriera, check del Game Engine come seconda (difesa in profondità). Comando `llm:parse`.
**Verifica:** contract test con HTTP mockato (estrazione valida con nome canonico; risposta con squadra fuori lista → rifiutata dal check; risposta ambigua → null; input malformato → null senza crash, CS7; 401/429/timeout → `LLMError`; prompt contiene lista e alias).

### Task 5.2 — LLM Generator + templates
Generator per gli 12 `EmailType` (LLD §6.3; il nuovo `auto_registered` — D5 — copre l'auto-iscrizione RF-27 con un unico messaggio), testo in italiano, template di sistema statici (`src/llm/templates.ts`, segnaposto `{{TT_TC}}` — D4). Comando `llm:generate` (output = soggetto `subjectFor` + corpo — D1).
**Aggancio (ADR-008, RF-25):** il contesto (`EmailContext`) trasporta `tt`/`tc` derivati dal Game Engine e iniettati **deterministicamente** nei template (oggetto/CLI forma compatta `TT2TC7` via `subjectFor(ctx)`, corpo forma estesa via sostituzione post-generazione); l'LLM non genera mai i numeri di turno (ADR-004). Date nei testi in formato it-IT con fuso fisso Europe/Rome (D9).
**Verifica:** contract test per ogni tipo (HTTP mockato, testo in italiano, soggetto con forma compatta); nessun accesso a DB/stato; test che il numero TT/TC nel testo email provenga dai dati (iniezione deterministica, RF-25).

---

## Fase 6 — Channel Adapter

> **Decisioni D1–D9 applicate (2026-08-14, briefing-fase-5-6.md §0):** D6 classificazione deterministica del Message Router (noto → pick; ignoto+keyword iscrizione → registration; ignoto → pick) con normalizzazione identità (K); D7 flag `\Seen` solo a successo (fetch di sola lettura, idempotente); D8 "round corrente" del wiring = primo `round_state open` della finestra `[start_round..N]` (rifiuto `round_not_open`, CL3).

### Task 6.1 — EmailAdapter
`imap-client` (imapflow; `receivedAt` = `internaldate`, mai header `Date`; fetch non letti; **non marca nulla** — D7; body via `mailparser.simpleParser` dal sorgente, fallback soggetto), `message-router` (classifica deterministica D6: iscrizione / pick / unknown; mittente noto vs ignoto; **normalizza l'identità in `ExternalIdentity {channel, identifier}`** con `normalizeEmail` — trim, minuscolo, rimozione del nome visualizzato, ADR-008/K), `smtp-client` (nodemailer; `sendMail({from, to, subject, text})`, soggetto dal chiamante — D1). Seam per i test: conn/transport passati come parametri (nessuna rete nei test). Comandi `channel:email:fetch`, `channel:email:send`.
**Verifica:** unit test router (mittente noto/ignoto, keyword iscrizione, normalizzazione indirizzi con display name); integration test con fake IMAP/SMTP (internaldate non Date header; soggetto passato; errore connessione → errore chiaro senza crash CLI).

### Task 6.2 — channel:email:process (wiring end-to-end)
Fetch → router (D6) → "round corrente" = primo `round_state open` della finestra `[start_round..N]` (D8; nessuno → rifiuto `round_not_open` CL3) → iscrizione (con gate finestra; email di benvenuto con formato pick e regole; **eligibilità invocata e loggata**) → pick (parse LLM con lista canonica+alias iniettati per chiamata → check esatto post-parse → **auto-iscrizione RF-27 se mittente sconosciuto nel TT1** con email unica `auto_registered` (D5) → validazione con guard anti-frode RF-31 → registrazione → conferma/rifiuto con motivo). **Flag `\Seen` a successo** (D7): messaggi non processabili (round chiuso) marcati letti per non ripetere il rifiuto a ogni tick; su `LLMError`/errore rete il messaggio resta non letto e il batch si ferma (retry al tick successivo; nessun crash del comando, RNF9). **CL2 aggiornato:** nel TT1 un mittente ignoto con contenuto interpretabile viene auto-iscritto (profilo+pick atomici); contenuto non interpretabile → chiarimento senza profilo (CL5); **dal TT2 un mittente ignoto è respinto senza registrazione** (RF-24, messaggio "torneo iniziato al TT 1 / TC n"). I comandi `round:*`/`tournament:register:*` iniettano le implementazioni reali via helper condiviso (`src/cli/email-wiring.ts`, problema M — niente `getConfig()` nei moduli).
**Verifica:** integration test e2e con adapter fake e LLM mock (CS1 simulato); test CL2/CL5/RF-27/RF-24; guard RF-31 con `receivedAt` forzato (internaldate); **verifica manuale** CS1 con casella Gmail reale prima del collaudo.

---

## Fase 7 — Simulazione e scheduler

**Decisioni di implementazione (R1–R8, confermate 2026-08-14 — dettagli in `tasks/briefing-fasi/briefing-fase-7.md`):**
R1 — i comandi `simulate:*` costruiscono il contesto SENZA channel/generator (nessuna email reale; `notify()` è no-op in assenza). R2 — clock deterministico della simulazione derivato dai dati per fase: open a deadline − 1min, `receivedAt` = deadline − 1min, close a deadline + 1min, score a tcClose + 1min (registrazione profili sim a kickoff TT1 − anticipo − 2min); con clock fisso due run con stessa seed producono export identici (RNF1). R3 — `simulate:full`/`simulate:round` rifiutano se `season_started=1` o esistono round non-pending; profili sim via `registerPlayer` a finestra aperta. R4 — seed default 42 (`--seed <n>`); RNG mulberry32 a mano (funzione pura); iterazione stabile (ORDER BY id/round). R5 — `scheduler:status` = stato COMPUTATO (niente "ultima esecuzione" persistita; audit nel log pino). R6 — `schedulerTick(ctx, deps)` con `deps.refresh` iniettato (CLI: `importMatches`+`FootballDataClient`; test: stub); errore refresh → warn e prosegui (RNF9). R7 — chiusure di sicurezza come LLD §1.4 (eventi `*_safety` con causa `deadline_missing`; TC non calcolabile → evento `warn_not_calculable` + anomalia in `tournament:status`). R8 — moduli `src/game/simulation.ts`, `src/game/scheduler.ts`, `src/cli/commands/simulate.ts`, `src/cli/commands/scheduler.ts`; registrazione in `src/cli/index.ts`; albero LLD §5 aggiornato. **Decisione A (fix determinismo RNF1):** `created_at` di player/profile/pick scritto esplicitamente dal clock iniettato (`insertPendingPick(..., createdAt)`, `registerPlayer`/`autoRegisterFromPick` con `ctx.now.toISOString()`) — il default SQLite `datetime('now')` resterebbe solo come fallback di schema.

### Task 7.1 — Simulazione
`simulate:round --round <n>` e `simulate:full [--start-round <n>]`: registra `SIM_PLAYERS` profili simulati, per ogni round apre → genera pick seeded (mulberry32; squadra random tra disponibili; esito random) → chiude scavalcando la deadline (`receivedAt` finto) → contabilizza → report. Opzione `--seed`; opzione `--start-round <n>` per simulare una **finestra agganciata** `[start_round..N]` (ADR-008, RF-20), con regressione a TC1.
**Verifica:** CS3: `simulate:full` sulla stagione reale importata via API completa i 38 round senza errori; **due run con stessa seed producono `tournament:export` identici** (diff vuoto = RNF1); simulazione agganciata (metà girone, TC20, TC38) idem senza errori (CL13/CL14/CL12); **regressione:** simulazione da TC1 invariata rispetto al comportamento legacy.

### Task 7.2 — Scheduler
`scheduler:tick` (orchestratore sottile, nessuna logica di gioco): se `SCHEDULER_ENABLED=false` esce senza effetti; altrimenti, sulla finestra `[start_round..N]` (ADR-008): auto-chiusura **finestra di iscrizione** alla deadline del TT1 (o chiusura di sicurezza alla chiusura del TC se la deadline TT1 manca); `round:open` al termine del TC precedente (TT1 all'apertura del torneo); `round:close` a deadline scaduta; **chiusura di sicurezza** per round `open` con deadline NULL/non innescata allo scadere del TC ricalcolato dai dati correnti (consolidamento identico, log `safety_close`, causa `deadline_missing`; se non calcolabile → warn + anomalia in `tournament:status`); `data:refresh`; `round:score` su round `closed` e `scored`-con-frozen. `scheduler:status`.
**Verifica:** unit test con clock finto: tick no-op quando non c'è nulla da fare; sequenza corretta di invocazioni; idempotenza; chiusura di sicurezza con deadline NULL (RF-30) e warn se TC non calcolabile.

### Task 7.3 — Operatività
Esempio crontab (commento in `.env.example` o `docs/`), `.env.example` completo di tutte le variabili.
**Verifica:** avvio da `.env.example` compilato fallisce solo per credenziali mancanti, con messaggi chiari.

**Checkpoint finale:** checklist CS1–CS7 (§9 PRD) verificata, inclusi i casi di test dell'aggancio (LLD §8.1: aggancio metà/TC20/TC38, auto-iscrizione, guard anti-frode, chiusura di sicurezza, coppie TT/TC, override con `--reason`); `AGENTS.md` "Stato attuale" aggiornato; code review con skill `code-review-and-quality`.

---

## Rischi e mitigazioni

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Token football-data.org era in chiaro su disco | Alto | File eliminati (Task 0); token fornito dal PO solo via env; `.gitignore` verificato al checkpoint finale prima del primo commit |
| Rate limit API (free tier 10 req/min) | Medio | Throttling header + retry; 1 refresh per tick; import una tantum |
| LLM non deterministico | Medio | Confinato all'I/O (ADR-004); mockato in tutti i test del Game Engine; `null` su ambiguo |
| Stagione reale senza rinvii | Medio | CL1/CL7/CL8 coperti da fixture sintetiche (Task 2.5) |
| Nomi squadra inglesi nei dati vs input italiano | Medio | Risoluzione via LLM con lista canonica nel prompt + `team-aliases.md` editabile + check esatto post-parse (Task 2.4/5.1) |
| Credenziali Gmail (App Password) mancanti | Basso | CS1 manuale rimandato alla configurazione della casella dedicata |
| **Deriva CL2: auto-iscrizione estesa oltre il TT1 (aggancio)** | Medio | Comportamento auto-iscrizione **solo nel TT1**; dal TT2 rifiuto senza registrazione — scritto in CL2/LLD §1.1 e testato (Task 4.2/6.2) |
| **Coppia TT/TC generata dall'LLM (aggancio)** | Medio | Iniezione deterministica nei template da `EmailContext.tt/tc` (ADR-004/008); test che il numero nel testo venga dai dati (Task 5.2) |
| **Deadline NULL / non registrata (aggancio)** | Medio | Guard anti-frode blocca i pick post-kickoff (RF-31) + chiusura di sicurezza allo scadere del TC (RF-30); se non calcolabile → warn + `tournament:status` + chiusura forzata del commissioner (RF-28/29) |
| **Chiusura forzata: eliminazioni anticipate** | Alto | `--reason` obbligatorio e auditato + notifiche ai giocatori; semantica identica alla chiusura a deadline (non esiste "chiudi senza eliminare") |
| **Migrazione start_round su DB esistenti** | Medio | Migrazione **additiva** idempotente (`ALTER TABLE` condizionato da PRAGMA) testata su DB legacy (senza colonna); già applicata |

## Mock e livelli di test

**Principio:** i mock/fake esistono **solo** nei test automatizzati (unit, contract, integration), ai confini esterni. Nell'**UAT (accettazione) nessun componente è mockato**: Gmail reale (IMAP/SMTP), LLM reale, API football-data.org reale, DB SQLite su file reale. I "giocatori simulati" di `simulate:full` **non sono mock**: sono attori sintetici che operano attraverso i comandi CLI reali (ADR-006). La deadline in UAT non si mocka: si scavalca con i comandi CLI del commissioner (PRD §9), funzionalità del sistema.

| Componente | Test automatizzati (unit/contract/integration) | UAT |
|---|---|---|
| LLM Parser | Engine/integration: mock (`PickExtraction` fisso o `null`). Contract: HTTP mockato (200 / ambiguo / malformato / squadra fuori lista) | **Reale** (API LLM) |
| LLM Generator | Integration: mock (stringhe fisse). Contract: HTTP mockato | **Reale** (API LLM) |
| ChannelAdapter / EmailAdapter | Fake in-memory (registra "inviati", fornisce messaggi scriptati); IMAP/SMTP reali mai toccati | **Reale** (Gmail IMAP/SMTP) |
| FootballDataClient | Contract: HTTP mockato (200; 429 con header throttling; errore rete). Integration `data:import`: client mockato | **Reale** (token fornito dal PO) |
| SeasonDataProvider | Non mockato: `DbSeasonDataProvider` reale su SQLite in-memory + fixture sintetiche | **Reale** sul DB popolato da import API |
| Database | Non mockato: better-sqlite3 `:memory:` reale, migrato a ogni test | **Reale**: SQLite su file |
| Deadline / orologio | `receivedAt` forzato (CS4); clock finto per scheduler | Nessun mock: scavalco deadline via CLI del commissioner (PRD §9) |
| Guard anti-frode / kickoff effettivo (RF-31) | Fixture con orari prima partita; `receivedAt` forzato oltre/entro il kickoff; deadline NULL | **Reale** sui dati importati: si verifica con dati + comandi CLI (override con `--reason`) |
| Eligibilità (seam ADR-008) | Impl POC (sempre `true`) unit testata + log; override forzabile con motivo | **Reale**: impl POC attiva in produzione |
| Game Engine | Mai mockato: è l'oggetto sotto test | **Reale** |

## Domande aperte (non bloccanti)

- Account Gmail dedicato e dettagli VPS: da definire con il commissioner prima del deploy (PRD §13.3-13.4).
- Default adottati e modificabili: contenuto email apertura round (solo squadre disponibili); notifica Freeze al giocatore (sì, template `pick_postponed`).

## Strategia di validazione

- `npm test` (vitest: unit + contract + integration su SQLite in-memory) verde a ogni checkpoint.
- `npm run typecheck` e `npm run lint` verdi a ogni task.
- Criteri di successo PRD §9: CS2/CS4/CS5/CS6 in Fase 3 (automatizzati); CS7 nei contract test LLM; CS3 e determinismo (doppio `tournament:export` identico) in Fase 7 come UAT via CLI con import reale da football-data.org; CS1 come UAT manuale end-to-end su Gmail e LLM reali.
- **UAT (nessun mock):**DB e `.env` reali; `data:import` reale; `simulate:full` via CLI; almeno un giocatore reale su casella Gmail per CS1.
- **Requisiti aggancio (ADR-008):** criteri e casi di test dettagliati in `tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md` (Task 7) e LLD §8.1; ogni Task di questo piano che li tocca ne cita il riferimento.

**Riferimenti:**
- `tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md` — sorgente dei requisiti aggancio (8 decisioni, RF-20…31, CL11–18, casi di test).
- ADR-008 (`docs/decisions/architecture-decisions.md`) — contesto/decisione/alternative/conseguenze.
- PRD v0.5.2 / HLD v0.4.2 / LLD v0.4.0 — design allineato.
