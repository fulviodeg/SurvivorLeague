# Ricetta UAT — Run scheduler automatico (win_only + auto-pick + jolly)

> Ricetta replicabile del run UAT eseguito il **2026-08-31** (esito: torneo
> completato e **chiuso automaticamente al round 3**, vincitore
> `fulviodegiovanni@gmail.com`, export scritto). Il calendario è
> **deterministico** (`--seed 42`): stessi punteggi → stesse possibilità di pick →
> esito riproducibile.

---

## 1. Parametri di gioco (`.env.uat`)

| Parametro | Valore | Effetto |
|---|---|---|
| `TEST_MODE` | `true` | banner UAT, guardrail test mode |
| `TEST_OFFSET_DAYS` | `0` | clock reale |
| `TEST_REFRESH_ALLOWED` | `false` | niente refresh su calendario sintetico |
| `SCHEDULER_ENABLED` | `true` | modalità cron: il sistema gestisce i round da solo |
| `SCHEDULER_AUTO_SCORE` | `true` | i round chiusi vengono contabilizzati in automatico |
| `SCHEDULER_TICK_MIN` | `1` | tick ogni minuto (cron) |
| `WIN_ONLY` | `true` | pick = solo squadra vincente (ADR-016) |
| `AUTOPICK_ON_MISSING` | `true` | auto-pick al mancato invio (ADR-017) |
| `JOLLIES_PER_PLAYER` | `1` | 1 jolly per giocatore (ADR-018) |
| `AI_EMAIL_PARSER` | `false` | parser deterministico (formule univoche) |
| `AI_EMAIL_GENERATOR` | `false` | generatore deterministico (nessuna chiamata LLM) |
| `DEADLINE_ADVANCE_MIN` | `3` | deadline pick = fischio − 3 min |
| `MATCH_DURATION_MIN` | `2` | durata stimata partita |
| `TC_CLOSE_SKEW_MIN` | `1` | chiusura TC oltre la fine dell'ultima partita |
| `DB_PATH` | `./data/uat-synthetic-2026-08-31.db` | DB torneo (nuovo a ogni run) |
| `PLATFORM_DB_PATH` | `./data/uat-platform-2026-08-30.db` | DB piattaforma (persiste tra i tornei) |
| `LOG_FILE` | `./data/logs/survivor-uat-2026-08-30.log` | log pino degli eventi |

**Attenzione:** `WIN_ONLY`, `AUTOPICK_ON_MISSING` e `JOLLIES_PER_PLAYER` sono
**fissati nel DB a `tournament:start`** e coperti dalla guardia fatal: impostarli
PRIMA dell'avvio e non cambiarli a torneo aperto (una variazione abortisce il
processo).

---

## 2. Setup (una tantum)

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
ENV_FILE=.env.uat npm run cli -- db:migrate
ENV_FILE=.env.uat npm run cli -- platform:migrate
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 20 --rounds 8 --spacing-min 6 --first-kickoff-offset-min 8 --seed 42
ENV_FILE=.env.uat npm run cli -- tournament:start
```

- 20 squadre (tutta la Serie A), 8 giornate, 80 partite.
- Primo fischio = `now + 8 min`; ultimo fischio = `now + 50 min`.
- `tournament:start` auto-join: 3 profili (account piattaforma con flag ON),
  deadline TT1 = `now + 5 min`.
- Se riusi lo stesso `DB_PATH` di un run precedente: **cancella prima il `.db`**
  (reset a livello filesystem, `rm data/uat-synthetic-*.db`) oppure cambia nome.

---

## 3. Guida automatica (cron o loop)

Su un sistema con cron (due righe ogni minuto — `scheduler:tick` orchetra i round,
`channel:email:process` legge i pick):

```cron
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && ENV_FILE=.env.uat npm run cli -- scheduler:tick >> /var/log/survivor-uat.log 2>&1
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && ENV_FILE=.env.uat npm run cli -- channel:email:process >> /var/log/survivor-uat-mail.log 2>&1
```

In ambienti **senza cron** (es. questa macchina): simulare il cron con un loop in
background (avviarlo **dopo** `tournament:start`):

```bash
LOG=/tmp/kilo/uat-auto.log; : > "$LOG"; while true; do \
  echo "[$(date -u +%H:%M:%SZ)] scheduler:tick" >> "$LOG"; \
  ENV_FILE=.env.uat npm run cli -- scheduler:tick 2>&1 | grep -vE '^npm warn|^$|^> ' >> "$LOG"; \
  echo "[$(date -u +%H:%M:%SZ)] channel:email:process" >> "$LOG"; \
  ENV_FILE=.env.uat npm run cli -- channel:email:process 2>&1 | grep -vE '^npm warn|^$|^> |"component":"imap-connection"' >> "$LOG"; \
  sleep 60; done
```

Il **primo tick apre il round 1 subito** dopo `tournament:start` (TT1).

### 3.1 Esecuzione su VPS staging (ambiente deployato)

Lo **staging della VPS** è già un ambiente TEST MODE permanente: il suo `.env`
ha `TEST_MODE=true`, DB e log dedicati con nome `staging`, e il cron di sistema
ha le righe di staging del template versionato `scripts/cron/survivor.cron`
(2 righe al minuto — `scheduler:tick` + `channel:email:process`). Quindi qui
**niente `ENV_FILE`, niente loop locale**: la stessa ricetta si esegue con il
wrapper `sl` (vedi `scripts/sl.sh`), che seleziona l'ambiente e legge il suo
`.env` dalla cwd:

```bash
# Setup (una tantum; il deploy.sh di staging esegue già migrate + build)
sudo -u survivor /opt/survivor/sl.sh staging db:migrate
sudo -u survivor /opt/survivor/sl.sh staging platform:migrate
# Reset per un nuovo run: rimuovere i .db di staging e rieseguire seed + start
sudo -u survivor /opt/survivor/sl.sh staging data:seed-synthetic --teams 20 --rounds 8 --spacing-min 6 --first-kickoff-offset-min 8 --seed 42
sudo -u survivor /opt/survivor/sl.sh staging tournament:start
```

Righe cron equivalenti (già nel template, installato da `deploy.sh` — D15):

```cron
* * * * * cd /opt/survivor/staging && /usr/bin/node dist/index.js scheduler:tick >> /opt/survivor/staging/logs/cron.log 2>&1
* * * * * cd /opt/survivor/staging && /usr/bin/node dist/index.js channel:email:process >> /opt/survivor/staging/logs/cron-mail.log 2>&1
```

Comandi di verifica: `sudo -u survivor /opt/survivor/sl.sh staging tournament:status`,
`… staging data:calendar`, `… staging channel:email:fetch` (pre-flight casella:
output atteso `Nessuna email non letta in casella`).

---

## 4. Modello temporale (perché la finestra di pick è corta)

- Distanza tra i fischietti (spacing): **6 min**.
- Distanza tra le deadline: **6 min** (≈ "5–6 minuti tra un pick e l'altro").
- **Finestra utile per inviare il pick: ~3 min** (`spacing − advance`): il round
  N+1 apre solo quando il round N è `scored` (≈ al fischio di N).
- **I giocatori devono inviare SUBITO all'apertura del round.** Chi non invia in
  tempo riceve l'auto-pick (con `AUTOPICK_ON_MISSING=true`).

Timeline dal seed (offset 8′, advance 3′, spacing 6′):

| Round | Fischio | Deadline |
|---|---|---|
| 1 | +8′ | +5′ |
| 2 | +14′ | +11′ |
| 3 | +20′ | +17′ |
| 4 | +26′ | +23′ |
| 5 | +32′ | +29′ |
| 6 | +38′ | +35′ |
| 7 | +44′ | +41′ |
| 8 | +50′ | +47′ |

---

## 5. Risultati veri per round (seed 42) — per i suggerimenti pick

Formula pick in win_only: **squadra nuda** (es. `SSC Napoli`), opzionale keyword
`Jolly` (es. `FC Internazionale Milano Jolly`). Pareggio o sconfitta della squadra
scelta = pick sbagliato (il jolly salva SOLO dal pareggio).

### Round 1
- AC Milan 2-1 Venezia FC → **AC Milan**
- AC Monza 3-2 Udinese Calcio → **AC Monza**
- ACF Fiorentina 0-2 US Sassuolo Calcio → **US Sassuolo Calcio**
- AS Roma 1-2 US Lecce → **US Lecce**
- Atalanta BC 3-1 Torino FC → **Atalanta BC**
- Bologna FC 1909 0-3 SSC Napoli → **SSC Napoli**
- Cagliari Calcio 2-1 SS Lazio → **Cagliari Calcio**
- Como 1907 0-2 Parma Calcio 1913 → **Parma Calcio 1913**
- FC Internazionale Milano 2-2 Juventus FC → ⚖️ **pareggio**
- Frosinone Calcio 0-1 Genoa CFC → **Genoa CFC**

### Round 2
- AC Milan 3-0 Udinese Calcio → **AC Milan**
- AC Monza 1-0 US Lecce → **AC Monza**
- ACF Fiorentina 0-3 Torino FC → **Torino FC**
- AS Roma 2-0 SSC Napoli → **AS Roma**
- Atalanta BC 0-3 SS Lazio → **SS Lazio**
- Bologna FC 1909 1-3 Parma Calcio 1913 → **Parma Calcio 1913**
- Cagliari Calcio 1-1 Juventus FC → ⚖️ **pareggio**
- Como 1907 0-0 Genoa CFC → ⚖️ **pareggio**
- FC Internazionale Milano 2-2 Frosinone Calcio → ⚖️ **pareggio**
- Venezia FC 2-0 US Sassuolo Calcio → **Venezia FC**

### Round 3
- AC Milan 0-2 US Sassuolo Calcio → **US Sassuolo Calcio**
- AC Monza 2-0 SSC Napoli → **AC Monza**
- ACF Fiorentina 1-1 SS Lazio → ⚖️ **pareggio**
- AS Roma 0-2 Parma Calcio 1913 → **Parma Calcio 1913**
- Atalanta BC 2-2 Juventus FC → ⚖️ **pareggio**
- Bologna FC 1909 3-0 Genoa CFC → **Bologna FC 1909**
- Cagliari Calcio 3-1 Frosinone Calcio → **Cagliari Calcio**
- Como 1907 3-0 FC Internazionale Milano → **Como 1907**
- Udinese Calcio 0-1 US Lecce → **US Lecce**
- Venezia FC 2-3 Torino FC → **Torino FC**

### Round 4
- AC Milan 0-0 US Lecce → ⚖️ **pareggio**
- AC Monza 3-1 Parma Calcio 1913 → **AC Monza**
- ACF Fiorentina 2-0 Juventus FC → **ACF Fiorentina**
- AS Roma 2-3 Genoa CFC → **Genoa CFC**
- Atalanta BC 0-3 Frosinone Calcio → **Frosinone Calcio**
- Bologna FC 1909 2-3 FC Internazionale Milano → **FC Internazionale Milano**
- Cagliari Calcio 1-2 Como 1907 → **Como 1907**
- US Sassuolo Calcio 1-1 Torino FC → ⚖️ **pareggio**
- Udinese Calcio 2-3 SSC Napoli → **SSC Napoli**
- Venezia FC 0-2 SS Lazio → **SS Lazio**

### Round 5
- AC Milan 1-2 Torino FC → **Torino FC**
- AC Monza 1-2 Genoa CFC → **Genoa CFC**
- ACF Fiorentina 1-0 Frosinone Calcio → **ACF Fiorentina**
- AS Roma 2-1 FC Internazionale Milano → **AS Roma**
- Atalanta BC 3-3 Como 1907 → ⚖️ **pareggio**
- Bologna FC 1909 0-1 Cagliari Calcio → **Cagliari Calcio**
- US Lecce 1-2 SSC Napoli → **SSC Napoli**
- US Sassuolo Calcio 1-1 SS Lazio → ⚖️ **pareggio**
- Udinese Calcio 3-2 Parma Calcio 1913 → **Udinese Calcio**
- Venezia FC 3-3 Juventus FC → ⚖️ **pareggio**

### Round 6
- AC Milan 3-0 SSC Napoli → **AC Milan**
- AC Monza 2-3 FC Internazionale Milano → **FC Internazionale Milano**
- ACF Fiorentina 1-3 Como 1907 → **Como 1907**
- AS Roma 1-0 Cagliari Calcio → **AS Roma**
- Atalanta BC 3-1 Bologna FC 1909 → **Atalanta BC**
- Torino FC 3-0 SS Lazio → **Torino FC**
- US Lecce 2-2 Parma Calcio 1913 → ⚖️ **pareggio**
- US Sassuolo Calcio 0-1 Juventus FC → **Juventus FC**
- Udinese Calcio 0-2 Genoa CFC → **Genoa CFC**
- Venezia FC 1-0 Frosinone Calcio → **Venezia FC**

### Round 7
- AC Milan 0-2 SS Lazio → **SS Lazio**
- AC Monza 1-0 Cagliari Calcio → **AC Monza**
- ACF Fiorentina 0-3 Bologna FC 1909 → **Bologna FC 1909**
- AS Roma 2-3 Atalanta BC → **Atalanta BC**
- SSC Napoli 2-3 Parma Calcio 1913 → **Parma Calcio 1913**
- Torino FC 3-0 Juventus FC → **Torino FC**
- US Lecce 2-1 Genoa CFC → **US Lecce**
- US Sassuolo Calcio 0-0 Frosinone Calcio → ⚖️ **pareggio**
- Udinese Calcio 2-2 FC Internazionale Milano → ⚖️ **pareggio**
- Venezia FC 1-1 Como 1907 → ⚖️ **pareggio**

### Round 8
- AC Milan 0-0 Parma Calcio 1913 → ⚖️ **pareggio**
- AC Monza 0-1 Atalanta BC → **Atalanta BC**
- ACF Fiorentina 1-1 AS Roma → ⚖️ **pareggio**
- SS Lazio 2-1 Juventus FC → **SS Lazio**
- SSC Napoli 1-1 Genoa CFC → ⚖️ **pareggio**
- Torino FC 1-2 Frosinone Calcio → **Frosinone Calcio**
- US Lecce 1-1 FC Internazionale Milano → ⚖️ **pareggio**
- US Sassuolo Calcio 3-1 Como 1907 → **US Sassuolo Calcio**
- Udinese Calcio 1-2 Cagliari Calcio → **Cagliari Calcio**
- Venezia FC 2-2 Bologna FC 1909 → ⚖️ **pareggio**

---

## 6. Esito osservato del run (2026-08-31)

Giocatori: `fulviodegiovanni@gmail.com` (fulvio), `fulviodegiovanni@live.com`
(pippo), `sara.zizzari@gmail.com` (trinniti). Auto-join a `tournament:start`.

| Round | fulvio | pippo | trinniti |
|---|---|---|---|
| R1 | AC Milan ✅ | Cagliari Calcio ✅ | Atalanta BC 🤖 auto ✅ |
| R2 | Genoa CFC 🎯 Jolly → **salvato** ✅ | Venezia FC ✅ | Bologna FC 1909 🤖 auto ❌ eliminata |
| R3 | Parma Calcio 1913 ✅ | Atalanta BC 🤖 auto ❌ eliminato | — |

- **Chiusura automatica al round 3** (ADR-011, caso 1): unico sopravvissuto =
  fulvio. Export: `data/exports/tournament-export-*.json`.
- **Auto-pick dimostrato** (ADR-017): trinniti (R1, R2) e pippo (R3) — squadra
  auto-assegnata = prima disponibile per `short_name` (verifica: `rules:teams`).
- **Jolly dimostrato** (ADR-018): fulvio dichiara `Genoa CFC Jolly` in R2, il Genoa
  pareggia → salvo ("🎯 Il tuo jolly ti ha salvato"), jolly bruciato 1→0.
- Comportamenti di rifiuto osservati: pick duplicato → `team_already_used` (stessa
  squadra) / `pick_already_exists` (squadra diversa ma pick già presente); pick
  oltre la deadline → `after_acceptance`; email a torneo chiuso → `round_not_open`.

---

## 7. Verifica e monitoraggio

```bash
# Eventi round (LOG_FILE, pino, testMode: true)
tail -f data/logs/survivor-uat-2026-08-30.log

# Output dei tick e esiti pick (loop senza cron)
tail -f /tmp/kilo/uat-auto.log

# Stato e vincitore
ENV_FILE=.env.uat npm run cli -- scheduler:status
ENV_FILE=.env.uat npm run cli -- tournament:status
ENV_FILE=.env.uat npm run cli -- winner:check
ENV_FILE=.env.uat npm run cli -- round:status --round N
ENV_FILE=.env.uat npm run cli -- data:results --round N   # punteggi veri
ENV_FILE=.env.uat npm run cli -- rules:teams              # ordine auto-pick
```

---

## 8. Lezioni apprese

1. **La finestra utile è ~3 minuti**: i giocatori devono inviare il pick appena
   aperto il round. Due pick arrivati a ~30–60s dalla deadline sono stati rifiutati
   `after_acceptance` in un run precedente con lo stesso cadenza.
2. Con `AUTOPICK_ON_MISSING=true`, chi non invia (o invia tardi) **non** viene
   eliminato alla chiusura: riceve l'auto-pick (prima squadra disponibile per
   `short_name`, esclusa la bruciata). Un auto-pick su squadra che pareggia/perde
   elimina comunque allo scoring (l'auto-pick non usa il jolly).
3. Il **jolly salva SOLO dal pareggio** (win_only), è bruciato alla dichiarazione
   e non è rimborsabile. A `jollies_remaining=0` un pick con "jolly" è rifiutato.
4. L'**auto-chiusura** arriva appena resta un solo profilo attivo (caso 1) o tutti
   eliminati nella stessa ondata (caso 2): export automatico in
   `TOURNAMENT_EXPORT_DIR`, `scheduler:status` → "Prossime azioni: nessuna".
5. Senza cron il loop in background simula il cron: gli effetti sono identici,
   l'unica differenza è che il comando lo lancia un processo invece del demone.
6. `rules:teams` dopo il seed mostra l'ordine alfabetico (`short_name`) usato
   dall'auto-pick: utile per prevedere chi verrà assegnato a chi non invia.
