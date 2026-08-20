# Revisione indipendente — Piano "Iscrizione a livello di piattaforma"

- **Oggetto:** `.kilo/plans/1787233853904-iscrizione-piattaforma.md` (da copiare in `tasks/` al termine della pianificazione).
- **Origine requisiti:** `tasks/brainstorming-iscrizione-piattaforma.md` (2026-08-20).
- **Revisore:** Product Manager + Product Architect + Developer senior (revisione indipendente, sola lettura).
- **Data:** 2026-08-20.

---

## 1. Verdetto

**PASS CON MODIFICHE.**

Il piano è ben strutturato, riflette fedelmente le decisioni bloccate (modello a due livelli, `registerID` stabile, soft-delete, log silenzioso, intento via LLM, auto-join al TT1, due connessioni, nessuna migrazione) e ha un'ordine di task sensato. Tuttavia **non è eseguibile così com'è**: prima dell'implementazione vanno risolte quattro lacune funzionali/architetturali (filtro piattaforma sulle notifiche esistenti, snapshot `knownEmails`/`activeEmails` nel batch, isolamento+determinismo del DB piattaforma in simulazione/UAT, conseguenza operativa dell'upgrade a metà torneo) e una contraddizione tra due decisioni bloccate (piattaforma "solo letta" vs `tournament:register` che scrive su entrambi i DB). Inoltre mancano nel piano documenti operativi che resterebbero incoerenti (in primis `docs/uat/guida-test-mode.md`).

---

## 2. Findings

### CRITICAL

*Nessun finding CRITICAL in senso stretto: nessuna decisione bloccata contraddice il codice esistente, e il piano è eseguibile con le modifiche elencate sotto. I finding HIGH-1/HIGH-2 sono i più vicini al blocco funzionale e vanno risolti prima dell'esecuzione.*

---

### HIGH

#### HIGH-1 — Il filtro "account attivo" NON è applicato alle notifiche di round esistenti
- **Riferimento:** piano §2.7 (decisione 8: "ogni email in uscita è filtrata anche sullo stato dell'account piattaforma… un disiscritto non riceve alcuna email"), §2.15 (decisione 15), §4 Task 9; codice `src/game/round-manager.ts:154-164` (`getActiveProfiles` filtra solo `eliminated=0`), `:275` (`closeRound` notifica sempre i `missing`), `:347` (`scoreRound` notifica sempre).
- **Problema:** il Task 9 dichiara `round:open` "invariato (pick ai soli attivi)" e applica il filtro sugli account attivi **solo al riepilogo** di chiusura round. Le email puntuali già esistenti — `pick_instructions` (open), `pick_missing_elimination` (close), `round_result_correct/wrong` (score) — restano inviate a **tutti** i profili `eliminated=0`, senza controllare lo stato dell'account piattaforma.
- **Impatto:** un giocatore che si disiscrive durante un torneo (decisione 15: "ferma comunicazioni e pick") con un profilo ancora attivo nel DB torneo **continua a ricevere** email di apertura round, eliminazione per pick mancante ed esiti — contraddicendo esplicitamente le decisioni bloccate 8 e 15. Il profilo "muore naturalmente a `missing_pick` senza email al disiscritto" non si verifica.
- **Correzione:** estendere il Task 9 (o introdurre un task dedicato) per iniettare il registry nel Round Manager e filtrare **tutti** i punti di notifica (`openRound`, `closeRound`, `scoreRound`) sullo stato `active` dell'account, non solo il riepilogo. Esplicitare che `getActiveProfiles`/`notify` diventano consapevoli del registry.

#### HIGH-2 — Snapshot di `knownEmails`/`activeEmails` calcolato una sola volta per batch
- **Riferimento:** piano §4 Task 8 ("`knownEmails` deriva dal registry (`activeEmails()`)"), §2.4; codice `src/cli/commands/channel.ts:127-131` (`knownEmails` calcolato UNA volta prima del loop); `src/channel/email-processor.ts:352-417` (batch).
- **Problema:** se nello **stesso batch** IMAP il messaggio N è una `subscribe` e il messaggio N+1 è un `pick` dello stesso mittente, il pick viene valutato contro l'insieme degli account attivi **snapshottato all'inizio del batch**, quindi il mittente risulta "sconosciuto" → log silenzioso, nessuna conferma. Il piano non specifica se `activeEmails()` è rivalutato per messaggio o aggiornato incrementalmente.
- **Impatto:** il giocatore che si iscrive e subito invia il primo pick (scenario tipico all'apertura del torneo) vede il proprio pick **silenziosamente scartato** e non riceve alcuna conferma; alla chiusura risulta `missing_pick`. È un difetto funzionale sul flusso core (checklist 1).
- **Correzione:** nel Task 8 specificare che l'insieme dei mittenti attivi è **rivalutato o aggiornato dopo ogni `subscribe`/`unsubscribe` elaborata nel batch** (ricomputo per messaggio, o aggiornamento incrementale del set), e coprirlo con un test di integrazione (subscribe+pick nello stesso batch).

#### HIGH-3 — Simulazione e UAT: nessuna guardia di isolamento del DB piattaforma + determinismo di `register_id`
- **Riferimento:** piano §4 Task 10 ("il seed crea account piattaforma (via registry su `PLATFORM_DB_PATH`) oltre ai profili"), §5 (RNF1); codice `src/game/simulation.ts:125-147` (`registerSimPlayers`), `src/game/tournament.ts:414-439` (`tournamentExport` fa `SELECT *` su `player`/`profile`).
- **Problema (a) inquinamento:** `simulate:*` scriverebbe gli account `sim-XX@survivor.test` nel **`PLATFORM_DB_PATH` reale** (default `./data/platform.db`), inquinando la piattaforma di produzione. Il piano non prevede alcuna guardia equivalente alla R3 della simulazione né una raccomandazione di usare un `PLATFORM_DB_PATH` dedicato per simulazione/UAT.
- **Problema (b) determinismo:** `register_id` è `INTEGER PK AUTOINCREMENT` sul DB piattaforma. `tournament:export` ora include `player.register_id`/`profile.register_id` (via `SELECT *`). Se lo stesso `PLATFORM_DB_PATH` è riusato tra due run di `simulate:full` senza reset, i `register_id` continuano a incrementare → export **non identici a parità di seed** → il test RNF1 (`season-sim.test.ts`) fallisce.
- **Impatto:** violazione di RNF1 e possibile contaminazione della piattaforma reale durante test/UAT (contraddice anche il vincolo di memoria `cron_env_consistency`/isolamento test-mode).
- **Correzione:** (1) nei Task 10/11 imporre che `.env.uat`/`.env.uat-replay` e la simulazione usino un `PLATFORM_DB_PATH` **dedicato e distinto** da quello di produzione (es. `./data/uat-platform.db`); (2) aggiungere una guardia di simulazione che rifiuti o avvisi se `PLATFORM_DB_PATH` coincide con quello di produzione, oppure far partire la simulazione da un DB piattaforma vuoto/in-memory; (3) documentare che il determinismo di `register_id` richiede un DB piattaforma pulito (stesso vincolo già espresso per il DB torneo dalla guardia R3).

#### HIGH-4 — Upgrade a metà torneo: giocatori esistenti diventano "sconosciuti" (conseguenza non dichiarata)
- **Riferimento:** piano §2.2 (decisione 2: "nessuna migrazione dati; DB piattaforma parte vuoto; player/profile esistenti non migrati"), §5 ("Migrazione colonne — nessuna perdita dati su DB esistenti").
- **Problema:** dopo l'upgrade, i `player`/`profile` già presenti in un torneo in corso hanno `register_id = NULL` e **nessun account piattaforma**. Il gate "iscritto attivo" (decisione 4: pick da sconosciuto → log silenzioso) fa sì che i loro pick vengano **silenziosamente scartati** finché il commissioner non li re-registra manualmente su piattaforma. Il piano dichiara "nessuna perdita dati" ma non dichiara questa conseguenza operativa né un percorso di recupero (es. `platform:register --email` per ogni email esistente).
- **Impatto:** in un torneo reale già avviato, tutti i giocatori verrebbero eliminati `missing_pick` senza alcun feedback. Anche per la POC (dati sintetici) il piano deve dichiararlo esplicitamente.
- **Correzione:** aggiungere al piano (e al Task 2/ADR-009) una nota esplicita sulla continuità operativa: "l'upgrade rende silenziosi i pick di chi non è (ri)registrato su piattaforma; il commissioner deve eseguire `platform:register` per ogni email esistente prima della prima deadline post-upgrade". Valutare un comando helper `platform:register --from-tournament-db` (opzionale, fuori scope se si dichiara il vincolo).

#### HIGH-5 — "Piattaforma solo letta dai flussi di torneo" contraddetta da `tournament:register`
- **Riferimento:** piano §2.1 (decisione 1: "la piattaforma è solo letta dai flussi di torneo… ogni scrittura resta in un singolo DB") vs §2.10 (decisione 10: "`tournament:register` (manuale): crea/riattiva account piattaforma (se assente) + profilo con `register_id`").
- **Problema:** `tournament:register` scrive **su entrambi i DB** (crea/riattiva account su piattaforma + crea profilo su torneo) in un'unica operazione senza transazione cross-DB. È un'eccezione non dichiarata all'invariante "piattaforma solo letta", e introduce un possibile stato incoerente (account attivo creato, profilo no) in caso di crash tra le due scritture.
- **Impatto:** l'invariante architetturale che motiva le due connessioni separate è più debole di quanto affermato; va ridefinito con l'eccezione esplicita e una strategia di idempotenza/ordine.
- **Correzione:** riformulare la decisione 1 come "la piattaforma è letta dai flussi di torneo, con l'**unica eccezione** di `tournament:register` (e dei futuri comandi di join manuale) che scrivono prima la piattaforma e poi il torneo, accettando il rischio residuo di un account orfano attivo (benigno) o documentando un ordine/rollback manuale". Registrare l'eccezione anche in ADR-009.

#### HIGH-6 — `docs/uat/guida-test-mode.md` (e altri documenti operativi) non aggiornati dal piano
- **Riferimento:** piano §4 (Task 1-11, nessuno cita la guida UAT); `docs/uat/guida-test-mode.md:346-347,363,369,555,558,623,625,693,695,752,754` (usa `tournament:register:open`/`tournament:register:close`, finestra di iscrizione).
- **Problema:** la guida operativa UAT — il "libretto di istruzioni" che documenta l'implementazione reale — descrive ancora la **finestra di iscrizione** (`tournament:register:open/close`, `--contacts`, iscrizione via email nel TT1) che il piano depreca (decisione 14). Il piano aggiorna AGENTS.md/current-status (Task 11) ma **non** la guida.
- **Impatto:** dopo l'esecuzione la guida UAT resterebbe incoerente con i comandi reali (i comandi deprecati non esisteranno più), rendendo impossibile l'esecuzione UAT documentata.
- **Correzione:** aggiungere un task esplicito di allineamento di `docs/uat/guida-test-mode.md` (flusso di iscrizione piattaforma, nuovi `platform:*`, matrice notifiche, esempi copia-incolla) e, secondariamente, di `docs/system-components.md` + `docs/system-components.excalidraw` (vedi MED-7).

---

### MED

#### MED-1 — Doppia email di eliminazione lasciata aperta ("dedup eventuale")
- **Riferimento:** piano §5 ("le email puntuali `pick_missing_elimination`, `round_result_*` restano oltre al riepilogo; eventuale dedup va confermato in review"), §7 (domanda aperta (a)).
- **Problema:** un eliminato `missing_pick` riceve `pick_missing_elimination` (alla close) **e** `round_closed_eliminated` (alla transizione `scored`); un eliminato `wrong_pick` riceve `round_result_wrong` (allo score) **e** `round_closed_eliminated`. Il piano lascia il dedup aperto, ma la matrice notifiche della checklist richiede di decidere chi riceve cosa senza doppioni.
- **Impatto:** il giocatore eliminato riceve due volte la stessa notizia di eliminazione, in modo confuso, in un gioco tra amici.
- **Correzione:** decidere **prima** dell'esecuzione: (opzione A) il riepilogo `round_closed_eliminated` sostituisce `pick_missing_elimination`/`round_result_wrong` per gli eliminati di quel round (una sola email con esito); oppure (opzione B) mantenere le puntuali e NON inviare `round_closed_eliminated` agli eliminati, riservando il riepilogo ai soli sopravvissuti. Spostare la domanda da "non bloccante" a "decisione PO richiesta".

#### MED-2 — Criterio `eliminated_at >= opened_at` sovra-misura le eliminazioni a posteriori da Freeze
- **Riferimento:** piano §2.7 (decisione 7: criterio "eliminati di quel round": `profile.eliminated_at >= round_state.opened_at`); codice `src/game/elimination.ts:54-77` (nessuna colonna "round di eliminazione").
- **Problema:** un profilo eliminato **a posteriori** da un Freeze risolto su un round **già `scored`** riceve `eliminated_at = now` (istante della risoluzione, molto successivo). Questo timestamp è `>= opened_at` anche dei round successivi: se la risoluzione del Freeze avviene prima della chiusura del round N+1, il profilo viene **erroneamente incluso nel riepilogo del round N+1** come "eliminato", oltre a ricevere `round_result_wrong` dalla risoluzione (doppia + attribuzione sbagliata al round).
- **Impatto:** riepilogo di chiusura round con esito sbagliato per i casi Freeze risolti tardi (checklist 4 e 5). Il flag `summary_sent` da solo non copre questo caso (il riepilogo del round N+1 è un invio diverso).
- **Correzione:** restringere il criterio (es. `eliminated_at >= opened_at AND eliminated_at <= scored_at` del round, oppure aggiungere una colonna `eliminated_round` al modello dati), e aggiungere un test con Freeze risolto dopo `scored`. Documentare che l'eliminazione a posteriori da Freeze non produce un secondo riepilogo per il round originario.

#### MED-3 — Il classificatore di intento non espone un comando CLI dedicato (ADR-006)
- **Riferimento:** piano §4 Task 6 (nuovo componente `LLMIntentClassifier`, "OpenAIParser resta per `llm:parse` (riusa internamente il classificatore)"); ADR-006/AGENTS §1.3 ("ogni componente espone comandi CLI dedicati, invocabile e verificabile indipendentemente").
- **Problema:** il nuovo componente non ha un comando CLI proprio (es. `llm:classify --input`), quindi non è verificabile/orchestrabile in modo indipendente, in violazione del principio architetturale.
- **Correzione:** aggiungere al Task 6 un comando `llm:classify` (output JSON `{intent, pick}`) e un contract test dedicato.

#### MED-4 — Nessuna barriera deterministica per l'intento (disiscrizione "distruttiva")
- **Riferimento:** piano §2.5 (decisione 5: "iscrizione/disiscrizione/pick classificati dall'LLM"), §4 Task 6; ADR-004 (barriera deterministica esiste solo per il pick exact-match).
- **Problema:** a differenza del pick (doppia barriera exact-match), l'intento `unsubscribe` non ha alcun filtro deterministico: un'email di pick mal formulata ("voglio cancellare la mia scelta") può essere classificata come disiscrizione, con **soft-delete e stop di tutte le comunicazioni**. La mitigazione ("conferma via email") lascia l'onere di accorgersi dell'errore al giocatore. Il piano riconosce il rischio (R-H) ma non introduce una barriera.
- **Impatto:** un giocatore può essere silenziosamente disiscritto per un fraintendimento, perdendo le notifiche fino al re-iscriversi.
- **Correzione:** valutare una barriera deterministica minima (es. richiesta di conferma esplicita per `unsubscribe` su account attivi con profilo in corso, o keyword di conferma), oppure dichiarare esplicitamente in PRD che il rischio è accettato. Documentare l'asimmetria rispetto alla barriera del pick.

#### MED-5 — `pick:register --profile-id` bypassa il gate piattaforma (non documentato)
- **Riferimento:** piano §2.9 (decisione 9: "gate del pick = piattaforma attiva + profilo"), §4 (nessuna modifica a `pick:register`); codice `src/game/pick-processor.ts:197-223` (`registerPick` opera per `profileId`, senza identità email).
- **Problema:** `pick:register --profile-id` (override commissioner) non passa per l'identità email, quindi **bypassa implicitamente** il gate piattaforma: può registrare un pick per un profilo il cui account è `unsubscribed`. Il piano non lo dichiara né lo giustifica come override.
- **Impatto:** incoerenza tra gate automatico (piattaforma attiva) e gate manuale (nessun controllo). Può essere accettabile come override US10, ma va esplicitato.
- **Correzione:** nel Task 7/PRD dichiarare che `pick:register --profile-id` è un override del commissioner che non verifica la piattaforma (analogo a US10), oppure estendere il controllo con l'identità del profilo.

#### MED-6 — Ordine dei task: rimozione di `openRegistration`/`closeRegistration` rompe `simulation.ts`/`scheduler.ts` prima del Task 10
- **Riferimento:** piano §4 Task 7 ("`openRegistration`/`closeRegistration` deprecati/rimossi") vs Task 10 (aggiorna `simulation.ts`/`scheduler.ts`); codice `src/game/simulation.ts:30,303` (`simulateRound` chiama `openRegistration`), `src/game/scheduler.ts:36,218,219` (`closeRegistration` usata da `register_close_auto/safety`).
- **Problema:** se il Task 7 rimuove (non solo depreca) `openRegistration`/`closeRegistration`, i moduli `simulation.ts` e `scheduler.ts` non compilano fino al Task 10, creando una finestra di rottura di build/test intermedia.
- **Correzione:** o mantenere le funzioni come stub fino al Task 10, o accorpare la rimozione e l'aggiornamento di simulazione/scheduler nello stesso task (o invertire l'ordine). Esplicitare nel piano che la build resta verde a ogni task.

#### MED-7 — `docs/system-components.md` / `docs/system-components.excalidraw` restano obsoleti
- **Riferimento:** `docs/system-components.md:52,53,119,120,192-194,208` e l'excalidraw gemello citano `autoRegisterFromPick`, `openRegistration`, `closeRegistration`, `REGISTRATION_KEYWORDS`, `checkEligibility` come implementati.
- **Problema:** il piano (Task 11) aggiorna AGENTS.md/current-status ma non questi artefatti di architettura, che resteranno incoerenti con il codice.
- **Correzione:** aggiungere al Task 11 (o a un task documentale) l'aggiornamento dei due file (sostituire `autoRegisterFromPick` con `autoJoinFromPick`, rimuovere `REGISTRATION_KEYWORDS`, aggiungere Platform Registry e Intent Classifier).

---

### LOW

#### LOW-1 — Privacy/data retention del DB piattaforma (osservazione)
- **Riferimento:** piano §2.3 (soft-delete, "il sistema ricorda l'email"), §2.2.
- **Problema:** `PLATFORM_DB_PATH` contiene l'elenco completo delle email; il soft-delete conserva i dati per sempre. In un gioco privato tra amici è accettabile, ma va segnalato (nessun meccanismo di cancellazione/anonymizzazione).
- **Correzione:** nota di osservazione in ADR-009/PRD; nessuna azione necessaria per la POC.

#### LOW-2 — Risposta a "disiscritto che si disiscrive di nuovo" non specificata
- **Riferimento:** piano §3 RF-P2 ("da mittente non iscritto → log silenzioso"), §4 Task 8.
- **Problema:** lo stato "già `unsubscribed`" non è distinto da "mai iscritto": il piano non dice se una seconda disiscrizione da un account già disiscritto produce `platform_unsubscribed`, "già disiscritto" o silenzio.
- **Correzione:** specificare in RF-P2 il comportamento per retry/duplicato di `unsubscribe` (idempotente: stesso `registerID`, risposta coerente), e testarlo.

#### LOW-3 — Incoerenza interna: RF-22/RF-28 "deprecati" vs "restano validi"
- **Riferimento:** piano §3 Task 2 ("deprecazioni RF-27/RF-22/RF-28") vs §2.14 (decisione 14: "Restano validi: RF-22/RF-28 reinterpretati come gate di partecipazione (TT1)").
- **Problema:** RF-28 era specificamente "il commissioner può chiudere la finestra di iscrizione con `tournament:register:close --reason`": nel nuovo modello non esiste più finestra da chiudere, quindi "RF-28 resta valido reinterpretato" è poco chiaro e contraddice la deprecazione del comando.
- **Correzione:** chiarire in PRD: RF-22/RF-28 vengono **sostituiti** (non "reinterpretati") dai nuovi RF-P; non lasciare la doppia formulazione.

---

## 3. Domande PO

1. **Doppia email di eliminazione (MED-1).** Alla chiusura round, un eliminato deve ricevere UNA sola email con l'esito, o possono coesistere la notifica puntuale (`pick_missing_elimination`/`round_result_wrong`) e il riepilogo `round_closed_eliminated`?
   - Opzione A: il riepilogo sostituisce le notifiche puntuali per gli eliminati di quel round (una email unica con esito).
   - Opzione B: si mantengono le puntuali e il riepilogo va solo ai sopravvissuti.
   - Opzione C: si mantengono entrambe (accettando la ridondanza).

2. **Intento `unsubscribe` senza barriera deterministica (MED-4).** Accettiamo che una disiscrizione sia interpretata dal solo LLM (con conferma via email), o serve una barriera di conferma esplicita per evitare disiscrizioni involontarie?

3. **`pick:register --profile-id` (MED-5).** L'override manuale del commissioner deve continuare a bypassare il gate piattaforma (come US10), o va esteso a verificare lo stato dell'account?

4. **Isolamento del DB piattaforma in simulazione/UAT (HIGH-3).** Confermi che simulazione e UAT debbano usare un `PLATFORM_DB_PATH` dedicato (mai `./data/platform.db` di produzione), con guardia di rifiuto/avviso se coincide col valore di produzione?

5. **Upgrade a metà torneo (HIGH-4).** È accettabile dichiarare che i giocatori esistenti vanno ri-registrati su piattaforma dal commissioner prima della prima deadline post-upgrade (altrimenti pick silenziosi), oppure serve un comando helper di migrazione one-shot (fuori dalla decisione 2 "nessuna migrazione")?

---

## 4. Checklist verificata

| # | Punto | Esito | Nota |
|---|-------|-------|------|
| 1 | Batch IMAP: `knownEmails` una volta per batch | **PROBLEMA** | HIGH-2: subscribe+pick nello stesso batch → pick silenziosamente scartato; il piano non specifica rivalutazione/aggiornamento incrementale. |
| 2 | Upgrade a metà torneo: esistenti diventano sconosciuti | **PROBLEMA** | HIGH-4: conseguenza operativa non dichiarata; "nessuna perdita dati" è fuorviante. |
| 3 | Email doppie (eliminazione + riepilogo) | **PROBLEMA** | MED-1: il piano lascia il dedup aperto (domanda non bloccante), ma la checklist richiede la matrice completa. |
| 4 | Criterio riepilogo `eliminated_at >= opened_at` | **PROBLEMA** | MED-2: sovra-misura le eliminazioni a posteriori da Freeze; `summary_sent` garantisce invio unico ma non la corretta attribuzione al round. |
| 5 | Freeze tardivo (eliminazione a posteriori) | **PROBLEMA** | MED-2/MED-1: riceve `round_result_wrong` ma nessun riepilogo per il round originario, e può comparire nel riepilogo di un round successivo. |
| 6 | Classificatore di intento: vuoto/HTML/spam, ambiguo, barriera deterministica | **PROBLEMA** | Corpo/mittente vuoto → `unknown` (no LLM) è preservato; ma nessuna barriera deterministica sull'intento (MED-4). Costo LLM per email sconosciuta non nuovo (oggi l'ignoto passa comunque dal parse). |
| 7 | Disiscrizione: retry/duplicato, re-iscrizione+pick stesso batch, UNIQUE `registerID` | **PROBLEMA (parziale)** | `registerID` riusato via soft-delete non viola UNIQUE (OK); re-iscrizione+pick stesso batch ricade in HIGH-2; risposta al secondo `unsubscribe` non specificata (LOW-2). |
| 8 | Override commissioner (`tournament:register`, `pick:register`, `platform:*`) con `--reason` | **PROBLEMA (parziale)** | `tournament:register` scrive su entrambi i DB (HIGH-5); `pick:register --profile-id` bypassa il gate piattaforma non documentato (MED-5); `--reason` resta coerente. |
| 9 | Consumatori `registrationOpen`/`tournament:export`/`scheduler:status` | **PROBLEMA (parziale)** | `tournament:status`/`scheduler:status` gestiti (Task 9/10); `tournament:export` include `register_id` via `SELECT *` → determinismo legato a HIGH-3. |
| 10 | Simulazione e piattaforma reale | **PROBLEMA** | HIGH-3: nessuna guardia di isolamento; determinismo `register_id` non garantito a parità di seed. |
| 11 | Test mode / cron, vincoli di memoria | **PROBLEMA (parziale)** | `PLATFORM_DB_PATH` in `.env.uat`/`.env.uat-replay` previsto ma senza obbligo di valore dedicato (HIGH-3); `cron_env_consistency` coperto dal Task 11 (aggiorna `.env` reale); `no_refresh_on_shifted_db` non impattato direttamente. |
| 12 | Privacy/data retention (soft-delete perenne) | **OK (osservazione)** | LOW-1: gioco privato tra amici; nessuna azione POC, segnalare in ADR-009. |
| 13 | Documenti dimenticati | **PROBLEMA** | HIGH-6 (`docs/uat/guida-test-mode.md`), MED-7 (`docs/system-components.md`/`.excalidraw`); `README.md`/`CHANGELOG.md` a basso impatto; `tasks/plan.md` e i briefing storici contengono riferimenti deprecati ma sono documenti di lavoro. |
| 14 | Coerenza delle decisioni bloccate | **PROBLEMA (parziale)** | Decisioni 1-6, 8, 11-13 sostanzialmente coerenti; **contraddizione tra decisione 1 e 10** (HIGH-5, piattaforma "solo letta" vs `tournament:register` cross-DB); decisione 8/15 non implementata nei percorsi di notifica esistenti (HIGH-1); decisione 14 contraddice §3 Task 2 su RF-22/RF-28 (LOW-3). |

---

## 5. Giudizio finale

Il piano **non è eseguibile così com'è**. L'ordine dei task (documenti → config/schema/registry → intent classifier → contesto/gate/auto-join → router/processor → notifiche → scheduler/simulazione → test/stato) è corretto in linea di massima, ma prima dell'esecuzione vanno applicate queste modifiche:

- **Obbligatorie (prima dell'esecuzione):** HIGH-1, HIGH-2, HIGH-3, HIGH-4, HIGH-5, HIGH-6.
- **Da risolvere entro il task pertinente (non bloccanti per l'avvio):** MED-1 (richiede decisione PO), MED-2, MED-3, MED-4 (decisione PO), MED-5 (decisione PO), MED-6, MED-7.
- **Task da modificare specificamente:**
  - **Task 7** — non rimuovere `openRegistration`/`closeRegistration` finché non aggiornati `simulation.ts`/`scheduler.ts` (o accorpare con il Task 10); esplicitare il filtro piattaforma in `registerPlayer`/auto-join.
  - **Task 8** — specificare rivalutazione incrementale di `activeEmails()` per messaggio; definire la risposta al `unsubscribe` duplicato.
  - **Task 9** — estendere il filtro account-attivo a `openRound`/`closeRound`/`scoreRound`, non solo al riepilogo; decidere il dedup con le email puntuali.
  - **Task 10** — aggiungere guardia di isolamento del DB piattaforma in simulazione e requisito di DB piattaforma pulito per il determinismo RNF1.
  - **Task 11** — includere `docs/uat/guida-test-mode.md`, `docs/system-components.md`/`.excalidraw`.
  - **Task 2/ADR-009 (Task 1)** — dichiarare la conseguenza operativa dell'upgrade (HIGH-4) e l'eccezione cross-DB di `tournament:register` (HIGH-5).

Con queste modifiche il piano è solido e pronto per l'implementazione su `feat/iscrizione-piattaforma`.
