# Briefing — Fase 3 "Game Engine (TDD)" (Task 3.1–3.5) + estensione 4.1/4.2

> Documento di lavoro preparatorio per l'implementatore. Prodotto in modalità
> di sola lettura a partire da: `tasks/plan.md` (Task 3.1–3.5, decisioni 1–12,
> requisiti ADR-008), `docs/POC/POC_LLD.md` (§1.1, §3.1, §3.2, §6, §7.3–7.7,
> §8.1), `docs/POC/POC_PRD.md` (§4.1–4.6, §5.1–5.4, CL1–18, RF-12…31,
> CS1/CS2/CS4/CS5/CS6), `docs/decisions/architecture-decisions.md` (ADR-008),
> `tasks/plan-aggancio-torneo-asincrono.md` (Task 7), stato reale di `src/`
> (config, schema, provider, importer, CLI) e `tests/` (fixture, pattern).
>
> **Decisioni confermate dal PO il 2026-08-14** (fonte: conversazione di
> briefing — vedi §0):
> - **A — Orologio iniettabile** come seam (non solo per i test): il Game
>   Engine riceve i dati dal provider e il tempo SOLO dall'orologio; in Fase 1
>   (dati live) il clock è reale e `rescheduled_date`/`end_time` su `match`
>   entrano come dati dal provider, senza cambi di logica.
> - **1 — Freeze con soglia `tcClose`**: CL7 resta `pending` entro la finestra
>   del TC; CL1/CL8 → `frozen` oltre la chiusura del TC (vedi §6).
> - **2 — Winner caso 2** ("tutti eliminati nello stesso TT") dedotto da
>   `eliminated_at` condiviso (stessa ondata), nessuna colonna round (vedi §5).
> - **3 — Auto-iscrizione RF-27 nel Task 4.2**, NON nel Task 3.2; richiede
>   l'**estensione 4.1+4.2** (finestra di iscrizione ancorata all'apertura del
>   torneo) — dipendenze elencate al §8.
> - **4 — Interfacce `ChannelAdapter`/`LLMGenerator` nascono come TIPI nel
>   Task 3.5**; implementazioni nelle Fasi 5–6.
>
> **Estensione scope (accettata):** questa Fase 3 include anche i **Task 4.1**
> (`tournament:start`/`status`/`history`/`leaderboard`/`export`) e **Task 4.2**
> (finestra iscrizione + auto-iscrizione RF-27 + eligibilità), perché
> l'auto-iscrizione richiede la struttura del torneo. L'ordine di esecuzione
> e le dipendenze sono al §8.
>
> Obiettivo: elencare **solo** incongruenze, problemi e modifiche necessarie
> emerse dalla verifica di spec, così l'agente che implementa parte dal
> briefing senza rileggere tutto il materiale. **Testo di lavoro non
> autorevole**: i documenti progetto (LLD/PRD) restano la fonte per le
> decisioni; dove il briefing contesta una spec, il punto va risolto su
> `plan.md`/ADR/LLD **prima o durante** l'implementazione.
>
> Data: 2026-08-14 · Stato: pronto per l'implementazione (Fase 3 + 4.1/4.2 estese).

---

## 0. Premessa — stato al Checkpoint 2 e design decisions accettate

Tutto ciò che la Fase 3 consumerà esiste già ed è testato al Checkpoint 2:

- **Dati stagione/rule-base:** `src/data/provider.ts` (`Match`,
  `SeasonDataProvider`, `SeasonDataError`), `src/data/db-provider.ts`
  (`DbSeasonDataProvider` reale), `src/data/importer.ts` (`upsertMatches`,
  formato canonico `match_date` ISO-8601 UTC), `src/data/football-data-client.ts`.
- **DB:** `src/db/schema.ts` — `player`, `profile` (incl. `eliminated_at`/
  `eliminated_reason`), `pick` (incl. `UNIQUE(profile_id, round)`, CHECK su
  `outcome`/`status`), `match`, `round_state`, `tournament_state` (incl.
  `start_round`, migrazione additiva idempotente). I vincoli applicativi NON
  sono nel DB (LLD §3.1): li costruisce ora il Game Engine.
- **Config:** `src/config.ts` ha già `DEADLINE_ADVANCE_MIN` (30),
  `TC_CLOSE_SKEW_MIN` (300), `MATCH_DURATION_MIN` (125), `SIM_PLAYERS` (10) e
  tutto il resto (LLD §4.1-§4.4). **Nessuna nuova env var per la Fase 3**
  (l'estensione 4.x non ne introduce: `ENTRY_FEE_EUR` resta placeholder Fase 1).
- **Directory già create ma VUOTE:** `src/game/` e `tests/unit/game/`.
  `src/channel/email-adapter/` vuota; `src/llm/` contiene solo `team-aliases.md`.
- **CLI:** `src/cli/index.ts` registra `db:migrate` e `data:*` (pattern:
  comando → `getConfig()` → `createConnection` → `migrate` → handler → `--json`).
- **Fixture:** `tests/fixtures/season.ts` — mini-stagione 4 squadre / 6 round /
  confine `ceil(6/2)=3`, helper `setScore`, `setPostponedFlag`, `setMatchDate`.
  I commenti dicono esplicitamente: *"la classificazione dentro/fuori finestra
  del TC è del Round Manager (Fase 3)"*.

**Design decision accettate (2026-08-14, PO):**

1. **A — Orologio come seam, compatibile con la Fase 1 (dati live).**
   Separazione dati/tempo: i moduli di gioco ricevono i *dati* dal
   `SeasonDataProvider` e il *tempo corrente* SOLO dall'orologio iniettato
   (`now(): Date`). In POC clock fisso → determinismo (RNF1/CS4/CL1/CL7/CL8/
   CL17/CL18); in Fase 1 clock reale + `rescheduled_date`/`end_time` come dati
   dal provider, senza cambi di logica. I derivatori di tempo sono funzioni
   pure sui dati (vedi §1-A e `src/game/round-time.ts`, §8).
2. **Decisione 1 — Freeze con soglia `tcClose`.** La chiusura del TC =
   fine prevista UPP + `TC_CLOSE_SKEW_MIN` (PRD §5.4, `MATCH_DURATION_MIN`).
   In `round:score`: match `postponed` senza punteggio e `now ≤ tcClose` →
   resta `pending` (CL7); `now > tcClose` → `frozen` (CL1/CL8). Da fissare in
   LLD §3.1/§7.3 (vedi §6).
3. **Decisione 2 — Winner caso 2 su `eliminated_at` condiviso.** I profili
   eliminati nella stessa ondata (stesso `round:score`/`round:close`, stesso
   clock) hanno `eliminated_at` identico. Case 2 = zero profili attivi e gli
   ultimi `eliminated_at` più recenti coincidono. Da registrare in
   LLD §7.7/PRD §4.6 (vedi §5).
4. **Decisione 3 — Auto-iscrizione RF-27 nel Task 4.2, non nel 3.2.** Il 3.2
   resta con i soli gate "profilo non iscritto/eliminato" → motivo dedicato.
   Il modulo di registrazione (`autoRegister`) crea il profilo e DELEGA al
   Pick Processor la validazione/registrazione del pick. Richiede l'estensione
   4.1+4.2 (vedi §8).
5. **Decisione 4 — Interfacce canale/LLM come TIPI nel 3.5.**
   `src/channel/adapter.ts` (`ChannelAdapter`) e `src/llm/generator.ts`
   (`LLMGenerator` + `EmailContext`/`EmailType`) con implementazioni nelle
   Fasi 5–6; mock nei test del Game Engine.

---

## 1. Problemi trasversali (vale per tutti i task)

**A — L'orologio: il Game Engine NON deve usare `new Date()` direttamente.**
La POC opera su dati storici e la deadline "si scavalca con i comandi CLI del
commissioner" (PRD §9); il determinismo RNF1, CS4 (receivedAt forzato),
CL1/CL7/CL8 (freeze), CL17/CL18 (guard) e la chiusura di sicurezza RF-30
dipendono dal confronto con un "adesso". **Modifica necessaria:** ogni modulo
di gioco che decide su base temporale accetta un **clock iniettabile**
(parametro `now: Date` o un'interfaccia `Clock`). **Compatibilità Fase 1**
(decisione A): la seam è strutturale — in produzione il clock è reale e i
tempi delle partite arrivano dal provider; non misuriamo mai il tempo in modo
implicito.

**B — Deadline "fissa all'apertura" (RF-14) vs kickoff effettivo "dai dati
correnti" (RF-31): due fonti temporali distinte.**
- La **deadline registrata** è calcolata una volta in `round:open` (da
  `getFirstMatchDateTime` di allora) e salvata in `round_state.deadline`.
- Il **kickoff effettivo** del guard anti-frode è letto in fase di accettazione
  **dai dati correnti** (può cambiare se il calendario anticipa/ritarda, CL18).
Il Pick Processor riceve **entrambi**: `round_state.deadline` **e** il kickoff
appena letto dal provider. Accettazione = `min(deadline registrata, kickoff
effettivo attuale)`. Non esporre un singolo "deadline" derivato al volo: sarebbe
una terza semantica non documentata (vedi `round:deadline` §6).

**C — Freeze CL7/CL1/CL8: la regola del piano "postponed senza punteggio →
frozen" è AMBIGUA e non copre CL7.**
LLD §3.1 regola operativa: "punteggio → contabilizza; postponed senza punteggio
→ frozen; altrimenti pending". Ma CL7 (recupero **entro** la finestra del TC)
richiede che il match rinviato senza punteggio **resti `pending`** finché il
recupero non arriva; solo un recupero **fuori** dalla finestra → `frozen`
(CL1) / UPP non giocata → `frozen` (CL8). **Decisione confermata (n. 1):**
il Round Manager calcola la **finestra del TC** `[getFirstMatchDateTime(round),
tcClose]` con `tcClose = fine prevista UPP + TC_CLOSE_SKEW_MIN` (PRD §5.4:
fine prevista = orario programmato `match_date` + `MATCH_DURATION_MIN`,
indipendente dal punteggio) e, in `round:score`, per un pick `pending` il cui
match è `postponed` senza punteggio:
  - `now ≤ tcClose` → resta `pending` (CL7);
  - `now > tcClose` → `frozen` (CL1/CL8).
Un match **non** postponed senza punteggio → `pending` (in corso) sempre.
La chiusura del TC è **finestra di riferimento, non trigger** (LLD §1.4).
Il calcolo `tcClose` è una funzione pura sui dati → vale anche in Fase 1 live.

**D — Interfacce canale/LLM non esistono ancora nel codice.**
**Decisione confermata (n. 4):** in 3.5 si definiscono le **interfacce** (tipi)
`ChannelAdapter { fetchMessages(); sendMessage(to, body) }` e
`LLMGenerator { generate(ctx): Promise<string> }` + `EmailContext`/`EmailType`
(da LLD §6.3) in `src/channel/adapter.ts` e `src/llm/generator.ts`.
Implementazioni concrete nelle Fasi 5–6. Il Round Manager dipende solo dalle
interfacce (iniettate, mock nei test). Non anticipare logica LLM nel 3.5
(ADR-004): si compone il **contesto** (con coppia tt/tc, squadre disponibili) e
si chiama `generate()`; mai testi hardcodati né numeri di turno generati.

**E — Coppia TT/TC (ADR-008) già necessaria in Fase 3, ma `start_round` è GLU
fino al Task 4.1.**
`round:status`/`round:deadline` (LLD §7.3) e le email devono esporre `(tt, tc)`;
`tournament_state.start_round` è scritto da `tournament:start` (4.1) e prima la
riga `tournament_state` può anche non esistere. **Modifica necessaria:** helper
derivato (proposta: `src/game/turn.ts`): `getStartRound(db): number` (legge la
riga; `NULL`/assente → **1**, legacy) e `ttFor(tc, startRound) = tc - startRound
+ 1` + forma compatta `TTnTCm` / estesa `TT n, TC m`. Testato in 3.5.
**Le query delle squadre bruciate NON filtrano la finestra `[start_round..N]`:**
è un filtro logico (ADR-008/LLD §3.2) — da non implementare mai nelle query.

**F — Errori/motivi del Game Engine: contratto strutturato.**
`pick:validate` deve produrre `{valid, reason}` (LLD §7.4) e ogni rifiuto ha
**motivo dedicato** (PRD US2). **Modifica necessaria:** enum dei motivi
(prop. `src/game/pick-processor.ts` o `src/game/errors.ts`):
  - `profile_not_registered` / `profile_eliminated` (gate);
  - `unknown_team` (squadra non in lista canonica `getTeams()` — check esatto
    post-parse, LLD §6.2, motivo CL5 lato Game Engine) e `team_not_in_round`
    (CL4 — distinguere: non gioca nel TC);
  - `team_already_used` (già bruciata nel girone, RF-10/CS5);
  - `invalid_outcome` (fuori `win|draw|lose`);
  - `pick_already_exists` (CL6/RF-08, anche su eccezione `UNIQUE` dal DB →
    motivo, non crash);
  - `round_not_open` / `after_acceptance` (CL3/CS4) / `after_kickoff` (guard
    RF-31, CL17/CL18).
**Ordine della cascata** (LLD §3.1): registrazione/attivo → squadra canonica →
squadra nel TC → non bruciata → esito valido → non già pick → accettazione
temporale. L'ordine è la base dei messaggi di risposta.

**G — Override `--reason` (US10/ADR-008): bypassa SOLO la finestra temporale,
mai le regole sostanziali.**
`pick:register --reason` è il rimedio ai pick rifiutati dal guard RF-31/CL18
(ADR-008 n. 6, PRD US10). L'override NON aggira squadra già bruciata, squadra
non in giornata, esito errato, già esistente ("stesse regole dei pick
automatici", PRD §4.4/US10). Test: override con squadra bruciata → rifiutato
comunque.

**H — Documentazione del codice (AGENTS.md rule 5).**
Header di file + commenti su funzioni/parametri per ogni file nuovo:
`src/game/turn.ts`, `rules.ts`, `round-time.ts` (vedi §8), `pick-processor.ts`,
`elimination.ts`, `winner.ts`, `round-manager.ts`, `eligibility.ts` (4.2),
`registration.ts` (4.2), `channel/adapter.ts`, `llm/generator.ts`, comandi CLI
(`rules.ts`, `pick.ts`, `elimination.ts`, `winner.ts`, `round.ts`,
`tournament.ts`), test. Stesso standard della Fase 2.

**I — Registrazione CLI incrementale.**
Ogni task registra i propri comandi in `src/cli/index.ts`. I comandi passano a
ogni modulo di gioco `{ db, dataProvider, config, now }` — mai `getConfig()`
dentro i moduli di gioco (separazione di responsabilità, AGENTS.md §1.3): la
CLI inietta (pattern già consolidato in data.ts/db.ts).

**J — CL5 nel Pick Processor vs parser.**
"Il formato illeggibile dell'email" è del Parser (Task 5.1); nel Pick Processor
l'unico caso CL5 è la **squadra non riconducibile alla lista canonica** (check
esatto post-parse) → motivo dedicato, mai crash. Non costruire logica di
parsing nel Game Engine (ADR-004).

---

## 2. Task 3.1 — Rules Engine

Contenuto (plan.md + LLD §7.5): burned/available/check-half, comandi `rules:*`.
Regola-base: squadra usata una volta per girone; confine `ceil(N/2)` (N =
`MAX(round)` dai dati, RF-19); azzeramento pool al ritorno; `frozen` conta come
bruciata (query su `pick` senza filtri di stato — LLD §1.1 / CRITICAL-01).

**Decisioni/modifiche da fissare:**
1. **Query dei gironi** (LLD §1.1: andata `round BETWEEN 1 AND floor(N/2)` o
   `< confine`; ritorno `round >= confine` con `confine = ceil(N/2)`).
   N=38 → andata 1–19, ritorno 20–38 (`ceil=20`). N=6 → andata 1–3, ritorno
   4–6 (`ceil=3`). Confini derivati, mai letterali.
2. **`checkHalf(round)`** → 1 (andata) se `round < ceil(N/2)`, 2 (ritorno) se
   `round >= ceil(N/2)`. Attenzione a `round == ceil` (es. 20 con N=38) =
   **ritorno**. Testarlo.
3. **`getAvailableTeams(profile, round)`**: squadre della stagione
   (`getTeams()`, UNION, non solo home) **meno** le bruciate del girone di
   `round`. **Dalla decisione 12 del piano** ("email apertura round con solo
   squadre disponibili") e da CL4 (la squadra deve giocare nel TC): le
   disponibili per la scelta = quelle **in giornata e non bruciate**. Da
   fissare esplicitamente (filmro il `rules:available-teams --round` come
   "squadre che giocano nel round, non bruciate nel girone").
4. **Confronto con la lista canonica** del Rules vs provider: `getTeams()` è la
   fonte; il rules espone `isBurned`, il pick-processor chiede. Nessun
   duplicato di logica.
5. **Nessuna finestra `[start_round..N]` nelle query** (ADR-008, §1-E): le
   bruciate si interrogano sull'intera stagione. CL13/CL14 (aggancio al
   confine/oltre metà) si verificano in Fase 4, ma il rules deve già
   comportarsi correttamente: burnout del ritorno indipendente da dove inizia
   il torneo.

**Verifica (plan):** unit test confine andata/ritorno, azzeramento pool al
ritorno, RF-19 (nessuna costante). Extra: `checkHalf` con N pari e dispari;
"frozen conta come bruciata" (pick `frozen` presente nella query burned).

---

## 3. Task 3.2 — Pick Processor (senza auto-iscrizione, decisione 3)

Contenuto (LLD §7.4, §3.1): cascata di validazione con motivo dedicato, guard
anti-frode RF-31 (accettazione = `min(deadline registrata, kickoff effettivo)`),
register atomico, comandi `pick:validate/register/list`.

**Decisioni/modifiche da fissare:**
1. **Ingressi:** `(profileId, round, team, outcome, receivedAt, opts?)` —
   `receivedAt` è il timestamp di ricezione (ADR-001), passato dal chiamante
   (CLI: `new Date()`/clock; test: forzato per CS4). Mai leggere header/Date.
2. **Cascata nell'ordine del §1-F**, con modulo di esito (proposta: funzione
   pura `pickOutcomeFor(team, match): 'win'|'draw'|'lose'` nel Rules Engine,
   riusata dal Round Manager 3.5 — non duplicata).
3. **Guard RF-31:** istante di accettazione = `min(round_state.deadline ??
   +∞, getFirstMatchDateTime(round) da provider)`; rifiuto `after_kickoff` con
   messaggio esplicito (CL17/CL18); prevale su RF-14 se il calendario anticipa
   (CL18). Con deadline NULL → vale solo il kickoff (CL17).
4. **Override `--reason`:** presente solo per il superamento del check
   temporale (§1-G); il resto della cascata resta attivo.
5. **Atomicità al write:** il `register` usa la transazione/UNIQUE del DB; su
   violazione `UNIQUE(profile_id, round)` → motivo `pick_already_exists` (CL6),
   mai crash.
6. **Profilo eliminato:** `register` rifiutato con `profile_eliminated` (LLD
   §3.1). Round non `open` (o riga `round_state` assente) → `round_not_open`
   (CL3).
7. **`pick:list`** con filtri `--round`/`--profile-id` (LLD §7.4): sola lettura.

**Verifica (plan):** unit test per ogni motivo (CL3/CL4/CL5/RF-08/RF-10/RF-11)
+ concorrenza CL6 (due insert, uno passa — CS2) + CS4 (receivedAt forzato
oltre/entro accettazione). Extra: RF-31 con deadline NULL (CL17) e con anticipo
calendarizzato (CL18, override `--reason` accetta).

---

## 4. Task 3.3 — Elimination Engine

Contenuto (LLD §7.6, PRD §5.2/CS4): eliminazione per pick mancante (al close) e
per pick sbagliato (alla contabilizzazione), con `eliminated_at`/
`eliminated_reason` (`'missing_pick'` | `'wrong_pick'`); comandi
`elimination:check`/`elimination:list`.

**Decisioni/modifiche da fissare:**
1. **Idempotenza:** `eliminate(db, profileId, reason, now)` no-op se già
   eliminato (un profilo eliminato per wrong non va ri-eliminato come missing
   nel TT successivo; PRD §5.4 "se il profilo è già eliminato … non ha
   effetto").
2. **Motivo:** la contabilizzazione `wrong` (Round Manager 3.5) chiama
   `eliminate(..., 'wrong_pick')`; il `missing` al close chiama
   `eliminate(..., 'missing_pick')`. `eliminated_reason` + `eliminated_at`
   (ISO-8601, da clock).
3. **`elimination:check --profile-id`** → `{eliminated, reason}` (sola lettura).
4. **Coerenza:** nessuna colonna round di eliminazione; il Winner Engine
   deduce "stesso TT" da `eliminated_at` condiviso (decisione 2, §5).
5. Il profilo eliminato non compare più come destinatario di email pick (delega
   al round manager §6, che filtra `eliminated = 0`).

**Verifica (plan):** unit test dei due casi; profilo eliminato non può più
inviare pick (interazione col pick processor: motivo `profile_eliminated`).

---

## 5. Task 3.4 — Winner Engine

Contenuto (LLD §7.7, PRD §4.6 RF-18/RF-26): tre casi di fine torneo; profilo
con freeze non contabilizzato resta in gara; comando `winner:check` →
`{finished, winners, case}`.

**Decisioni/modifiche da fissare (GAP di spec risolto, decisione 2):**
1. **"Fine torneo" senza `tournament:start`:** l'ultimo TC = `getTotalRounds()`
   (dalla stagione importata). Torneo **finito** quando (a) resta **un solo
   profilo non eliminato** (case 1), oppure (b) **zero** profili non eliminati
   (case 2, §3), oppure (c) **2+ profili attivi dopo che l'ultimo TC della
   stagione è `scored`** (case 3). I test preparano gli stati direttamente
   (pick/eliminazioni/round_state) — non serve passare per l'avvio.
2. **Freeze a fine stagione (CS6):** profilo con pick `frozen` non valutato
   **resta in gara** (non eliminato) → rientra nei conteggi dei superstiti.
   Test: 2 superstiti con un frozen → `{finished: true, case: 3, winners:
   [entrambi]}`.
3. **Case 2 — "tutti gli ultimi in gara eliminati nello stesso TT"
   (decisione 2):** zero attivi **e** gli ultimi `eliminated_at` più recenti
   coincidono (stessa ondata di `round:score`/`round:close`, stesso clock).
   Registrare la decisione in LLD §7.7/PRD §4.6.
4. **CL12 (torneo di un turno, aggancio all'ultimo TC):** i tre casi
   "collassano naturalmente" (RF-26) — il winner è finestra-agnostico, nessuna
   logica speciale (il warning è solo di `tournament:start`, Task 4.1).
   Verificare che non usi mai "richiede almeno 2 round".

**Verifica (plan):** unit test dei tre casi + caso frozen a fine stagione (CS6).

---

## 6. Task 3.5 — Round Manager (il task più grande)

Contenuto (LLD §7.3, §1.1, §1.4): `round:open` (deadline fissa, crea
`round_state`, invia email pick ai profili attivi via canale+LLM mockati),
`round:close` (consolida: elimina mancanti + notifica; + `--force --reason`
RF-29), `round:score` (incrementale: pending con punteggio → correct/wrong;
postponed fuori finestra → frozen; **frozen con punteggio ora → valutato,
eliminazione a posteriori**; round → `scored` quando nessun pending; idempotente
RF-17), `round:status`, `round:deadline` (esporre deadline + kickoff effettivo,
RF-31); coppia TT/TC in output/email (RF-25).

**Decisioni/modifiche da fissare:**
1. **`round:open`:** se `round_state` non esiste → crea (status `open`,
   `deadline` da `getFirstMatchDateTime(round) − DEADLINE_ADVANCE_MIN`,
   `opened_at` = clock). Se già `open` → errore chiaro "già aperto" (no
   duplicato). Un round `scored` non si riapre senza override/CL9 (fuori scope
   3.5).
2. **`round:close`:** semantica di **consolidamento**: elimina i profili
   **attivi** senza pick registrato per il round (`missing_pick`), notifica
   (via interfaccia mockata), `closed_at`, `status='closed'`. La **forzata**
   `--force --reason` (RF-29) ha la **stessa** semantica e vale anche con
   deadline NULL/anticipata; **senza `--reason` rifiuta** (audit obbligatorio).
   **Non esiste "chiudi senza eliminare"** (ADR-008).
3. **`round:score` — il cuore, con la finestra del TC (decisione 1):** per ogni
   pick `pending` del round:
   - match con punteggio → valutalo: `correct` oppure `wrong` (+
     `eliminate(..., 'wrong_pick')` se non già eliminato);
   - match `postponed` senza punteggio → `frozen` se `now > tcClose` (CL1/CL8),
     altrimenti resta `pending` (CL7);
   - match non rinviato senza punteggio → resta `pending`.
   Poi: **processa anche i pick `frozen`** la cui partita ora ha punteggio
   (frozen → correct/wrong + eventuale eliminazione a posteriori, decisione 4
   del piano) — su round `scored` compresi. Quando non restano `pending` →
   `scored` (RF-16). **Idempotenza RF-17** (processa solo pending/frozen;
   rieseguire = no-op).
4. **`round:score` sui `frozen` dei round `scored`:** lo scheduler (Task 7.2)
   invoca `round:score --round n`; il round manager DEVE processare anche i
   frozen dei round già `scored` (LLD §1.4: `SELECT DISTINCT round FROM pick
   WHERE status='frozen'`). Nel 3.5 basta che `round:score` accetti un
   parametro "processa anche i round scored" o che lo faccia sempre.
5. **Notifica/invio email (interfacce §1-D):** consumatore delle interfacce
   `ChannelAdapter`/`LLMGenerator` (mock nei test). Compone `EmailContext` (con
   `tt`/`tc` da `turn.ts`, `availableTeams`, `deadline`, motivo) e delega.
   Email previste al 3.5: apertura round (pick_instructions), eliminazioni
   (missing/wrong... round_result), freeze (pick_postponed). **Nessuna email
   reale** in 3.5 (implementazione Fasi 5–6), solo il contratto.
6. **TT/TC everywhere (RF-25):** `round:status`/`round:deadline` e log/CLI
   emettono la coppia `TTnTCm`/`{tt, tc}` derivata da `start_round` (fallback
   1), mai hardcodata né dall'LLM (§1-E).
7. **`round:deadline`:** output = deadline registrata **e** kickoff effettivo
   attuale (istante di accettazione, RF-31) — esplicita le due fonti del §1-B.

**Verifica (plan):** `tests/integration/round-flow.test.ts` su DB in-memory
(open → pick → close → score); idempotenza `round:score` ripetuto (RF-17);
CL1/CL7/CL8 sulle fixture (sequenze con clock fisso); frozen valutato a recupero
concluso; chiusura forzata con/senza `--reason` (RF-29). Extra: round:score che
valuta UN match alla volta (incrementale); TT → `scored` solo quando tutti i
pending sono terminali (RF-16); pick wrong di un profilo già eliminato → nessuna
doppia eliminazione.

---

## 7. Coerenze verificate (non-problemi)

- **Config completa** per Fase 3 e 4.x: `DEADLINE_ADVANCE_MIN`,
  `TC_CLOSE_SKEW_MIN`, `MATCH_DURATION_MIN` già in `config.ts` e `.env.example`
  — nessun task di config.
- **Schema già aggiornato** (ADR-008/Fase 1): `start_round`, `eliminated_at/
  reason`, `status` enum, `UNIQUE(profile_id, round)` — nessuna migrazione.
- **`DbSeasonDataProvider` non va mockato** (LLD §8): i test girano sul provider
  reale su SQLite in-memory + fixture. Il mock è confinato solo alle interfacce
  esterne canale/LLM.
- **Separazione di responsabilità** (AGENTS.md §1.3): il round manager non
  tocca `getConfig()`/API; legge i dati via `SeasonDataProvider`, scrive solo su
  `pick`/`profile`/`round_state`/`tournament_state`. Pattern "la CLI inietta".
- **Fixture pronte** con helper di mutazione e sequenze CL7/CL1/CL8/frozen come
  stati dati — manca solo la classificazione temporale del Round Manager (§1-C).
- **Retry/JSON output/errori CLI** seguono il pattern esistente (`--json`,
  `.fail` che stampa il messaggio pulito).

---

## 8. Estensione — Task 4.1 e 4.2 (auto-iscrizione RF-27, decisione 3)

**Perché 4.1 è NECESSARIA (non opzionale):** la finestra di iscrizione si
ancora all'**apertura del torneo** (US6, RF-22). Senza `tournament:start` non
esiste `tournament_state` (`start_round`, `season_started`), nessun `round_state
pending`, nessuna deadline TT1 da validare (RF-21) e il gate
`registration_open` non ha riga. **"Includere la 4.2" = includere anche la 4.1.**

**Catena di dipendenze (ordine di esecuzione):**
```
3.1 rules → 3.2 pick → 3.3 elimination → 3.4 winner
        → round-time.ts (estratto, puro) → 3.5 round manager
        → 4.1 tournament:start/status/history/leaderboard/export
        → 4.2 registrazione + auto-iscrizione (RF-22/24/27/28, CL2/CL5/CL10/CL16,
          eligibilità)
        → Checkpoint 3 esteso
```

| # | Dipendenza | Perché serve al 4.2 |
|---|-----------|---------------------|
| 1 | **3.1 Rules Engine** | Il pick dell'auto-iscrizione è un pick normale: cascata squadra canonica + non bruciata nel girone |
| 2 | **3.2 Pick Processor** | `autoRegister` crea profilo poi DELEGA validate+register atomico al processor (motivi, CS2) |
| 3 | **3.5 Round Manager o i suoi derivatori di tempo** | Deadline TT1 (finestra RF-22): in `round:open` o via `computeDeadline`; CL16 (iscritto senza pick al TT1 → eliminato) è test di `round:close` → verificare 3.5 e 4.2 insieme |
| 4 | **4.1 `tournament:start`** | Finestra ancorata all'apertura torneo; `tournament_state`/`start_round`; RF-21; RN round pending |
| 5 | **Seam eligibilità (ADR-008 §6.5)** | Nuovo file piccolo `src/game/eligibility.ts`: `ExternalIdentity {channel, identifier}`, `EligibilityResult {eligible, reason?}`, `Eligibility`, `AlwaysEligibleEligibility` (sempre `true` + log pino). Invocata da `registerProfile`/`autoRegister` e dagli override con esito forzato + motivo |
| 6 | **Interfacce canale/LLM (nate nel 3.5, decisione 4)** | Notifiche: welcome, `registration_open_invite`, conferma/rifiuto auto-iscrizione via `ChannelAdapter`/`LLMGenerator` mockati |

**Cosa NON serve (la 4.2 resta implementabile prima delle Fasi 5–6):**
- **Niente LLM Parser (5.1) né canale email (6.1/6.2).** Il modulo 4.2 riceve
  `PickExtraction | null` e `ExternalIdentity` già normalizzati; chi invoca il
  Parser è il wiring `channel:email:process` (6.2). Nei test si passa
  `extraction` direttamente o un fake.
- **Nessuna nuova env var, nessuna migrazione.** `ENTRY_FEE_EUR` è usata solo
  in Fase 1 (quota eligibilità): nel seam POC resta `true` + log.

**Raccomandazione strutturale:** estrarre i derivatori di tempo in
**`src/game/round-time.ts`** (puro): `computeDeadline(kickoff, advanceMin)`,
`computeTcClose(matches, durationMin, skewMin)`. Usato da 3.5, 4.1 (RF-21) e
4.2 (finestra TT1) — evita di accoppiare 4.1/4.2 a tutto il Round Manager **ed
è la seam che la Fase 1 userà coi dati live** (§1-A).

**Contenuto minimo di 4.1 (LLD §7.10):**
- `tournament:start [--start-round <n>]` — verifica calendario presente/completo/
  coerente; deriva parametri (RF-19); inizializza `round_state` pending;
  `season_started=1`; `start_round`; validazioni RF-21 (TC esistente, con partite,
  deadline TT1 futura → rifiuto **atomico** senza stato parziale); aggancio
  all'ultimo TC → warning informativo CL12. Fallimento senza stato parziale
  (US6).
- `tournament:status`, `tournament:history <email>`, `tournament:leaderboard`,
  `tournament:export` (dump JSON + metadati) — sola lettura, economici.

**Contenuto minimo di 4.2 (LLD §7.10, §6.5, ADR-008):**
- `tournament:register:open [--contacts <file>]` (notifica best-effort una
  sola volta), `tournament:register:close [--reason <motivo>]` (RF-28, chiusura
  forzata auditata; auto-chiusura alla deadline TT1 RF-22; finestre indipendenti),
  `tournament:register --email [--name] [--reason <motivo>]` (manuale, univocità
  email/profilo, nuovo iscritto parte dal round corrente con pool intatto).
- **Auto-iscrizione RF-27:** nel TT1 un `PickExtraction` da mittente sconosciuto
  → creazione profilo + validazione pick **atomiche** (`autoRegister`); non
  interpretabile → chiarimento senza profilo (CL5); dal TT2 → rifiuto senza
  registrazione (RF-24).
- **Eligibilità:** invocata (e loggata) a ogni registrazione/auto-registrazione;
  override passa per la stessa funzione con esito forzabile + motivo.

**Verifica (plan + Task 7 aggancio):** CL2 (auto-iscrizione TT1 / rifiuto dal
TT2), CL5 (nessun profilo creato), CL10/CL16; auto-chiusura alla deadline TT1;
chiusura forzata con/senza `--reason`; univocità su invii concorrenti (RNF2);
eligibilità loggata; coppia TT/TC in output/email (RF-25).

---

## 9. Correzioni ai documenti da applicare in itinere

| File | Modifica |
|------|----------|
| `tasks/plan.md` Task 3.2 | Chiarire che l'**auto-iscrizione RF-27** non è nel 3.2 (gate "profilo non iscritto/eliminato" sì); CL5 = squadra non canonica lato Game Engine, non parsing |
| `tasks/plan.md` Task 3.5 | Esplicitare la **regola del freeze con la finestra del TC e clock iniettabile** (CL7 resta pending entro finestra; soglia `tcClose`) |
| `tasks/plan.md` Task 4.2 | Esplicitare la dipendenza da 4.1 e dal derivatore di tempo condiviso; elenco motivi |
| `docs/POC/POC_LLD.md` §3.1/§7.3 | Specificare la semantica freeze CL7 vs CL1/CL8 con la soglia `tcClose` (finestra di riferimento, non trigger) |
| `docs/POC/POC_LLD.md` §7.7 / `POC_PRD.md` §4.6 | Definire il caso 2 del Winner su `eliminated_at` condiviso (decisione 2) |
| `docs/POC/POC_LLD.md` §5 | Concretizzare `src/game/round-time.ts` e `turn.ts`; interfacce `ChannelAdapter`/`LLMGenerator` come TIPI dal 3.5 (decisione 4) |
| `AGENTS.md` §1.7 | Aggiornare lo "Stato attuale" al completamento del Checkpoint 3 esteso (Fase 3 + 4.1/4.2) |

---

## 10. Prompt pronto per l'agente implementatore

Prompt di base (da precorrere con qualunque task della Fase 3 estesa):

> Implementa la **Fase 3 estesa** del piano (`tasks/plan.md`): Task 3.1→3.5
> **più** Task 4.1 e 4.2 (auto-iscrizione RF-27 inclusa), seguendo
> **prioritariamente** il briefing `tasks/briefing-fase-3.md` (decisioni
> 1/2/3/4/A del 2026-08-14) e le sezioni LLD/PRD ivi citate come autorità.
> Prima di scrivere codice: (1) se una spec nel briefing è contestata, applica
> la correzione a `plan.md`/ADR/LLD nello stesso lavoro (tabella §9), (2)
> applica AGENTS.md rule 5 (header file e commenti funzioni/parametri), (3)
> scrivi prima i test (TDD) su SQLite in-memory con `DbSeasonDataProvider`
> reale + fixture e **clock fisso**, mockando SOLO le interfacce esterne
> (`ChannelAdapter`/`LLMGenerator`), (4) verifica con `npm run typecheck`,
> `npm run lint`, `npm test`.
> Vincoli: non usare `new Date()` dentro i moduli di gioco (inietta il clock,
> seam compatibile con la Fase 1 dati live); non usare `getConfig()` nei moduli
> di gioco (la CLI inietta); non hardcodare costanti (RF-19/LLD §3.2); non
> implementare la finestra `[start_round..N]` nelle query (ADR-008); estrai i
> derivatori di tempo in `src/game/round-time.ts` (puro, condiviso da
> 3.5/4.1/4.2).
> Fine Checkpoint 3 esteso: engine completo, CS2/CS4/CS5/CS6 verdi, guard
> anti-frode RF-31 unit testato, auto-iscrizione RF-27 testata (4.2), logica di
> gioco interamente fuori da canale e LLM (mock).

Per task specifico:
- **3.1**: §2 del briefing + `tests/unit/game/rules.test.ts`.
- **3.2**: §3 (senza auto-iscrizione) + motivi del §1-F.
- **3.3**: §4.
- **3.4**: §5 + caso 2 su `eliminated_at` condiviso (decisione 2).
- **3.5**: §6 + finestra del TC (decisione 1) + interfacce (decisione 4) +
  `tests/integration/round-flow.test.ts`.
- **4.1**: §8 (avvio stagione, RF-19/21, CL11/12/13/14, export).
- **4.2**: §8 (finestra RF-22/28, auto-iscrizione RF-27, eligibilità, CL2/CL5/
  CL10/CL16).
