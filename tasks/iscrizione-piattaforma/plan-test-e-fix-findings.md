# Piano: test di riproduzione e correzione dei findings della revisione tecnica (2026-08-21)

> **Branch:** `feat/iscrizione-piattaforma` (working tree NON committato — feature ADR-009 implementata, piano `tasks/iscrizione-piattaforma/plan-iscrizione-piattaforma.md` eseguito).
> **Fonte dei findings:** `tasks/iscrizione-piattaforma/report-revisione-tecnica-2026-08-21.md` (sola lettura, 2026-08-21).
> **Baseline verificata dal report:** `npm test` 414/414 verdi (39 file), `npm run typecheck` pulito, `npm run lint` pulito; smoke live `simulate:full` su DB dedicati `/tmp` OK.
> **Scopo di QUESTO piano:** SOLO il piano (nessuna modifica a codice/documenti, nessun commit/push). L'implementazione avverrà in sessioni separate secondo la strategia del §5.
> **Skill di riferimento per l'esecuzione:** `test-driven-development` (Fase A: ogni test scritto PRIMA e confermato rosso) + `incremental-implementation` (una correzione alla volta).

---

## 1. Contesto e vincoli non negoziabili

### 1.1 Struttura del piano

- **FASE A — Test di riproduzione:** per OGNI finding del report (inclusi i LOW) un test specifico che riproduce il problema e che OGGI FALLISCE (rosso), oppure dichiarazione esplicita che un test esistente già copre il punto, oppure dichiarazione di esclusione motivata (piano separato / accettato POC).
- **FASE B — Correzione dei findings:** una correzione alla volta, MAI in parallelo, in ordine HIGH → MEDIUM → LOW → documentale. Ogni correzione si chiude SOLO a protocollo verde.

### 1.2 Vincoli (da AGENTS.MD e dal report)

1. **AGENTS.MD §5:** ogni funzione/parametro/file modificato riceve commenti esplicativi aggiornati (scopo, input/output, logica).
2. **AGENTS.MD §1.3:** nessuna logica di gioco fuori dal Game Engine; nessuna scrittura cross-DB — la piattaforma resta SOLO LETTA dai flussi di torneo (verifica con grep su `ctx.platform` a fine lavoro: solo `find`/`list`/`activeEmails`/metodi di lettura).
3. **Log pino in inglese** per ogni nuovo messaggio di log introdotto dalle correzioni.
4. **Git:** nessun commit, nessun push in questo piano; nessuna correzione tocca `main`.
5. **Protocollo di verifica per OGNI singola correzione (regola non negoziabile):**
   - `npm test` — INTERA suite (baseline 414 + i nuovi test della Fase A; attesi verdi);
   - `npm run typecheck`;
   - `npm run lint`;
   - verifica comportamentale mirata al punto corretto (specificata per ogni correzione);
   - quando si toccano `simulate:*`/guardie: smoke `simulate:full` su DB dedicati in `/tmp` (seed sintetico, `PLATFORM_DB_PATH` dedicato, verifica guardie dal vivo).
6. Qualsiasi regressione rilevata dal protocollo va risolta PRIMA di procedere alla correzione successiva.

### 1.3 Vincoli operativi sul DB (da memoria di progetto)

- Su DB di test con date shiftate: MAI `data:refresh` né `scheduler:tick`; usare `SCHEDULER_ENABLED=false` e comandi manuali.
- Lo smoke `simulate:full` usa DB dedicati `/tmp/kilo/…` (mai `./data/platform.db`); nessun cleanup automatico delle cartelle di test (cleanup SOLO su comando esplicito dell'utente).

---

## 2. Decisioni di design CONFERMATE dal piano (raccomandazioni del report §4)

| # | Decisione | Contenuto |
|---|---|---|
| (a) | **Barriera unsubscribe** | Per account `pending_unsubscribe`, il body di conferma (`confermo`/`sì`/`si`/`yes`, match esatto normalizzato) completa la soft-delete **indipendentemente dall'intento** classificato (copre il caso reale "confermo" → `other`). In aggiunta, `buildClassifySystemPrompt` cita "confermo"/"sì"/"si" tra gli esempi di intento `unsubscribe`. Il ramo `unsubscribe` con intento `unsubscribe` e body NON in lista continua a ri-chiedere la conferma (la barriera resta a due passi). |
| (b) | **`summary_sent`** | Scritto **PRIMA** del loop di invio del riepilogo, nello STESSO `UPDATE` atomico della transizione a `scored` (`SET status='scored', scored_at=?, summary_sent=1`): non esiste più lo stato intermedio `scored` + `summary_sent=0`. L'invio è **best-effort per destinatario** (try/catch, warn pino in INGLESE, si continua) — un errore SMTP/LLM non fa più perdere la guardia e non fa fallire `scoreRound`. |
| (c) | **Filtro notifiche fail-closed** | `isAccountActive` ritorna `false` quando `ctx.platform === undefined` (simmetria con `checkEligibility` → `platform_unavailable`): un chiamante che dimentica l'iniezione NON riceve email non filtrate. |
| (d) | **Guardia `simulate:*` ancorata al default reale** | Il valore di produzione di `PLATFORM_DB_PATH` è esposto come costante unica **da `src/config.ts`** (usata sia come default zod sia dalla guardia); `simulate.ts` elimina la costante locale duplicata `PRODUCTION_PLATFORM_DB_PATH`. |
| (e) | **Politica ramo `other`** | Chiarimento SOLO ad account `active`; silenzio (log interno, markSeen, nessuna risposta) per `unsubscribed` e `pending_unsubscribe`. Il completamento della barriera (decisione (a)) avviene PRIMA di questo ramo e non è toccato. |
| (f) | **Tipo email dedicato "già iscritto"** | Nuovo `EmailType` `platform_already_registered` (etichetta soggetto deterministica "Già iscritto alla piattaforma"), usato dal ramo `subscribe` su account già `active` al posto di `pick_rejected`. |
| (g) | **Correzioni documentali + dead-write** | Rimozione dead-write `registration_open` in `startTournament`; pulizia commenti stale (tournament.ts, pick-processor.ts, scheduler.ts describe, pick.ts); carve-out ADR-009/PRD RF-P6 per le conferme RF-P1/P2; allineamento ADR-009 decisione 3 alla semantica implementata; conteggio test in `agent-context/current-status.md` → 414 (non 429); contract test `llm:classify` (D7). |

Nota su (b): tra le due opzioni del report ("prima del loop" / "transazione col passaggio a `scored`") si conferma la prima, resa atomica scrivendo guardia e transizione nella stessa istruzione `UPDATE`. L'alternativa "marca solo al successo con retry esplicito" è scartata perché reintrodurrebbe uno stato pendente non idempotente.

---

## 3. FASE A — Test di riproduzione (scritti PRIMA, confermati ROSSI)

Ordine di esecuzione: si scrivono TUTTI i test della Fase A, si esegue la suite e si registra il rosso di ogni test nuovo (fotografia dello stato attuale). Poi si passa alla Fase B. Nessun test della Fase A viene eliminato o ammorbidito durante la Fase B.

Legenda esito: **RED** = il test fallisce oggi (riproduce il finding); **GREEN da subito** = copre un comportamento già corretto (coverage gap, non un bug); **ESISTENTE** = già coperto da un test in suite (dichiarato, nessun nuovo test).

### A1 — Deadlock barriera unsubscribe: "confermo" classificato `other` (HIGH, D2 — sintomo del report §3)

- **File test:** `tests/integration/email-process.test.ts` (nuovo `it` nel describe "unsubscribe a due passi (RF-P2)").
- **Setup:** harness esistente (`makeHarness`); `platform.register('a@test.it', T_OPEN)` + `platform.beginUnsubscribe('a@test.it', T_OPEN)`; classificatore fake che scripta il corpo `'confermo'` → `{ intent: 'other', pick: null }` (comportamento realistico dell'LLM, come documentato nel report).
- **Asserzione attesa (post-fix):** action `unsubscribe_confirmed`; account `status === 'unsubscribed'` con `unsubscribedAt = T_OPEN`; email inviata di tipo `platform_unsubscribed`; messaggio marcato `seen`.
- **Esito attuale:** **RED** — action `clarification`, status resta `pending_unsubscribe`, il mittente riceve il chiarimento "non ho capito" (deadlock: mai disiscritto).

### A2 — Prompt del classificatore senza esempi di conferma (HIGH, D2 — `intent-classifier.ts:80-81`)

- **File test:** `tests/unit/llm/intent-classifier.test.ts` (nuovo `it` nel describe `buildClassifySystemPrompt`).
- **Setup:** `buildClassifySystemPrompt({ teams: FIXTURE_TEAMS, aliases: '...' })`.
- **Asserzione attesa (post-fix):** il prompt degli esempi `unsubscribe` contiene i testi `confermo`, `sì` (e `si`) come segnali di disiscrizione.
- **Esito attuale:** **RED** — gli esempi citano solo "voglio disiscrivermi" / "non voglio più giocare" / "rimuovetemi".

### A3 — `summary_sent` perso su eccezione durante l'invio del riepilogo (HIGH, report §3)

- **File test:** `tests/unit/game/round-notifications.test.ts` (nuovo `it`).
- **Setup:** harness esistente; round 1 `closed` con 2 sopravvissuti e pick già contabilizzati (o match con punteggio); generator fake che lancia SOLO sulla 2ª chiamata con tipo `round_closed_survived` (es. `new Error('smtp down')`).
- **Asserzione attesa (post-fix):**
  1. `scoreRound` risolve senza lanciare (best-effort per destinatario);
  2. `round_state.status === 'scored'` **E** `summary_sent === 1` (stessa scrittura atomica);
  3. il 1° destinatario ha ricevuto `round_closed_survived`; il 2° no (errore loggato warn);
  4. rieseguire `scoreRound` → **0** nuovi invii `round_closed_survived` (idempotenza conservata).
- **Esito attuale:** **RED** — l'eccezione del generator propaga fuori da `scoreRound`; `summary_sent` resta 0 con status già `scored` (le riaperture saltano il riepilogo: perso per sempre).

### A4 — Filtro notifiche fail-open senza registry (MEDIUM, D4 — `round-manager.ts:80-84`)

- **File test:** `tests/unit/game/round-notifications.test.ts` (nuovo `it`).
- **Setup:** contesto con `channel` + `generator` FAKE iniettati ma **`platform` ASSENTE** (simula il chiamante che dimentica il registry); 1 profilo attivo; `startTournament` (broadcast no-op senza registry, invariato) + `openRound(ctx, 1)`.
- **Asserzione attesa (post-fix):** **nessuna email inviata** (`channel.sent` vuoto): il filtro fallisce chiuso, coerente con `checkEligibility` (`platform_unavailable`).
- **Esito attuale:** **RED** — `isAccountActive` ritorna `true` → `pick_instructions` inviata non filtrata.

### A5 — Guardia `simulate:*` ancorata al default di `config.ts` (MEDIUM, D8 — `simulate.ts:29-39`)

- **File test:** `tests/unit/cli/simulate-guard.test.ts` (nuovo `it`; i 2 test esistenti restano e vanno adeguati agli import).
- **Setup:** il test importa la costante di produzione **da `src/config.ts`** (nuova export `PLATFORM_DB_PATH_DEFAULT`); costruisce `parseConfig({…required})` SENZA `PLATFORM_DB_PATH` (si applica il default) e chiama `assertSimPlatformPath(config)`.
- **Asserzione attesa (post-fix):**
  1. la guardia rifiuta (`/valore di produzione/`) una config il cui `PLATFORM_DB_PATH` coincide col default esposto da `config.ts`;
  2. `src/cli/commands/simulate.ts` NON dichiara più una costante locale di produzione (nessuna duplicazione del default).
- **Esito attuale:** **RED (a livello di compilazione)** — `src/config.ts` oggi NON esporta alcun default di produzione, quindi il test non compila; inoltre la guardia confronta con la costante locale `'./data/platform.db'` duplicata in `simulate.ts`. Il rosso documenta il decoupling: cambiando il default reale (es. via `.env` di produzione) la guardia non scatta.

### A6a — Chiarimento inviato ad account `unsubscribed` (MEDIUM, D3 — istanza non dichiarata, `email-processor.ts:389-405`)

- **File test:** `tests/integration/email-process.test.ts` (nuovo `it`).
- **Setup:** harness; account `unsubscribed` (register → beginUnsubscribe → confirmUnsubscribe); classificatore scriptato `'come funziona?'` → `{ intent: 'other', pick: null }`.
- **Asserzione attesa (post-fix):** NESSUNA risposta (`channel.sent` vuoto); action `silent_other`; messaggio marcato `seen`.
- **Esito attuale:** **RED** — oggi parte la risposta di chiarimento (violazione decisione 7/ADR-009 "nessuna email a `unsubscribed`").

### A6b — Chiarimento inviato ad account `pending_unsubscribe` (MEDIUM, stessa istanza D3)

- **File test:** `tests/integration/email-process.test.ts` (nuovo `it`).
- **Setup:** account `pending_unsubscribe` (register → beginUnsubscribe); classificatore `'ma forse cambio idea?'` → `other` (body NON in lista di conferma).
- **Asserzione attesa (post-fix):** silenzio (nessuna risposta, action `silent_other`, `seen`); lo stato resta `pending_unsubscribe`.
- **Esito attuale:** **RED** — oggi parte il chiarimento.
- **Nota di confine:** la conferma della barriera da `pending` con body in lista resta completabile (A1): l'ordine dei rami corretto è "barriera (a) PRIMA, silenzio `other` (e) DOPO".

### A7 — Soggetto email "già iscritto" di tipo `pick_rejected` (LOW/MED, report §3)

- **File test:** `tests/integration/email-process.test.ts` (aggiornamento del test esistente "mittente già active → 'già iscritto'" + nuovo `it` dedicato al soggetto).
- **Setup:** account già `active` che invia un `subscribe`.
- **Asserzione attesa (post-fix):** il contesto generato ha `type: 'platform_already_registered'`; il soggetto è `"Survivor League — Già iscritto alla piattaforma"`; action `already_subscribed` invariata; nessun account duplicato.
- **Esito attuale:** **RED** — oggi `type: 'pick_rejected'` con soggetto `"Survivor League — Pick non registrato"` (UX fuorviante).

### A8 — `player` esistente senza `profile` (dati legacy) → `already_registered` permanente (LOW, report §3)

- **File test:** `tests/unit/game/registration.test.ts` (nuovo `it` su `autoJoinFromPick`).
- **Setup:** DB torneo con riga `player` preesistente per l'email (senza `profile`, `register_id` NULL — dato legacy, decisione 2 "nessuna migrazione"); account piattaforma `active`; round = `start_round` e `open`; pick valido.
- **Asserzione attesa (post-fix):** esito `ok: true`; il profilo nasce collegato al `player` ESISTENTE (niente nuova riga player, UNIQUE email rispettato); `profile.register_id = account.registerId` (backfill); pick inserito.
- **Esito attuale:** **RED** — `autoJoinFromPick` ritorna `{ ok: false, reason: 'already_registered' }` a causa del check `playerExists` (`registration.ts:100-102`): l'utente non entra MAI.

### A9 — Contract test `llm:classify` mancante (LOW, D7 — coverage gap)

- **File test:** `tests/unit/cli/llm-classify.test.ts` (NUOVO file; oggi 0 occorrenze di `classifyInputBody`/`llm:classify` nei test, verificato con grep).
- **Setup:** fetch/`OpenAIClient` mockato come in `intent-classifier.test.ts`; invoca il wiring del comando `llm:classify` (funzione esportata del comando, non il binario) con input JSON.
- **Asserzione attesa:** output `{ intent, pick }` coerente con l'input; contenuto ambiguo → `{intent:'other', pick:null}`; errore di trasporto → `LLMError` (contratto D3).
- **Esito attuale:** test INESISTENTE (gap di copertura, non un bug). **GREEN da subito** dopo la scrittura (il comportamento è già implementato): chiude D7 senza modifiche di codice; eventuali rossi inattesi vanno trattati come regressione reale.

### Dichiarazioni di copertura già esistente (nessun nuovo test richiesto)

| Punto | Coperto da |
|---|---|
| Secondo messaggio da `pending` con intento `unsubscribe` e body in lista (`confermo`/`sì`/`si`/`yes`) → soft-delete | `tests/integration/email-process.test.ts` `it.each` (righe ~248-268) — ESISTENTE e verde |
| Matrice notifiche: filtri `active` su open/close/score/broadcast, riepilogo ai soli sopravvissuti, unico invio | `tests/unit/game/round-notifications.test.ts` — ESISTENTE |
| Guardia `simulate:*` base (rifiuto/accettazione su percorso dedicato) | `tests/unit/cli/simulate-guard.test.ts` (2 test) — ESISTENTE; resta scoperto SOLO l'ancoraggio al default (A5) |
| Auto-join atomico (BEGIN/COMMIT/ROLLBACK, nessun profilo orfano, risposta `pick_confirmed`) | `tests/unit/game/registration.test.ts` — ESISTENTE |
| Idempotenza `round:score`, doppio `platform:register`, doppio unsubscribe | suite esistente (verificata dal report §3 "Aspetti verificati senza rilievi") — ESISTENTE |

### Dichiarazioni di esclusione motivata (findings LOW senza test in QUESTO piano)

| Finding | Motivo |
|---|---|
| **Doppio processing su tick concorrenti del cron (fetch prima del markSeen) → risposte duplicate** (LOW, preesistente, `email-processor.ts:445-477`) | Il fix di `markSeen` è assegnato al piano separato `tasks/llm/plan-failover-llm-multimodello.md` (dipendenza UAT dichiarata in memoria di progetto). Il test di riproduzione va scritto LÌ (esecuzione UAT già vincolata ad avvenire DOPO quel piano). NON si aggiunge qui un test destinato a restare rosso. |
| **Invio sequenziale 1-per-1 (SMTP+LLM) per broadcast/riepilogo** (LOW, `tournament.ts:268-276`, `round-manager.ts:235-246,448-455`) | Accettato come limite POC dal report ("accettabile POC"): nessun test, nessuna correzione in questo piano. |
| **Findings documentali** (commenti stale, dead-write `registration_open`, conteggio test in current-status) | Elencati come correzioni in Fase B8 SENZA test dedicato (nessun comportamento osservabile da asserire). |

---

## 4. FASE B — Correzione dei findings (una alla volta, MAI in parallelo)

Ordine fisso: **B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8**. Ogni step: test rosso già pronto → modifica → protocollo verde completo → si procede.

### B1 (HIGH) — Barriera unsubscribe robusta all'LLM reale (D1/D2, decisione (a))

- **Test collegati:** A1, A2 (rossi).
- **File e modifica:**
  1. `src/channel/email-processor.ts` — `processOne`: subito dopo la lettura dell'account e PRIMA dei rami di intento, aggiungere il ramo barriera: se `account?.status === 'pending_unsubscribe' && isUnsubscribeConfirmation(routed.body)` → `platform.confirmUnsubscribe(...)` + risposta `platform_unsubscribed` + `markSeen` + action `unsubscribe_confirmed` (**intento-agnostico**: copre "confermo" classificato `other`). Il ramo `unsubscribe` esistente resta invariato (active→begin; pending+body non in lista→ri-chiede conferma; unsubscribed/sconosciuto→silenzio). Commenti §5 aggiornati su `processOne` e sul file header (il flusso documentato ora include il completamento intento-agnostico).
  2. `src/llm/intent-classifier.ts` — `buildClassifySystemPrompt`: aggiungere agli esempi di `unsubscribe` i testi "confermo", "sì", "si" (con la nota che sono risposte alla richiesta di conferma del sistema).
- **Comportamento risultante:** un utente reale che risponde "confermo" completa la disiscrizione anche se l'LLM classifica `other`; l'LLM ha comunque più contesto per classificare `unsubscribe`.
- **Verifica comportamentale mirata (matrice barriera a due passi):**
  - active + unsubscribe → pending + conferma (nessuna soft-delete);
  - pending + "confermo" con intento `other` → soft-delete (A1);
  - pending + "confermo" con intento `unsubscribe` → soft-delete (test esistente);
  - pending + unsubscribe con body non in lista → resta pending + conferma ripetuta (test esistente);
  - pending + `other` con body non in lista → silenzio (A6b, dopo B5 — attenzione: in B1 il test A6b resta ROSSO e viene sistemato SOLO in B5; il protocollo di B1 esegue l'intera suite esclusi i test rossi attesi di step successivi, che vanno annotati nel report di sessione, oppure si esegue la suite con `-t` esclusione. REGOLA PRATICA del piano: ogni step esegue l'intera suite e considera "protocollo verde" = nessun rosso TRANNE i test rossi attesi degli step successivi, tracciabili nel registro di esecuzione);
  - unsubscribed/sconosciuto + unsubscribe → log silenzioso;
  - subscribe/pick da pending → riattivazione.
- **Protocollo:** `npm test` (414 + A1/A2 verdi), `npm run typecheck`, `npm run lint`, matrice sopra. Nessuno smoke (nessun `simulate:*` toccato).

### B2 (HIGH) — `summary_sent` atomico con la transizione a `scored` (decisione (b))

- **Test collegato:** A3 (rosso).
- **File e modifica:** `src/game/round-manager.ts` — `scoreRound`, blocco transizione `closed→scored` (~righe 428-457):
  1. la scrittura della transizione diventa `UPDATE round_state SET status = 'scored', scored_at = ?, summary_sent = 1 WHERE round = ?` (UNA istruzione: guardia e stato cambiano insieme, PRIMA del loop di invio);
  2. il loop di invio del riepilogo: ogni `notify` avvolto in try/catch → `logger`-style warn pino in INGLESE (es. `'round:score: riepilogo non inviato a <email> — si continua (best-effort)'`), il loop continua coi destinatari successivi; `scoreRound` risolve normalmente anche con invii falliti;
  3. commenti §5 aggiornati su `scoreRound` e sul blocco (semantica best-effort documentata).
- **Comportamento risultante:** non esiste più `scored` con `summary_sent=0`; la guardia non si perde mai; gli invii falliti sono visibili nei log; l'idempotenza (nessun re-invio alle riaperture) è invariata.
- **Verifica comportamentale mirata (idempotenza riepilogo):** run → A3 verde; seconda `scoreRound` → 0 email riepilogo; riepilogo ai SOLI sopravvissuti `active` (test esistenti); nessun riepilogo nelle riaperture.
- **Protocollo:** `npm test`, typecheck, lint, verifiche sopra. Nessuno smoke.

### B3 (MEDIUM) — Filtro notifiche fail-closed (D4, decisione (c))

- **Test collegato:** A4 (rosso).
- **File e modifica:** `src/game/round-manager.ts` — `isAccountActive` (~righe 80-84): `if (ctx.platform === undefined) return false;` (prima riga) + doc comment aggiornato: senza registry le notifiche NON partono (nessun bypass silenzioso, simmetria con `checkEligibility`).
- **Comportamento risultante:** un contesto senza registry iniettato non invia email; tutte le CLI reali che inviano email (`round:*`, `tournament:start`, `scheduler:*`, `channel:email:process`) iniettano già il registry (verificato dal report), quindi il comportamento di produzione non cambia.
- **Verifica comportamentale mirata (matrice notifiche):** A4 verde; con registry iniettato l'intera matrice esistente di `round-notifications.test.ts` resta verde (open/close/score/broadcast filtrati su `active`); `tournament:start` senza registry resta no-op (comportamento già esplicito e testato).
- **Protocollo:** `npm test`, typecheck, lint, matrice sopra. Nessuno smoke.

### B4 (MEDIUM) — Guardia `simulate:*` ancorata al default reale di produzione (D8, decisione (d))

- **Test collegato:** A5 (rosso a livello di compilazione).
- **File e modifica:**
  1. `src/config.ts` — nuova export `PLATFORM_DB_PATH_DEFAULT = './data/platform.db'` con commento §5 (scopo: unica fonte del valore di produzione; usata dal default zod e dalla guardia di simulazione); lo schema usa `PLATFORM_DB_PATH: z.string().min(1).default(PLATFORM_DB_PATH_DEFAULT)`.
  2. `src/cli/commands/simulate.ts` — rimozione della costante locale `PRODUCTION_PLATFORM_DB_PATH`; `assertSimPlatformPath` confronta `config.PLATFORM_DB_PATH === PLATFORM_DB_PATH_DEFAULT` (import da `config.ts`); commento aggiornato (il default reale è UNO, in `config.ts`).
  3. `tests/unit/cli/simulate-guard.test.ts` — i 2 test esistenti adeguati all'import da `config.ts`; A5 aggiunto.
- **Comportamento risultante:** se il valore di produzione cambia (default in `config.ts` o `.env` reale con lo stesso valore del default), la guardia segue automaticamente la fonte unica; nessuna costante duplicata che può divergere.
- **Verifica comportamentale mirata + SMOKE OBBLIGATORIO (si tocca `simulate:*`):**
  - `npm test`, typecheck, lint;
  - smoke su `/tmp` (DB dedicati, mai `./data`): ① `data:seed-synthetic` su DB torneo `/tmp/kilo/sim-guard-b4.db` (seed sintetico, `--force` se serve, `SCHEDULER_ENABLED=false`); ② `simulate:full` con `PLATFORM_DB_PATH=./data/platform.db` → **rifiuto esplicito** ("valore di produzione"), exit non-zero, nessuna scrittura; ③ `simulate:full` con `PLATFORM_DB_PATH=/tmp/kilo/sim-platform-b4.db` → esecuzione completa: auto-join TT1 con `register_id` 1..N replicato su `player`/`profile`, `summary_sent=1` in `tournament:export`, `platform:list` corretto; ④ nessun `data:refresh`/`scheduler:tick` sui DB shiftati; cleanup SOLO su comando esplicito dell'utente.
- **Nota rischio residuo (documentata nel §8):** la guardia si ancora al DEFAULT; un `.env` di produzione che imposta un `PLATFORM_DB_PATH` CUSTOM diverso dal default non viene intercettato dalla guardia (già così oggi). Mitigazione: file env dedicati per simulazione/UAT (`.env.uat-replay`, DB dedicati).

### B5 (MEDIUM) — Chiarimento `other` solo ad account `active` (istanza D3, decisione (e))

- **Test collegati:** A6a, A6b (rossi; A6b diventa verde SOLO con questo step).
- **File e modifica:** `src/channel/email-processor.ts` — ramo `other` (~righe 389-405): dopo il check `account === null` (silenzio per sconosciuti, invariato), aggiungere `if (account.status !== 'active')` → log info pino in INGLESE (es. `'email:process: other da account non active — log interno, nessuna risposta (decisione 7)'`), `markSeen`, action `silent_other`; il chiarimento parte SOLO per account `active`. Commento §5 aggiornato sul ramo e nel file header.
- **Comportamento risultante:** decisione 7/ADR-009 rispettata: `unsubscribed`/`pending_unsubscribe` non ricevono più il chiarimento; il completamento della barriera (A1, ramo B1) resta raggiungibile perché valutato PRIMA.
- **Verifica comportamentale mirata (silenzio anti-spam):** matrice: `active`+other → chiarimento; `unsubscribed`+other → silenzio+seen (A6a); `pending`+other non-conferma → silenzio+seen (A6b); sconosciuto+other → silenzio (test esistente); pending+"confermo"(other) → soft-delete (A1 ancora verde, nessuna regressione B1).
- **Protocollo:** `npm test`, typecheck, lint, matrice sopra. Nessuno smoke.

### B6 (LOW) — Tipo email dedicato "già iscritto" (decisione (f))

- **Test collegato:** A7 (rosso).
- **File e modifica:**
  1. `src/llm/generator.ts` — `EMAIL_TYPES` + `SUBJECT_LABELS`: nuovo `platform_already_registered` con etichetta `'Già iscritto alla piattaforma'` (il soggetto finale è `"Survivor League — Già iscritto alla piattaforma"`, determinismo D1 invariato); commenti aggiornati;
  2. `src/llm/templates.ts` — nuova voce `EMAIL_TEMPLATES.platform_already_registered` (il `Record<EmailType, string>` garantisce la copertura a compile-time): spiega che l'account è già attivo, che la re-iscrizione non serve e che per partecipare basta inviare il primo pick entro la scadenza del TT1;
  3. `src/channel/email-processor.ts` — ramo `subscribe` su account già `active`: la risposta diventa `{ type: 'platform_already_registered', reason: 'sei già iscritto alla piattaforma (email_already_registered)' }` (action `already_subscribed` invariata).
- **Comportamento risultante:** soggetto/body coerenti per chi tenta di iscriversi due volte; nessun riuso improprio di `pick_rejected`.
- **Verifica comportamentale mirata:** A7 verde; subscribe nuovo → `platform_registered` (invariato); riattivazioni da unsubscribed/pending → `platform_registered` (invariato); copertura `Record` verde (typecheck).
- **Protocollo:** `npm test`, typecheck, lint. Nessuno smoke.

### B7 (LOW) — Auto-join con `player` legacy senza `profile` (decisione (g), report §3)

- **Test collegato:** A8 (rosso).
- **File e modifica:** `src/game/registration.ts` — `autoJoinFromPick`:
  1. rimuovere il check anticipato `playerExists(...)` che produce `already_registered`;
  2. nella transazione: `SELECT id FROM player WHERE email = ?` — se esiste, RIUSARE il `player_id` (niente INSERT su `player`; backfill `register_id` con `account.registerId` se NULL) e inserire SOLO il `profile`; se non esiste, comportamento attuale (INSERT player + profile). Il vincolo `UNIQUE(email)` non è mai violato;
  3. il motivo `already_registered` resta nell'unione `AutoJoinResult` solo per il caso difensivo di profilo già esistente (raggiungibile solo in corsa concorrente: il wiring instrada il profilo esistente altrove);
  4. commenti §5 aggiornati (logica di riuso/backfill documentata).
- **Comportamento risultante:** dati legacy (player senza profile, decisione 2 "nessuna migrazione") non bloccano più l'auto-join: il profilo nasce sul player esistente con `register_id` allineato; l'atomicità e il rollback restano identici.
- **Verifica comportamentale mirata (auto-join TT1 atomico):** A8 verde; test esistenti di atomicità (rollback su pick invalido, nessun profilo orfano, risposta `pick_confirmed`) ancora verdi; nessuna nuova riga `player` duplicata (UNIQUE).
- **Protocollo:** `npm test`, typecheck, lint. Nessuno smoke (nessun `simulate:*` toccato).

### B8 (LOW + documentale) — Dead-write, commenti stale, contract test, allineamento documenti

Nessun test dedicato (correzioni non comportamentali), tranne B8c. Verifica finale: `npm test` (intera suite, inclusi tutti i nuovi test verdi), typecheck, lint, grep documentali sotto.

- **B8a — Rimozione dead-write `registration_open` (D5):** `src/game/tournament.ts` — `startTournament`: l'`INSERT/UPDATE` su `tournament_state` (~righe 246-252) non scrive più `registration_open = 1` (la colonna resta DEPRECATA nello schema, `schema.ts:92`, per compatibilità; il valore resta il default 0). Verifica: grep `registration_open = 1` → 0 occorrenze in `src/`; `tournament:export` coerente.
- **B8b — Commenti stale (AGENTS.MD §5):**
  - `src/game/tournament.ts:17-18` e `:23`: header/stato aggiornati (niente più "RF-22 / finestra di iscrizione"; `registration_open` non scritto);
  - `src/game/pick-processor.ts:6` e `:168`: "auto-iscrizione (Task 4.2)" / "auto-iscrizione RF-27" → "auto-join RF-P5" (RF-27 deprecata);
  - `src/cli/commands/scheduler.ts:6` (describe header): rimuovere "finestra di iscrizione" dalle azioni di `scheduler:tick`;
  - `src/cli/commands/pick.ts:17`: "`now = new Date()`" → "`now = makeNow(config)`".
  Verifica: grep `finestra di iscrizione` in `src/cli/commands/scheduler.ts` → 0; grep `RF-27` in `src/game/pick-processor.ts` → 0.
- **B8c — Contract test `llm:classify` (D7):** nuovo `tests/unit/cli/llm-classify.test.ts` come da A9 (atteso verde da subito; nessuna modifica a `src/cli/commands/llm.ts` salvo emersione di rossi inattesi).
- **B8d — Carve-out documentale (D3):**
  - `docs/decisions/architecture-decisions.md`: l'ADR è append-only → registrare una NUOVA voce (ADR-010, "Chiarimenti ADR-009 post-revisione 2026-08-21") che formalizza: (i) le conferme RF-P1/P2 (`platform_unsubscribe_confirm` verso `pending_unsubscribe`, `platform_unsubscribed` verso `unsubscribed`, risposte subscribe) partono SEMPRE, anche verso account non `active`, perché sono il flusso di conferma stesso — carve-out esplicito al filtro `active` di RF-P6/decisione 7; (ii) la semantica esatta della barriera (decisione 3): completamento = account `pending_unsubscribe` + body nella lista di conferma, indipendente dall'intento; (iii) le decisioni (a)–(g) di questo piano come decisioni registrate.
  - `docs/POC/POC_PRD.md` (v0.6.1): RF-P6 con carve-out per le conferme RF-P1/P2; RF-P1 con il nuovo tipo email `platform_already_registered`; §3/elenco `EmailType` aggiornato; changelog.
  - `docs/POC/POC_LLD.md` se enumera gli `EmailType` (§6.3): aggiungere `platform_already_registered` (verifica puntuale sul file; nessuna riscrittura).
- **B8e — Conteggio test in `agent-context/current-status.md`:** correggere "429 test verdi" → "414 test verdi" (riga 7) e — a Fase B conclusa — aggiornare con il conteggio consuntivo (414 + nuovi) e voce changelog ISO-8601 (AGENTS.MD §0) che riepiloga correzioni e test aggiunti.
- **Protocollo B8:** `npm test` (intera suite, attesi 414 + ~12 nuovi, tutti verdi), typecheck, lint, grep documentali sopra elencati.

---

## 5. Strategia delle sessioni di implementazione (git)

- **Strategia scelta (default):** sessioni SEQUENZIALI in modalità **local** sullo stesso working tree `feat/iscrizione-piattaforma`, una correzione per sessione (B1, B2, …), NESSUN commit intermedio e nessun push: il delta resta nel working tree come oggi, e il protocollo di verifica (§1.2) chiude ogni sessione. Vantaggi: zero rischio git, nessuna richiesta di autorizzazione necessaria, working tree già allineato al branch.
- **Alternativa (solo previa autorizzazione ESPLICITA dell'utente):** commit di BASELINE del lavoro corrente su `feat/iscrizione-piattaforma` (nessun push) e successivi **worktree** dedicati per ciascuna correzione, con merge sequenziale a protocollo verde. Utile solo se l'utente vuole tracciabilità per-commit o parallelismo (NON previsto: le correzioni sono strettamente sequenziali).
- In entrambe le strategie: MAI commit su `main`; push e PR solo su richiesta esplicita (AGENTS.MD §7.2).

---

## 6. Checklist di chiusura complessiva

- [ ] Fase A completa: tutti i test A1–A9 scritti e fotografati rossi (o dichiarati ESISTENTI/ESCLUSI come da §3).
- [ ] Fase B completa nell'ordine B1→B8; ogni step chiuso con `npm test` + `npm run typecheck` + `npm run lint` verdi e verifica comportamentale mirata eseguita.
- [ ] **Test totali attesi:** 414 (baseline) + ~12 nuovi (A1, A2, A3, A4, A5, A6a, A6b, A7, A8, A9×~3) ≈ **426** — il numero esatto si conferma a consuntivo e si riporta in `agent-context/current-status.md`.
- [ ] **Smoke richiesti:** ① smoke guardia in B4 (`simulate:full` su DB `/tmp`: rifiuto con `PLATFORM_DB_PATH=./data/platform.db` + run completo con `PLATFORM_DB_PATH` dedicato, seed sintetico, `summary_sent=1`, `platform:list`, `register_id` replicati); nessun altro smoke richiesto (i fix non toccano provider SMTP/IMAP/LLM reali: nessuna modifica a componenti con vincolo di smoke reale).
- [ ] **Documenti riallineati:** `architecture-decisions.md` (ADR-010), `POC_PRD.md` (RF-P6 carve-out, `platform_already_registered`, changelog), `POC_LLD.md` (§6.3 se necessario), `agent-context/current-status.md` (414→consuntivo, changelog), commenti sorgente (B8a/B8b).
- [ ] **Grep finali di conformità:** nessuna scrittura via `ctx.platform` fuori dal registry; nessun `registration_open = 1`; nessun "finestra di iscrizione" in scheduler.ts; nessun `RF-27` nei commenti di pick-processor.ts; log pino nuovi in inglese.
- [ ] Nessun commit/push effettuato in questo piano (consegna = solo piano + future sessioni).

---

## 7. Mappatura findings → task di correzione (tracciabilità)

| Finding report | Gravità | Test Fase A | Correzione Fase B |
|---|---|---|---|
| D1 — condizione soft-delete più restrittiva della spec | HIGH | A2 (+ A1) | B1 (barriera intento-agnostica) + B8d (ADR decisione 3 allineata) |
| D2 — deadlock "confermo"→`other` | HIGH | A1 | B1 |
| D3 — conferme sempre inviate (doc) | HIGH (doc) | — (nessun test) | B8d (ADR-010 + PRD carve-out) |
| D3 — chiarimento ad account `unsubscribed`/`pending` (istanza non dichiarata) | MEDIUM | A6a, A6b | B5 |
| D4 — filtro notifiche fail-open senza registry | MEDIUM | A4 | B3 |
| D5 — `registration_open` dead-write + header stale | LOW | — (documentale) | B8a/B8b |
| D6 — deviazione 1 `GameContext.classifier` | giustificata | — | nessuna |
| D7 — contract test `llm:classify` assente | LOW (gap) | A9 | B8c |
| D8 — guardia su costante hardcoded | MEDIUM | A5 | B4 |
| §3 — `summary_sent` perso su eccezione | HIGH | A3 | B2 |
| §3 — reply "già iscritto" con soggetto `pick_rejected` | LOW/MED | A7 | B6 |
| §3 — player esistente senza profile → `already_registered` | LOW | A8 | B7 |
| §3 — doppio processing tick concorrenti (risposte duplicate) | LOW (preesistente) | — (escluso: piano `plan-failover-llm-multimodello.md`) | — (fuori scope, dipendenza UAT nota) |
| §3 — invio sequenziale 1-per-1 broadcast/riepilogo | LOW (accettato POC) | — (escluso) | — |
| §2 — commenti stale (tournament.ts, pick-processor.ts, scheduler.ts, pick.ts) | LOW | — (documentale) | B8b |
| §4.7 — conteggio test `current-status.md` (429 → 414) | Documentale | — | B8e |

---

## 8. Rischi residui

1. **B4:** la guardia si ancora al DEFAULT di produzione; un `PLATFORM_DB_PATH` custom nel `.env` reale diverso dal default non viene intercettato (comportamento già attuale). Mitigazione: simulazione/UAT usano file env dedicati e DB dedicati; rischio accettato e documentato nel commento della guardia.
2. **B2:** invio best-effort per destinatario — su outage SMTP/LLM un sopravvissuto può non ricevere il riepilogo (il fallimento è loggato, non ritentato). Accettato come trade-off POC; l'alternativa (retry esplicito per destinatario) resta fuori scope e documentata nel commento.
3. **B1:** il prompt aggiornato migliora la classificazione ma non la garantisce; la barriera è comunque robusta perché il completamento è ancorato al body (deterministico), non all'intento.
4. **B7:** il backfill di `register_id` su player legacy usa il valore dell'account piattaforma; un player la cui email non corrisponde ad alcun account resta ineleggibile (decisione 2: nessuna migrazione dati).
5. **Doppio processing concorrente del cron** (risposte duplicate) resta aperto finché il piano failover LLM non atterra: le esecuzioni UAT devono continuare ad avvenire DOPO quel piano (vincolo di progetto già registrato).
6. **Conteggio test:** 414 è la baseline del report; il consuntivo finale va verificato alla prima esecuzione della suite con i nuovi test.
