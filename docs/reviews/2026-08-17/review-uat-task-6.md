# Review tecnica (sola lettura) — UAT Task 6: guida operativa del Test Mode

- **Data:** 2026-08-17
- **Oggetto:** `docs/uat/guida-test-mode.md` (851 righe) — Task 6 del piano `tasks/plan-uat-calendario-sintetico.md`
- **Tipo:** verifica con evidenza (read-only) + esecuzione delle liste di comandi su DB di scarto (`data/guide-review.db`) in modalità commissioner con chiusure forzate e **0 giocatori**; **nessun file di codice o della guida modificato** (unico file scritto: questo report)
- **Verdetto:** **FAIL** — 1 difetto di coerenza col comportamento reale (§5.3), tutto il resto conforme (vedi §7)

## Allineamento al piano (riassunto dell'intendimento)

Il Task 6 consegna il "libretto di istruzioni" del TEST MODE per amministratori,
PO e operatori **non sviluppatori**: cosa è il test mode e cosa cambia per ogni
componente, i parametri test-only con scopo+motivazione, le due modalità
(commissioner/cron), il seed spiegato in linguaggio semplice (guardie
`--force`/`--clear`, calendario misto, WARN fuori test mode), lo scope
dimostrabile/non-dimostrabile con la nota RF-31 (`after_kickoff` solo
commissioner/CL17), il replay 2025 (`.env.uat-replay`), il cleanup della casella
Gmail condivisa e un glossario. Ogni esempio di timeline (2h, ~4h30, ~6h30) deve
riportare la lista comandi CLI copiabile passo-passo con i valori già compilati,
e ogni nome citato (comando/opzione/parametro/messaggio) deve esistere davvero
con quel nome.

Questa verifica accerta i 10 acceptance criterion del Task 6 con evidenza
concreta (grep su `src/cli/commands/*` e `src/config.ts`, confronto con
`.env.uat.example`, esecuzione reale dei comandi), mai a fiducia. **Eseguito su
DB di scarto** `data/guide-review.db` (override inline `DB_PATH`,
`SCHEDULER_ENABLED=false`, `ENV_FILE=.env.uat`): 0 profili attivi → `round:open`
notifica 0 e non tocca SMTP, `round:close --force` elimina 0 senza notifiche.
**Non eseguiti** (vincolo forte): `channel:email:*` (richiede la casella Gmail
reale), `scheduler:tick` (cron), invii email reali. `scheduler:status` (sola
lettura) eseguito.

## 1. Acceptance criteria — evidenza

| # | Criterion (Task 6) | Esito | Evidenza |
|---|---|---|---|
| 1 | Guida coerente con l'implementazione (stessi nomi) | **FAIL parziale** | Tutti i nomi di comandi/opzioni/parametri/messaggi verificati esatti (§2–§4); **un** dato di comportamento errato in §5.3 (confine di girone, §7.1) |
| 2 | Comprensibile da non-developer (glossario, niente TS, esempi pronti) | PASS | §9 glossario; nessun codice TS (solo comandi `npm run cli`); log/banner citati in inglese testuali; italiano semplice |
| 3 | Ogni esempio (2h/~4h30/~6h30) con lista comandi CLI copiabile | PASS | §5.1 (righe 504-556), §5.2 (572-604), §5.3 (632-664): setup/iscrizioni/avvio/per-round/verifica finale |
| 4 | Sezione "Scope del test mode" + nota RF-31 | PASS | §6.1 dimostrabile, §6.2 non dimostrabile, §6.3 nota `after_kickoff` (commissioner/CL17, non cron) — corretta (§5) |
| 5 | Assunzione giocatori di TEST all'inizio e nei singoli esempi | PASS | §0 righe 30-47 + §5 righe 485-488 (ripetuta per tutti gli esempi) |
| 6 | Manuale operativo completo ("libretto di istruzioni") | PASS | §2: attivazione (2.1), uso (2.2), disattivazione (2.3), fare/non-fare (2.4), procedure standard con comandi di verifica (2.5) |
| 7 | Sezione introduttiva "Cos'è il test mode" (differenze vs produzione, parametri e perché) | PASS | §1: 1.1 parole semplici + implicazioni, 1.2 tabella componenti che cambiano (loader/email/CLI/log/parser/clock/receivedAt/scheduler), 1.3 parametri test-only con motivazione |
| 8 | Entrambe le modalità (commissioner + cron) | PASS | §3.1 commissioner, §3.2 cron con esempio crontab e vincolo refresh |
| 9 | Sezione seed (`--force`, `--clear`, WARN, calendario misto, guardia stato di gioco) | PASS | §4 con opzioni reali e le tre guardie (righe 430-459) |
| 10 | Procedura cleanup casella Gmail condivisa con riconoscimento banner | PASS | §8 (riconoscimento `[TEST MODE]`, procedura 4 passi, vincolo "no delete automatico") |
| — | (Verifica) Guida collegata nella mappa documenti | PASS | AGENTS.md §1.6 include `docs/uat/guida-test-mode.md` |
| — | (Verifica) Revisionata da lettore non-developer | Non verificabile qui | Questa review è la verifica tecnica; la revisione non-developer/commissioner resta da fare (Checkpoint D del piano) |

## 2. Coerenza dei nomi — comandi (grep `src/cli/commands/*`)

Tutti i 21 comandi citati nella guida esistono come `command: '…'` registrati in
`src/cli/index.ts`:

| Comando (guida) | File | Verifica |
|---|---|---|
| `db:migrate` | `commands/db.ts:26` | ok |
| `data:seed-synthetic` | `commands/data.ts:365` | ok |
| `data:calendar` / `data:calendar --json` | `commands/data.ts:467` | ok |
| `data:results --round <N>` | `commands/data.ts:489` (`round` demandOption) | ok |
| `tournament:register:open [--contacts]` | `commands/tournament.ts:260` | ok |
| `tournament:register:close [--reason]` | `commands/tournament.ts:294` | ok |
| `tournament:register --email [--name] --reason` | `commands/tournament.ts:327` | ok |
| `tournament:start` | `commands/tournament.ts:70` | ok |
| `tournament:status` / `:leaderboard` / `:history --email` / `:export` | `commands/tournament.ts:108/190/151/222` | ok |
| `round:open --round` / `round:close --round [--force --reason]` | `commands/round.ts:86/108` | ok |
| `round:score` / `round:status` / `round:deadline` (tutti `--round`) | `commands/round.ts:143/166/191` | ok |
| `channel:email:fetch` / `channel:email:process` | `commands/channel.ts:38/105` | ok (solo verifica nome: NON eseguiti, casella reale) |
| `scheduler:tick` / `scheduler:status` | `commands/scheduler.ts:132/186` | ok (`tick` non eseguito) |

## 3. Coerenza dei nomi — opzioni del seed e parametri (confronto `src/config.ts` + `.env.uat.example`)

- **Opzioni `data:seed-synthetic`** (`commands/data.ts:370-409`): `--teams`
  (default 8), `--rounds` (default 7), `--spacing-min` (default 90),
  `--first-kickoff-offset-min` (default 120), `--seed` (default 42), `--force`
  (false), `--clear` (false), `--json` (false). **Identiche** alla tabella §4
  della guida (righe 419-428).
- **Parametri config** presenti in `src/config.ts`: `ENV_FILE` (loader, `:232-247`),
  `TEST_MODE` (`:163`), `TEST_OFFSET_DAYS` (`:168`), `TEST_REFRESH_ALLOWED`
  (`:173`), `DEADLINE_ADVANCE_MIN` (default 30), `MATCH_DURATION_MIN` (default
  125), `TC_CLOSE_SKEW_MIN` (default 300), `SCHEDULER_ENABLED` (default false),
  `SCHEDULER_AUTO_SCORE` (default true). I default della guida §1.3 (tabella
  "cadenza compressa" righe 142-147) coincidono: `MATCH_DURATION_MIN` 125→5,
  `TC_CLOSE_SKEW_MIN` 300→10, `DEADLINE_ADVANCE_MIN` 30→30, `SCHEDULER_ENABLED`
  false→true(cron)/false(commissioner). Valori UAT coincidenti con
  `.env.uat.example` (`:15,18,22,89`).
- **Messaggi citati testuali in inglese** — verificati esatti nel sorgente:
  - banner email `[TEST MODE] This email was sent by a test instance of Survivor League.` → `src/channel/email-adapter/index.ts:59` ✓
  - banner CLI `TEST MODE` / campo JSON `testMode` → `src/cli/output.ts:19,38-44` ✓
  - skip refresh `import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled` → `src/cli/commands/data.ts:76` ✓ (guida §3.2 riga 383)
  - WARN seed fuori test mode `data:seed-synthetic is a test-only command: seeding with TEST_MODE=false may pollute a production database with synthetic data` → `data.ts:182` ✓ (guida §4 riga 458)
  - WARN `--force` senza `--clear` (`--force without --clear on a non-empty match table: … Use --force --clear to wipe the match table first`) → `data.ts:189` ✓ (guida §4 riga 438)
  - rifiuto `--clear` stato di gioco `Rifiuto --clear: stato di gioco presente (season_started=1 oppure righe in pick/round_state). La tabella match non può essere svuotata a torneo in corso` → `data.ts:296` ✓ (guida §4 riga 448)
  - log errore sovrapposizione D8 `Synthetic seed: spacing between rounds (--spacing-min = N min) is less than MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN (…)` → `data.ts:323` ✓ (guida §4 riga 467)
  - messaggio scheduler disabilitato `Scheduler disabilitato (SCHEDULER_ENABLED=false): nessuna azione eseguita — usa i comandi manuali (LLD §7.12)` → `commands/scheduler.ts:144` ✓ (guida §3.1 riga 313)
  - messaggio fetch `Nessuna email non letta in casella` → `commands/channel.ts:56` ✓ (guida §8 riga 823)
- **Rosa Serie B + alias** (guida §1.2 righe 103-113): coincidenti esattamente con
  `src/data/synthetic-season.ts:51-60` (`SYNTHETIC_TEAMS`) e
  `src/llm/team-aliases-synthetic.md:24-44`.

## 4. Timeline — valori e wrap (esecuzione reale su DB di scarto)

Valori dei seed compilati nelle liste della guida, **esatti** rispetto ai
prescritti (4/2/45/60, 8/6/45/60, 8/8/45/60):

| Esempio | Comando seed (guida) | Valori | Esito |
|---|---|---|---|
| §5.1 | `--teams 4 --rounds 2 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42` | 4/2/45/60 | ok |
| §5.2 | `--teams 8 --rounds 6 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42` | 8/6/45/60 | ok |
| §5.3 | `--teams 8 --rounds 8 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42` | 8/8/45/60 | ok |

**Wrap 8/8 verificato** (output `data:calendar`, seed 42):
- R1: `Brescia Calcio–UC Sampdoria`, `SSC Bari–Spezia Calcio`, `US Catanzaro–SSC Palermo`, `US Cremonese–Pisa Sporting Club`
- R8: **stesse quattro coppie casa/trasferta di R1**, con punteggi diversi (R1 3-2/0-2/1-2/2-1 → R8 3-0/0-0/1-1/3-1) e `round` diverso.

Conferma la descrizione della guida §5.3 righe 617-626 ("stessi accoppiamenti
della giornata 1 … punteggi diversi"). **Nota:** la guida afferma anche, nello
stesso paragrafo, che il reset del pool "cade dopo il round 7" — **errato**, vedi
§7.1 (l'unico difetto bloccante).

**Esecuzione delle liste** (DB scarto, `SCHEDULER_ENABLED=false`, 0 giocatori,
chiusure forzate `--force --reason`; `channel:email:process` omesso — casella
reale):

| Flusso | Esito |
|---|---|
| §5.1 (4/2): db:migrate → seed → calendar → register:open(0) → register:close → start → 2×[open,close --force,score,status,deadline,results] → status/leaderboard/history/export/scheduler:status | **completa senza errori** (banner `TEST MODE`, `round:open` "profili notificati: 0", `round:close --force` "eliminati: nessuno", `round:score` "→ scored") |
| §5.2 (8/6): idem con loop su 6 giornate | **completa senza errori** (confine girone 4) |
| §5.3 (8/8): idem con loop su 8 giornate | **completa senza errori** (confine girone 5) |

Nota trasparenza: `tournament:status` dopo `register:close`+`start` mostra
`Iscrizioni: aperte`. Non è un errore delle liste della guida (che completano
senza errori) né un'affermazione della guida; comportamento del Game Engine fuori
dallo scope di questa review, segnalato come osservazione (§7.3).

## 5. Nota RF-31 (§6.3) — correttezza

La guida afferma: nel flusso cron standard un pick tardivo riceve `round_not_open`
(la giornata è già chiusa alla deadline, che precede il fischio) e `after_kickoff`
si dimostra solo in **commissioner** (round lasciata aperta oltre il kickoff) o
con **deadline NULL (CL17)**. **Corretta e coerente** con:
- `src/game/pick-processor.ts:143` (`round_not_open` senza round aperto), `:159`
  (`after_kickoff` se `receivedAt > kickoff`), `:161` (`after_acceptance` se
  `receivedAt > deadline`);
- piano §3 (worked example: "RF-31 non morde mai … un pick tardivo riceve
  `round_not_open`, non `after_kickoff`") e §4 (criteri di accettazione UAT).

## 6. Altre verifiche richieste

- **§6 Scope** — dimostrabile (flusso email completo, guard anti-frode su
  timestamp veri, eliminazioni, reset pool, vincitore, banner) e non-dimostrabile
  (freeze, rinvii, deadline NULL tranne CL17, anticipo calendario, chiusura di
  sicurezza, `warn_not_calculable`, refresh reale). Corretto.
- **§9 Glossario** — 13 termini in italiano semplice (round, deadline, kickoff,
  pick, seed, commissioner, cron/scheduler, test mode, banner, TC/TT, pool, UAT,
  env file). Corretto.
- **§0 + §5 assunzione giocatori di TEST** — dichiarata all'inizio e ripetuta nei
  singoli esempi (persone consapevoli, collaborative, casella aperta, pronte a
  rispondere in finestre brevi e a inviare pick in ritardo su richiesta). Corretto.
- **§8 cleanup casella condivisa** — decisione 2026-08-17 (stessa casella
  test/produzione), riconoscimento via banner `[TEST MODE]`, procedura 4 passi,
  vincolo "il sistema non elimina in automatico". Corretto.
- **§7 replay 2025** — file dedicato `.env.uat-replay`, `TEST_OFFSET_DAYS` > 0,
  `DB_PATH` dedicato, vincoli, nota diagnostica fetch (timestamp REALI) vs process
  (timestamp shiftati). Coerente con piano Task 0.3 e `.env.uat-replay.example`.
- **§8 assenza di segreti** — grep su `survivorleague755|@gmail.com|sk-|api_key|token|password|pass=` nella guida: **nessun match** di credenziali reali (unico match: la riga 18 "Niente segreti"). Solo placeholder `alice@example.com` ecc.
- **§7.3 compressione** — la guida è leggibile da non-developer: niente TS, log
  citati in inglese verbatim (vincolo `log_messages_english`), testo in italiano.

## 7. Problemi puntuali

### 7.1 (bloccante) — §5.3 riga 627: confine di girone errato

- **Riga:** `guida-test-mode.md:627` — «il **reset del pool** al confine di
  girone (che con 8 giornate cade **dopo il round 7**)».
- **Cosa è sbagliato:** con 8 giornate il confine di girone NON cade dopo il
  round 7 (cioè al round 8), ma **al round 5**. Il confine è
  `halfBoundary(N) = floor(N/2) + 1` (`src/game/rules.ts:58-59`); con N=8 →
  `floor(8/2)+1 = 5`. Il reset del pool avviene all'inizio del girone di ritorno,
  cioè **dopo il round 4**, non dopo il round 7.
- **Perché è un problema:** la guida confonde due concetti indipendenti — il
  *wrap* del round-robin (round 8 = round 1, perché con 8 squadre il girone
  completo ha 7 accoppiamenti unici) e il *confine di girone* (reset del pool a
  `floor(N/2)+1`). Il wrap NON coincide col reset del pool. Un operatore che
  segua la guida si aspetterebbe di osservare il reset del pool al round 8,
  mentre in realtà avviene al round 5 (evidenza: `tournament:start` su 8 giornate
  stampa `confine girone 5`; su 6 giornate `confine 4`, coerente con
  `floor(6/2)+1`). Errore fattuale sul comportamento osservabile del gioco, in
  contrasto con l'acc-criterion 1 ("coerente con l'implementazione").

### 7.2 (minore) — etichette di durata negli header vs corpo

- **Righe:** header §5.2 `:559` «~4h30» vs corpo `:565` «Durata ≈ 4h45»; header
  §5.3 `:607` «~6h30» vs corpo `:613` «Durata ≈ 6h15».
- **Cosa:** le etichette negli header seguono le diciture del piano ("~4h30",
  "~6h30"), ma la durata calcolata nel corpo (60 + 45×(rounds−1)) dà 4h45 e 6h15.
  Scarto di ±15 min, non bloccante ma potenzialmente confondente per un operatore.

### 7.3 (osservazione, fuori scope) — `tournament:status` mostra "Iscrizioni: aperte" dopo `register:close`+`start`

- Durante l'esecuzione (§4), dopo `tournament:register:close` +
  `tournament:start` con 0 giocatori, `tournament:status` riporta
  `Iscrizioni: aperte`. La guida non fa affermazioni al riguardo e le sue liste
  completano senza errori; è un comportamento del Game Engine, non un difetto
  della guida. Segnalato per trasparenza, da verificare separatamente se rilevante
  per l'UAT.

## 8. Conclusione

La guida è **completa e quasi interamente conforme**: tutti i 21 comandi, le 8
opzioni del seed, i parametri config e ogni messaggio/banner citato esistono con
il nome esatto riportato; le tre timeline riportano i valori prescritti
(4/2/45/60, 8/6/45/60, 8/8/45/60) e le liste completano senza errori su DB di
scarto con chiusure forzate e 0 giocatori; il wrap 8/8 è verificato (round 8 =
stessi accoppiamenti del round 1); la nota RF-31 è corretta; scope, glossario,
assunzione giocatori, cleanup casella e replay `.env.uat-replay` sono presenti e
corretti; nessun segreto rivelato. **Un solo difetto bloccante:** §5.3 riga 627
indica il confine di girone (reset del pool) "dopo il round 7" mentre è al round
5 (`floor(8/2)+1`). Correzione puntuale richiesta prima di considerare la guida
pronta (e prima della revisione non-developer/commissioner del Checkpoint D).
Nessun file di codice o della guida modificato.
