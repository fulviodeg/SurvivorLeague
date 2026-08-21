# Briefing — Fase 7 "Simulazione e scheduler" (Task 7.1–7.3)

> Documento di lavoro preparatorio per l'implementatore. Prodotto in modalità
> di sola lettura a partire da: `tasks/plan.md` (Task 7.1–7.3, decisioni 1–12,
> requisiti ADR-008), `docs/POC/POC_LLD.md` (§1.4, §4.4, §5, §7.11–7.12, §8.1),
> `docs/POC/POC_PRD.md` (§9 CS3, §7 RNF1/RNF9, §8 CL12–CL14), `docs/decisions/
> architecture-decisions.md` (ADR-003, ADR-006, ADR-008), stato reale di `src/`
> (`game/tournament.ts`, `game/round-manager.ts`, `game/round-time.ts`,
> `game/turn.ts`, `game/pick-processor.ts`, `game/registration.ts`, `config.ts`,
> `cli/commands/tournament.ts`, `cli/commands/round.ts`, `cli/index.ts`,
> `data/importer.ts`) e `tests/` (pattern `tournament.test.ts`, fixture
> `tests/fixtures/season.ts`).
>
> Obiettivo: elencare **solo** incongruenze, problemi e modifiche necessarie
> emerse dalla verifica di spec, così l'agente che implementa parte dal
> briefing senza rileggere tutto il materiale. **Testo di lavoro non
> autorevole**: i documenti progetto (LLD/PRD) restano la fonte per le
> decisioni; dove il briefing contesta una spec, il punto va risolto su
> `plan.md`/ADR/LLD **prima o durante** l'implementazione.
>
> **Stato:** analisi completata (2026-08-14) — le decisioni R1–R8 (§0) sono
> state **confermate dal PO** prima dell'implementazione; non ci sono blocchi.

---

## 0. Premessa — stato al Checkpoint 4 e decisioni confermate

Tutto ciò che la Fase 7 consumerà esiste già ed è testato al Checkpoint 4
(237 test verdi, typecheck/lint puliti; `.env` reale salvato e validato —
Gmail survivorleague755@gmail.com con App Password testata OK, LLM
OpenRouter, `FOOTBALL_DATA_TOKEN` presente; `data/survivor.db` migrato e
vuoto):

- **Game Engine completo e deterministico:** Round Manager
  (`openRound`/`closeRound`/`scoreRound` con freeze CL1/CL7/CL8, ADR-003),
  Tournament (`startTournament` con seam `allowPastDeadline`, status/history/
  leaderboard/export), Registration (`registerPlayer`/`openRegistration`/
  `closeRegistration`/`autoRegisterFromPick` RF-27), Pick Processor (cascata
  con guard RF-31), Winner Engine (3 casi), Eligibility seam.
- **Clock iniettato (decisione A del briefing Fase 3):** i moduli di gioco
  ricevono `now: Date` nel `GameContext` e non usano mai `new Date()`;
  `eliminated_at`/`opened_at`/`closed_at`/`scored_at`/`exportedAt` derivano
  dal clock.
- **Derivatori di tempo puri:** `computeDeadline(kickoff, advanceMin)` e
  `computeTcClose(matches, durationMin, skewMin)` in `src/game/round-time.ts`
  (restituisce `null` se il round non ha partite).
- **Config completa:** `SIM_PLAYERS` (default 10), `SCHEDULER_ENABLED`
  (default `false`), `SCHEDULER_TICK_MIN` (default 1), `SCHEDULER_AUTO_SCORE`
  (default `true`) già in `config.ts` e `.env.example` (§4.4).
- **Pattern CLI consolidato** "la CLI inietta": ogni comando costruisce
  `{ db, dataProvider, config, now }` con `getConfig()` e passa il contesto al
  modulo di gioco; i comandi che notificano (`round:*`, `tournament:*`)
  iniettano le componenti email reali via `attachEmailToContext`
  (`src/cli/email-wiring.ts`). **Nessun modulo chiama `getConfig()`.**
- **Fixture stagione riusabile:** `tests/fixtures/season.ts` (4 squadre, 6
  round: 3 andata + 3 ritorno, kickoff TC1 = 2026-09-12T16:00Z) + helper di
  mutazione (`setScore`/`setPostponedFlag`/`setMatchDate`).
- **`data:refresh` orchestrale:** `importMatches(db, client)` in
  `src/data/importer.ts` (client iniettato: il CLI costruisce
  `FootballDataClient` dalla config; i test passano uno stub).

**Decisioni R1–R8 confermate dal PO (2026-08-14):**

- **R1 — Contesto senza canale.** I comandi `simulate:*` costruiscono il
  contesto di gioco SENZA `channel`/`generator` (nessuna email reale in
  simulazione): `notify()` è già no-op in assenza (round-manager.ts). Niente
  `attachEmailToContext` nei comandi di simulazione.
- **R2 — Clock deterministico derivato dai dati.** Il clock della simulazione
  NON è un parametro: è derivato dai dati per fase — `open` a
  `deadline − 1min`, `receivedAt` dei pick = `deadline − 1min`, `close` a
  `deadline + 1min`, `score` a `tcClose + 1min`. Con clock fisso due run con
  stessa seed producono `tournament:export` identici (RNF1, diff vuoto della
  verifica). La deadline è calcolata da `openRound` (kickoff − anticipo) e
  riletta da `round_state`; il tcClose da `computeTcClose` sui dati correnti.
- **R3 — Guardie di sicurezza.** `simulate:full`/`simulate:round` rifiutano
  se `season_started=1` (torneo già avviato) o se esistono round non-pending
  (niente simulazione su stato reale); i profili simulati si registrano via
  `registerPlayer` (modulo reale) a finestra aperta (RF-22: `registration_open=1`
  all'avvio) con email `sim-XX@survivor.test`.
- **R4 — RNG deterministico.** Seed default 42 (`--seed <n>`); RNG
  `mulberry32` implementato a mano come funzione pura (nessuna dipendenza,
  nessuna libreria non-deterministica); iterazione stabile con `ORDER BY id`
  e round crescenti (determinismo dell'ordine di scelta squadra/esito).
- **R5 — Scheduler senza stato persistito.** `scheduler:status` = stato
  COMPUTATO al volo (nessuna tabella, nessuna "ultima esecuzione" persistita);
  l'audit delle esecuzioni sta nel log pino (eventi strutturati con
  `{event, round?, cause?}`).
- **R6 — `schedulerTick(ctx, deps)` con refresh iniettato.** Il modulo di
  gioco riceve `deps.refresh` (funzione) come dipendenza: la CLI inietta
  `importMatches + FootballDataClient` reali; i test iniettano uno stub.
  Errore del refresh → log `warn` e prosegui (RNF9: nessun crash, le azioni
  dello stato corrente si eseguono comunque).
- **R7 — Chiusure di sicurezza (LLD §1.4, RF-30).** Round `open` con deadline
  NULL/non innescata allo scadere del TC ricalcolato dai dati correnti →
  `round:close` con evento `round_close_safety` e causa `deadline_missing`
  (stessa semantica di consolidamento); se il TC non è calcolabile (nessuna
  partita) → nessuna auto-chiusura, evento `warn_not_calculable` + anomalia
  `deadline_missing` già esposta da `tournament:status` (uscita manuale:
  `round:close --force --reason`).
- **R8 — Moduli e registrazione.** Nuovi moduli `src/game/simulation.ts`,
  `src/game/scheduler.ts`, `src/cli/commands/simulate.ts`,
  `src/cli/commands/scheduler.ts`; registrazione in `src/cli/index.ts`
  (pattern yargs esistente); aggiornare l'albero LLD §5 (file `scheduler.ts`
  e `simulate.ts` mancano oggi).

**Fix di determinismo necessario (RNF1) — scoperto in analisi:**

- Le colonne `created_at` di `player`/`profile`/`pick` usano
  `DEFAULT (datetime('now'))` di SQLite (orologio REALE): due run di
  `simulate:full` con la stessa seed produrrebbero export diversi sulle
  righe `created_at` → il "diff vuoto" della verifica fallirebbe.
- **Decisione A (approvata):** clock iniettato anche su `created_at`:
  - `pick-processor.ts`: `insertPendingPick(db, profileId, round, team,
    outcome, createdAt: string)` — `created_at` esplicito nell'INSERT;
    aggiornare i 2 call-site (`registerPick` → `ctx.now.toISOString()`;
    `autoRegisterFromPick` in `registration.ts` → `ctx.now.toISOString()`).
  - `registration.ts`: `registerPlayer` e `autoRegisterFromPick` scrivono
    `created_at` esplicito = `ctx.now.toISOString()` su `player` e `profile`.
  - Nessun test esistente dipende da `created_at` (verificato: i test
    asseriscono solo su campi selezionati o usano `toMatchObject`).

---

## 1. Problemi trasversali (vale per entrambi i task)

**A — Determinismo dei timestamp (RNF1).** Oltre a `created_at` (Decisione A
sopra), verificare che la simulazione non lasci NESSUNA scrittura dipendente
dall'orologio reale: tutti i write passano per il clock iniettato (ora derivata
dai dati, R2). Il doppio export con lo stesso `now` (in test: stesso Date
passato al contesto) deve essere identico **salvo `exportedAt`** (scritto dal
clock di `tournamentExport`, che in UAT è reale e ovviamente differisce tra
due processi: escluderlo dal diff).

**B — La simulazione non è una scorciatoia alle regole (ADR-004/§1.3).**
`simulate:*` invoca esclusivamente i moduli di gioco esistenti
(`startTournament` con seam, `registerPlayer`, `openRound`, `registerPick`,
`closeRound`, `scoreRound`): nessuna logica di gioco replicata nel modulo di
simulazione. I pick si generano con squadra random tra `getAvailableTeams`
(modulo rules, rispetta bruciate/partite in giornata) ed esito random:
`registerPick` può rifiutarli solo per motivi imprevisti → in tal caso la
simulazione **fallisce con errore esplicito** (mai silenzioso: un rifiuto
inatteso è un bug dei generatori o delle regole).

**C — La guardia R3 e la finestra di iscrizione (RF-22).** `startTournament`
apre la finestra di iscrizione (`registration_open=1`); `simulate:full`
registra i profili sim PRIMA dell'apertura dei round (TT1 incluso) → la
finestra è aperta e `registerPlayer` accetta senza reason. La guardia
anti-simulazione su DB già avviato controlla `season_started` e l'esistenza
di round non-pending (righe inizializzate da un avvio precedente): in caso di
rifiuto, errore pulito che spiega il motivo (pattern `tournament:start`).

**D — `simulate:round` senza `tournament:start`.** Un round singolo si
simula anche senza avviare la stagione: se manca la riga `tournament_state`
(o `start_round`), usare `openRegistration` per aprire la finestra (e creare
la riga) e procedere su quel solo round; `getStartRound` fallback 1
(comportamento legacy, turn.ts). Se la riga esiste già (torneo avviato o
finestra presente) → guardia R3 identica a `simulate:full`.

**E — Rifiuto dei comandi di simulazione su stato sporco (R3).** La guardia
"esistono round non-pending" va valutata sull'intera tabella `round_state`
(vincolo: niente round_state al di fuori di una finestra simulata): se il DB
contiene round con stato ≠ `pending`, la simulazione è rifiutata (il DB è
reale: `simulate:full` con `season_started=1` non è permesso, la verifica
RNF1 usa DB freschi).

**F — Ordine delle azioni del tick (R6/R7, LLD §1.4).** `schedulerTick` esegue
in sequenza, con check-then-act idempotente su ogni azione (RNF9: un tick
ripetuto non produce effetti): (1) refresh dati (se iniettato), (2)
finestra di iscrizione (auto-close a deadline TT1 / safety a tcClose TT1),
(3) `round:open` per il TT1 o al termine del TC precedente (RF-23), (4)
`round:close` a deadline scaduta (registrata) o safety (deadline NULL,
RF-30), (5) `round:score` per i round `closed` e per i round `scored` con
pick `frozen` (`SELECT DISTINCT round FROM pick WHERE status='frozen'`). Ogni
azione produce un evento `SchedulerEvent` (vedi §3); `SCHEDULER_AUTO_SCORE=false`
esclude solo le azioni di score (config, §4.4).

**G — Niente email in simulazione, niente log fantasma.** I comandi
`simulate:*` NON iniettano channel/generator (R1): le notifiche sono no-op e
il report della simulazione è il solo output. Lo scheduler invece logga con
pino ogni evento (warn per `*_safety` e `refresh_failed`): il logger è
costruito dalla CLI (`createLogger(config.LOG_LEVEL)`, src/logger.ts) e
passato... no: i moduli NON ricevono il logger (niente log nei moduli di
gioco — audit = eventi restituiti, log = compito della CLI). Decisione: i
moduli restituiscono `{ events }`, la CLI logga.

**H — Documentazione del codice (AGENTS.md rule 5).** Header di file +
commenti su funzioni/parametri per ogni file nuovo: `src/game/simulation.ts`,
`src/game/scheduler.ts`, `src/cli/commands/simulate.ts`,
`src/cli/commands/scheduler.ts`, test. Stesso standard delle Fasi 2–6.
Commenti in italiano.

**I — Nessuna nuova env/dipendenza.** `SIM_PLAYERS`, `SCHEDULER_*` esistono
già; il seed è un parametro CLI (`--seed <n>`, default 42), non una env.
Nessun pacchetto nuovo (mulberry32 a mano, R4).

---

## 2. Task 7.1 — Simulazione (`src/game/simulation.ts` + CLI `simulate:*`)

Contenuto (plan + LLD §7.11 + PRD CS3/RNF1 + ADR-008 RF-20): registra
`SIM_PLAYERS` profili simulati, per ogni round della finestra apre → genera
pick seeded → chiude scavalcando la deadline (`receivedAt` finto) →
contabilizza → report. Opzioni `--seed` e `--start-round` (finestra agganciata
`[start_round..N]`, ADR-008/RF-20).

**Modulo di gioco (`src/game/simulation.ts`):**

1. `mulberry32(seed: number): () => number` — RNG puro (mulberry32,
   implementazione a mano documentata), restituisce una funzione che produce
   `[0, 1)`. Nessuno stato globale: ogni chiamata crea una sequenza nuova.
   Helper interno `pickIndex(rng, n) = Math.floor(rng() * n)`.
2. `simulateSeason(ctx, opts?: { seed?, players?, startRound? }): Promise<SimulationReport>`
   — full-season:
   - guardia R3 (season_started / round non-pending) → errore pulito;
   - `startTournament(ctx, { startRound, allowPastDeadline: true })` (seam,
     MAI usato in CLI reale: RF-21 su dati storici richiederebbe la deadline
     futura; la simulazione è l'unico consumatore del seam);
   - registra `players ?? config.SIM_PLAYERS` profili `sim-01@survivor.test`,
     `sim-02@…`, ecc. via `registerPlayer` (finestra aperta, R3);
   - per ogni round `r` della finestra: clock derivato (R2) → `openRound` →
     per ogni profilo SIM attivo: squadra = random tra
     `getAvailableTeams(...)` (con seed, ordine stabile), esito random tra
     win/draw/lose, `registerPick` con `receivedAt = deadline − 1min`;
     rifiuto inatteso → throw con dettaglio → `closeRound` → `scoreRound`;
   - report: `{ startRound, totalRounds, seed, playersRegistered, rounds:
     [{ round, tt, tc, picks, evaluated, frozen, eliminated, status }],
     winner? }` — struttura leggibile, nessuna logica duplicata (i dati
     vengono dagli esiti dei moduli).
3. `simulateRound(ctx, round, opts?: { seed?, players? }): Promise<SimulationReport>`
   — round singolo senza `startTournament`: guardia R3; se la riga
   `tournament_state` manca → `openRegistration` (crea la finestra e la riga);
   stessi passi del full su UN round (open → pick → close → score). Il round
   deve essere nel calendario (provider); se la riga `round_state` esiste
   già con stato non-pending → guardia.

**CLI (`src/cli/commands/simulate.ts`):** pattern consolidato (context senza
email, R1; `getConfig → createConnection → migrate`):
- `simulate:full [--start-round <n>] [--seed <n>] [--json]` — default
  `--start-round 1`, `--seed 42`;
- `simulate:round --round <n> [--seed <n>] [--json]` — `--round` obbligatorio
  (`demandOption`);
- output testo: per ogni round una riga compatta (`TC n (TT n): pick x,
  valutati y, frozen z, eliminati w — [status]`) + riga finale con vincitore
  (se `checkWinner` esaurito) o "torneo in corso"; `--json` = report completo
  (LLD §7.13).

**Test (`tests/integration/season-sim.test.ts`, pattern di tournament.test.ts
con DB in-memory reale + fixture 4 squadre/6 round):**
- stagione completa (`simulateSeason`) senza errori: tutti i 6 round in stato
  `scored`, tutti i pick valutati (corretti+sbagliati), profili SIM presenti
  con pool bruciate coerente (verifica su un profilo: team distinti nel
  girone d'andata);
- **RNF1:** due run con stessa seed su DB in-memory FRESCHI e stesso `now`
  → `tournamentExport` deep-equal (asserire `toEqual` sugli export con lo
  stesso `now`; il campo `exportedAt` è identico perché il clock è lo stesso);
  due run con seed diversa → export diversi (sanzione del determinismo);
- guardia R3: `simulateSeason` su torneo già avviato (`startTournament`
  fatto prima) → errore; con round_state non-pending → errore;
- aggancio `--start-round 4` (CL13 sul confine girone della fixture:
  `halfBoundary(6)=4`): finestra TC 4..6, pool azzerato al ritorno;
- aggancio all'ultimo TC (CL12): `startRound=6` → warning
  `lastRoundWarning` esposto nel report;
- `simulateRound` su round singolo: apre finestra se manca, round → scored,
  guardia su round già aperto;
- `simulate:full` da TC1 invariato rispetto al comportamento legacy:
  i moduli invocati sono gli stessi del flusso manuale (nessuna regola
  duplicata — si verifica che un pick sbagliato elimini il profilo, come nel
  flusso reale).

---

## 3. Task 7.2 — Scheduler (`src/game/scheduler.ts` + CLI `scheduler:*`)

Contenuto (plan + LLD §1.4 + PRD RF-30/RNF9 + ADR-008 RF-22): orchestratore
sottile; finestra iscrizione ancorata al TT1 (auto-close a deadline /
safety), open/close/score sulla finestra `[start_round..N]`, `data:refresh`
prima di tutto; chiusura di sicurezza RF-30 con log `safety_close`; nessuna
logica di gioco (LLD §1.4: invoca esclusivamente i comandi del Game Engine).

**Modulo di gioco (`src/game/scheduler.ts`):**

1. **Helper locali (sola lettura):** SELECT su `tournament_state`/
   `round_state` (pattern già in tournament.ts/round-manager.ts);
   `computeDeadline`/`computeTcClose` riusati da round-time.ts (mai
   duplicati); `getFirstMatchDateTime` con catch → `null` (chiusura non
   calcolabile).
2. `computeActions(ctx, state): Promise<PendingAction[]>` — funzione PURA di
   decisione (nessuna scrittura): legge lo stato e restituisce la lista di
   azioni da eseguire nell'ordine (LLD §1.4):
   - `register_close_auto`: finestra aperta E deadline TT1 registrata E
     `now > deadline TT1` (RF-22; deadline del TT1 = deadline della riga
     `round_state` del round = `start_round`; il TT1 è il primo pending o già
     aperto);
   - `register_close_safety`: finestra aperta E deadline TT1 NULL E
     `now > tcClose TT1` (chiusura di sicurezza, causa `deadline_missing`);
     se tcClose non calcolabile → azione `warn_not_calculable` (nessuna
     auto-chiusura, RF-30);
   - `round_open`: primo round `pending` della finestra, quando il TC
     precedente è `scored` (o TT1, RF-23: se è il primo della finestra e il
     torneo è avviato); nessun vincolo temporale per il TT1 (si apre
     all'avvio);
   - `round_close`: round `open` con deadline registrata E `now > deadline`;
   - `round_close_safety`: round `open` con deadline NULL E `now > tcClose`
     (causa `deadline_missing`); tcClose non calcolabile → `warn_not_calculable`;
   - `round_score`: round `closed` non `scored` (se `SCHEDULER_AUTO_SCORE`);
   - `round_score_frozen`: round `scored` con pick frozen
     (`SELECT DISTINCT round FROM pick WHERE status='frozen'`).
   Ogni azione: `{ type, round? }`.
3. `schedulerTick(ctx, deps): Promise<{ events: SchedulerEvent[] }>` — esegue
   con check-then-act (idempotente, RNF9): refresh (deps.refresh, errore →
   evento `refresh_failed` e prosegui), poi `computeActions` e per ciascuna
   invoca il modulo corrispondente (`closeRegistration`, `openRound`,
   `closeRound`, `scoreRound`), traducendo ogni esito in un evento
   `SchedulerEvent`: `round_open | round_close | round_close_safety |
   round_score | round_score_frozen | register_close_auto |
   register_close_safety | refresh_failed | warn_not_calculable`, con
   `round?` e `cause?` (`deadline_missing` per le safety). Se un'azione fallisce
   (es. stato cambiato tra check e act) → la si salta (già eseguita da un tick
   concorrente), senza crash.
4. `schedulerStatus(ctx): Promise<SchedulerStatusResult>` — stato COMPUTATO:
   `{ enabled (dal config), startRound, totalRounds, registrationOpen,
   roundStates: [{round, tt, tc, status, deadline?}], anomalies
   (deadline_missing, RF-30), nextActions (da computeActions, prossime
   azioni) }`. Nessuna persistenza (R5).

**CLI (`src/cli/commands/scheduler.ts`):**
- `scheduler:tick [--json]` — se `SCHEDULER_ENABLED=false` stampa
  "scheduler disabilitato (SCHEDULER_ENABLED=false)" e ESCE senza effetti
  (LLD §7.12); altrimenti costruisce il contesto (con `attachEmailToContext`
  come `round:*`: le chiusure/score notificano in produzione), inietta
  `deps.refresh = () => importMatches(db, new FootballDataClient(config))`
  (stesso pattern di `data:refresh`), esegue il tick e LOGGA con pino ogni
  evento (warn per `*_safety`/`refresh_failed`/`warn_not_calculable`); output
  testo/JSON con la lista eventi;
- `scheduler:status [--json]` — SEMPRE attivo (solo lettura, idempotente):
  stampa stato computato + anomalie + prossime azioni.

**Test (`tests/unit/scheduler.test.ts`)** — clock finto (same pattern
tournament.test.ts), `parseConfig` con override `SCHEDULER_AUTO_SCORE`,
fixture 4 squadre/6 round:
- tick su torneo NON avviato → no-op (nessun evento, nessuna scrittura);
- sequenza completa: start → tick (open TT1) → deadline passata → tick
  (close TT1 + register_close_auto + score) → TC precedente scored → tick
  (open TT2) — eventi ordinati come atteso;
- idempotenza: secondo tick con lo stesso `now` → nessun evento (RNF9);
- safety close: round `open` con `deadline = NULL` (UPDATE round_state) e
  `now > tcClose` → evento `round_close_safety` con `cause: deadline_missing`
  e round consolidato (mancanti eliminati);
- `warn_not_calculable`: round `open` con deadline NULL e round senza partite
  (DELETE match del round) → nessuna chiusura, evento warn, anomalia in
  `tournament:status`;
- refresh: stub chiamato (es. una volta a tick); refresh che LANCIA → evento
  `refresh_failed` e le azioni proseguono (RNF9);
- `SCHEDULER_AUTO_SCORE=false` → nessun evento `round_score`/`round_score_frozen`;
- score dei frozen: pick `frozen` su round scored → evento
  `round_score_frozen` e pick rivalutato (con `setScore`).

---

## 4. Task 7.3 — Operatività

- `.env.example` §4.4: commento con esempio crontab:
  `*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && npm run cli -- scheduler:tick >> /var/log/survivor.log 2>&1`
  (RNF3, LLD §1.4: il cron esegue `scheduler:tick` ogni minuto).
- Verifica: avvio da `.env.example` compilato fallisce solo per credenziali
  mancanti con messaggi chiari (già coperto dai test config; il punto è la
  completezza del file, già verificata).

---

## 5. Coerenze verificate (non-problemi)

- **Config già pronta** per Fase 7: `SIM_PLAYERS`, `SCHEDULER_ENABLED`,
  `SCHEDULER_TICK_MIN`, `SCHEDULER_AUTO_SCORE` esistono in `config.ts` e
  `.env.example` — nessun task di config, nessuna env nuova (I).
- **Nessuna migrazione:** la Fase 7 non aggiunge tabelle/colonne (R5: niente
  stato scheduler persistito).
- **Seam già pronto:** `startTournament` ha `allowPastDeadline` (Task 4.1)
  pensato esplicitamente per la simulazione; `registerPlayer` accetta a
  finestra aperta; `closeRound` ha la semantica di consolidamento identica
  per auto e forzata (RF-29); `scoreRound` è idempotente e processa anche i
  frozen su round scored (LLD §1.4).
- **Determinismo già garantito** da: clock iniettato (decisione A Fase 3),
  `computeTcClose` puro, ordini `ORDER BY` stabili, seed RNG nel chiamante.
  Resta il fix `created_at` (Decisione A, §0).
- **Separazione di responsabilità** (AGENTS.md §1.3/ADR-003): scheduler e
  simulazione chiamano i moduli di gioco esistenti senza duplicarne la
  logica; il refresh è iniettato (R6); il logger resta nella CLI (G).
- **Test pattern riusabili:** fixture `season.ts`, pattern
  `tournament.test.ts` (DB in-memory + provider reale), stub di refresh
  come il fake di `FootballDataClient` nei test `data:import`.

---

## 6. Correzioni ai documenti da applicare in itinere

| File | Modifica |
|------|----------|
| `docs/POC/POC_LLD.md` §5 | Aggiungere all'albero: `game/scheduler.ts` e `game/simulation.ts` sotto `src/game/`; `cli/commands/scheduler.ts` e `cli/commands/simulate.ts` sotto `src/cli/commands/`; `tests/integration/season-sim.test.ts` (già presente nel tree? verificare — oggi il tree elenca `season-sim.test.ts`) |
| `docs/POC/POC_LLD.md` §7.11 | Specificare le opzioni CLI: `simulate:full [--start-round <n>] [--seed <n>]`, `simulate:round --round <n> [--seed <n>]`; seed default 42; guardia su torneo avviato; contesto senza email (R1) |
| `docs/POC/POC_LLD.md` §7.12 | `scheduler:status` = stato computato, niente "ultima esecuzione" persistita (R5); evento `warn_not_calculable` (R7) |
| `docs/POC/POC_LLD.md` §1.4 | Evento `warn_not_calculable` per TC non calcolabile (chiusura di sicurezza non applicabile) — allineare la lista azioni |
| `docs/POC/POC_LLD.md` §3 | Nota `created_at`: scritture esplicite dal clock iniettato per il determinismo RNF1 (Decisione A) |
| `tasks/plan.md` Task 7.1/7.2/7.3 | Decisioni R1–R8 e Decisione A (fix determinismo created_at): seed default 42, clock derivato per fase, guardie R3, refresh iniettato, safety close con causa, eventi scheduler |
| `docs/POC/POC_PRD.md` §9 | Riferimento RNF1: il determinismo copre anche `created_at` (export identici a parità di seed/clock) |
| `AGENTS.md` §1.7 | Aggiornare lo "Stato attuale" al completamento della Fase 7 (Checkpoint 5) |

---

## 7. Ordine di esecuzione e dipendenze

```
Decisione A (fix determinismo created_at, PRIMA — tocca moduli esistenti)
  → 7.1 simulation.ts (dipende da A: i pick creati hanno created_at dal clock)
  → 7.1 CLI simulate.ts + registrazione (dipende da simulation.ts)
  → 7.2 scheduler.ts (indipendente da 7.1; usa round-time/round-manager/registration)
  → 7.2 CLI scheduler.ts + registrazione
  → 7.3 .env.example (crontab) — indipendente, in coda
  → check: typecheck/lint/test verdi + aggiornamento LLD §5/§7.11/§7.12/§3 e
    plan/PRD (tabella §6) + UAT CLI (CS3/RNF1: data:import → simulate:full
    --seed 42 → doppio tournament:export → diff vuoto; agganci 20/38)
```

Parallelismo reale solo tra 7.1 e 7.2 (dopo la Decisione A). L'uscita dalla
fase = `npm run typecheck`/`lint`/`test` verdi + UAT CLI eseguita (CS3, RNF1,
CL13/CL12) + documenti aggiornati.

---

## 8. Prompt pronto per l'agente implementatore

> Implementa la Fase 7 del piano (`tasks/plan.md` Task 7.1–7.3) seguendo
> **prioritariamente** il briefing `tasks/briefing-fasi/briefing-fase-7.md` (decisioni R1–R8
> e Decisione A) e le sezioni LLD/PRD ivi citate come autorità. Prima di
> scrivere codice: (1) applica la Decisione A (fix determinismo `created_at`
> in `pick-processor.ts`/`registration.ts` con i suoi test), (2) applica le
> correzioni di spec della tabella §6 ai documenti (LLD/plan/PRD) nello stesso
> lavoro, (3) applica AGENTS.md rule 5 (header file e commenti
> funzioni/parametri, in italiano), (4) scrivi prima i test (TDD) su SQLite
> in-memory con `DbSeasonDataProvider` reale + fixture `season.ts`, mockando
> SOLO i confini esterni (stub di refresh nello scheduler), (5) verifica con
> `npm run typecheck`, `npm run lint`, `npm test`, (6) esegui la UAT CLI
> (CS3/RNF1) come da §7, (7) aggiorna `agent-context/current-status.md`
> (timestamp + changelog ISO-8601 UTC) e AGENTS.md §1.7.
> Vincoli: niente `getConfig()` nei moduli (la CLI inietta); nessuna logica di
> gioco duplicata (simulazione e scheduler invocano SOLO i moduli esistenti);
> nessuna nuova env/dipendenza (mulberry32 a mano); determinismo totale a
> parità di seed e clock (RNF1); i comandi `simulate:*` senza canale email
> (R1); `scheduler:tick` idempotente con refresh iniettato (R6, RNF9).
