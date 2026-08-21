# Log di esecuzione — piano test-e-fix findings (2026-08-21)

Registro sequenziale delle sessioni che eseguono `tasks/iscrizione-piattaforma/plan-test-e-fix-findings.md`.
Ogni step: test rosso fotografato → modifica → protocollo completo (`npm test` intera suite, typecheck, lint) → verifica comportamentale mirata → append qui. Nessun commit/push in nessuno step.

## Baseline (fotografata dal report di revisione tecnica 2026-08-21)

- **Branch:** `feat/iscrizione-piattaforma` (working tree NON committato).
- **Suite:** `npm test` 414/414 verdi (39 file).
- **Typecheck/lint:** puliti.
- **Data:** 2026-08-21.

---

## Step B1 (HIGH) — Barriera unsubscribe robusta all'LLM reale (D1/D2, decisione (a))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (primo step: log creato in questa sessione).
- **Test scritti (Fase A):** A1 in `tests/integration/email-process.test.ts`, A2 in `tests/unit/llm/intent-classifier.test.ts`.

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test` (filtro `-t`) alle 12:08Z del 2026-08-21:

**A1** (`tests/integration/email-process.test.ts`, 25 test → 1 failed):
```
× channel:email:process — unsubscribe a due passi (RF-P2) > pending + "confermo" classificato other → soft-delete INTENTO-AGNOSTICO (barriera B1, D1/D2)
AssertionError: expected 'pending_unsubscribe' to be 'unsubscribed' // Object.is equality
Expected: "unsubscribed"
Received: "pending_unsubscribe"
❯ tests/integration/email-process.test.ts:286:29
```
→ deadlock confermato: con "confermo" classificato `other` lo stato resta `pending_unsubscribe`
(il ramo `other` risponde il chiarimento; soft-delete mai eseguita).

**A2** (`tests/unit/llm/intent-classifier.test.ts`, 16 test → 1 failed):
```
× buildClassifySystemPrompt — contesto lega in test mode (D7) > gli esempi di unsubscribe citano le conferme "confermo"/"sì"/"si" come segnali (B1, D1/D2)
AssertionError: expected 'Sei il classificatore di Survivor Lea…' to contain '"confermo", "sì", "si"'
❯ tests/unit/llm/intent-classifier.test.ts:214:20
```
→ il prompt degli esempi `unsubscribe` cita solo "voglio disiscrivermi" / "non voglio più giocare" /
"rimuovetemi": nessuna conferma "confermo"/"sì"/"si".

### Modifica applicata

1. **`src/channel/email-processor.ts`** — `processOne`: nuovo ramo **barriera** subito dopo la
   lettura dell'account e PRIMA dei rami di intento: se `account?.status === 'pending_unsubscribe'`
   e `isUnsubscribeConfirmation(routed.body)` (match esatto normalizzato su `confermo`/`sì`/`si`/`yes`)
   → `platform.confirmUnsubscribe(...)` + risposta `platform_unsubscribed` + `markSeen` + action
   `unsubscribe_confirmed`, con log info pino in INGLESE
   (`'email:process: unsubscribe confirmed via barrier (confirmation body, intent-agnostic)'`,
   include l'intento classificato per diagnosi). **Intento-agnostico** (copre "confermo"→`other`).
   Il ramo `unsubscribe` esistente resta INVARIATO (active→begin+conferma; pending+intento
   unsubscribe con body NON in lista→conferma ripetuta; unsubscribed/sconosciuto→silenzio).
   Commenti §5 aggiornati: header del file (bullet `unsubscribe` con barriera B1/decisione (a))
   e doc comment di `processOne`.
2. **`src/llm/intent-classifier.ts`** — `buildClassifySystemPrompt`: gli esempi dell'intento
   `unsubscribe` ora citano `"confermo", "sì", "si" — risposte alla richiesta di conferma del
   sistema`; doc comment §5 della funzione aggiornato (barriera ancorata al body deterministico,
   il prompt dà solo più contesto all'LLM).

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` usato solo con
`find`/`register`/`beginUnsubscribe`/`confirmUnsubscribe`/`reactivate` del registry.

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **416/416 verdi** (39 file) = 414 baseline + A1 + A2.
  Nessun rosso residuo (i test rossi attesi di step successivi A3–A8 non sono ancora stati
  scritti in questa sessione, per cui la suite è interamente verde).
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (matrice barriera, filtro `-t unsubscribe` su
  `email-process.test.ts` → 12 test verdi):**
  - active + unsubscribe → pending + conferma, NESSUNA soft-delete (test esistente) ✓
  - pending + "confermo" con intento `other` → soft-delete + `platform_unsubscribed` + seen (A1) ✓
  - pending + "confermo"/"sì"/"si"/"yes" con intento `unsubscribe` → soft-delete (test esistente `it.each`) ✓
  - pending + unsubscribe con body NON in lista → resta pending + conferma ripetuta (test esistente) ✓
  - unsubscribed/sconosciuto + unsubscribe → silenzio + seen (test esistente) ✓
  - subscribe da pending → riattivazione stesso registerID (test esistente) ✓
  - pick da pending → riattivazione e pick registrato (test esistente) ✓
- **Punti NON di questo step:** "pending + other con body non in lista → silenzio" (A6b, step B5)
  NON scritto, come da piano. Nessuno smoke (nessun `simulate:*` toccato). Nessun commit/push.

---

## Step B2 (HIGH) — `summary_sent` atomico con la transizione a `scored` + invio best-effort (decisione (b))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (secondo step).
- **Test scritto (Fase A):** A3 in `tests/unit/game/round-notifications.test.ts` (nuovo `it`
  "round:score con invio riepilogo che fallisce sul 2° destinatario → …").

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -t "invio riepilogo che fallisce"` alle 12:21Z del 2026-08-21:

```
 FAIL  tests/unit/game/round-notifications.test.ts > filtro account active sulle notifiche (RF-P6, ADR-009) > round:score con invio riepilogo che fallisce sul 2° destinatario → scored+summary_sent atomici, best-effort, idempotente (A3/B2)
Error: smtp down
 ❯ ThrowingOnSecondSummaryGenerator.generate tests/unit/game/round-notifications.test.ts:88:31
 ❯ notify src/game/round-manager.ts:194:36
 ❯ Module.scoreRound src/game/round-manager.ts:449:15
 ❯ tests/unit/game/round-notifications.test.ts:319:20
 Test Files  1 failed | 38 skipped (39)
      Tests  1 failed | 416 skipped (417)
```

→ finding §3 confermato: l'eccezione del generator propaga fuori da `scoreRound` (loop del
riepilogo, `round-manager.ts:449`); con status già `scored` la `summary_sent` sarebbe rimasta
0 (l'UPDATE della guardia era DOPO il loop) e il riepilogo perso per sempre.

### Modifica applicata

1. **`src/game/round-manager.ts`** — `scoreRound`, blocco transizione `closed→scored`:
   - la scrittura della transizione è ORA UN'UNICA istruzione
     `UPDATE round_state SET status = 'scored', scored_at = ?, summary_sent = 1 WHERE round = ?`
     (guardia e stato cambiano insieme, PRIMA del loop di invio): non esiste più lo stato
     intermedio `scored` + `summary_sent=0`;
   - ogni `notify` del loop di riepilogo è avvolto in try/catch → warn pino in INGLESE
     (`round:score: summary not sent to <email> — continuing (best-effort)`, con campi
     strutturati `{ email, error }`) via `ctx.logger` (quando iniettato); il loop continua coi
     destinatari successivi e `scoreRound` risolve normalmente anche con invii falliti;
   - commenti §5 aggiornati: doc comment di `scoreRound`, header del file (bullet round:score)
     e commento del blocco 3 (semantica best-effort documentata, trade-off "nessun retry"
     = rischio §8 del piano).
2. **`src/game/context.ts`** — nuovo campo opzionale `logger?: Logger` (pino) nel
   `GameContext`, con commento §5: è il punto di iniezione DI coerente con gli altri
   componenti I/O (channel/generator/parser/classifier/platform) e rende il warn TESTABILE
   (lo stream catturabile col pattern `createLogger('debug', { write })`).
3. **`src/cli/commands/round.ts`** e **`src/cli/commands/scheduler.ts`** — iniezione del
   logger pino del comando (livello + binding testMode dalla config) nel contesto di gioco:
   i fallimenti best-effort restano visibili nei log di produzione (`round:score`,
   `scheduler:tick`). `simulate.ts` NON toccato (R1: nessuna componente email nel contesto di
   simulazione → il riepilogo non può fallire lì).

   DEVIAZIONE MOTIVATA rispetto all'elenco file del piano §4 B2 (solo round-manager.ts):
   senza il campo `logger` nel `GameContext` l'asserzione A3 "(errore loggato warn)" non era
   implementabile in modo testabile, e senza l'iniezione nelle CLI il risultato dichiarato dal
   piano ("gli invii falliti sono visibili nei log") non sarebbe stato raggiunto in produzione.
   Nessun'altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` invariato
   (solo lettura).

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **417/417 verdi** (39 file) = 416 (baseline + A1/A2)
  + A3. Nessun rosso residuo.
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (idempotenza riepilogo, filtro `-t "filtro account active"`
  su `round-notifications.test.ts` → 6 test verdi):**
  - A3 verde: `scoreRound` risolve senza lanciare; `status='scored'` E `summary_sent=1`
    (unica scrittura); 1° destinatario notificato, 2° no, warn pino catturato
    (`round:score: summary not sent`); seconda `scoreRound` → 0 nuovi invii (assert nel test) ✓
  - riepilogo ai SOLI sopravvissuti `active`, UNA volta (test esistente) ✓
  - eliminati ricevono solo `round_result_wrong`, mai il riepilogo (test esistente) ✓
  - open/close/broadcast filtrati su `active` (test esistenti) ✓
- **Punti NON di questo step:** nessuno smoke (nessun `simulate:*` toccato). Nessun
  commit/push. Test rossi attesi di step successivi (A4–A8) non ancora scritti.

### Post-review dello step (review `/review uncommitted`, correzioni applicate su scelta utente)

Dopo la chiusura del protocollo B2 è stata eseguita una review del working tree non committato
(6 track). Esiti consolidati: 1 WARNING + 6 SUGGESTION, tutti applicati su scelta dell'utente
("Correggi WARNING + SUGGESTION"). Finding già noti del report (D1–D8) NON ri-riportati
(restano assegnati a B3–B8); scartati i rilievi su trade-off accettati e documentati nel piano
(best-effort senza retry = rischio §8; nessuna migrazione dati = decisione 2; invio 1-per-1 =
"accettabile POC" del report).

**WARNING (business logic) — `src/llm/intent-classifier.ts`:** rimosso lo short-circuit
`teams.length === 0 → other` senza chiamata API: con lista squadre vuota (DB senza dati
stagione) OGNI email reale era classificata `other` e subscribe/unsubscribe venivano
inghiottiti in silenzio (contraddicendo "indipendenti dai round", ADR-009). Ora l'intento è
classificato SEMPRE (il filtro esatto su `parseClassification` azzera comunque il pick sulla
lista vuota). Il contratto storico del PARSER (`extractPick`, pick-only) resta invariato:
la guardia "lista vuota → null senza chiamare l'API" è stata spostata in
`src/llm/parser.ts` (nessuna regressione del test esistente).

**SUGGESTION applicate:**
1. `src/channel/email-processor.ts` — rimosso il ramo morto `pending_unsubscribe` +
   body di conferma dentro il ramo `unsubscribe` (irraggiungibile dopo la barriera B1):
   resta il solo caso raggiungibile body NON in lista → conferma ripetuta (comportamento
   osservabile invariato, i test esistenti passano via barriera);
2. `src/game/round-manager.ts` — rimossa la guardia interna sempre-vera
   `if (rs.summary_sent !== 1)` post-UPDATE atomico B2 (la protezione dalle riaperture è la
   transizione stessa, commento aggiornato) e la query sopravvissuti inline sostituita con
   `getActiveProfiles(db)` (niente SQL duplicata nello stesso modulo);
3. `src/llm/templates.ts` — nuova costante UNICA `UNSUBSCRIBE_CONFIRM_WORDS`
   (`confermo`/`sì`/`si`/`yes`): il Set del processor, il template
   `platform_unsubscribe_confirm` (interpola le prime due parole) e gli esempi del prompt
   classificatore (interpolati) derivano tutti da qui — niente copie divergenti sulla
   barriera;
4. `src/game/simulation.ts` — `simEmail` non più esportato (usato solo internamente);
5. `src/cli/commands/platform.ts` — rimossa l'opzione morta `--name` di `platform:register`
   (dichiarata ma mai letta dal handler; header aggiornato);
6. `tests/unit/llm/intent-classifier.test.ts` — test "lista vuota" aggiornato al nuovo
   contratto (intento comunque classificato, pick azzerato, UNA chiamata API).

**Protocollo post-review:** `host-spawn npm test` → **419/419 verdi** (39 file; il conteggio
include i test A4/B3 e le modifiche di sessione B3/B4 concorrenti, vedi nota sotto);
`host-spawn npm run typecheck` pulito; `host-spawn npm run lint` pulito.

**NOTA di osservazione (concorrenza sul working tree):** durante questa sessione sono state
osservate modifiche NON appartenenti allo step B2 in `tests/integration/round-flow.test.ts`
(12:58Z), `tests/unit/game/round-notifications.test.ts` (12:55Z, nuovo test A4/B3),
`src/config.ts`, `src/cli/commands/simulate.ts`, `tests/unit/cli/simulate-guard.test.ts`
(13:02-13:03Z, B4) e `isAccountActive` fail-closed in `round-manager.ts` (B3): un'altra
sessione sta lavorando su B3/B4 in parallelo sullo stesso working tree. Nessun intervento di
questa sessione su quei file; i protocolli di questo step sono stati eseguiti con l'albero
che le include (suite verde 419/419). Nessun commit/push.

---

## Step B3 (MEDIUM) — Filtro notifiche fail-closed senza registry (D4, decisione (c))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (terzo step).
- **Test scritto (Fase A):** A4 in `tests/unit/game/round-notifications.test.ts` (nuovo `it`
  "senza registry iniettato → nessuna email dai flussi di round (filtro fail-closed, A4/B3, D4)").

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -- --run tests/unit/game/round-notifications.test.ts -t "senza registry iniettato"`
alle 12:56Z del 2026-08-21:

```
 FAIL  tests/unit/game/round-notifications.test.ts > filtro account active sulle notifiche (RF-P6, ADR-009) > senza registry iniettato → nessuna email dai flussi di round (filtro fail-closed, A4/B3, D4)
AssertionError: expected [ { to: 'a@test.it', …(2) } ] to have a length of +0 but got 1
 ❯ tests/unit/game/round-notifications.test.ts:390:26
```

→ finding D4 confermato: senza registry `isAccountActive` ritorna `true` e `pick_instructions`
parte NON filtrata (`channel.sent` = 1). `startTournament` senza registry resta invece un no-op
(`start.notified = 0`), come già esplicito nel codice.

### Modifica applicata

1. **`src/game/round-manager.ts`** — `isAccountActive` (~righe 80-84): prima riga
   `if (ctx.platform === undefined) return false;` (era `return true`). Doc comment aggiornato:
   senza registry iniettato il filtro FALLISCE CHIUSO (nessuna email, nessun bypass silenzioso,
   simmetria con `checkEligibility` → `platform_unavailable`); le CLI reali che inviano email
   iniettano già il registry, quindi il comportamento di produzione non cambia.

   DEVIAZIONE MOTIVATA (regressione da protocollo, §1.2.6 del piano): con il filtro fail-closed,
   3 test pre-ADR-009 di `tests/integration/round-flow.test.ts` (Task 3.5, harness SENZA registry
   ma con asserzioni sul contratto di notifica: `notified: 2`, `round_result_wrong`,
   `pick_postponed`) sono diventati rossi. Risoluzione coerente con la decisione (c) e con la
   produzione (le CLI iniettano sempre il registry): il harness del file inietta ora un
   PlatformRegistry su DB piattaforma in-memory e i 3 test registrano gli account `active` dei
   profili coinvolti. NESSUNA asserzione attenuata o rimossa: i test verificano lo stesso
   contratto di notifica, solo con la precondizione ADR-009 esplicitata. Header del file
   aggiornato (commento §5).

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` usato solo con
`find` (lettura) in `isAccountActive`.

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **418/418 verdi** (39 file) = 417 (baseline + A1/A2/A3)
  + A4. Nessun rosso residuo.
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (matrice notifiche):**
  - A4 verde: senza registry nessuna email da `openRound` (`channel.sent` vuoto); broadcast
    `tournament:start` senza registry no-op (`notified = 0`, invariato e testato nello stesso it) ✓
  - con registry iniettato l'intera matrice esistente di `round-notifications.test.ts` resta
    verde: 7/7 (open/close/score/broadcast filtrati su `active`, riepilogo A3 best-effort) ✓
  - `tests/integration/round-flow.test.ts` adattato: 15/15 verdi (notifiche del flusso round
    verificate con account `active`, asserzioni invariate) ✓
- **Punti NON di questo step:** nessuno smoke (nessun `simulate:*` toccato). Nessun commit/push.
  Test rossi attesi di step successivi (A5–A8) non ancora scritti.

---

## Step B4 (MEDIUM) — Guardia `simulate:*` ancorata al default reale di produzione (D8, decisione (d))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (quarto step).
- **Test scritto (Fase A):** A5 in `tests/unit/cli/simulate-guard.test.ts` (nuovo `it`; i 2 test
  esistenti adeguati all'import di `PLATFORM_DB_PATH_DEFAULT` da `src/config.ts`).

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -- --run tests/unit/cli/simulate-guard.test.ts` alle
13:03 locali del 2026-08-21:

```
× guardia simulate:* su PLATFORM_DB_PATH (ADR-009, piano Task 10) > A5/B4 (D8): la guardia è
  ancorata al default reale esposto da config.ts (fonte unica, nessuna costante locale in simulate.ts)
AssertionError: expected './data/platform.db' to be undefined // Object.is equality
- Expected: undefined
+ Received: "./data/platform.db"
❯ tests/unit/cli/simulate-guard.test.ts:62:37
```

→ rosso documentale del decoupling: `src/config.ts` NON esporta ancora
`PLATFORM_DB_PATH_DEFAULT`, quindi l'import named risolve a `undefined` sotto
vitest/esbuild e l'asserzione `config.PLATFORM_DB_PATH === PLATFORM_DB_PATH_DEFAULT` fallisce
(il default zod esiste ma non è esposto come fonte unica; la guardia confronta con la
costante locale duplicata in `simulate.ts`).

### Modifica applicata

1. **`src/config.ts`** — nuova export `PLATFORM_DB_PATH_DEFAULT = './data/platform.db'` con
   commento §5 (UNICA fonte del valore di produzione di `PLATFORM_DB_PATH`, usata dal default
   zod E dalla guardia di simulazione; MAI duplicarla altrove); lo schema usa
   `PLATFORM_DB_PATH: z.string().min(1).default(PLATFORM_DB_PATH_DEFAULT)`; commento del campo
   aggiornato (default = costante unica).
2. **`src/cli/commands/simulate.ts`** — rimossa la costante locale
   `PRODUCTION_PLATFORM_DB_PATH`; `assertSimPlatformPath` confronta
   `config.PLATFORM_DB_PATH === PLATFORM_DB_PATH_DEFAULT` (import da `config.ts`); commento
   della guardia aggiornato (fonte unica, limite documentato del rischio §8: un
   `PLATFORM_DB_PATH` custom nel `.env` reale non è intercettato — mitigazione = env/DB
   dedicati per simulazione/UAT) e header del file aggiornato (bulle guardia).
3. **`tests/unit/cli/simulate-guard.test.ts`** — i 2 test esistenti importano ora
   `PLATFORM_DB_PATH_DEFAULT` da `config.ts` (non più `PRODUCTION_PLATFORM_DB_PATH` da
   `simulate.ts`); A5 aggiunto: config costruita SENZA `PLATFORM_DB_PATH` (default zod
   applicato) → `config.PLATFORM_DB_PATH === PLATFORM_DB_PATH_DEFAULT` → la guardia rifiuta
   (`/valore di produzione/`); lettura del sorgente di `simulate.ts` che NON deve contenere
   `PRODUCTION_PLATFORM_DB_PATH` (nessuna duplicazione locale del default).

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` invariato.

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **419/419 verdi** (39 file) = 418 (baseline +
  A1–A4) + A5. Nessun rosso residuo.
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata:** `simulate-guard.test.ts` 3/3 verdi (rifiuto sul valore
  di produzione, accettazione di percorsi dedicati, ancoraggio A5 al default di `config.ts`).

### SMOKE OBBLIGATORIO (si tocca `simulate:*`) — DB dedicati, mai `./data`

Ambiente: file env temporanei `/tmp/kilo/env-b4` (copia di `.env` + override
`DB_PATH=/tmp/kilo/sim-guard-b4.db`, `PLATFORM_DB_PATH=/tmp/kilo/sim-platform-b4.db`,
`SCHEDULER_ENABLED=false`) e `/tmp/kilo/env-b4-reject` (stesso file +
`PLATFORM_DB_PATH=./data/platform.db` in coda). DEVIAZIONE AMBIENTALE MOTIVATA: in questo
sandbox Flatpak `/tmp` della sandbox e `/tmp` dell'host (dove esegue `host-spawn`) sono
DIRETTORI DISTINTI: gli env file e i DB dello smoke vivono nel `/tmp/kilo` visibile
all'host (tutti i comandi passano da `host-spawn sh -c 'set -a && . /tmp/kilo/env-b4 &&
set +a && npm run cli -- …'`). Nessun `data:refresh`, nessun `scheduler:tick`. NESSUNA pulizia
automatica: i DB dello smoke restano in `/tmp/kilo` (cleanup solo su comando esplicito).

1. **`data:seed-synthetic`** su `/tmp/kilo/sim-guard-b4.db` → `Seed completato: 8 squadre,
   7 giornate, 28 partite` (WARN test-only atteso: `TEST_MODE=false`; WARN overlap
   `--spacing-min 90 < 425` atteso, non bloccante).
2. **`simulate:full` con `PLATFORM_DB_PATH=./data/platform.db`** → RIFIUTO esplicito, exit
   non-zero:
   ```
   simulate:* rifiutato: PLATFORM_DB_PATH coincide col valore di produzione (./data/platform.db) — usa un DB piattaforma DEDICATO per la simulazione (es. ./data/sim-platform.db)
   EXIT_CODE=1
   ```
   `stat ./data/platform.db` PRIMA/DOPO invariato (mtime 2026-08-20 20:45:40): nessuna
   scrittura sul DB di produzione (la guardia scatta prima di ogni connessione).
3. **`simulate:full` con `PLATFORM_DB_PATH=/tmp/kilo/sim-platform-b4.db`** → esecuzione
   completa, exit 0: `Simulazione completa — seed 42, TT1 = TC 1 (7 TC), profili sim: 10`,
   7 TC `scored`, vincitori caso 2 (`sim-02@survivor.test`, `sim-06@survivor.test`).
4. **Verifiche di contenuto:**
   - `platform:list` → 10 account `active`, `register_id` 1..10 (`sim-01@survivor.test`…
     `sim-10@survivor.test`) ✓
   - `tournament:export --json` → `round_state` 7/7 `status: "scored"` con
     `summary_sent: 1`; `player` 10 righe con `register_id` 1..10; `profile` 10 righe con
     `register_id` 1..10 e `player_id` corrispondente ✓
   - query SQLite di allineamento: `player` {n:10, withReg:10, mn:1, mx:10}, `profile`
     {n:10, withReg:10, mn:1, mx:10}, coppie `player.register_id = profile.register_id` via
     `player_id`: 10/10 ✓
   - `./data/platform.db` e `./data/survivor.db` NON toccati (mtime invariati) ✓

### NOTA di osservazione (concorrenza sul working tree)

Durante questa sessione è stata osservata un'ALTRA sessione (B2, post-review `/review
uncommitted`) attiva in parallelo sullo stesso working tree: modifiche NON appartenenti a B4
in `src/llm/intent-classifier.ts`, `src/llm/parser.ts`, `src/llm/templates.ts`,
`src/channel/email-processor.ts`, `src/game/round-manager.ts`, `src/game/simulation.ts`,
`src/cli/commands/platform.ts`, `tests/unit/llm/intent-classifier.test.ts` (13:02-13:07
locali, documentate dalla stessa sessione B2 nel suo paragrafo "Post-review"). Due prime
esecuzioni della suite intera hanno mostrato 2 rossi transitori in test LLM
(`parser.test.ts`/`intent-classifier.test.ts`, "lista vuota") dovuti agli edit in corso di
quella sessione (short-circuit spostato dal classificatore al parser); ad albero stabilizzato
la suite è tornata interamente verde. Nessun intervento di questa sessione su quei file: i
file di B4 (`config.ts`, `simulate.ts`, `simulate-guard.test.ts`) NON risultano toccati dalla
sessione concorrente. Il protocollo di chiusura di questo step è stato eseguito ad albero
stabile. Nessun commit/push.

- **Punti NON di questo step:** test rossi attesi di step successivi (A6a/A6b, A7, A8, A9)
  non ancora scritti.

---

## Step B5 (MEDIUM) — Chiarimento `other` solo ad account `active` (istanza D3, decisione (e))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (quinto step).
- **Test scritti (Fase A):** A6a e A6b in `tests/integration/email-process.test.ts`
  (due nuovi `it` nel describe "other, unknown, gate round (ADR-009)").

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -- --run tests/integration/email-process.test.ts`
alle 13:18 locali del 2026-08-21 (27 test → 2 failed):

```
 ❯ tests/integration/email-process.test.ts (27 tests | 2 failed) 72ms
   × channel:email:process — other, unknown, gate round (ADR-009) > other da account unsubscribed → NESSUNA risposta, silenzio + seen (A6a/B5, D3, decisione (e)) 5ms
     → expected [ { to: 'a@test.it', …(2) } ] to have a length of +0 but got 1
   × channel:email:process — other, unknown, gate round (ADR-009) > other da account pending_unsubscribe con body NON di conferma → NESSUNA risposta, stato invariato (A6b/B5, D3, decisione (e)) 2ms
     → expected [ { to: 'a@test.it', …(2) } ] to have a length of +0 but got 1
```

→ istanza non dichiarata D3 confermata: il ramo `other` controllava solo `account === null`
e il chiarimento partiva anche verso `unsubscribed`/`pending_unsubscribe` (violazione
decisione 7/ADR-009 "nessuna email a non active"), in entrambi i casi con `channel.sent` = 1
(assertion error a `email-process.test.ts:527` e `:549`).

### Modifica applicata

1. **`src/channel/email-processor.ts`** — ramo `other` (righe 413-431 del codice ATTUALE,
   già modificato dalla review post-B2): dopo il check `account === null` (silenzio per
   sconosciuti, INVARIATO) è stato aggiunto `if (account.status !== 'active')` → log info
   pino IN INGLESE (`'email:process: other from non-active account — internal log, no
   reply (decision 7 / ADR-009)'`, campi strutturati `{ email, intent, accountStatus }`),
   `markSeen`, action `silent_other`; il chiarimento parte SOLO per account `active`.
   Commenti §5 aggiornati: commento del ramo `other` (policy decisione (e)/B5, istanza D3,
   barriera B1 valutata PRIMA e non toccata), bullet `other` nel file header, commenti
   delle action `clarification` e `silent_other` nell'unione `ProcessedAction`.
   La barriera B1 (pending + "confermo" classificato `other` → soft-delete) resta INTATTA:
   è valutata PRIMA dei rami di intento e non è stata modificata.

   DEVIAZIONE MINORE MOTIVATA: il testo del nuovo log pino è in INGLESE mentre l'esempio
   del piano §4 B5 (`'email:process: other da account non active — …'`) era in italiano:
   prevale il vincolo non negoziabile §1.2.3 del piano ("log pino in inglese per ogni
   nuovo messaggio di log"), coerente con i log inglesi introdotti da B1/B2. I log pino
   PREESISTENTI in italiano nel file non sono stati toccati (surgical changes, §3).

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: il ramo aggiunto non usa
`ctx.platform` (solo lettura `account.status` già in memoria); `ctx.platform` nel file
resta usato con soli `find`/`register`/`beginUnsubscribe`/`confirmUnsubscribe`/`reactivate`.

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **421/421 verdi** (39 file) = 419 (baseline +
  A1–A5) + A6a/A6b. Nessun rosso residuo.
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (matrice silenzio anti-spam, filtro `-t other` su
  `email-process.test.ts` → 7 test verdi; filtro `-t confermo` → 2 test verdi):**
  - `active` + other → chiarimento (test esistente "other da mittente noto → chiarimento") ✓
  - `unsubscribed` + other → NESSUNA risposta + seen, action `silent_other` (A6a) ✓
  - `pending_unsubscribe` + other con body NON di conferma → NESSUNA risposta + seen,
    action `silent_other`, stato RESTA `pending_unsubscribe` (A6b) ✓
  - sconosciuto + other → silenzio + seen (test esistente) ✓
  - pending + "confermo" classificato `other` → soft-delete + `platform_unsubscribed` +
    action `unsubscribe_confirmed` (A1 + variante `confermo` dell'`it.each`, ancora verdi:
    NESSUNA regressione B1) ✓
- **Punti NON di questo step:** nessuno smoke (nessun `simulate:*` toccato). Nessun
  commit/push. Test rossi attesi di step successivi (A7, A8, A9) non ancora scritti.

---

## Step B6 (LOW/MED) — Tipo email dedicato "già iscritto" (decisione (f))

- **Sessione:** 2026-08-21, modalità local, stesso working tree (sesto step).
- **Test scritto (Fase A):** A7 in `tests/integration/email-process.test.ts` — aggiornato
  il test esistente "mittente già active → 'già iscritto', nessun duplicato" (ora attende
  `type: 'platform_already_registered'`) + nuovo `it` dedicato al soggetto
  ("mittente già active → soggetto 'Survivor League — Già iscritto alla piattaforma' e
  action already_subscribed (A7/B6)").

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -- --run tests/integration/email-process.test.ts
-t "già active"` alle 13:23 locali del 2026-08-21 (28 test → 2 failed):

```
 ❯ tests/integration/email-process.test.ts (28 tests | 2 failed | 26 skipped) 23ms
   × … > mittente già active → "già iscritto" con tipo email dedicato, nessun duplicato
     → expected { type: 'pick_rejected', …(1) } to match object { …(2) }
   × … > mittente già active → soggetto "Survivor League — Già iscritto alla piattaforma" …
     → expected { type: 'pick_rejected', …(1) } to match object { type: 'platform_already_registered' }
```

→ finding §3 confermato: la reply "già iscritto" usa `pick_rejected` (soggetto
"Pick non registrato", UX fuorviante), come da report riga 42.

NOTA sul typecheck: il piano prevedeva un possibile rosso di compilazione finché il nuovo
`EmailType` non esisteva; NON si è materializzato perché l'argomento di `toMatchObject`
non è tipizzato come `EmailContext`. Il rosso rilevante è quello RUNTIME fotografato sopra.

### Modifica applicata

1. **`src/llm/generator.ts`** — `EMAIL_TYPES`: nuovo `'platform_already_registered'`
   (posizionato dopo `platform_unsubscribed`, commento "re-iscrizione da account già
   active (ADR-009, decisione (f)/B6)"); `SUBJECT_LABELS`: nuova etichetta
   `'Già iscritto alla piattaforma'` → soggetto finale deterministico
   `"Survivor League — Già iscritto alla piattaforma"` (determinismo D1 invariato:
   `subjectFor` non toccato). Commenti §5 aggiornati (riga del tipo).
2. **`src/llm/templates.ts`** — nuova voce `EMAIL_TEMPLATES.platform_already_registered`:
   spiega che l'account è già attivo, che la re-iscrizione non serve e che per
   partecipare basta inviare la prima scelta (squadra + esito) entro la scadenza del
   primo turno; header del file aggiornato (14 → 15 tipi, nuovo tipo nell'elenco
   ADR-009). La copertura resta garantita a compile-time da `Record<EmailType, string>`.
3. **`src/channel/email-processor.ts`** — ramo `subscribe` su account già `active`: la
   risposta diventa `{ type: 'platform_already_registered', reason: 'sei già iscritto
   alla piattaforma (email_already_registered)' }`; action `already_subscribed`
   INVARIATA; commento §5 aggiunto sul ramo (niente riuso improprio di
   `pick_rejected`) e bullet `subscribe` del file header aggiornato.

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` invariato.
`src/cli/commands/llm.ts` usa `EMAIL_TYPES` come choices della CLI: il nuovo tipo entra
automaticamente (nessuna modifica necessaria).

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **423/423 verdi** (39 file) = 421 (baseline +
  A1–A6b) + A7 + 1 test del loop contract in `generator.test.ts` (il `for (const type of
  EMAIL_TYPES)` genera automaticamente un test per il NUOVO tipo: soggetto/body/template).
  Il piano prevedeva 421 + 1 = 422: il +1 aggiuntivo è il contract test automatico del
  nuovo tipo (copertura extra, nessuna deviazione).
- **`host-spawn npm run typecheck`**: pulito (la copertura `Record<EmailType, string>` è
  verificata qui).
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (filtro `-t subscribe` su `email-process.test.ts` →
  19/19 verdi; filtro `-t platform_already_registered` su `generator.test.ts` → 1/1 verde):**
  - A7 verde: tipo `platform_already_registered` + soggetto
    `"Survivor League — Già iscritto alla piattaforma"` + action `already_subscribed` +
    nessun duplicato ✓
  - subscribe nuovo → `platform_registered` (invariato, test esistenti) ✓
  - riattivazioni da `unsubscribed`/`pending_unsubscribe` → `platform_registered`
    (invariato, test esistenti) ✓
  - contract test del nuovo tipo: soggetto con forma compatta, template senza numeri
    letterali, dati serializzati (automatico dal loop su `EMAIL_TYPES`) ✓
- **Punti NON di questo step:** nessuno smoke (nessun `simulate:*` toccato). Nessun
  commit/push. Test rossi attesi di step successivi (A8, A9) non ancora scritti.

**OSSERVAZIONE per B8 (fuori scope di B6, non toccato):** l'header di
`tests/unit/llm/generator.test.ts` cita ancora "14" tipi ("un contract test per OGNI
tipo di email (14, …)") e ora è 15: correzione documentale da valutare in B8b (commenti
stale), insieme all'aggiornamento dei documenti `POC_PRD.md`/`POC_LLD.md` che enumerano
gli `EmailType` (già pianificato in B8d).

---

## Step B7 (LOW) — Auto-join con `player` legacy senza `profile` (decisione (g), report §3)

- **Sessione:** 2026-08-21, modalità local, stesso working tree (settimo step).
- **Test scritto (Fase A):** A8 in `tests/unit/game/registration.test.ts` (nuovo `it`
  "player legacy senza profile (register_id NULL) + pick valido nel TT1 → profilo sul
  player ESISTENTE con backfill register_id (A8/B7, decisione (g))").

### Rosso fotografato (prima della modifica)

Esecuzione mirata `host-spawn npm test -- --run tests/unit/game/registration.test.ts
-t "player legacy"` alle 13:28 locali del 2026-08-21 (9 test → 1 failed):

```
  ❯ tests/unit/game/registration.test.ts (9 tests | 1 failed | 8 skipped) 19ms
    × auto-join RF-P5 (ADR-009) — eligibilità piattaforma + profilo+pick atomici >
      player legacy senza profile (register_id NULL) + pick valido nel TT1 →
      profilo sul player ESISTENTE con backfill register_id (A8/B7, decisione (g)) 18ms
      → expected false to be true // Object.is equality
  AssertionError: expected false to be true // Object.is equality
   ❯ tests/unit/game/registration.test.ts:161:20
       expect(res.ok).toBe(true);
```

→ finding §3 confermato: con una riga `player` preesistente SENZA `profile` il check
anticipato `playerExists` (`registration.ts:100-102`) ritorna
`{ ok: false, reason: 'already_registered' }`: il dato legacy blocca l'auto-join per
sempre (`res.ok === false`).

### Modifica applicata

1. **`src/game/registration.ts`** — `autoJoinFromPick`:
   - RIMOSSO il check anticipato `playerExists(...)` che produceva
     `already_registered`, insieme alla funzione `playerExists` (rimasta inutilizzata,
     AGENTS.MD §3) e all'import `Database` di `better-sqlite3` (solo tipo, ormai
     inutilizzato);
   - nella transazione (dopo BEGIN): `SELECT id, register_id FROM player WHERE
     email = ?` — se la riga esiste, si RIUSA il `player_id` (nessun INSERT su
     `player`: UNIQUE email mai violato) con BACKFILL `UPDATE player SET register_id`
     se NULL (dato legacy, decisione 2 "nessuna migrazione") e si inserisce SOLO il
     `profile`; se non esiste, comportamento storico INVARIATO (INSERT player +
     profile);
   - caso difensivo: `SELECT 1 FROM profile WHERE player_id = ?` — profilo GIÀ
     esistente (raggiungibile solo in corsa concorrente: il wiring instrada il
     profilo esistente altrove) → ROLLBACK + `already_registered` (il motivo RESTA
     nell'unione `AutoJoinResult`, commento aggiornato);
   - commenti §5 aggiornati: header del file (bullet dati legacy/decisione (g)/B7),
     doc comment di `autoJoinFromPick` (riuso player_id, backfill register_id,
     `already_registered` solo difensivo), commento del blocco transazionale.

Nessuna altra modifica (surgical). Nessuna scrittura cross-DB: `ctx.platform` usato
solo con `find` (lettura) in `checkEligibility`/gate account, come prima.

### Protocollo di chiusura

- **`host-spawn npm test`** (intera suite): **424/424 verdi** (39 file) = 423 (baseline
  + A1–A7) + A8. Nessun rosso residuo.
- **`host-spawn npm run typecheck`**: pulito (prima esecuzione: 2 errori TS2532
  "Object is possibly 'undefined'" su `players[0]` nel nuovo test → corretti con
  `player = players[0]` + `toBeDefined()` + optional chaining; nessuna asserzione
  attenuata, si asserisce comunque `toHaveLength(1)`).
- **`host-spawn npm run lint`**: pulito.
- **Verifica comportamentale mirata (auto-join TT1 atomico):**
  - A8 verde: `ok: true`; NESSUNA nuova riga `player` (UNIQUE email rispettato,
    `toHaveLength(1)` + id = player legacy); backfill `player.register_id` NULL →
    `account.registerId`; `profile.player_id` = player legacy e
    `profile.register_id` = `account.registerId` (RF-P7); pick inserito (round 1,
    team/esito/status corretto) ✓
  - test esistenti di atomicità ancora verdi: `registration.test.ts` 9/9 (rollback su
    pick invalido, nessun profilo orfano; not_tt1; round_not_open; not_eligible;
    re-iscrizione stesso registerID) ✓
  - risposta `pick_confirmed` nel wiring: filtro `-t auto` su
    `email-process.test.ts` → 8/8 verdi (auto-join dal flusso reale) ✓
- **Punti NON di questo step:** nessuno smoke (nessun `simulate:*` toccato). Nessun
  commit/push. Test di step successivi (A9) non ancora scritto.

---

## Step B8 (LOW + documentale, ULTIMO) — Dead-write, commenti stale, contract test, allineamento documenti

- **Sessione:** 2026-08-21, modalità local, stesso working tree (ottavo e ULTIMO step).
- **Test scritto (Fase A):** A9 — NUOVO file `tests/unit/cli/llm-classify.test.ts`
  (7 test; prima di questo file 0 occorrenze di `classifyInputBody`/`llm:classify` nei
  test, verificato con grep: gap D7 confermato).

### B8c — Contract test `llm:classify` (D7, A9)

Test scritto PRIMA (TDD) ed eseguito in isolato alle 13:37 locali:
`host-spawn npm test -- --run tests/unit/cli/llm-classify.test.ts` → **7/7 VERDI DA
SUBITO**, come previsto dal piano (gap di copertura, NON un bug: il comportamento era
già implementato). **NESSUNA modifica a `src/cli/commands/llm.ts`** (nessun rosso
inatteso emerso). Copertura: `classifyInputBody` (funzione esportata del comando —
input JSON con campo `body` → body estratto; testo libero → passthrough; JSON senza
`body` → trattato come testo libero) + wiring `classifyInputBody(input)` →
`OpenAIIntentClassifier.classify(body, {teams, aliases})` con fetch/`OpenAIClient`
MOCKATI (stesso pattern di `intent-classifier.test.ts`, LLD §8 — si invoca il wiring
del comando, non il binario). Asserzioni del piano: output `{intent, pick}` coerente
con l'input (subscribe e pick); contenuto ambiguo (output LLM non interpretabile) →
`{intent:'other', pick:null}` senza crash (CS7); errore di trasporto (401) →
`LLMError` (D3, `toBeInstanceOf` + `toMatchObject {name, status}`).

### B8a — Dead-write `registration_open` (D5)

`src/game/tournament.ts` — `startTournament`: l'INSERT/UPDATE su `tournament_state`
non scrive più `registration_open`:
`INSERT INTO tournament_state (id, season_started, start_round) VALUES (1, 1, ?)
ON CONFLICT(id) DO UPDATE SET season_started = 1, start_round = excluded.start_round`.
La colonna resta DEPRECATA in `src/db/schema.ts` (compatibilità, default 0, non più
scritta); commenti §5 aggiornati (header del file, bullet `tournament:status`, blocco
"Scritture atomiche"). ADEGUAMENTO TEST NECESSARIO (documentato): l'asserzione
esistente di `tests/unit/game/tournament.test.ts:84-85` codificava il vecchio
comportamento (`registration_open: 1`) → aggiornata a `registration_open: 0` con
commento (colonna DEPRECATA mai scritta); header del file test aggiornato. Verifica:
grep `registration_open = 1` in `src/` → **0 occorrenze**; `tournament:export`
coerente (test esistenti verdi).

### B8b — Commenti stale (AGENTS.MD §5)

- `src/game/tournament.ts` header (righe 16-18 e 23): rimosso "RF-22 / finestra di
  iscrizione"; documentato che `registration_open` è DEPRECATA e non viene scritta;
- `src/game/pick-processor.ts:6` "auto-iscrizione (Task 4.2)" → "auto-join (RF-P5,
  ADR-009)"; `:168` "auto-iscrizione RF-27 (…, Task 4.2)" → "auto-join RF-P5 (…,
  ADR-009)" (RF-27 deprecata);
- `src/cli/commands/scheduler.ts` header (riga 6) e `describe` di `scheduler:tick`
  (riga 142): rimosse le occorrenze "finestra di iscrizione"/"finestra iscrizione"
  dalle azioni del tick;
- `src/cli/commands/pick.ts:17`: "`now = new Date()`" → "`now = makeNow(config)`";
- `tests/unit/llm/generator.test.ts` header: "14" tipi → "15" (osservazione lasciata
  da B6).
- DEVIAZIONE MINORE MOTIVATA (stessa classe di finding, comment-only, zero impatto
  comportamentale): corretto anche il commento stale omologo in
  `src/cli/commands/tournament.ts` (header riga 8 e `describe` di `tournament:status`
  riga 113 citavano ancora "finestra di iscrizione", che l'output non espone più).
  Le occorrenze residue di "finestra di iscrizione" in `src/` (game/scheduler.ts,
  db/schema.ts, game/tournament.ts) sono affermazioni CORRETTE di deprecazione
  ("non esiste più"), non commenti stale: lasciate invariate.
- Verifica: grep `finestra di iscrizione`/`finestra iscrizione` in
  `src/cli/commands/scheduler.ts` → **0**; grep `RF-27` in
  `src/game/pick-processor.ts` → **0**.

### B8d — Documenti

1. `docs/decisions/architecture-decisions.md` (append-only): registrata **ADR-010
   "Chiarimenti ADR-009 post-revisione 2026-08-21"** (indice + sezione). Formalizza:
   (i) carve-out esplicito al filtro `active` di RF-P6/decisione 7 — le conferme
   RF-P1/P2 (`platform_unsubscribe_confirm` verso `pending_unsubscribe`,
   `platform_unsubscribed` verso `unsubscribed`, risposte subscribe/
   `platform_already_registered`) partono SEMPRE, anche verso account non `active`,
   perché sono il flusso di conferma stesso; (ii) semantica esatta della barriera
   (decisione 3 allineata): completamento = account `pending_unsubscribe` + body
   nella lista di conferma, INDIPENDENTE dall'intento classificato; (iii) le decisioni
   (a)–(g) del piano come decisioni registrate. ADR-009 NON toccata (append-only).
2. `docs/POC/POC_PRD.md` → **v0.6.1**: versione header aggiornata; RF-P1 con il nuovo
   tipo email `platform_already_registered` (regola §4.1, testo §4.1, bullet RF-P1);
   RF-P6 con carve-out esplicito per le conferme RF-P1/P2 (bullet RF-P6 + regola §4.1
   riga 166 + §4.5 riga 284); changelog §14 con nuova riga 0.6.1.
3. `docs/POC/POC_LLD.md`: §6.3 enumera gli `EmailType` → aggiunto
   `"platform_already_registered"` (posizione e commento coerenti con
   `src/llm/generator.ts`, ADR-010). Nessuna riscrittura (verifica puntuale).

### B8e — Conteggio test in `agent-context/current-status.md`

- Corretto "429 test verdi" → **431 test verdi** (conteggio REALE dalla suite
  eseguita); voce della fase aggiornata al consuntivo finale (ADR-001…010,
  PRD v0.6.1, piano B1–B8 eseguito); `Last updated` → 2026-08-21T11:45:00Z;
  aggiunta voce changelog ISO-8601 (AGENTS.MD §0) che riepiloga le correzioni B1–B8
  e i test aggiunti (414 baseline → 431).

### Protocollo di chiusura B8 (e dell'intero piano)

- **`host-spawn npm test`** (intera suite): **431/431 verdi (40 file)** = 424
  (baseline B1–B7) + 7 (A9). Nessun rosso.
- **`host-spawn npm run typecheck`**: pulito.
- **`host-spawn npm run lint`**: pulito.
- **Grep finali di conformità (§6 del piano):**
  - nessuna scrittura via `ctx.platform` fuori dal registry: nei flussi di torneo
    (`src/game/*`) solo `find`/`list`/`activeEmails` (letture) e check `=== undefined`;
    le scritture `register`/`beginUnsubscribe`/`confirmUnsubscribe`/`reactivate`/
    `unregister` avvengono solo nel wiring del comando piattaforma
    (`src/channel/email-processor.ts`) e nel seed della simulazione su DB dedicato
    (`src/game/simulation.ts`, pre-esistente e verificato dallo smoke B4) ✓
  - grep `registration_open = 1` in `src/` → 0 ✓
  - grep `finestra di iscrizione`/`finestra iscrizione` in
    `src/cli/commands/scheduler.ts` → 0 ✓
  - grep `RF-27` in `src/game/pick-processor.ts` → 0 ✓
  - log pino nuovi in inglese: B8 NON introduce log nuovi (modifiche
    documentali/commenti + test); i log introdotti da B1–B5 sono in inglese
    (verificati nei rispettivi step) ✓
- **Smoke:** nessuno richiesto per B8 (nessun `simulate:*`/provider toccato; lo
  smoke obbligatorio di B4 resta valido e non è stato invalidato da questo step).
- **Git:** nessun commit, nessun push (working tree `feat/iscrizione-piattaforma`
  non committato, come da strategia §5 del piano).

### Checklist di chiusura complessiva (§6 del piano) — consuntivo

- [x] Fase A completa: A1–A9 scritti e fotografati (ROSSI A1–A8 come da piano,
      A9 GREEN da subito = gap di copertura D7); ESISTENTI/ESCLUSI dichiarati nel §3
      del piano.
- [x] Fase B completa nell'ordine B1→B8; ogni step chiuso con suite intera verde +
      typecheck + lint + verifica comportamentale mirata (vedi sezioni sopra).
- [x] **Test totali a consuntivo: 431** (414 baseline + 17: A1, A2, A3, A4, A5, A6a,
      A6b, A7, +1 contract automatico del nuovo `EmailType`, A8, A9×7) — riportato
      in `agent-context/current-status.md`.
- [x] Smoke richiesti: smoke guardia in B4 eseguito e superato (DB `/tmp/kilo`:
      rifiuto con `PLATFORM_DB_PATH=./data/platform.db` + run completo con DB
      dedicato, seed sintetico, `summary_sent=1`, `platform:list`, `register_id`
      replicati); nessun altro smoke richiesto (nessun provider SMTP/IMAP/LLM
      reale toccato).
- [x] Documenti riallineati: `architecture-decisions.md` (ADR-010),
      `POC_PRD.md` (RF-P6 carve-out, `platform_already_registered`, changelog,
      v0.6.1), `POC_LLD.md` (§6.3), `agent-context/current-status.md`
      (414→431, changelog), commenti sorgente (B8a/B8b).
- [x] Grep finali di conformità: tutti verdi (vedi sopra).
- [x] Nessun commit/push effettuato in tutto il piano.

### Rischi residui (dal §8 del piano) — stato finale

1. Guardia `simulate:*` ancorata al DEFAULT: un `PLATFORM_DB_PATH` custom nel
   `.env` reale non è intercettato (mitigazione: env/DB dedicati per sim/UAT) —
   invariato e documentato nel commento della guardia.
2. Invio best-effort del riepilogo senza retry: accettato (trade-off POC, loggato
   warn) — invariato.
3. Barriera unsubscribe ancorata al body deterministico, prompt come contesto —
   invariato (robusto per costruzione).
4. Backfill `register_id` su player legacy usa l'account piattaforma; email senza
   account resta ineleggibile (decisione 2) — invariato.
5. Doppio processing concorrente del cron (risposte duplicate): resta aperto fino
   al piano `tasks/llm/plan-failover-llm-multimodello.md` (fuori scope, dipendenza
   UAT nota) — invariato.

**IL PIANO È CONCLUSO: B1–B8 completati, suite 431/431 verde, typecheck/lint
puliti, nessun commit/push. Non esistono step successivi.**


