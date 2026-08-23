# Report UAT — Aggancio asincrono (ADR-008) — 2026-08-22

> **Scopo del report**: fornire a un agente, in una NUOVA sessione, tutto il
> contesto necessario per analizzare i problemi osservati durante il test UAT
> in modalità **commissioner** con **aggancio asincrono** (`--start-round 3`).
> Il report include: configurazione, timeline, stato DB completo, testo
> VERBATIM delle email dei giocatori per ogni pick, e i commenti da analizzare.
>
> **Data test**: 2026-08-22, ore ~17:55Z – 18:27Z. **Ambiente**: TEST MODE
> (`ENV_FILE=.env.uat`), DB `data/uat-synthetic-pippo.db` +
> `data/uat-platform-pippo.db`. Modello LLM primario: `mistralai/mistral-nemo`.

---

## 1. Configurazione del test

### Parametri `.env.uat` (run UAT aggancio asincrono)

| Parametro | Valore | Note |
|---|---|---|
| `TEST_MODE` | `true` | Banner TEST MODE, alias sintetici Serie B |
| `TEST_OFFSET_DAYS` | `0` | Clock/receivedAt reali |
| `TEST_REFRESH_ALLOWED` | `false` | Refresh bloccati |
| `SCHEDULER_ENABLED` | `false` | **Modalità commissioner** (niente loop scheduler) |
| `DEADLINE_ADVANCE_MIN` | `3` | Deadline = kickoff − 3 min |
| `MATCH_DURATION_MIN` | `2` | + `TC_CLOSE_SKEW_MIN=1` → D8: spacing ≥ 3 ✓ |
| `TC_CLOSE_SKEW_MIN` | `1` | — |
| `LLM_MODEL` | `mistralai/mistral-nemo,google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free` | Primario mistral-nemo (verificato) |
| `LLM_TIMEOUT_MS` / `LLM_RETRIES` | `15000` / `3` | Default |

### Seed (dati sintetici)

```
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 4 --rounds 6 --spacing-min 15 --first-kickoff-offset-min 45 --seed 42
```

- Squadre: US Cremonese, Brescia Calcio, SSC Bari, US Catanzaro
- 6 giornate (TC 1–6), kickoff: TC1 18:43:43Z, TC2 18:58:43Z, TC3 19:13:43Z,
  TC4 19:28:43Z, TC5 19:43:43Z, TC6 19:58:43Z (spacing 15 min)
- Confine girone (halfBoundary) = `floor(6/2)+1` = **4** → pool squadre resettato al TC4

### Reset DB

- **Solo DB torneo**: `rm data/uat-synthetic-pippo.db` + `db:migrate` + seed
- **DB piattaforma NON resettato**: Fulvio (`fulviodegiovanni@gmail.com`,
  registerID 1) e Pippi (`sara.zizzari@gmail.com`, registerID 2) erano già
  registrati dal test precedente
- **Nuovo giocatore registrato** prima dell'avvio torneo:
  `platform:register --email "fulviodegiovanni@live.com" --name "Fulvio"` → registerID 3, status `active`

### Account piattaforma al momento dell'avvio torneo

| register_id | email | name | status |
|---|---|---|---|
| 1 | fulviodegiovanni@gmail.com | Fulvio De Giovanni | active |
| 2 | sara.zizzari@gmail.com | Pippi | active |
| 3 | fulviodegiovanni@live.com | Fulvio | active |

### Avvio torneo (aggancio asincrono)

```
ENV_FILE=.env.uat npm run cli -- tournament:start --start-round 3
```

Output:
```
Stagione avviata: TT1 = TC 3, 4 round inizializzati (confine girone 4)
  Deadline TT1: 2026-08-22T19:10:43.700Z (kickoff 2026-08-22T19:13:43.700Z)
```

- `tournament_state.start_round = 3`
- `round_state` inizializzato SOLO per TC 3,4,5,6 (status `pending`); TC 1-2 non esistono (fuori finestra)
- Mappatura TT/TC (da export): `[{tc:3,tt:1},{tc:4,tt:2},{tc:5,tt:3},{tc:6,tt:4}]`
- **Commento da analizzare #1**: la mail `tournament_open` (annuncio apertura torneo) **NON è arrivata a fulviodegiovanni@live.com**

---

## 2. Timeline del test

Tutti gli orari in UTC. Comandi eseguiti manualmente dal commissioner.

| Ora (UTC) | Azione | Esito |
|---|---|---|
| 17:58:47 | seed + registrazione fulviodegiovanni@live.com | registerID 3 |
| 17:59:05 | `tournament:start --start-round 3` | TT1=TC3, 4 TT, confine 4 |
| 17:59:17 | `round:open --round 3` (TC3=TT1) | deadline 19:10:43Z, notificati 3 registrati senza profilo |
| 18:00:30 | email pick TC3 — Fulvio live (UID 285) | — |
| 18:02:13 | email pick TC3 — Fulvio De Giovanni (UID 286) | — |
| 18:03:06 | email pick TC3 — Pippi (UID 287) | — |
| 18:04:24 | `channel:email:process` | 3× `auto_joined` (3 profili creati) |
| 18:06:01 | `round:close --round 3 --force` | nessun eliminato |
| 18:06:05 | `round:score --round 3` | 3/3 correct, `scored` |
| 18:06:46 | `round:open --round 4` (TC4=TT2, **confine girone**) | deadline 19:25:43Z, notificati 3 profili |
| 18:08:48 | email pick TC4 — Fulvio De Giovanni (UID 288) | — |
| 18:09:31 | email pick TC4 — Fulvio live (UID 289) | — |
| 18:10:28 | email pick TC4 — Pippi (UID 290) | — |
| 18:10:46 | `channel:email:process` | 3× `pick_registered` |
| 18:11:20 | `round:close --round 4 --force` + `round:score` | **Fulvio live eliminato** (`wrong_pick`), round scored |
| 18:11:49 | `round:open --round 5` (TC5=TT3) | deadline 19:40:43Z, notificati 2 profili |
| 18:13:27 | email pick TC5 — Fulvio De Giovanni (UID 291) | — |
| 18:14:13 | email pick TC5 — Pippi (UID 292) | — |
| 18:14:23 | `channel:email:process` | 2× `pick_registered` |
| 18:14:50 | `round:close --round 5 --force` + `round:score` | 2/2 correct, nessun eliminato |
| 18:15:18 | `round:open --round 6` (TC6=TT4, ultimo) | deadline 19:55:43Z, notificati 2 profili |
| 18:17:46 | email pick TC6 — Fulvio De Giovanni (UID 293) | — |
| 18:18:34 | email pick TC6 — Pippi (UID 294) | — |
| 18:18:46 | `channel:email:process` | Fulvio `pick_registered`, **Pippi `pick_rejected (team_already_used)`** |
| 18:22:56 | email Pippi (UID 295) "Catanzaro pareggia" | → processato come `clarification (unrecognized_format)` |
| 18:25:11 | email Pippi (UID 296) "Vince cremonese" | → `pick_registered` |
| 18:26:41 | `round:close --round 6 --force` + `round:score` | 2/2 correct → **CHIUSURA AUTOMATICA** |
| 18:26:42 | Export automatico | `data/exports/tournament-export-2026-08-22T18-26-42.486Z.json` |

---

## 3. Comandi CLI inviati per amministrare il torneo

Tutti i comandi eseguiti dal commissioner (in ordine cronologico), con
`ENV_FILE=.env.uat npm run cli -- <comando>`. Le opzioni `--json` non sono
state usate; tutti i comandi sono stati eseguiti senza `--force` se non
indicato. I log pino (con `[TEST MODE]`) sono stati filtrati dalle righe
`npm warn`/`>`. In giallo le note sui comandi con effetti particolari.

### Fase di preparazione (prima del torneo)

```bash
# 1. Reset SOLO del DB torneo (il DB piattaforma NON è stato toccato:
#    Fulvio DG e Pippi erano già registrati dal test precedente)
rm -f data/uat-synthetic-pippo.db

# 2. Migrazione schema DB torneo (ricrea tabelle sul file nuovo)
ENV_FILE=.env.uat npm run cli -- db:migrate

# 3. Seed del calendario sintetico: 4 squadre, 6 giornate, kickoff
#    spaziati di 15 min, primo fischio a +45 min da adesso, seed 42
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic \
  --teams 4 --rounds 6 --spacing-min 15 --first-kickoff-offset-min 45 --seed 42

# 4. Registrazione del NUOVO giocatore sulla piattaforma
#    (fulviodegiovanni@gmail.com e sara.zizzari@gmail.com erano già attivi)
ENV_FILE=.env.uat npm run cli -- platform:register \
  --email "fulviodegiovanni@live.com" --name "Fulvio"
```

### Fase di gioco (in ordine cronologico)

```bash
# 5. Avvio torneo con AGGANCIO ASINCRONO al TC 3
#    → output: "Stagione avviata: TT1 = TC 3, 4 round inizializzati (confine girone 4)"
ENV_FILE=.env.uat npm run cli -- tournament:start --start-round 3

# 6. Apertura TC3 (TT1) — notifica i 3 registrati senza profilo (RF-P6)
ENV_FILE=.env.uat npm run cli -- round:open --round 3

# 7. Processazione delle 3 email di pick TC3 (Fulvio live, Fulvio DG, Pippi)
#    → 3× auto_joined (RF-P5: profilo+pick atomici)
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 8. Chiusura forzata TC3 (RF-29) — nessun eliminato (tutti hanno il pick)
ENV_FILE=.env.uat npm run cli -- round:close --round 3 \
  --force --reason "chiusura forzata per test UAT aggancio asincrono"

# 9. Contabilizzazione TC3 → scored (3/3 correct)
ENV_FILE=.env.uat npm run cli -- round:score --round 3

# 10. Apertura TC4 (TT2 = CONFINE GIRONE: reset pool squadre) — notifica i 3 profili
ENV_FILE=.env.uat npm run cli -- round:open --round 4

# 11. Processazione delle 3 email di pick TC4 → 3× pick_registered
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 12. Chiusura forzata TC4 + contabilizzazione
#     → eliminato: Fulvio live (wrong_pick)
ENV_FILE=.env.uat npm run cli -- round:close --round 4 \
  --force --reason "chiusura forzata per test UAT aggancio asincrono"
ENV_FILE=.env.uat npm run cli -- round:score --round 4

# 13. Apertura TC5 (TT3) — notifica i 2 profili attivi (l'eliminato non viene più contattato)
ENV_FILE=.env.uat npm run cli -- round:open --round 5

# 14. Processazione delle 2 email di pick TC5 → 2× pick_registered
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 15. Chiusura forzata TC5 + contabilizzazione → 2/2 correct
ENV_FILE=.env.uat npm run cli -- round:close --round 5 \
  --force --reason "chiusura forzata per test UAT aggancio asincrono"
ENV_FILE=.env.uat npm run cli -- round:score --round 5

# 16. Apertura TC6 (TT4, ultimo round) — notifica i 2 profili attivi
ENV_FILE=.env.uat npm run cli -- round:open --round 6

# 17. Prima processazione TC6: Fulvio pick_registered, Pippi pick_rejected
#     (team_already_used — aveva scelto "Vince bari", Bari bruciata per lei)
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 18. Seconda processazione TC6: "Catanzaro pareggia" → clarification
#     (unrecognized_format), nessun pick
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 19. Terza processazione TC6: "Vince cremonese" → pick_registered
ENV_FILE=.env.uat npm run cli -- channel:email:process

# 20. Chiusura forzata TC6 + contabilizzazione → 2/2 correct
#     → CHIUSURA AUTOMATICA del torneo (vittoria condivisa) + export
ENV_FILE=.env.uat npm run cli -- round:close --round 6 \
  --force --reason "chiusura forzata per test UAT aggancio asincrono"
ENV_FILE=.env.uat npm run cli -- round:score --round 6
```

### Comandi di sola verifica (eseguiti a margine)

```bash
# Verifica deadline/accettazione di un round
ENV_FILE=.env.uat npm run cli -- round:deadline --round 4

# Verifica stato dei round (usato dopo ogni passaggio)
ENV_FILE=.env.uat npm run cli -- round:status --round 3

# Query dirette sul DB (via sqlite3) per profilare pick/round/player:
#   sqlite3 data/uat-synthetic-pippo.db "SELECT ... FROM pick/round_state/..."
```

**Note importanti sui comandi:**
- `round:close` è stato sempre forzato (`--force --reason`) per comprimere i
  tempi: le deadline reali erano future (19:10Z–19:55Z), quindi la chiusura
  naturale sarebbe avvenuta molto più tardi.
- `channel:email:process` è stato lanciato più volte nello stesso round quando
  serviva ri-processare email arrivate dopo il primo batch (caso Pippi TC6).
- Nessun comando è stato eseguito in modalità `--json`; l'output `[TEST MODE]`
  è quello standard del CLI in test mode.

---

## 4. Stato finale del DB

### tournament_state

```
id=1, season_started=1, registration_open=0, start_round=3, registration_notified=0,
winner_notified=1, finished_at=2026-08-22T18:26:42.486Z,
export_path=data/exports/tournament-export-2026-08-22T18-26-42.486Z.json
```

### round_state

| round | status | deadline | opened_at | closed_at | scored_at | summary_sent |
|---|---|---|---|---|---|---|
| 3 | scored | 19:10:43.700Z | 17:59:17.991Z | 18:06:01.399Z | 18:06:05.103Z | 1 |
| 4 | scored | 19:25:43.700Z | 18:06:46.292Z | 18:11:20.142Z | 18:11:20.781Z | 1 |
| 5 | scored | 19:40:43.700Z | 18:11:49.240Z | 18:14:50.202Z | 18:14:50.739Z | 1 |
| 6 | scored | 19:55:43.700Z | 18:15:18.769Z | 18:26:41.930Z | 18:26:42.486Z | 1 |

### player

| id | email | name | register_id | created_at |
|---|---|---|---|---|
| 1 | fulviodegiovanni@live.com | Fulvio | 3 | 18:04:24.108Z |
| 2 | fulviodegiovanni@gmail.com | Fulvio De Giovanni | 1 | 18:04:24.108Z |
| 3 | sara.zizzari@gmail.com | Pippi | 2 | 18:04:24.108Z |

### profile

| id | player_id | register_id | eliminated | eliminated_at | eliminated_reason | created_at |
|---|---|---|---|---|---|---|
| 1 | 1 | 3 | **1** | 18:11:20.781Z | `wrong_pick` | 18:04:24.108Z |
| 2 | 2 | 1 | 0 | — | — | 18:04:24.108Z |
| 3 | 3 | 2 | 0 | — | — | 18:04:24.108Z |

### pick (TUTTI, ordinati per id)

| id | profile | round | team | outcome | status | created_at |
|---|---|---|---|---|---|---|
| 1 | 1 (Fulvio live) | 3 | US Catanzaro | win | correct | 18:04:24.108Z |
| 2 | 2 (Fulvio DG) | 3 | US Cremonese | win | correct | 18:04:24.108Z |
| 3 | 3 (Pippi) | 3 | US Catanzaro | win | correct | 18:04:24.108Z |
| 4 | 2 (Fulvio DG) | 4 | US Cremonese | win | correct | 18:10:46.170Z |
| 5 | 1 (Fulvio live) | 4 | US Catanzaro | win | **wrong** | 18:10:46.170Z |
| 6 | 3 (Pippi) | 4 | SSC Bari | win | correct | 18:10:46.170Z |
| 7 | 2 (Fulvio DG) | 5 | US Catanzaro | lose | correct | 18:14:23.575Z |
| 8 | 3 (Pippi) | 5 | US Catanzaro | lose | correct | 18:14:23.575Z |
| 9 | 2 (Fulvio DG) | 6 | SSC Bari | win | correct | 18:18:46.885Z |
| 10 | 3 (Pippi) | 6 | US Cremonese | win | correct | 18:25:52.378Z |

### Risultati partite (per TC, dal calendario sintetico)

| TC | Partita | Punteggio |
|---|---|---|
| 3 | SSC Bari - US Catanzaro | 0-3 |
| 3 | US Cremonese - Brescia Calcio | 3-1 |
| 4 | Brescia Calcio - SSC Bari | 0-2 |
| 4 | US Cremonese - US Catanzaro | 2-1 |
| 5 | US Catanzaro - Brescia Calcio | 0-1 |
| 5 | US Cremonese - SSC Bari | 2-2 |
| 6 | SSC Bari - US Catanzaro | 2-0 |
| 6 | US Cremonese - Brescia Calcio | 3-0 |

### Esito torneo

- **Vincitori (vittoria condivisa, caso 3)**: Fulvio De Giovanni (profile 2) e Pippi (profile 3) — 2 sopravvissuti all'ultimo TC scored
- Eliminato: Fulvio live (profile 1) per `wrong_pick` al TC4

---

## 5. Testo VERBATIM delle email dei giocatori

> Nota sui soggetti email: il sistema numerava i round come "Round N · Turno di
> campionato M" dove **N = TT** e **M = TC**. Quindi "Round 1 · Turno di
> campionato 3" = TC3/TT1, "Round 2 · Turno di campionato 4" = TC4/TT2, ecc.

### TC3 (TT1) — pick

**UID 285 — 18:00:30Z — da fulviodegiovanni@live.com**
- Subject: `R: Survivor League — Round 1 · Turno di campionato 3: Invia il tuo pick`
- Testo (verbatim, prima parte fino alla citazione della mail precedente):
  ```
  Vince catanzaro
  ```
- → **Registrato**: US Catanzaro win (pick id 1, `correct`)

**UID 286 — 18:02:13Z — da fulviodegiovanni@gmail.com**
- Subject: `Re: Survivor League — Round 1 · Turno di campionato 3: Invia il tuo pick`
- Testo (verbatim):
  ```
  vince cremonese
  ```
- → **Registrato**: US Cremonese win (pick id 2, `correct`)

**UID 287 — 18:03:06Z — da sara.zizzari@gmail.com**
- Subject: `Re: Survivor League — Round 1 · Turno di campionato 3: Invia il tuo pick`
- Testo (verbatim, corpo prima della firma):
  ```
  Vince catanzaro
  ```
- → **Registrato**: US Catanzaro win (pick id 3, `correct`)

### TC4 (TT2, confine girone) — pick

**UID 288 — 18:08:48Z — da fulviodegiovanni@gmail.com**
- Subject: `Re: Survivor League — Round 2 · Turno di campionato 4: Invia il tuo pick`
- Testo (verbatim):
  ```
  vince la cremonese
  ```
- → **Registrato**: US Cremonese win (pick id 4, `correct`)

**UID 289 — 18:09:31Z — da fulviodegiovanni@live.com**
- Subject: `R: Survivor League — Round 2 · Turno di campionato 4: Invia il tuo pick`
- Testo (verbatim, prima parte):
  ```
  Vince il caanzaro
  ```
  (typo: "caanzaro" con doppia "a")
- → **Registrato**: US Catanzaro win (pick id 5, `wrong` — Catanzaro ha perso 1-2)

**UID 290 — 18:10:28Z — da sara.zizzari@gmail.com**
- Subject: `Re: Survivor League — Round 2 · Turno di campionato 4: Invia il tuo pick`
- Testo (verbatim, corpo prima della firma):
  ```
  Vince il bari
  ```
- → **Registrato**: SSC Bari win (pick id 6, `correct`)

### TC5 (TT3) — pick

**UID 291 — 18:13:27Z — da fulviodegiovanni@gmail.com**
- Subject: `Re: Survivor League — Round 3 · Turno di campionato 5: Invia il tuo pick`
- Testo (verbatim):
  ```
  cremonese pareggia
  ```
- → **Registrato nel DB**: US Catanzaro lose (pick id 7, `correct`)
  - ⚠️ **COMMENTO DA ANALIZZARE #2**: l'utente sostiene che la mail diceva Cremonese, non Catanzaro
  - ⚠️ **COMMENTO DA ANALIZZARE #3**: Cremonese era tra le bruciate di Fulvio DG nel 2° girone

**UID 292 — 18:14:13Z — da sara.zizzari@gmail.com**
- Subject: `Re: Survivor League — Round 3 · Turno di campionato 5: Invia il tuo pick`
- Testo (verbatim, corpo prima della firma):
  ```
  Catanzaro perde
  ```
- → **Registrato**: US Catanzaro lose (pick id 8, `correct`)

### TC6 (TT4, ultimo round) — pick

**UID 293 — 18:17:46Z — da fulviodegiovanni@gmail.com**
- Subject: `Re: Survivor League — Round 4 · Turno di campionato 6: Invia il tuo pick`
- Testo (verbatim):
  ```
  catanzaro
  ```
- → **Registrato nel DB**: SSC Bari win (pick id 9, `correct`)
  - ⚠️ **COMMENTO DA ANALIZZARE #4**: inviato "catanzaro", il sistema ha risposto
    "pick registrato, Complimenti! La tua squadra, il **SSC Bari**..." — Bari ≠ Catanzaro

**UID 294 — 18:18:34Z — da sara.zizzari@gmail.com**
- Subject: `Re: Survivor League — Round 4 · Turno di campionato 6: Invia il tuo pick`
- Testo (verbatim, corpo prima della firma):
  ```
  Vince bari
  ```
- → **Rifiutato**: `pick_rejected (team_already_used)` — SSC Bari era bruciata per Pippi (usata al TC4, 2° girone). La mail di rifiuto del sistema (citata nella risposta successiva di Pippi) recitava:
  ```
  Ciao! Mi dispiace, ma la tua squadra SSC Bari è già stata usata in questo turno.
  ```
  ⚠️ Nota: la pick_instructions TC6 di Pippi (inclusa nella mail UID 294) elencava come bruciate "SSC Bari — Round 2" e "US Catanzaro — Round 3" (numerazione TT) e come disponibili "Brescia Calcio e US Cremonese".

**UID 295 — 18:22:56Z — da sara.zizzari@gmail.com** (risposta a "Pick non registrato")
- Subject: `Re: Survivor League — Round 4 · Turno di campionato 6: Pick non registrato`
- Testo (verbatim, corpo prima della firma):
  ```
  Catanzaro pareggia
  ```
- → **Processato come**: `clarification (unrecognized_format)` — nessun pick registrato/rifiutato con motivo specifico
  - ⚠️ **COMMENTO DA ANALIZZARE #5**: "catanzaro pareggia" non è stato compreso come pick (né come `team_already_used`, benché US Catanzaro fosse bruciata per Pippi nel 2° girone)

**UID 296 — 18:25:11Z — da sara.zizzari@gmail.com** (risposta a "Pick non registrato")
- Subject: `Re: Survivor League — Round 4 · Turno di campionato 6: Pick non registrato`
- Testo (verbatim, corpo prima della firma):
  ```
  Vince cremonese
  ```
- → **Registrato**: US Cremonese win (pick id 10, `correct`)

---

## 6. Commenti da analizzare (accumulati durante il test)

1. **Mail di apertura torneo non arrivata**: `tournament_open` non è arrivata a
   `fulviodegiovanni@live.com` (account registerID 3, registrato PRIMA di
   `tournament:start`). Verificare se il broadcast `tournament_open` esclude
   account senza profilo, o se il problema è altro (routing, spam, etc.).
   Riferimento: round-manager.ts `startTournament` → notifica `tournament_open`.

2. **TC5 — testo email ≠ pick registrato**: fulviodegiovanni@gmail.com ha
   inviato "cremonese pareggia" (UID 291) ma il DB registra **US Catanzaro lose**
   (pick id 7). Possibile errore di classificazione/parse LLM o di matching
   alias. Da confrontare con UID 292 (Pippi, "Catanzaro perde" → US Catanzaro lose).

3. **TC5 — squadra bruciata accettata**: secondo l'utente, la Cremonese era tra
   le squadre bruciate di Fulvio DG al TC5 (nel 2° girone aveva già usato
   US Cremonese al TC4). Il sistema ha contabilizzato il pick come `correct`
   senza `team_already_used`. NB: il DB dice che il pick registrato era
   US Catanzaro (non Cremonese), quindi il punto 3 è concatenato al punto 2:
   se il pick fosse stato Cremonese, il gate bruciate avrebbe dovuto rifiutarlo.

4. **TC6 — testo email ≠ pick registrato**: fulviodegiovanni@gmail.com ha
   inviato "catanzaro" (UID 293) ma il DB registra **SSC Bari win** (pick id 9)
   e la risposta del sistema diceva "Complimenti! La tua squadra, il SSC Bari".
   Bari ≠ Catanzaro. Possibile errore di classificazione/parse LLM.

5. **TC6 — "catanzaro pareggia" non compreso**: Pippi ha inviato "Catanzaro
   pareggia" (UID 295) in risposta al rifiuto `team_already_used`; il sistema
   ha risposto `clarification (unrecognized_format)` invece di riconoscere il
   pick e rispondere con un motivo specifico (es. di nuovo `team_already_used`,
   essendo US Catanzaro bruciata per Pippi nel 2° girone). Verificare se il
   parser LLM gestisce "pareggia" come esito draw (cfr. UID 291 "cremonese
   pareggia" che apparentemente è stato riconosciuto — anche se mappato male).

---

## 7. Piste tecniche di analisi (suggerite, da verificare)

- **LLM classifier/parser** (`src/llm/intent-classifier.ts`, `src/llm/parser.ts`,
  `src/llm/openai-client.ts`): verificare con `llm:classify`/`llm:parse` gli
  input verbatim dei punti 2/4/5 contro il modello `mistralai/mistral-nemo` e
  contro gli altri modelli della lista failover. Possibili cause: allucinazione
  di squadra, prompt ambiguo, aliases duplicati/incrociati nella risorsa
  sintetica (`src/llm/team-aliases-synthetic.md`), estrazione non deterministica.
- **Wiring email** (`src/channel/email-processor.ts`): la catena
  router→classificatore→autoJoin/registerPick usa il pick restituito dal
  classificatore; se il classificatore sbaglia squadra, il pick registrato è
  sbagliato. Verificare se esiste validazione di coerenza col testo originale.
- **Burn/availability** (`src/game/rules.ts` `isBurned`/`getAvailableTeams`,
  confine `halfWindow`): verificare il caso TC5 per il profilo 2 — nel 2° girone
  (TC4-6) le bruciate dovrebbero essere solo quelle usate dal TC4 in poi
  (US Cremonese al TC4); US Catanzaro al TC5 NON era bruciata per lui.
- **Mail tournament_open**: verificare il flusso di notifica all'avvio
  (round-manager/tournament) e i destinatari (solo profili? anche registrati
  senza profilo? account active?).

---

## 8. Riferimenti utili per la nuova sessione

- **Comandi per riprodurre i singoli punti** (su DB di prova separato):
  ```bash
  ENV_FILE=.env.uat npm run cli -- llm:parse --input "cremonese pareggia"
  ENV_FILE=.env.uat npm run cli -- llm:parse --input "catanzaro"
  ENV_FILE=.env.uat npm run cli -- llm:parse --input "Catanzaro pareggia"
  ENV_FILE=.env.uat npm run cli -- llm:classify --input "catanzaro"
  ```
- **DB attuale del test** (stato finale): `data/uat-synthetic-pippo.db`
- **DB piattaforma**: `data/uat-platform-pippo.db`
- **Export automatico**: `data/exports/tournament-export-2026-08-22T18-26-42.486Z.json`
- **Casella email**: survivorleague755@gmail.com (UID 285–296 = messaggi del test;
  fetch senza modifica dei flag)
- **Memoria di progetto**: 5 note salvate con `kilo_memory_save` (chiavi
  `uat_async_hookup_note_*`, `uat_async_comment_*`)
