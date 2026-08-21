# Report di revisione tecnica — feature iscrizione piattaforma (ADR-009), branch `feat/iscrizione-piattaforma`

Revisione sola lettura completata. Verifiche di base rieseguite: **`npm test` 414/414 verdi (39 file)**, **`npm run typecheck` pulito**, **`npm run lint` pulito**. Smoke live su DB dedicati `/tmp` (seed sintetico 8×6 → `simulate:full`): auto-join TT1 con `register_id` 1..10 replicato su `player`/`profile`, `summary_sent=1` in `tournament:export`, `platform:list` corretto, guardie `simulate:*` verificate dal vivo (rifiuto su path di produzione e su DB piattaforma sporco). Nessuna modifica a file, nessun commit.

## 1. Discrepanze piano ↔ codice

**D1 — Condizione di soft-delete più restrittiva della spec (NON dichiarata, HIGH).** Decisione 3/ADR-009: soft-delete su "secondo messaggio con intento `unsubscribe` **o** body nella lista di conferma". Il codice richiede **entrambe**: ramo `unsubscribe` raggiunto solo con intento `unsubscribe` e poi `isUnsubscribeConfirmation(routed.body)` con match **esatto** sull'intero body (`src/channel/email-processor.ts:240-260`, `:158-160`). Un secondo "voglio disiscrivermi" (intento ok, body non in lista) non completa mai; "sì, voglio disiscrivermi" non matcha l'esatto.

**D2 — Deadlock della barriera unsubscribe (HIGH, conseguenza di D1).** Il template `platform_unsubscribe_confirm` istruisce a rispondere "confermo" o "sì" (`src/llm/templates.ts:68-71`), ma il prompt del classificatore non cita questi testi tra gli esempi di `unsubscribe` (`src/llm/intent-classifier.ts:80-81`): l'LLM reale classificherà "confermo" quasi certamente come `other`, il ramo unsubscribe non viene raggiunto e il ramo `other` risponde col chiarimento "non ho capito" (`email-processor.ts:397-405`). L'utente non completa **mai** la disiscrizione col flusso documentato. I test usano un classificatore fake che scripta "confermo"→`unsubscribe` (`tests/integration/email-process.test.ts` ~riga 246), quindi il problema reale non è coperto.

**D3 — Deviazione dichiarata 3 (conferme sempre inviate): giustificata, ma la spec va corretta e c'è un'istanza non dichiarata.** La barriera a due passi richiede per costruzione `platform_unsubscribe_confirm` verso `pending_unsubscribe` e `platform_unsubscribed` verso `unsubscribed` (`email-processor.ts:242-258`): funzionalmente necessaria, ma contraddice la lettera di decisione 7/ADR-009 ("nessuna email a `unsubscribed`/`pending_unsubscribe`") e del Task 8 — il piano è internamente incoerente; serve un carve-out documentale in ADR-009/PRD RF-P6. **Non dichiarata**: il ramo `other` risponde il chiarimento anche ad account `unsubscribed`/`pending_unsubscribe` (`email-processor.ts:389` controlla solo `account === null`), violando la stessa decisione 7. Raccomandato: chiarimento solo ad account `active`.

**D4 — Deviazione dichiarata 2 (fail-open senza registry): discutibile.** `isAccountActive` ritorna `true` se `ctx.platform === undefined` (`src/game/round-manager.ts:80-84`). Verificato che tutte le CLI che inviano email iniettano il registry (round/tournament/scheduler/channel), ma è incoerente con `checkEligibility` che invece fallisce chiuso (`platform_unavailable`, `src/game/eligibility.ts:73-75`). Un futuro chiamante che dimentica l'iniezione otterrebbe email non filtrate in silenzio. Raccomandato fail-closed.

**D5 — `registration_open` ancora scritta da `startTournament`** (`src/game/tournament.ts:246-252`) nonostante la deprecazione (decisione 13) e il commento "DEPRECATA" in `src/db/schema.ts:92`. Dead-write innocuo; il commento header di `tournament.ts:17-18` descrive ancora RF-22. LOW.

**D6 — Deviazione dichiarata 1 (`GameContext.classifier`): giustificata** — stesso pattern di `parser`/`channel`, richiesto esplicitamente dal wiring (`email-processor.ts:176-181, 419-428`).

**D7 — Deviazione dichiarata 4 (`llm:classify` testo libero oltre a JSON): giustificata** (superset innocuo), ma il piano Task 6 richiedeva un "contract test dedicato per `llm:classify`": **assente** — nessun test copre `classifyInputBody`/il comando (grep su `tests/`: 0 occorrenze). Gap di copertura.

**D8 — Deviazione dichiarata 5 (guardie simulazione): giustificata e verificata dal vivo.** La guardia "DB piattaforma pulito" è prescritta dal piano (RNF1) e il rifiuto senza auto-cleanup rispetta la convenzione "cleanup solo su comando". Nota: `assertSimPlatformPath` confronta con la costante hardcoded `'./data/platform.db'` (`src/cli/commands/simulate.ts:29-39`), duplicata della default di `src/config.ts:140` — se il valore di produzione viene cambiato in `.env` reale (previsto dal piano), la guardia non scatta e una piattaforma di produzione **vuota** verrebbe inquinata dagli account sim. MEDIUM.

**Conformità vincoli non negoziabili (esito):** due DB con piattaforma sola lettura ✓ (grep: nessuna scrittura via `ctx.platform`, solo `find`/`list`/`activeEmails`); `platform:register` unico comando di creazione account e senza profili ✓; auto-join solo TT1 con `pick_confirmed` e nessun `tournament:register` ✓; riepilogo solo ai sopravvissuti alla transizione `closed→scored` con guardia `summary_sent`, nessun `round_closed_eliminated` ✓; filtro `active` sulle notifiche di torneo ✓ (salvo D4); rivalutazione mittenti per messaggio ✓ con test subscribe+pick stesso batch presente (`tests/integration/email-process.test.ts`, describe "mittenti rivalutati per messaggio"); `llm:classify` presente ma senza contract test dedicato (D7); `PLATFORM_DB_PATH` dedicato nei file reali `.env`/`.env.uat`/`.env.uat-replay` (verificati su disco) e negli esempi ✓.

## 2. Violazioni standard AGENTS.MD

- **§5 "Keep comments up to date"** — commenti obsoleti (LOW): `src/game/tournament.ts:17-18` (header con RF-22/finestra iscrizione); `src/game/pick-processor.ts:6` e `:168` ("auto-iscrizione RF-27, Task 4.2" — RF-27 deprecata); `src/cli/commands/scheduler.ts` `describe` di `scheduler:tick` (menziona ancora "finestra iscrizione"); `src/cli/commands/pick.ts:17` ("`now = new Date()`" — è `makeNow(config)`).
- **§1.3 separazione responsabilità** — rispettata: nessun `getConfig()` nei moduli, nessuna logica di gioco nel wiring, classificatore confinato all'I/O.
- **§6 TDD** — copertura solida sui nuovi comportamenti (registry, classificatore, notifiche, auto-join, batch); gap: contract test `llm:classify` (D7) e caso "confermo → `other`" (D2).
- **Log pino in inglese** — rispettato (`email-processor.ts`); output console CLI in italiano = convenzione preesistente, coerente.
- **§7 git** — nessun commit, come dichiarato ✓.

## 3. Errori logici / bug potenziali

| Gravità | Rilievo | file:line | Sintomo / innesco | Test di riproduzione |
|---|---|---|---|---|
| **HIGH** | Deadlock barriera unsubscribe (D1/D2) | `email-processor.ts:240-260`, `intent-classifier.ts:80-81`, `templates.ts:68-71` | Utente risponde "confermo" → chiarimento, mai disiscritto | `processOne` con classifier che classifica "confermo" come `other`, account `pending_unsubscribe` → azione `clarification`, stato invariato |
| **HIGH** | `summary_sent` perso se l'invio del riepilogo lancia | `round-manager.ts:428-457` | `scored_at` scritto prima del loop; eccezione SMTP/LLM → `summary_sent=0` con status `scored` → riepilogo mai inviato (le riaperture saltano) | generator fake che lancia sul 2° destinatario; `scoreRound` di nuovo → 0 riepiloghi |
| **MEDIUM** | Filtro notifiche fail-open senza registry (D4) | `round-manager.ts:80-84` | chiamante senza `platform` → email non filtrate in silenzio | contesto senza `platform` + channel/generator presenti |
| **MEDIUM** | Guardia anti-produzione su costante hardcoded (D8) | `cli/commands/simulate.ts:29-39` | produzione con `PLATFORM_DB_PATH` custom vuoto → inquinata da sim | `.env` con path custom vuoto → `simulate:full` non rifiuta |
| **MEDIUM** | Chiarimento inviato ad account `unsubscribed`/`pending` | `email-processor.ts:389-405` | viola decisione 7/ADR-009 "nessuna email" | account `unsubscribed` invia "come funziona?" → riceve risposta |
| **LOW/MED** | Reply "già iscritto" con soggetto "Pick non registrato" | `email-processor.ts:209-215` + `generator.ts:94` | UX fuorviante per chi tenta di iscriversi | subscribe da account già `active` → subject `Survivor League — Pick non registrato` |
| **LOW** | `player` esistente senza `profile` (dati legacy) → `already_registered` permanente | `registration.ts:100-102` | utente mai ammesso all'auto-join | player row senza profile + pick TT1 |
| **LOW** | Doppio processing su tick concorrenti del cron (fetch prima del markSeen) → risposte duplicate | `email-processor.ts:445-477` | preesistente, aggravato dal flusso a due passi | due `channel:email:process` simultanei |
| **LOW** | `registration_open=1` dead-write + commenti stale | `tournament.ts:246-252` | incoerenza con deprecazione | — |
| **LOW** | Invio sequenziale 1-per-1 (SMTP + LLM) per broadcast/riepilogo | `tournament.ts:268-276`, `round-manager.ts:235-246,448-455` | lento con centinaia di iscritti; accettabile POC | — |

Aspetti verificati senza rilievi: transazione `autoJoinFromPick` con BEGIN/COMMIT/ROLLBACK anche sui percorsi d'errore (`registration.ts:107-149`); idempotenza `round:score`/doppio `platform:register`/doppio unsubscribe; clock iniettato su tutte le scritture (nessun `new Date()`/`datetime('now')` residuo nelle scritture — i match residui sono letture o clock derivati); chiusura di `platformDb` in `finally` in **tutti** i comandi (platform, channel, pick, round, tournament, scheduler, simulate); nessuna injection SQL (tutte le query parametrizzate).

## 4. Correzioni raccomandate (priorità)

1. **HIGH — Barriera unsubscribe**: accettare il body di conferma anche con intento `other` per account `pending_unsubscribe` (o l'intento `unsubscribe` senza body di conferma, come da spec "O"); aggiungere "confermo"/"sì" come segnali `unsubscribe` nel prompt; test unitario del caso "confermo → other".
2. **HIGH — `summary_sent`**: scriverlo prima del loop di invio (best-effort) o in transazione con lo `scored`; in alternativa inviare e marcare solo al successo con retry esplicito.
3. **MEDIUM — fail-closed** in `isAccountActive` (simmetria con `checkEligibility`).
4. **MEDIUM — guardia simulazione** ancorata al valore reale di produzione (es. esporre i default da `config.ts`, o un flag esplicito), non alla costante.
5. **MEDIUM — policy `other`**: chiarimento solo ad account `active`; silenzio per `unsubscribed`/`pending_unsubscribe`.
6. **LOW —** tipo email dedicato per "già iscritto"; rimozione dead-write `registration_open`; pulizia commenti stale (tournament.ts, pick-processor.ts, scheduler.ts, pick.ts); contract test `llm:classify`/`classifyInputBody`.
7. **Documentale**: carve-out esplicito in ADR-009/PRD RF-P6 per le conferme del flusso RF-P1/P2 rispetto al filtro `active` (risolve la contraddizione interna del piano); `agent-context/current-status.md` riporta "429 test verdi" mentre la suite reale è **414** — numero da correggere.

**Giudizio complessivo**: implementazione solida e molto ben documentata, con il gate a due DB, l'auto-join atomico e la matrice notifiche correttamente realizzati e testati. I due rilievi HIGH sono entrambi sulla robustezza del flusso reale (deadlock disiscrizione dipendente dal comportamento LLM non coperto dai fake, e finestra di crash sul riepilogo): raccomandato correggerli prima del merge. Le 5 deviazioni dichiarate sono quasi tutte giustificate; quella più delicata è la n. 3 (conferme sempre inviate), corretta nel comportamento ma da sancire nei documenti.
