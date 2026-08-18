# LLD: Survivor League — Proof of Concept

> ⚠ **POC ONLY** — Questo documento descrive il sistema per la Proof of Concept. Non è il design del sistema di produzione.

**Stato:** Revisionato
**Data:** 2026-08-14
**Versione:** 0.4.0

> Documento di dettaglio implementativo. Per l'architettura di alto livello vedi [POC_HLD.md](POC_HLD.md); per i requisiti di prodotto vedi [POC_PRD.md](POC_PRD.md). Cross-riferimenti aggiornati alla numerazione del PRD v0.5.2 e dell'HLD v0.4.2.

**Changelog:**
- **0.4.0** (2026-08-14) — Allineamento all'aggancio asincrono del torneo (ADR-008, PRD v0.5.2): colonna `tournament_state.start_round INTEGER NULL` con strategia di migrazione **additiva** idempotente (`ALTER TABLE … ADD COLUMN` se manca — §3); nuovo vincolo applicativo di accettazione pick `min(deadline registrata, fischio d'inizio effettivo prima partita del TC)` (guard anti-frode, RF-31, §3.1); nota finestra `[start_round..N]` come filtro logico (§3.2); nuova interfaccia di **eligibilità** `checkEligibility(ExternalIdentity)` con implementazione POC vuota (ADR-008, §6.5); auto-iscrizione del mittente sconosciuto nel TT1 e iniezione deterministica della coppia TT/TC nei template (ADR-004, §1.1, §6.3); scheduler con chiusura di sicurezza allo scadere del TC se deadline NULL (log `safety_close`, §1.4); comandi CLI aggiornati (`tournament:start --start-round <n>`, `tournament:register --reason`, `pick:register --reason`, `tournament:register:close --reason`, `round:close --force --reason`, output con coppia TT/TC — §7.3, §7.10); casi di test §8 aggiornati.
- **0.3.0** (2026-08-13) — Allineamento alle decisioni del piano di implementazione: `SeasonDataProvider` con unica implementazione `DbSeasonDataProvider` (lettura da DB; rimosso il precedente provider basato su file JSON); client API football-data.org solo per i comandi `data:*`; contratto del Parser LLM con lista canonica squadre + `team-aliases.md` e check deterministico post-parse; `round:score` processa anche i pick `frozen`; scheduler tick con `data:refresh`; colonne `eliminated_at`/`eliminated_reason` su `profile`; regola operativa rinvii senza `rescheduled_date`; nuovo comando `tournament:export`; distinzione mock/UAT in test strategy.

---

## Indice

- [1. Dettaglio componenti](#1-dettaglio-componenti)
  - [1.1 Game Engine](#11-game-engine)
  - [1.2 LLM Adapter](#12-llm-adapter)
  - [1.3 Channel Adapter](#13-channel-adapter)
  - [1.4 Scheduler](#14-scheduler)
- [2. Stack tecnologico](#2-stack-tecnologico)
- [3. Modello dati](#3-modello-dati)
  - [3.1 Vincoli applicativi (non nel DB, gestiti dal Game Engine)](#31-vincoli-applicativi-non-nel-db-gestiti-dal-game-engine)
  - [3.2 Parametri data-driven](#32-parametri-data-driven)
- [4. Configurazione](#4-configurazione)
  - [4.1 Parametri di gioco](#41-parametri-di-gioco)
  - [4.2 Parametri infrastruttura](#42-parametri-infrastruttura)
  - [4.3 Parametri dati stagione](#43-parametri-dati-stagione)
  - [4.4 Parametri scheduler](#44-parametri-scheduler)
  - [4.5 Validazione](#45-validazione)
- [5. Struttura del progetto](#5-struttura-del-progetto)
- [6. Interfacce TypeScript](#6-interfacce-typescript)
  - [6.1 SeasonDataProvider](#61-seasondataprovider)
  - [6.2 LLM Parser](#62-llm-parser)
  - [6.3 LLM Generator](#63-llm-generator)
  - [6.4 ChannelAdapter](#64-channeladapter)
  - [6.5 Eligibilità (seam ADR-008)](#65-eligibilità-seam-adr-008)
- [7. Comandi CLI](#7-comandi-cli)
  - [7.1 Setup](#71-setup)
  - [7.2 Dati stagione](#72-dati-stagione)
  - [7.3 Game Engine — Round Manager](#73-game-engine--round-manager)
  - [7.4 Game Engine — Pick Processor](#74-game-engine--pick-processor)
  - [7.5 Game Engine — Rules Engine](#75-game-engine--rules-engine)
  - [7.6 Game Engine — Elimination Engine](#76-game-engine--elimination-engine)
  - [7.7 Game Engine — Winner Engine](#77-game-engine--winner-engine)
  - [7.8 LLM Adapter](#78-llm-adapter)
  - [7.9 Channel Adapter](#79-channel-adapter)
  - [7.10 Torneo (vista aggregata)](#710-torneo-vista-aggregata)
  - [7.11 Simulazione](#711-simulazione)
  - [7.12 Scheduler (solo produzione)](#712-scheduler-solo-produzione)
  - [7.13 Principi di design per i comandi](#713-principi-di-design-per-i-comandi)
- [8. Test strategy](#8-test-strategy)

---

## 1. Dettaglio componenti

### 1.1 Game Engine

| Modulo | Responsabilità |
|--------|---------------|
| **Round Manager** | Apre e chiude round, gestisce deadline, coordina l'invio delle email di pick, e implementa la **contabilizzazione incrementale** dei pick (`round:score`: processa i pick `pending`, aggiorna lo stato a `correct`/`wrong`/`frozen`, chiude il round a `scored` quando non restano pick `pending`; processa inoltre i pick `frozen` la cui partita ora ha punteggio, aggiornandoli a `correct`/`wrong` con eventuale eliminazione a posteriori). Gestisce inoltre: l'**auto-chiusura alla deadline** e alla deadline del TT1 anche della finestra di iscrizione (ADR-008); la **chiusura forzata** (`round:close --force --reason`, RF-29) e la **chiusura di sicurezza** allo scadere del TC quando la deadline è NULL/non innescata (RF-30, log `safety_close`) — tutte con **semantica di consolidamento identica** |
| **Pick Processor** | Valida un pick (profilo iscritto o auto-iscrizione nel TT1, squadra in giornata, già bruciata, esito valido, già inviato, entro l'**istante di accettazione** `min(deadline registrata, fischio d'inizio effettivo prima partita del TC)` — RF-31), registra il pick nel database |
| **Rules Engine** | Regole di gioco: squadre bruciate per girone, esiti validi, condizioni di vittoria |
| **Elimination Engine** | Determina quali profili sono eliminati (pick mancante, pick sbagliato) |
| **Winner Engine** | Determina se il torneo è finito e chi ha vinto (casi 1, 2, 3 del PRD §4.6), sulla finestra `[start_round..N]` |
| **Eligibility (seam)** | Gate pre-registrazione `checkEligibility(ExternalIdentity) → {eligible, reason?}` (ADR-008, §6.5): implementazione POC sempre `true` con log; Fase 1: controllo quota (`ENTRY_FEE_EUR`) |
| **Season Data Provider** | Interfaccia astratta per calendario e risultati. Unica implementazione nella POC: `DbSeasonDataProvider` (legge dalla tabella `match` del DB) |

**Derivazione squadre bruciate.** Non esiste una tabella separata: il Rules Engine deriva l'insieme delle squadre già usate da un profilo interrogando la tabella `pick` per i round del girone corrente. Per il girone di andata (TC 1-19 nella stagione completa), la query è `SELECT team FROM pick WHERE profile_id = ? AND round BETWEEN 1 AND 19`. Per il girone di ritorno (TC 20+ nella stagione completa), la query è `SELECT team FROM pick WHERE profile_id = ? AND round >= 20`. Il confine tra i due gironi è determinato dinamicamente dal numero totale di round diviso 2, non hardcodato. I pick in **Freeze** (PRD §5.4) contano come squadre bruciate: la query non filtra i pick in attesa di risultato. Il modello non prevede più l'annullamento del pick per rinvio, quindi la derivazione resta valida senza filtri aggiuntivi. **In un torneo agganciato** (ADR-008) le derivazioni operano **sull'intera stagione** (§3.2); il torneo gioca la finestra `[start_round..N]` come filtro logico: le query e i confini non cambiano.

### 1.2 LLM Adapter

| Modulo | Input | Output | Modello |
|--------|-------|--------|---------|
| **Parser** | Testo dell'email (italiano, forma libera) | `{ team: string, outcome: "win" \| "draw" \| "lose" } \| null` | Qualsiasi LLM API |
| **Generator** | Contesto strutturato (es. `{ type: "pick_confirmed", round, team, outcome }`) | Testo email in italiano | Qualsiasi LLM API |

**Contratto del Parser:**
- Il prompt include: il testo dell'email + la lista canonica delle squadre da `SeasonDataProvider.getTeams()` + il contenuto del file `src/llm/team-aliases.md` (alias noti, risorsa del prompt, non codice) — lista e alias **iniettati per chiamata** (`PickParseOptions`, §6.2, D2)
- L'LLM restituisce `team` come **esatto nome canonico** dalla lista (vincolato via JSON schema/enum se supportato dall'API); se ambiguo o non riconducibile, restituisce `null`
- Se l'email non contiene un pick riconoscibile, restituisce `null` (non lancia eccezioni per il contenuto; `LLMError` solo per trasporto/HTTP/timeout, D3)
- Il formato di output è validato dal **Parser con `zod`** (e filtrato con l'exact-match sulla lista) **e dal Game Engine con l'exact match** — doppia barriera (D2/C)
- **Check deterministico post-parse**: il Game Engine accetta solo exact-match sulla lista canonica; qualsiasi altro valore è trattato come `null` (rifiuto con richiesta di chiarimento al giocatore). L'LLM propone, il check dispone: nessun nome inventato entra nello stato di gioco
- L'LLM non ha accesso allo stato del torneo (non sa quali squadre sono bruciate, non decide se il pick è valido)

**Contratto del Generator:**
- Riceve un tipo di notifica e dati strutturati, restituisce solo testo
- Non accede al database, non prende decisioni
- Template di sistema per ogni tipo di email definiti staticamente
- **Coppia TT/TC iniettata (ADR-008, RF-25):** il Game Engine deriva `(tt, tc)` da `start_round` (§3.2) e la passa nel contesto (`EmailContext.tt`/`EmailContext.tc`, §6.3); il corpo email la mostra in forma estesa ("TT 2, TC 7"), oggetto/CLI in forma compatta (`TT2TC7`). **Il Generator non genera mai numeri di turno** e i template non contengono la coppia come testo statico: è sempre iniettata dal chiamante (ADR-004)

### 1.3 Channel Adapter

Il Game Engine non conosce i dettagli di trasporto. Dialoga con un'interfaccia astratta `ChannelAdapter` che espone due metodi: ricevere messaggi in ingresso e inviare messaggi in uscita.

| Modulo | Responsabilità |
|--------|---------------|
| **ChannelAdapter** (interfaccia) | Contratto astratto per qualsiasi canale di comunicazione: `fetchMessages()`, `sendMessage()` |
| **EmailAdapter** (implementazione) | Unica implementazione nella PoC. Al suo interno contiene: |
| &nbsp;&nbsp;├─ **IMAP Client** | Si connette alla casella Gmail, recupera le nuove email (`imapflow`). Popola `IncomingMessage.receivedAt` con l'`internaldate` del messaggio (arrivo in casella), non con l'header `Date` (PRD §5.3) |
| &nbsp;&nbsp;├─ **Message Router** | Classifica il messaggio in arrivo e **normalizza l'identità del mittente** in `ExternalIdentity { channel, identifier }` (ADR-008): per l'email `{channel: 'email', identifier: <indirizzo minuscolo, senza nome visualizzato>}` (D6/K). **Criterio deterministico (D6):** mittente **noto** → `pick`; mittente **ignoto** con keyword di iscrizione nel corpo (lista costante documentata: "iscriv", "mi iscrivo", "partecipo", "vorrei giocare", "registr") → `registration`; mittente ignoto senza keyword → `pick` (il wiring decide auto-iscrizione/chiarimento/rifiuto); corpo vuoto → `unknown`. **Il router NON decide nulla di gioco** (auto-iscrizione/rifiuti = Game Engine, PRD §4.1): produce `{ kind, identity, body }`, il wiring (6.2) decide. **"Round corrente" del wiring (D8):** il primo `round_state` con `status='open'` nella finestra `[start_round..N]` (stessa semantica di `tournament:status`); nessun round aperto → rifiuto `round_not_open` (CL3) |
| &nbsp;&nbsp;└─ **SMTP Client** | Invia email di risposta e notifica (`nodemailer`): `sendMail({from, to, subject, text})`, soggetto dal chiamante (D1) |

**Adapters futuri** (fuori scope PoC, da FUTURE_EXPLORATIONS.md punto 7):
- `WhatsAppAdapter` — invio/ricezione via WhatsApp Business API
- `TelegramAdapter` — invio/ricezione via Telegram Bot API
- `WebAdapter` — frontend web con API REST

### 1.4 Scheduler

| Modulo | Responsabilità |
|--------|---------------|
| **Scheduler** | **Orchestratore sottile**: in produzione, decide *quando* agire in base al calendario e allo stato dei round e della fase di iscrizione (apre/chiude la fase di iscrizione, apre round, chiude deadline, invoca la contabilizzazione). **Non contiene logica di gioco**: non confronta risultati, non valida pick, non tocca lo stato dei pick o delle iscrizioni. Invoca esclusivamente i comandi del Game Engine |
| **Cron Job** | Meccanismo di scheduling (cron del sistema operativo). Esegue il processo Node.js a intervalli regolari per verificare se ci sono azioni da compiere (aprire/chiudere la fase di iscrizione, aprire round, chiudere deadline, contabilizzare) |

**Funzionamento:**
- Il cron job esegue `npm run cli -- scheduler:tick` ogni minuto
- La **finestra di iscrizione** = `[apertura del torneo, deadline del TT 1]` (ADR-008, RF-22): si apre all'avvio del torneo e si **auto-chiude alla deadline del TT 1** (`tournament:register:close`, senza `--reason`); se la deadline del TT 1 non è registrata, si applica la **chiusura di sicurezza** della finestra alla chiusura del TC ricalcolata dai dati correnti (log `safety_close`, causa `deadline_missing`); se nemmeno questa è calcolabile → nessuna auto-chiusura, log `warn` + anomalia in `tournament:status` (uscita: chiusura forzata RF-28)
- Il comando `scheduler:tick` esegue prima `data:refresh` (aggiornamento dei dati stagione dall'API), poi controlla il calendario e lo stato corrente di ogni round (operando sulla finestra `[start_round..N]` in caso di aggancio, ADR-008):
  - Round `pending` al termine del TC precedente (o TT 1 all'apertura del torneo, RF-23) → `round:open`
  - Round `open` con deadline scaduta **e** deadline registrata → `round:close` (auto-chiusura a deadline)
  - Round `open` con **deadline NULL o mai innescata** e chiusura del TC raggiunta (fine prevista UPP + scarto, ricalcolata **dai dati correnti** al tick) → `round:close` come **chiusura di sicurezza**: stessa semantica di consolidamento, evento loggato `safety_close` con causa `deadline_missing` (RF-30). Se la chiusura del TC non è calcolabile → nessuna auto-chiusura, log `warn` (evento `warn_not_calculable`) + anomalia in `tournament:status` (uscita: `round:close --force --reason`, RF-29)
  - Round in stato `closed` e non `scored` → `round:score` (idempotente; il Round Manager processa solo i pick `pending`)
  - Round in stato `scored` con pick `frozen` (`SELECT DISTINCT round FROM pick WHERE status = 'frozen'`) → `round:score` (contabilizza a posteriori i pick `frozen` la cui partita ora ha punteggio)
- La contabilizzazione è **incrementale**: viene invocata ad ogni tick per i round chiusi, e il Round Manager contabilizza i pick man mano che il risultato della singola partita è disponibile (PRD §4.5). Il TC close **non è più un trigger dello scheduler**: è la finestra di riferimento (CL7/CL8) usata dal Round Manager
- I pick in Freeze non bloccano `round:score`: sono già in stato terminale `frozen` rispetto alla chiusura del round, e vengono contabilizzati quando la partita recuperata ha punteggio (PRD §5.4) — anche in round già `scored`
- Semantica stati: `closed` = chiusura della finestra di pick (deadline); `scored` = chiusura del TT, tutti i pick contabilizzati o freezati (PRD §4.5)
- Se non c'è nulla da fare, il comando esce senza effetti
- In sviluppo/test il Scheduler non è attivo: il commissioner usa i comandi CLI manualmente

---

## 2. Stack tecnologico

| Componente        | Scelta                      | Note                                    |
| ----------------- | --------------------------- | --------------------------------------- |
| Runtime           | Node.js ≥20 LTS             |                                         |
| Linguaggio        | TypeScript 5.x              | Strict mode                             |
| Package manager   | npm                         |                                         |
| Database          | SQLite via `better-sqlite3` | Zero setup, perfetto per PoC monoutente |
| Email (ricezione) | `imapflow`                  | IMAP client moderno, async/await |
| Email (invio)     | `nodemailer`                | SMTP client standard                    |
| Email (MIME)      | `mailparser`                | `simpleParser`: decodifica del corpo testuale dal sorgente grezzo di imapflow |
| LLM               | API OpenAI-compatibile      | Modello da configurare via env          |
| Validazione       | `zod`                       | Tutti i dati esterni validati           |
| CLI               | `yargs`                     | Comandi e sottocomandi                  |
| Logging           | `pino`                      | JSON strutturato                        |
| Testing           | `vitest`                    |                                         |
| Lint/format       | `eslint` + `prettier`       |                                         |
| Type check        | `tsc --noEmit`              |                                         |

---

## 3. Modello dati

> **Nota `created_at` (Decisione A del briefing Fase 7, RNF1):** i default
> `datetime('now')` di SQLite (orologio reale) sono il fallback di schema; le
> scritture applicative scrivono SEMPRE `created_at` esplicito dal clock
> iniettato (`ctx.now` — registrazione, auto-iscrizione e pick): due run della
> stessa simulazione con stessa seed producono export identici anche sulle
> righe `created_at`.

```sql
-- Giocatore (persona reale)
CREATE TABLE player (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Profilo (iscrizione al torneo)
-- Nella PoC: 1 profilo per giocatore
CREATE TABLE profile (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         INTEGER NOT NULL UNIQUE REFERENCES player(id),
  eliminated        INTEGER NOT NULL DEFAULT 0,
  eliminated_at     TEXT,  -- timestamp dell'eliminazione (ISO 8601), NULL se in gara
  eliminated_reason TEXT CHECK (eliminated_reason IN ('missing_pick', 'wrong_pick')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- eliminated_at / eliminated_reason sono esposte da `elimination:list` (§7.6)

-- Pick registrato
CREATE TABLE pick (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profile(id),
  round      INTEGER NOT NULL,
  team       TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'lose')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'frozen', 'correct', 'wrong')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, round)
);

-- Dati stagione (calendario + risultati Serie A)
CREATE TABLE match (
  round      INTEGER NOT NULL,
  match_date TEXT NOT NULL,
  home_team  TEXT NOT NULL,
  away_team  TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  postponed  INTEGER NOT NULL DEFAULT 0,  -- rinviata (nella POC include le sospese: PRD §5.4)
  PRIMARY KEY (round, home_team, away_team)
);

-- Stato round
CREATE TABLE round_state (
  round      INTEGER PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'scored')),
  deadline   TEXT,
  opened_at  TEXT,
  closed_at  TEXT,
  scored_at  TEXT
);

-- Stato del torneo (riga singola nell'istanza: PoC monoutente)
-- Gestisce la finestra di iscrizione (PRD §4.1, US7/US8), l'avvio della stagione (US6)
-- e l'aggancio del torneo a un TC arbitrario (ADR-008, RF-20)
CREATE TABLE tournament_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  season_started    INTEGER NOT NULL DEFAULT 0,  -- stagione avviata (operazioni preliminari concluse, US6)
  registration_open INTEGER NOT NULL DEFAULT 0,  -- finestra di iscrizione aperta: si accettano iscrizioni automatiche;
                                                 -- si chiude da sola alla deadline del TT1 (RF-22) o per chiusura forzata (RF-28)
  start_round       INTEGER                      -- TC di aggancio del torneo (NULL = comportamento legacy: TC 1, ADR-008);
                                                 -- da esso si deriva TT = TC - start_round + 1 (RF-20, RF-25)
);
```

### 3.1 Vincoli applicativi (non nel DB, gestiti dal Game Engine)

- Una squadra non può essere usata due volte nello stesso girone (andata: round 1-`N/2`, ritorno: round `N/2+1`-`N`, dove N = numero totale di round derivato dai dati)
- Il girone di ritorno azzera il pool: le squadre usate in andata non contano per il ritorno
- **Accettazione del pick = `min(deadline registrata, fischio d'inizio effettivo della prima partita del TC)`** (guard anti-frode, RF-31): un pick è rifiutato se `receivedAt` supera **entrambe** le soglie. Il confronto usa `receivedAt` (ricezione sul server; per l'email l'`internaldate` IMAP, arrivo in casella), non l'header `Date` dell'email (PRD §5.3). Con la deadline nominale è ridondante; morde quando la deadline è NULL/errata o quando il calendario anticipa una partita dopo l'apertura (CL17, CL18). Il kickoff effettivo è letto dai dati correnti al momento della valutazione
- Un profilo eliminato non può ricevere email di pick né inviare pick
- Partita rinviata o sospesa (`postponed = 1`; nella POC le partite sospese sono trattate come rinviate, PRD §5.4): recupero entro la finestra del TC → pick contabilizzato quando il risultato del recupero è disponibile (CL7); recupero fuori finestra → pick in Freeze (`status = 'frozen'`, squadra bruciata, contabilizzazione a partita conclusa). Nessun annullamento (PRD §5.4)
- **Regola operativa POC sui rinvii**: non esiste una colonna `rescheduled_date` su `match`. La regola è interamente data-driven: punteggio presente → contabilizza; `postponed = 1` senza punteggio → `frozen`; altrimenti il pick resta `pending`. Il recupero giocato **emerge dai dati**: quando la partita rinviata viene giocata, appare nel DB con il punteggio e viene contabilizzata al `round:score` successivo
- La chiusura del TC è determinata dalla fine prevista dell'ultima partita programmata + scarto configurabile (PRD §5.4); definisce la finestra del TC ed è usata dal Round Manager per le decisioni sui rinvii (CL7/CL8/CL1), **non** come trigger della contabilizzazione
- Lo stato del pick è esplicito: `status` enum `pending | frozen | correct | wrong`. `pending` = in attesa del risultato; `frozen` = partita rinviata fuori finestra (terminale per la chiusura del round, contabilizzato a recupero concluso); `correct`/`wrong` = contabilizzato. Il Freeze è quindi rappresentato da `status = 'frozen'` (non da `result = NULL`); `rescheduled_date`/`end_time` su `match` sono rimandati a Fase 1 (PRD §5.4, HIGH-03)
- Vincolo di iscrizione: un profilo deve risultare iscritto al momento dell'invio del pick e comunque entro la deadline del TT. La **finestra di iscrizione** è l'intervallo `[apertura del torneo, deadline del TT 1]` (`tournament_state.registration_open = 1`, RF-22): le iscrizioni automatiche sono ammesse solo entro la finestra e si chiudono da sole alla deadline del TT 1 (RF-13); prima dell'apertura e dopo la chiusura l'email di iscrizione è rifiutata, e l'unico ingresso ammesso è l'iscrizione manuale del commissioner (`tournament:register --reason <motivo>`, obbligatorio e auditato — PRD US8/US10/CL2, ADR-008). Durante la finestra, un pick da mittente sconosciuto produce l'**auto-iscrizione** (RF-27, §1.1); dal TT 2 il pick da sconosciuto è respinto senza registrazione (RF-24)
- **Gate di eligibilità**: prima di ogni registrazione (automatica, auto-iscrizione o manuale) il Game Engine valuta `checkEligibility(ExternalIdentity)` (§6.5, ADR-008): implementazione POC sempre `eligible = true` con log; gli override del commissioner passano per la stessa funzione con esito forzabile + motivo

### 3.2 Parametri data-driven

I seguenti valori sono derivati dai dati della stagione, non hardcodati:

| Parametro | Fonte | Uso |
|-----------|-------|-----|
| Numero totale di round | `SELECT MAX(round) FROM match` | Vincolo di fine torneo, confine girone |
| Squadre partecipanti | `SELECT DISTINCT home_team FROM match` | Validazione pick, pool disponibili |
| Confine andata/ritorno | `Math.ceil(numeroRound / 2)` | Azzeramento squadre bruciate |
| Orario prima partita del round | `SELECT MIN(match_date) FROM match WHERE round = ?` | Calcolo deadline (apertura) e **kickoff effettivo** (guard anti-frode RF-31) |
| TC di aggancio del torneo | `SELECT start_round FROM tournament_state WHERE id = 1` (NULL = TC 1) | Mappatura `TT = TC − start_round + 1` (RF-20); finestra torneo `[start_round..N]` (RF-26) |

**Nota aggancio (ADR-008).** Tutte le derivazioni operano **sull'intera stagione** importata; in un torneo agganciato la finestra `[start_round..N]` è un **filtro logico**, non un dominio dati: import, numero TC, squadre, confine gironi, deadline e kickoff effettivi restano calcolati sulla stagione completa. La mappatura TT↔TC è sempre derivata da `start_round`, mai persistita su `pick`/`round_state` (RF-25).

---

## 4. Configurazione

Tutti i parametri modificabili vivono in variabili d'ambiente, validate con `zod` all'avvio. Nessun valore è hardcodato nel sorgente.

### 4.1 Parametri di gioco

| Parametro | Env var | Default | Note |
|-----------|---------|---------|------|
| Deadline anticipo (minuti) | `DEADLINE_ADVANCE_MIN` | `30` | PRD §5.3, BRIEF §3.7. Anticipo sul fischio d'inizio della prima partita del TC; la deadline chiude la finestra di pick del TT |
| Scarto chiusura TC (minuti) | `TC_CLOSE_SKEW_MIN` | `300` | PRD §5.4. Chiusura TC = fine prevista UPP + scarto; usato dal life-cycle automatico e dalla simulazione |
| Durata stimata partita (minuti) | `MATCH_DURATION_MIN` | `125` | PRD §5.4. Per calcolare la fine prevista di una partita |
| Numero massimo profili per giocatore | `MAX_PROFILES_PER_PLAYER` | `1` | PoC: 1. Futuro: aumentabile (BRIEF §3.3) |
| Quota iscrizione (EUR) | `ENTRY_FEE_EUR` | `5` | BRIEF §3.6. Placeholder per la Fase 1: pagamenti e montepremi sono fuori scope nella POC (PRD §10, BRIEF §7.2). Non usato nella POC |
| Ripartizione vincitore (%) | `WINNER_SHARE_PCT` | `85` | BRIEF §3.9. Placeholder per la Fase 1: payout fuori scope nella POC (PRD §10, BRIEF §7.2). Non usato nella POC |

### 4.2 Parametri infrastruttura

| Parametro | Env var | Default | Note |
|-----------|---------|---------|------|
| IMAP host | `IMAP_HOST` | `imap.gmail.com` | |
| IMAP port | `IMAP_PORT` | `993` | |
| IMAP user | `IMAP_USER` | — | Richiesto |
| IMAP password | `IMAP_PASS` | — | Richiesto (App Password Gmail) |
| SMTP host | `SMTP_HOST` | `smtp.gmail.com` | |
| SMTP port | `SMTP_PORT` | `587` | |
| SMTP user | `SMTP_USER` | — | Richiesto |
| SMTP password | `SMTP_PASS` | — | Richiesto (App Password Gmail) |
| LLM API key | `LLM_API_KEY` | — | Richiesto |
| LLM API base URL | `LLM_API_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatibile |
| LLM model | `LLM_MODEL` | `gpt-4o-mini` | Lista separata da virgola, in ordine di priorità (failover client-side: il primo è il primario, i successivi sono fallback). Il failover scatta SOLO su errore di trasporto/HTTP (`LLMError`), MAI su `null` (D3: per il Parser `null` è una risposta valida = pick ambiguo, e non deve cambiare modello) |
| LLM timeout (ms) | `LLM_TIMEOUT_MS` | `15000` | Timeout di una singola richiesta LLM. Abbassarlo rende il failover più rapido ma scarta risposte lente (tier free); worst case latenza per messaggio: Σ modelli × tentativi × timeout ≈ 135 s con 3×3×15 s (i fallimenti reali 429/5xx sono però immediati) |
| LLM retries | `LLM_RETRIES` | `3` | Tentativi TOTALI per modello (1 richiesta + N-1 ritentativi) su errori ritentabili (429, 5xx, timeout, rete, body malformato), con ~1 s di pausa tra i tentativi; `1` = nessun ritentativo. I 4xx deterministici (400/401/403/404) non vengono ritentati: failover diretto al modello successivo |
| Database path | `DB_PATH` | `./data/survivor.db` | |
| Log level | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| IMAP polling interval (ms) | `IMAP_POLL_MS` | `60000` | 1 minuto |

### 4.3 Parametri dati stagione

| Parametro | Env var | Default | Note |
|-----------|---------|---------|------|
| Token API football-data.org | `FOOTBALL_DATA_TOKEN` | — | Richiesto; fornito dal PO al momento dell'uso |
| Base URL API football-data.org | `FOOTBALL_DATA_BASE_URL` | `https://api.football-data.org` | |
| Competizione | `FOOTBALL_DATA_COMPETITION` | `SA` | Serie A |
| Stagione | `FOOTBALL_DATA_SEASON` | `2025` | Stagione 2025/26 |

### 4.4 Parametri scheduler

| Parametro | Env var | Default | Note |
|-----------|---------|---------|------|
| Modalità scheduler | `SCHEDULER_ENABLED` | `false` | `true` = cron attivo (produzione), `false` = solo CLI (sviluppo/test) |
| Intervallo tick (minuti) | `SCHEDULER_TICK_MIN` | `1` | Ogni quanto il cron esegue `scheduler:tick` |
| Auto-score abilitato | `SCHEDULER_AUTO_SCORE` | `true` | Se `true`, lo scheduler invoca `round:score` (contabilizzazione incrementale) per i round chiusi non ancora scored |

### 4.5 Validazione

`config.ts` carica tutte le variabili, applica i default e valida con `zod`. Se una variabile richiesta manca o ha un formato errato, il sistema si rifiuta di avviarsi con un messaggio esplicito.

**Loader (test mode UAT, piano §0.2).** Il file env viene caricato con `process.loadEnvFile(process.env.ENV_FILE ?? '.env')` (Node ≥ 20.12, dichiarato in `engines`). `ENV_FILE` seleziona un file alternativo (es. `.env.uat`) senza toccare il default `.env`. Due regole:

- **Semantica no-override.** `process.loadEnvFile` NON sovrascrive le variabili già presenti in `process.env` (equivalente a `dotenv` senza `override`): un override inline `VAR=x npm run cli -- ...` è letto prima del file e vince sul file. Per scenari riproducibili/auditabili si usano file env dedicati (`.env.uat`, `.env.uat-replay`), non override inline.
- **Errore esplicito.** Se `ENV_FILE` è impostato ma il path non esiste, l'avvio fallisce con `ConfigError` che nomina il path; il caso "nessun `.env`" (default) resta silenzioso, perché le variabili possono arrivare dall'ambiente del cron.

**Parametri test mode (§0.1/D9) e gating a consumo (§0.3).**

| Env var | Tipo | Default | Note |
|---------|------|---------|------|
| `TEST_MODE` | bool | `false` | Attiva il test mode: banner "TEST MODE" su email inviate/CLI/log, campo `testMode` negli output `--json`, risorsa alias sintetica nel Parser. MAI in produzione |
| `TEST_OFFSET_DAYS` | intero ≥ 0 | `0` | Offset orario UNIFICATO in giorni applicato sia al clock (`makeNow`) sia al `receivedAt` delle email; `0` = disattivato. Test-only |
| `TEST_REFRESH_ALLOWED` | bool | `false` | Se `true` in test mode consente import/refresh reali (con WARN di consenso a ogni operazione); default = bloccati. Test-only |

I parametri test-only (`TEST_OFFSET_DAYS`, `TEST_REFRESH_ALLOWED`) sono **sempre** parsati dallo schema (con default `0`/`false`), ma il loro **effetto** è gated **a consumo**: i consumer (`makeNow`, guardia refresh, banner) leggono `config.testMode` e applicano l'offset/l'azione solo quando `TEST_MODE=true`. Con `TEST_MODE=false` il comportamento è identico al passato anche se i parametri sono presenti nell'ambiente (es. copiati per sbaglio); un parametro test-only malformato è ricondotto al default senza errore. La configurazione validata espone il campo derivato `testMode` (equivalente a `TEST_MODE`).

**Import/refresh bloccati in test mode (Task 4).** Quando `TEST_MODE=true` e `TEST_REFRESH_ALLOWED=false` (default), `data:import`, `data:refresh` e il refresh dello scheduler NON chiamano l'API e non toccano la tabella `match`: output esplicito e log pino dello skip (in inglese). Con `TEST_REFRESH_ALLOWED=true` import/refresh eseguono normalmente con log WARN di consenso a ogni operazione (incluso `DB_PATH`). Con `TEST_MODE=false` `TEST_REFRESH_ALLOWED` è ignorato: import/refresh reali. La guardia vive nei comandi CLI (niente `getConfig()` nei moduli di gioco: `importMatches` resta pura).

**Mai `ENV_FILE`/`TEST_MODE` in produzione.** Il selettore `ENV_FILE` e il parametro `TEST_MODE` sono strumenti del test mode UAT e NON vanno MAI usati nell'ambiente di produzione (D4: la sola segnalazione visibile — banner email/CLI/log — è il guardrail scelto per la POC privata).

---

## 5. Struttura del progetto

La radice `survivor-league/` dell'albero corrisponde alla **root del repository**: il codice vive nella root del repo, non in una sottodirectory.

```
survivor-league/
├── src/
│   ├── index.ts                  # Entry point CLI
│   ├── config.ts                 # Config da env, validata con zod
│   ├── db/
│   │   ├── connection.ts         # better-sqlite3 connection
│   │   ├── schema.ts             # DDL e migrazioni
│   │   └── seed.ts               # Popolamento dati test
│   ├── game/
│   │   ├── round-manager.ts      # Apertura/chiusura round
│   │   ├── pick-processor.ts     # Validazione e registrazione pick
│   │   ├── rules.ts              # Regole (squadre bruciate, gironi)
│   │   ├── elimination.ts        # Logica eliminazione
│   │   ├── winner.ts             # Determinazione vincitore
│   │   ├── eligibility.ts        # Seam checkEligibility(ExternalIdentity) (ADR-008, §6.5)
│   │   ├── simulation.ts         # Simulazione seeded full/round (Task 7.1: mulberry32, clock derivato dai dati)
│   │   └── scheduler.ts          # Automazione round via cron (solo produzione; Task 7.2)
│   ├── channel/
│   │   ├── adapter.ts            # Interfaccia ChannelAdapter
│   │   ├── email-adapter/
│   │   │   ├── index.ts          # EmailAdapter: implementazione concreta (fetch+send)
│   │   │   ├── imap-client.ts    # Ricezione email (imapflow) — seam: conn passata dal chiamante
│   │   │   ├── message-router.ts # Classificazione messaggi in arrivo + normalizzazione identità (D6/K)
│   │   │   └── smtp-client.ts    # Invio email (nodemailer) — seam: transport passato dal chiamante
│   │   └── email-processor.ts    # Wiring channel:email:process (Task 6.2): fetch → router →
│   │                             # iscrizione/pick con Parser LLM + moduli di gioco; flag \Seen a successo (D7)
│   ├── llm/
│   │   ├── parser.ts             # LLM: email → {team, outcome} (interfaccia + impl OpenAI)
│   │   ├── generator.ts          # LLM: contesto → testo email (interfaccia + impl OpenAI + subjectFor)
│   │   ├── templates.ts          # Template statici per il LLM Generator (segnaposto {{TT_TC}}, D4)
│   │   ├── openai-client.ts      # Client HTTP condiviso Parser/Generator (chat/completions) + LLMError (D3)
│   │   └── team-aliases.md       # Alias noti delle squadre (risorsa del prompt del Parser, editabile a mano)
│   ├── data/
│   │   ├── provider.ts           # Interfaccia SeasonDataProvider
│   │   ├── db-provider.ts        # DbSeasonDataProvider: unica implementazione, legge dalla tabella match
│   │   └── football-data-client.ts # Client API football-data.org (usato solo dai comandi data:*)
│   └── cli/
│       ├── index.ts              # Registrazione comandi
│       ├── email-wiring.ts       # Helper condiviso: costruisce EmailAdapter+LLMGenerator+Parser reali
│       │                         # dai config e li inietta nel GameContext (briefing Fase 5-6, problema M)
│       ├── commands/
│       │   ├── round.ts          # round:open, round:close, round:score, round:status, round:deadline
│       │   ├── pick.ts           # pick:validate, pick:register, pick:list
│       │   ├── rules.ts          # rules:burned-teams, rules:available-teams, rules:check-half
│       │   ├── elimination.ts    # elimination:check, elimination:list
│       │   ├── winner.ts         # winner:check
│       │   ├── llm.ts            # llm:parse, llm:generate
│       │   ├── channel.ts        # channel:email:fetch, channel:email:process, channel:email:send
│       │   ├── tournament.ts     # tournament:start [--start-round], tournament:status, tournament:history, tournament:leaderboard, tournament:register [--reason], tournament:register:open/close [--reason], tournament:export
│       │   ├── data.ts           # data:import, data:refresh, data:calendar, data:results
│       │   ├── scheduler.ts      # scheduler:tick, scheduler:status
│       │   └── simulate.ts       # simulate:full, simulate:round
│       └── print.ts              # Formattazione output
├── tests/
│   ├── unit/
│   │   └── game/                 # Test regole, pick, eliminazioni, vincitori
│   └── integration/
│       ├── round-flow.test.ts    # Flusso completo round
│       └── season-sim.test.ts    # Simulazione intera stagione
├── docs/
│   ├── POC_PRD.md                # Product Requirements Document
│   ├── POC_HLD.md                # Design di alto livello
│   └── POC_LLD.md                # Questo documento
├── agent-skills/                 # Skill condivise (skills/, references/, LICENSE)
├── AGENTS.md
├── kilo.json                     # Config Kilo: skills.paths -> ./agent-skills/skills
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
└── .gitignore
```

**Nota asset `.md` (briefing Fase 5-6, problema E):** `src/llm/team-aliases.md` è una risorsa del prompt letta via `new URL('./team-aliases.md', import.meta.url)` (indipendente dal cwd); il build `tsc` non copia asset `.md` nel dist → nella POC si gira via `tsx` dalla root (script `npm run cli`), quindi il file resta raggiungibile. Se in futuro si builda con `tsc` + `dist/`, l'asset va copiato esplicitamente.

---

## 6. Interfacce TypeScript

### 6.1 SeasonDataProvider

```typescript
interface Match {
  round: number;
  matchDate: Date;
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
  postponed: boolean; // rinviata; nella POC include le partite sospese (trattate come rinviate, PRD §5.4)
}

interface SeasonDataProvider {
  getCalendar(): Promise<Match[]>;
  getMatchesForRound(round: number): Promise<Match[]>;
  getFirstMatchDateTime(round: number): Promise<Date>;
  getTeams(): Promise<string[]>;
  getTotalRounds(): Promise<number>;
}
```

**Convenzioni di dominio (fissate in Fase 2, briefing §1-B/2.1-4):**
- `round` è il Turno di campionato (TC): l'API v4 espone **`matchday`**, non `round` — la mappatura `matchday → round` avviene nel client (Task 2.1);
- `matchDate` (colonna `match_date`) è **canonica ISO-8601 UTC con suffisso `Z`** (`toISOString()`): `data:import` la scrive così (Task 2.3) e `DbSeasonDataProvider` la parsa così — in questo modo `MIN(match_date)` (deadline RF-14 e kickoff effettivo RF-31) e gli ordinamenti lessicografici di SQLite sono indipendenti dal fuso orario;
- i nomi squadra sono i **`name` dell'API** (non `shortName`/`tla`): il nome canonico stabile tra import, `getTeams()` e `team-aliases.md` (Task 2.4);
- `getResults(round)` è stato **rimosso dall'interfaccia** (Fase 2): era ridondante rispetto a `getMatchesForRound(round)` (entrambe filtravano per round ed esponevano punteggi/postponed) e nessun consumatore la usava. Il Round Manager e il comando `data:results` usano `getMatchesForRound`.

**Implementazioni:**
- `DbSeasonDataProvider` — **unica implementazione nella POC**: legge esclusivamente dalla tabella `match` del DB. Il Game Engine usa solo questa e non accede mai all'API esterna
- Il client API `FootballDataClient` (verso football-data.org) è usato **solo** dai comandi `data:*` (`data:import`, `data:refresh`) per popolare/aggiornare il DB
- `ApiProvider` — eventuale evoluzione futura (fuori scope POC)

**Documentazione del provider dati (football-data.org):**
- Overview e API reference: https://docs.football-data.org/general/v4/index.html
- Response headers (throttling): https://docs.football-data.org/general/v4/lookup_tables.html#_response_headers
- Quickstart: https://www.football-data.org/documentation/quickstart/

Autenticazione via header HTTP `X-Auth-Token`; il client deve rispettare gli header di throttling della risposta per evitare il rate limiter.

**Nota (CRITICAL-02).** Il provider **non espone** un metodo di completezza (es. `areAllResultsFinal`): **non serve**. Con la contabilizzazione incrementale (PRD §4.5) il Round Manager processa i pick `pending` e usa `getMatchesForRound(round)`, che espone `homeScore?`/`awayScore?`/`postponed` per ogni match: un match con punteggio è concluso (→ contabilizza), `postponed = 1` senza punteggio è un rinvio (→ Freeze) e un match senza punteggio né rinvio è ancora in corso (→ resta `pending`). Questo distingue "risultato non disponibile" da "rinviata/sospesa" senza sapere se *tutti* i risultati del round sono pronti.

**Semantica di `getFirstMatchDateTime(round)` per i rinvii (RF-31, fissata in Fase 2).** Il kickoff "effettivo" del guard anti-frode vale `MIN(match_date)` **tra i match NON rinviati** del round: una partita rinviata non ha un fischio effettivo noto a priori. Se TUTTE le partite del round sono rinviate il kickoff effettivo non è calcolabile dai dati: il provider restituisce il `MIN(match_date)` programmato dell'intero round (valore di fallback documentato, che il guard usa comunque; il caso "non calcolabile" è coperto dalla chiusura di sicurezza RF-30/CL17). Un round senza partite in calendario lancia `SeasonDataError`.

### 6.2 LLM Parser

```typescript
// Definito UNA volta in src/llm/parser.ts e riusato da game/registration.ts
// (auto-iscrizione RF-27; re-export come ParsedPickContent per compatibilità).
interface PickExtraction {
  team: string;
  outcome: "win" | "draw" | "lose";
}

// Lista canonica e alias INIETTATI PER CHIAMATA (D2): l'import stagionale può
// cambiare le squadre a metà torneo e la risorsa alias è editabile a mano
// senza ricompilare. Mai letti dall'LLMParser da DB/config (ADR-004).
interface PickParseOptions {
  teams: string[];   // da SeasonDataProvider.getTeams()
  aliases: string;   // contenuto testuale di src/llm/team-aliases.md
}

interface LLMParser {
  extractPick(emailBody: string, opts: PickParseOptions): Promise<PickExtraction | null>;
}
```

**Prompt e output vincolato:**
- Il prompt include: il testo dell'email + la lista canonica delle squadre da `SeasonDataProvider.getTeams()` (data-driven: i cambi di squadra stagionali non richiedono modifiche al codice) + il contenuto di `src/llm/team-aliases.md` (file Markdown editabile a mano con alias noti, es. "Juve → Juventus FC"; è una risorsa del prompt, non codice)
- Output vincolato: `team` come esatto nome canonico dalla lista (JSON schema/enum se supportato dall'API); ambiguo/non riconducibile → `null`
- **Contratto d'errore (D3):** il Parser NON lancia mai eccezioni per il *contenuto* (email ambigua, output non-JSON, squadra fuori lista) → `null`; lancia `LLMError` (src/llm/openai-client.ts) SOLO per problemi di trasporto/HTTP/timeout/body malformato — il wiring tratta `LLMError` come "non processato, resta non letto, retry al tick successivo"
- **Doppia barriera (D2/C):** il filtro deterministico esatto (team non nella lista → `null`) vive nel Parser (confine I/O, ADR-004: nessun nome spurio esce dall'I/O); il check esatto del Game Engine (Pick Processor, passo 2 della cascata → motivo `unknown_team`) resta come seconda barriera di difesa in profondità
- **Check deterministico post-parse** lato Game Engine: solo exact-match sulla lista canonica, altrimenti trattato come `null` (rifiuto con richiesta di chiarimento al giocatore). Nessun nome inventato entra nello stato di gioco

### 6.3 LLM Generator

```typescript
type EmailType = 
  | "welcome"
  | "registration_open_invite"   // notifica apertura fase di iscrizione a una lista di contatti (PRD US7)
  | "pick_instructions"
  | "pick_confirmed"
  | "pick_rejected"
  | "pick_missing_elimination"
  | "round_result_correct"
  | "round_result_wrong"
  | "pick_postponed"
  | "auto_registered"            // auto-iscrizione RF-27: UN UNICO messaggio che unisce
                                 // iscrizione ed esito del pick (PRD §4.1, CL2; D5)
  | "tournament_won"
  | "tournament_shared_win";

interface EmailContext {
  type: EmailType;
  playerName?: string;
  tc?: number;          // TC assoluto, iniettato deterministicamente (ADR-008, RF-25)
  tt?: number;          // TT derivato (TC - start_round + 1), iniettato deterministicamente (ADR-008, RF-25)
  subject?: string;     // oggetto esplicito opzionale (D1): se assente lo compone subjectFor(ctx)
  team?: string;
  outcome?: string;
  reason?: string;
  availableTeams?: string[];
  deadline?: Date;
}

interface LLMGenerator {
  generate(ctx: EmailContext): Promise<string>;
}
```

> **Coppia TT/TC (ADR-008):** `tc` è il numero di campionato; `tt` è derivato dal Game Engine (`TT = TC − start_round + 1`, §3.2). Il Generator li usa solo come dati iniettati dal chiamante. **Nessun numero di turno entra nel prompt** (ADR-004, D4): i template usano il segnaposto `{{TT_TC}}` (corpo, forma estesa "TT 2, TC 7") e `{{TTTC}}` (forma compatta "TT2TC7"), sostituiti DOPO la generazione con `turnExtended(tt,tc)`/`turnCompact(tt,tc)` (src/game/turn.ts) dai dati di `ctx`; coppia assente → sostituiti con stringa vuota.
>
> **Soggetto (D1):** composto DETERMINISTICAMENTE dal chiamante con l'helper `subjectFor(ctx)` (src/llm/generator.ts) — etichetta per tipo + forma compatta `TT2TC7` (RF-25); mai dall'LLM, mai numeri inventati. `ctx.subject` permette a un chiamante di fornire un oggetto esplicito (subjectFor lo usa come priorità).
>
> **Formato date nei testi (D9):** le date (`deadline`, esiti) sono UTC; i testi email le mostrano con `Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', … })` — fuso fisso = determinismo (RNF1), parametri di formato documentati nel file `src/llm/templates.ts`.
>
> **Errori (D3):** problemi di trasporto/HTTP → `LLMError` rilanciata (mai silenziosa: il chiamante decide se notificare); nessuna eccezione su contenuto (il testo dell'LLM è sostituito/completato deterministicamente, mai validato in modo bloccante).

### 6.4 ChannelAdapter

```typescript
interface IncomingMessage {
  from: string;         // mittente (email, numero telefono, username)
  channel: string;      // "email" | "whatsapp" | "telegram" | "web"
  body: string;         // corpo del messaggio
  receivedAt: Date;     // istante di RICEZIONE SUL SERVER (per l'email: `internaldate` IMAP,
                        // cioè l'arrivo in casella registrato dal server di posta ricevente;
                        // NON l'header "Date" della mail). È il timestamp autorevole per il
                        // confronto con la deadline del round (PRD §5.3, HIGH-02).
}

interface ChannelAdapter {
  /** Recupera i messaggi in arrivo non ancora processati */
  fetchMessages(): Promise<IncomingMessage[]>;

  /**
   * Invia un messaggio a un destinatario.
   * `subject` è OPZIONALE (D1): per l'email è l'oggetto SMTP; chi compone i
   * contesti (Round Manager, Registration, wiring) calcola il soggetto con
   * l'helper deterministico `subjectFor(ctx)` (LLM Generator, §6.3).
   */
  sendMessage(to: string, body: string, subject?: string): Promise<void>;
}
```

**Semantica del flag `\Seen` (D7):** il fetch (`fetchMessages`, `channel:email:fetch`) è di **sola lettura e non marca nulla** (idempotente). Il flag `\Seen` viene impostato SOLO da `channel:email:process` a **messaggio processato con successo** (tutte le email di risposta inviate); su errore (es. `LLMError`) il messaggio resta **non letto** e viene ritentato al tick successivo. Il duplicato da crash tra process e flag è accettato in POC: la logica di gioco è idempotente (secondo process → `pick_already_exists`/profilo già esistente → risposta "già registrato"); nessuna tabella di dedup (fuori scope POC, dichiarato). I messaggi non processabili (es. round non aperto, CL3) vengono marcati letti per non ripetere il rifiuto a ogni tick.

**Implementazioni:**
- `EmailAdapter` — unica implementazione nella PoC, usa IMAP per `fetchMessages` e SMTP per `sendMessage`
- `WhatsAppAdapter`, `TelegramAdapter`, `WebAdapter` — future (fuori scope PoC)

### 6.5 Eligibilità (seam ADR-008)

```typescript
/** Identità di un giocatore fornita dal canale (ADR-008): nella POC {channel: 'email', identifier: <email>}. */
interface ExternalIdentity {
  channel: string;      // "email" | "whatsapp" | "telegram" | "web"
  identifier: string;   // identificativo nel canale (per l'email: l'indirizzo)
}

interface EligibilityResult {
  eligible: boolean;
  reason?: string;      // motivo del diniego (es. quota non pagata, in Fase 1)
}

interface Eligibility {
  /** Gate pre-registrazione: l'identità può partecipare al torneo? */
  checkEligibility(identity: ExternalIdentity): Promise<EligibilityResult>;
}
```

**Implementazioni:**
- **POC** — `AlwaysEligibleEligibility` (o equivalente): restituisce sempre `{ eligible: true }` e scrive un log strutturato dell'invocazione (identità, esito). È la **seam** che in Fase 1 ospiterà il controllo quota (`ENTRY_FEE_EUR`, LLD §4.1)
- **Override US10** — gli override del commissioner (iscrizione manuale, auto-iscrizione forzata) passano per la stessa funzione: il comando CLI specifica esito forzato + motivo (`--reason` obbligatorio, audit) e la chiamata resta registrata nei log

**Uso nel flusso (PRD §4.1, US10):** la registrazione automatica via email, l'auto-iscrizione (RF-27) e l'iscrizione manuale (RF-28) invocano `checkEligibility` prima di creare il profilo; esito negativo → messaggio di rifiuto con `reason` (nella POC, mai verificato: il risultato è sempre `true`).

---

## 7. Comandi CLI

Ogni componente del sistema espone comandi CLI dedicati. I comandi sono organizzati in tre livelli: setup, operazioni atomice di componente, e operazioni composte di alto livello.

### 7.1 Setup

```bash
npm run db:migrate                            # Crea tabelle
npm run db:seed                               # Popola dati test
```

### 7.2 Dati stagione

```bash
npm run cli -- data:import                    # Importa calendario e risultati dall'API football-data.org
npm run cli -- data:refresh                   # Aggiorna calendario e risultati dall'API football-data.org
npm run cli -- data:calendar                  # Mostra calendario completo
npm run cli -- data:results --round <n>       # Mostra risultati di un round
```

`data:import` e `data:refresh` chiamano l'API football-data.org (endpoint `GET /v4/competitions/{competition}/matches?season={season}`, header `X-Auth-Token`, token da env `FOOTBALL_DATA_TOKEN`, competizione/stagione da `FOOTBALL_DATA_COMPETITION`/`FOOTBALL_DATA_SEASON`) e fanno **upsert** nella tabella `match` sulla chiave primaria `(round, home_team, away_team)`, in una transazione (tutto o niente: nessuno stato parziale). Non leggono file statici. `data:refresh` è invocato dallo scheduler a ogni tick (§1.4).

### 7.3 Game Engine — Round Manager

```bash
npm run cli -- round:open --round <n>         # Apre round, invia email pick
npm run cli -- round:close --round <n>        # Chiude round all'istante di accettazione (deadline o chiusura di sicurezza)
npm run cli -- round:close --round <n> --force --reason <motivo>   # CHIUSURA FORZATA: consolida subito (RF-29),
                                              # semantica identica alla chiusura a deadline (elimina i mancanti + notifiche);
                                              # --reason obbligatorio e auditato; non esiste "chiudi senza eliminare"
npm run cli -- round:score --round <n>        # Contabilizzazione incrementale: processa i pick pending con risultato disponibile, fa freeze dei posticipati fuori finestra; idempotente; chiude il round (scored) quando nessun pick è pending
                                              # Processa anche i pick frozen la cui partita ora ha punteggio (frozen → correct/wrong, con eventuale eliminazione a posteriori)
npm run cli -- round:status --round <n>       # Stato di un round specifico (output con coppia TT/TC)
npm run cli -- round:deadline --round <n>     # Mostra la deadline calcolata e il kickoff effettivo (istante di accettazione, RF-31)
```

### 7.4 Game Engine — Pick Processor

```bash
npm run cli -- pick:validate --round <n> --profile-id <id> --team <name> --outcome <win|draw|lose>
                                              # Valida un pick senza registrarlo. Output: JSON {valid, reason}
npm run cli -- pick:register --round <n> --profile-id <id> --team <name> --outcome <win|draw|lose> [--reason <motivo>]
                                              # Registra un pick dopo averlo validato (valida sempre, con le stesse regole dei pick automatici). Output: JSON {id, status}.
                                              # --reason obbligatorio per pick fuori dall'istante di accettazione (override US10, ADR-008)
npm run cli -- pick:list --round <n>          # Lista pick registrati per un round
npm run cli -- pick:list --profile-id <id>    # Lista pick di un profilo
```

### 7.5 Game Engine — Rules Engine

```bash
npm run cli -- rules:burned-teams --profile-id <id> [--half <1|2>]
                                              # Squadre bruciate da un profilo. Default: girone corrente
npm run cli -- rules:available-teams --profile-id <id> --round <n>
                                              # Squadre disponibili per un profilo in un round
npm run cli -- rules:check-half --round <n>   # Restituisce il girone (1=andata, 2=ritorno) per un round
```

### 7.6 Game Engine — Elimination Engine

```bash
npm run cli -- elimination:check --profile-id <id>
                                              # Verifica se un profilo dovrebbe essere eliminato. Output: JSON {eliminated, reason}
npm run cli -- elimination:list               # Lista profili eliminati con motivo ed istante (eliminated_reason, eliminated_at)
```

### 7.7 Game Engine — Winner Engine

```bash
npm run cli -- winner:check                   # Verifica se il torneo è finito. Output: JSON {finished, winners, case}
```

### 7.8 LLM Adapter

```bash
npm run cli -- llm:parse --input <text>       # Estrae {team, outcome} da testo libero. Output: JSON.
                                              # Lista canonica da getTeams() (DB reale) + contenuto di
                                              # team-aliases.md iniettati per chiamata; DB vuoto → lista
                                              # vuota → {team: null} con messaggio chiaro
npm run cli -- llm:generate --type <email-type> [--player-name <name>] [--tt <n>] [--tc <n>] [--team <name>] [--outcome <outcome>] [--reason <text>] [--deadline <datetime>]
                                              # Genera email da contesto strutturato. Output: SOGGETTO
                                              # (subjectFor, forma compatta TT2TC7) + corpo (segnaposto
                                              # {{TT_TC}} sostituito deterministicamente). Coppia TT/TC
                                              # assente → segnaposto sostituito con stringa vuota
```

### 7.9 Channel Adapter

```bash
npm run cli -- channel:email:fetch             # Recupera email non lette dalla casella IMAP. Output: JSON array
npm run cli -- channel:email:process           # Fetch + processa (iscrizioni e pick) tutte le email non lette
npm run cli -- channel:email:send --to <email> --subject <subject> --body <text>
                                               # Invia un'email via SMTP
```

### 7.10 Torneo (vista aggregata)

```bash
npm run cli -- tournament:start [--start-round <n>]   # Avvia la stagione (US6): verifica il calendario, esegue le operazioni
                                                      # preliminari (parametri data-driven, round in stato pending, stato stagione).
                                                      # --start-round <n> = aggancio del torneo a un TC arbitrario (RF-20, ADR-008; default 1).
                                                      # Validazioni RF-21: TC esistente, con partite, deadline TT1 futura → rifiuto atomico
                                                      # senza stato parziale; aggancio all'ultimo TC → warning informativo (CL12)
npm run cli -- tournament:status               # Stato torneo: finestra di iscrizione, round corrente, profili attivi/eliminati,
                                               # vincitore; anomalie (es. chiusure di sicurezza non applicabili, RF-30)
npm run cli -- tournament:history <email>      # Storico pick di un profilo (output con coppia TT/TC)
npm run cli -- tournament:leaderboard          # Classifica profili ancora in gara (output con coppia TT/TC)
npm run cli -- tournament:register:open [--contacts <file>]
                                               # Apre la finestra di iscrizione (US7): il sistema accetta iscrizioni automatiche;
                                               # se è fornita una lista di contatti (--contacts), invia loro la notifica di apertura
npm run cli -- tournament:register:close [--reason <motivo>]
                                               # Chiude la finestra di iscrizione (RF-28): stop alle iscrizioni automatiche.
                                               # Senza --reason = chiusura automatica alla deadline del TT 1 (RF-22) o di sicurezza;
                                               # con --reason = CHIUSURA FORZATA anticipata (o con deadline TT1 assente), auditata.
                                               # Non chiude la finestra di pick del TT 1 (finestre indipendenti)
npm run cli -- tournament:register --email <email> [--name <name>] [--reason <motivo>]
                                               # Registra manualmente un giocatore (bypass email); unico ingresso a finestra chiusa.
                                               # --reason obbligatorio (override US10, ADR-008): audit; un nuovo iscritto parte
                                               # dal round corrente con pool intatto
npm run cli -- tournament:export               # Dump JSON di tutte le tabelle + metadati (timestamp, parametri derivati,
                                               # start_round e mappatura TT/TC)
                                               # Usi: verifica del determinismo della simulazione (diff tra run),
                                               # trasparenza verso i giocatori, audit pre/post correzioni
```

### 7.11 Simulazione

```bash
npm run cli -- simulate:full [--start-round <n>] [--seed <n>]   # Simula intera stagione 2025/26 (o dalla finestra [start_round..N] con
                                                                 # aggancio, ADR-008/RF-20: TT1 = start_round, pool/girone secondo i dati)
npm run cli -- simulate:round --round <n> [--seed <n>]          # Simula round singolo (open → close → score) sul TC n
```

- Seed del RNG deterministico (mulberry32, funzione pura) — default `42`; stessa
  seed + stesso clock → `tournament:export` identici (RNF1).
- Registra `SIM_PLAYERS` profili sintetici (`sim-XX@survivor.test`) via
  `tournament:register` a finestra aperta; clock di ogni fase DERIVATO dai dati
  (open/receivedAt a deadline − 1min, close a deadline + 1min, score a
  tcClose + 1min) — mai orologio reale.
- Rifiuta su DB con `season_started=1` o con round non-pending (la simulazione
  richiede un DB senza stato di gioco). I comandi `simulate:*` costruiscono il
  contesto SENZA canale/generatore email (R1): nessuna notifica reale.

### 7.12 Scheduler (solo produzione)

```bash
npm run cli -- scheduler:tick                   # Orchestratore sottile: verifica quali azioni eseguire in base al
                                                # calendario e allo stato dei round e della finestra di iscrizione
                                                # (register:close auto/sicurezza, open/close/score; chiusura di sicurezza
                                                # allo scadere del TC se deadline NULL — log safety_close, RF-30).
                                                # Non contiene logica di gioco; invoca i comandi del Game Engine. Idempotente.
                                                # Esce senza effetti se SCHEDULER_ENABLED=false (sviluppo/test).
npm run cli -- scheduler:status                 # Mostra lo stato COMPUTATO dello scheduler (R5: nessuna "ultima
                                                # esecuzione" persistita — l'audit sta nel log pino): round, anomalie
                                                # (deadline mancanti, RF-30) e prossime azioni.
```

In produzione, `scheduler:tick` è invocato ogni minuto da cron. In sviluppo (`SCHEDULER_ENABLED=false`), il comando esiste ma non esegue azioni automatiche — il commissioner usa i comandi manuali (`tournament:register:open`, `tournament:register:close`, `round:open`, `round:close`, `round:score`).

### 7.13 Principi di design per i comandi

- Ogni comando produce output JSON strutturato (`--json`) o testo formattato per lettura umana (default)
- I comandi di sola lettura non modificano lo stato e sono idempotenti
- I comandi di scrittura restituiscono l'oggetto creato/modificato
- Un agente AI può comporre comandi atomici per realizzare flussi complessi (es. `round:open` → `channel:email:process` → `round:close` → `round:score`)
- In produzione questi flussi sono eseguiti automaticamente dallo Scheduler; la CLI serve per override e debugging

---

## 8. Test strategy

| Livello | Cosa testa | Framework |
|---------|-----------|-----------|
| Unit | Regole (squadre bruciate, gironi), validazione pick, logica eliminazione, calcolo vincitore | `vitest` |
| Integration | Flusso round completo, parsing email, generazione email, interazione DB | `vitest` + SQLite in-memory |
| Simulazione | Stagione completa 2025/26 con dati noti, output deterministico | `vitest` + CLI |

**Mock e confini esterni:** mock/fake **solo nei test automatizzati** (unit/contract/integration) e solo ai confini esterni del sistema (LLM, IMAP/SMTP, API football-data.org). LLM Parser e Generator sono mockati nei test del Game Engine; i test del LLM Adapter sono isolati e verificano solo il contratto dell'interfaccia.

**UAT (User Acceptance Test):** nessun componente è mockato — Gmail reale, LLM reale, API football-data.org reale, SQLite su file reale. I "giocatori simulati" di `simulate:full` **non sono mock** ma attori sintetici che operano tramite i comandi CLI reali. La deadline in UAT non si mocka: si scavalca con i comandi CLI del commissioner (`round:close`, `round:score`).

### 8.1 Casi di test dell'aggancio asincrono (ADR-008, PRD RF-20…31 / CL11–18)

Casi aggiuntivi al set di test già definito, da distribuire tra unit/integration/simulazione (quando i moduli torneo/registrazione esistono):

**Aggancio (RF-20/21/26, CL11-14):**
- aggancio a metà girone (es. `--start-round 5`): TT/TC derivati correttamente, finestra `[start_round..N]` rispettata, pool bruciate corretto
- aggancio al confine di girone (`--start-round 20`, CL13): pool azzerato per il girone di ritorno
- aggancio oltre metà stagione (CL14): solo girone ritorno, disponibilità squadre garantita (19 squadre per 19 TT)
- aggancio all'ultimo TC (CL12): ammesso con warning informativo; i tre esiti di vittoria collassano (RF-18/RF-26)
- aggancio a TC passato o in corso (CL11): rifiuto **atomico** senza stato parziale (RF-21)

**Finestra di iscrizione (RF-22/24/27/28, CL2/CL5):**
- chiusura automatica della finestra di iscrizione alla deadline del TT 1
- chiusura forzata anticipata `tournament:register:close --reason`: iscrizioni respinte, pick del TT 1 ancora accettati fino alla deadline (finestre indipendenti)
- auto-iscrizione + pick valido in un unico messaggio (RF-27): un solo invio crea profilo e registra il pick
- auto-iscrizione + pick invalido + retry entro deadline (il profilo esiste, il pick viene rifiutato e riprovato)
- messaggio non interpretabile → richiesta di chiarimento senza profilo creato (CL5)
- pick da sconosciuto dopo la deadline del TT 1 → respinto senza registrazione (RF-24)
- unicità del profilo su invii concorrenti (RNF2)

**Chiusura forzata finestra pick (RF-29) e guard anti-frode (RF-31, CL17/CL18):**
- `round:close --force --reason` anticipata: consolidamento immediato (eliminazioni `missing_pick` + notifiche)
- pick dopo il fischio d'inizio effettivo con deadline NULL → respinto (guard anti-frode)
- pick dopo il kickoff effettivo con deadline nominale più tarda (anticipo di calendario, CL18) → respinto; rimedio = override US10 `--reason`
- auto-iscrizione dopo il kickoff → respinta (nessun profilo creato a partita iniziata)
- `round:close --force` senza `--reason` → comando rifiutato (audit obbligatorio)

**Chiusura di sicurezza (RF-30):**
- deadline NULL → consolidamento alla chiusura del TC con log `safety_close` (causa `deadline_missing`); nessun pick accettato nel frattempo (guard attivo)
- chiusura TC non calcolabile → nessuna auto-chiusura, log `warn` + anomalia in `tournament:status`, uscita via chiusura forzata

**Comunicazione e audit (RF-25, ADR-008):**
- coppia (tt, tc) presente in email (forma estesa), log strutturati `{tt, tc}` e output CLI (forma compatta)
- coppia iniettata deterministicamente nei template: il numero nel testo email proviene dai dati, mai dall'LLM (ADR-004)
- eligibilità invocata e loggata a ogni registrazione (seam POC ritorna `true`)
- override con `--reason` auditato (iscrizione manuale, pick fuori accettazione)

**Regressione:** simulazione full-season da TC 1 (nessun aggancio) con esito invariato rispetto al comportamento legacy (CS3); `tournament:export` identico a parità di seed (RNF1).