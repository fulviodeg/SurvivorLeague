# LLD: Survivor League — Proof of Concept

> ⚠ **POC ONLY** — Questo documento descrive il sistema per la Proof of Concept. Non è il design del sistema di produzione.

**Stato:** Revisionato
**Data:** 2026-08-20
**Versione:** 0.5.0

> Documento di dettaglio implementativo. Per l'architettura di alto livello vedi [POC_HLD.md](POC_HLD.md); per i requisiti di prodotto vedi [POC_PRD.md](POC_PRD.md). Cross-riferimenti aggiornati alla numerazione del PRD v0.6.0 e dell'HLD v0.5.0.

**Changelog:**
- **0.5.0** (2026-08-20) — Allineamento all'iscrizione a livello di piattaforma (ADR-009, PRD v0.6.0): nuova tabella `platform_account` su DB separato `PLATFORM_DB_PATH` (§3, §4.2) con soft-delete a due passi (`active`/`pending_unsubscribe`/`unsubscribed`); colonne additive `player.register_id`, `profile.register_id`, `round_state.summary_sent` (§3); vincoli applicativi riscritti: gate piattaforma `active`, auto-join al TT1 (RF-P5), riepilogo `round_closed_survived` alla transizione `closed→scored` con guardia `summary_sent` (§3.1); nuova interfaccia `PlatformRegistry` (§6.6) e `LLMIntentClassifier` (§6.2); `EmailType` aggiornati (`platform_registered`, `platform_unsubscribed`, `platform_unsubscribe_confirm`, `tournament_open`, `round_closed_survived`; rimossi `welcome`, `registration_open_invite`, `auto_registered`, `round_closed_eliminated`) (§6.3); nuovi comandi `platform:*` e modifiche `tournament:*`/`round:*`/`channel:email:process` (§7); `channel:email:process` migra entrambi i DB; casi di test §8 aggiornati (registry, classificatore, notifiche filtrate).
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
  - [6.2 LLM Parser e Intent Classifier](#62-llm-parser-e-intent-classifier)
  - [6.3 LLM Generator](#63-llm-generator)
  - [6.4 ChannelAdapter](#64-channeladapter)
  - [6.5 Eligibilità (seam ADR-008/009)](#65-eligibilità-seam-adr-008009)
  - [6.6 PlatformRegistry (ADR-009)](#66-platformregistry-adr-009)
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
| **Round Manager** | Apre e chiude round, gestisce deadline, coordina l'invio delle email di pick, e implementa la **contabilizzazione incrementale** dei pick (`round:score`: processa i pick `pending`, aggiorna lo stato a `correct`/`wrong`/`frozen`, chiude il round a `scored` quando non restano pick `pending`; processa inoltre i pick `frozen` la cui partita ora ha punteggio, aggiornandoli a `correct`/`wrong` con eventuale eliminazione a posteriori). Gestisce inoltre: la **chiusura forzata** (`round:close --force --reason`, RF-29) e la **chiusura di sicurezza** allo scadere del TC quando la deadline è NULL/non innescata (RF-30, log `safety_close`) — tutte con **semantica di consolidamento identica**; alla transizione `closed→scored` invia il riepilogo `round_closed_survived` ai soli sopravvissuti (guardia `summary_sent`, RF-P6); filtra OGNI notifica sull'account piattaforma `active` (RF-P6, ADR-009) |
| **Pick Processor** | Valida un pick (account piattaforma `active` + profilo in gara — o auto-join nel TT1 —, squadra in giornata, già bruciata, esito valido, già inviato, entro l'**istante di accettazione** `min(deadline registrata, fischio d'inizio effettivo prima partita del TC)` — RF-31), registra il pick nel database |
| **Rules Engine** | Regole di gioco: squadre bruciate per girone, esiti validi, condizioni di vittoria |
| **Elimination Engine** | Determina quali profili sono eliminati (pick mancante, pick sbagliato) |
| **Winner Engine** | Determina se il torneo è finito e chi ha vinto (casi 1, 2, 3 del PRD §4.6), sulla finestra `[start_round..N]` |
| **Eligibility (seam)** | Gate pre-partecipazione `checkEligibility(ExternalIdentity) → {eligible, reason?}` (ADR-008/009, §6.5): implementazione POC "account piattaforma `active`" (lettura dal Platform Registry); Fase 1: controllo quota (`ENTRY_FEE_EUR`) |
| **Platform Registry** | Archivio account piattaforma su DB separato (§6.6): `register`/soft-delete a due passi/`activeEmails`; **solo letto** dai flussi di torneo (ADR-009) |
| **Season Data Provider** | Interfaccia astratta per calendario e risultati. Unica implementazione nella POC: `DbSeasonDataProvider` (legge dalla tabella `match` del DB) |

**Derivazione squadre bruciate.** Non esiste una tabella separata: il Rules Engine deriva l'insieme delle squadre già usate da un profilo interrogando la tabella `pick` per i round del girone corrente. Per il girone di andata (TC 1-19 nella stagione completa), la query è `SELECT team FROM pick WHERE profile_id = ? AND round BETWEEN 1 AND 19`. Per il girone di ritorno (TC 20+ nella stagione completa), la query è `SELECT team FROM pick WHERE profile_id = ? AND round >= 20`. Il confine tra i due gironi è determinato dinamicamente dal numero totale di round diviso 2, non hardcodato. I pick in **Freeze** (PRD §5.4) contano come squadre bruciate: la query non filtra i pick in attesa di risultato. Il modello non prevede più l'annullamento del pick per rinvio, quindi la derivazione resta valida senza filtri aggiuntivi. **In un torneo agganciato** (ADR-008) le derivazioni operano **sull'intera stagione** (§3.2); il torneo gioca la finestra `[start_round..N]` come filtro logico: le query e i confini non cambiano.

### 1.2 LLM Adapter

| Modulo | Input | Output | Modello |
|--------|-------|--------|---------|
| **Intent Classifier** | Testo dell'email (italiano, forma libera) | `{ intent: 'subscribe'\|'unsubscribe'\|'pick'\|'other', pick: {team, outcome} \| null }` in UNA chiamata | Qualsiasi LLM API |
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
| &nbsp;&nbsp;├─ **Message Router** | Normalizza l'identità del mittente in `ExternalIdentity { channel, identifier }` (ADR-008): per l'email `{channel: 'email', identifier: <indirizzo minuscolo, senza nome visualizzato>}` (D6/K). **La decisione di intento è del classificatore (ADR-009, LLM o deterministico — ADR-014):** il router NON usa più keyword (`REGISTRATION_KEYWORDS` rimossa) e produce `{ kind: 'classified', identity, body, subject? }`; corpo e subject vuoti → `kind: 'unknown'` (nessuna chiamata di classificazione). **Il router NON decide nulla di gioco** (auto-join/rifiuti = Game Engine, PRD §4.1): il wiring (6.2) decide. **"Round corrente" del wiring (D8):** il primo `round_state` con `status='open'` nella finestra `[start_round..N]` (stessa semantica di `tournament:status`); nessun round aperto → rifiuto `round_not_open` (CL3) per il ramo pick |
| &nbsp;&nbsp;└─ **SMTP Client** | Invia email di risposta e notifica (`nodemailer`): `sendMail({from, to, subject, text})`, soggetto dal chiamante (D1) |

**Adapters futuri** (fuori scope PoC, da FUTURE_EXPLORATIONS.md punto 7):
- `WhatsAppAdapter` — invio/ricezione via WhatsApp Business API
- `TelegramAdapter` — invio/ricezione via Telegram Bot API
- `WebAdapter` — frontend web con API REST

### 1.4 Scheduler

| Modulo | Responsabilità |
|--------|---------------|
| **Scheduler** | **Orchestratore sottile**: in produzione, decide *quando* agire in base al calendario e allo stato dei round (apre round, chiude deadline, invoca la contabilizzazione). **Non contiene logica di gioco**: non confronta risultati, non valida pick, non tocca lo stato dei pick o degli account. Invoca esclusivamente i comandi del Game Engine |
| **Cron Job** | Meccanismo di scheduling (cron del sistema operativo). Esegue il processo Node.js a intervalli regolari per verificare se ci sono azioni da compiere (aprire round, chiudere deadline, contabilizzare) |

**Funzionamento:**
- Il cron job esegue `npm run cli -- scheduler:tick` ogni minuto
- **Nessuna finestra di iscrizione (ADR-009):** le azioni `register_close_auto`/`register_close_safety` e i relativi rami sono RIMOSSI — l'iscrizione piattaforma è sempre disponibile e la partecipazione è gated dalla deadline del TT1 (auto-join, RF-P5)
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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  register_id INTEGER,  -- riferimento REPLICATO all'account piattaforma (ADR-009, RF-P7);
                        -- nessun vincolo cross-DB: è un riferimento informativo
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Profilo (partecipazione al torneo)
-- Nella PoC: 1 profilo per giocatore; nasce per AUTO-JOIN al primo pick valido nel TT 1 (RF-P5)
CREATE TABLE profile (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         INTEGER NOT NULL UNIQUE REFERENCES player(id),
  register_id       INTEGER,  -- riferimento REPLICATO all'account piattaforma (RF-P7, come player)
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
  round         INTEGER PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'scored')),
  deadline      TEXT,
  opened_at     TEXT,
  closed_at     TEXT,
  scored_at     TEXT,
  summary_sent  INTEGER NOT NULL DEFAULT 0  -- riepilogo round_closed_survived inviato UNA volta
                                            -- alla transizione closed→scored (RF-P6, ADR-009)
);

-- Stato del torneo (riga singola nell'istanza: PoC monoutente)
-- Gestisce l'avvio della stagione (US6) e l'aggancio del torneo a un TC
-- arbitrario (ADR-008, RF-20). La colonna registration_open è DEPRECATA
-- (ADR-009): non esiste più una finestra di iscrizione.
CREATE TABLE tournament_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  season_started    INTEGER NOT NULL DEFAULT 0,  -- stagione avviata (operazioni preliminari concluse, US6)
  registration_open INTEGER NOT NULL DEFAULT 0,  -- DEPRECATA (ADR-009): resta per compatibilità dello schema,
                                                 -- non è più letta/scritta dai flussi
  start_round       INTEGER,                     -- TC di aggancio del torneo (NULL = TC 1 legacy, ADR-008);
                                                 -- da esso si deriva TT = TC - start_round + 1 (RF-20, RF-25)
  registration_notified INTEGER NOT NULL DEFAULT 0 -- DEPRECATA (ADR-009): non più letta/scritta
);
```

> **Nota `win_only` (ADR-016, emendamento).** La colonna additiva
> `tournament_state.win_only INTEGER NOT NULL DEFAULT 0` è aggiunta da
> `applyAdditiveMigrations` (idempotente, guardata da `PRAGMA table_info`):
> `1` = modalità `win_only` (pick = sola squadra, outcome `win`). È scritta a
> `tournament:start` e confrontata dalla guardia fatal `assertModeConsistent`
> (`src/game/mode.ts`) a torneo aperto; l'export la include (determinismo RNF1).
> Le colonne ADR-011/ADR-015 (`winner_notified`, `finished_at`, `export_path`)
> seguono lo stesso pattern additivo e non sono ripetute qui per brevità.

**DB piattaforma (storage separato, ADR-009, RF-P7).** Vive in `PLATFORM_DB_PATH` (default `./data/platform.db`, §4.2): **mai** nello stesso file di `DB_PATH`. Due connessioni separate, nessuna transazione cross-DB: la piattaforma è **solo letta** dai flussi di torneo (gate notifiche/pick). `register_id` su `player`/`profile` è un riferimento replicato **senza vincoli cross-DB** (RF-P7). Il DB piattaforma **non viene eliminato** col DB torneo e non partecipa alle migrazioni di `db:migrate` (`platform:migrate` dedicato).

```sql
-- Account piattaforma (DDL di src/db/platform-schema.ts, RF-P1/P2/P8)
CREATE TABLE platform_account (
  register_id     INTEGER PRIMARY KEY AUTOINCREMENT,  -- registerID INTERNO STABILE, riusato alla re-iscrizione
  email           TEXT NOT NULL UNIQUE,               -- univocità: il sistema ricorda l'email (RF-P3)
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'pending_unsubscribe', 'unsubscribed')),
  created_at      TEXT NOT NULL,      -- SEMPRE dal clock iniettato (RF-P8, RNF1): mai default datetime('now')
  unsubscribed_at TEXT               -- istante della soft-delete (clock iniettato), NULL finché non disiscritto
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
- **Gate piattaforma (ADR-009, RF-P4/P5/P6):** ogni email in uscita è inviata SOLO ad account piattaforma `active` al momento dell'invio — `unsubscribed` e `pending_unsubscribe` non ricevono alcuna email. Il gate del pick = account `active` + profilo in gara (o auto-join al TT1). Un pick da mittente non iscritto (mai o disiscritto) produce **solo log interno, nessuna risposta** (anti-spam, RF-P4), con messaggio marcato letto. La piattaforma è **solo letta** dai flussi di torneo: nessuna scrittura cross-DB
- **Auto-join al TT1 (RF-P5):** il profilo nasce **al primo pick valido** nel TT1 (round = `start_round`, round `open`, pick che passa la cascata RF-31) con profilo + pick in un'unica transazione sul DB torneo; pick invalido → rollback, nessun profilo; la risposta è `pick_confirmed`. L'iscrizione piattaforma durante un torneo aperto NON crea il profilo; chi si iscrive e non invia mai un pick non è partecipante (non eliminato, nessuna email). Dopo il TT1 un pick da iscritto senza profilo è rifiutato con risposta. La disiscrizione a torneo in corso NON tocca il profilo (storico intatto): ferma solo comunicazioni e pick; il profilo muore alla prossima chiusura round (`missing_pick`, senza email al disiscritto); re-iscrizione prima della prossima deadline → stesso `registerID` e stesso profilo
- **Riepilogo chiusura round (RF-P6):** alla transizione `closed → scored` — e solo lì — il Round Manager invia `round_closed_survived` ai **soli sopravvissuti** (`eliminated = 0`) con account `active`, poi imposta `round_state.summary_sent = 1`; le riaperture di `round:score` non rinviano (idempotente). Gli eliminati ricevono SOLO `pick_missing_elimination` (alla `round:close`) e `round_result_wrong` (allo `round:score`); l'eliminazione a posteriori da Freeze produce SOLO `round_result_wrong`. Non esistono `round_closed_eliminated` né criteri `eliminated_at >= opened_at`
- **Gate di eligibilità**: prima di ogni auto-join (e degli override) il Game Engine valuta `checkEligibility(ExternalIdentity)` (§6.5, ADR-008/009): implementazione POC = "**account piattaforma `active`**" (lettura dal `PlatformRegistry`); gli override del commissioner passano per la stessa funzione con esito forzabile + motivo

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
| Modalità di gioco `win_only` (default) | `WIN_ONLY` | `true` | ADR-016. `true` (default) = il giocatore sceglie SOLO la squadra che vincerà (outcome sempre `win`); pareggio o sconfitta = pick sbagliato → eliminazione. `false` = modalità classica (win/draw/lose). Fissata nel DB a `tournament:start`; una guardia fatal abortisce il processo se cambia a torneo aperto |
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
| Generazione IA email | `AI_EMAIL_GENERATOR` | `false` | Interruttore email v3 (ADR-013): `true` = narrativa LLM con fallback deterministico su `LLMError`/narrativa degenerata; assente/`false` = generatore deterministico (`DeterministicGenerator`, MAI chiamate LLM per i testi email). Lettura a ogni invocazione CLI (nessun daemon da riavviare) |
| Classificazione IA input | `AI_EMAIL_PARSER` | `false` | Interruttore email v3 Parte B (ADR-014): `true` = classificazione LLM con fallback per-messaggio sul deterministico; assente/`false` = `DeterministicIntentClassifier` (formule univoche `ISCRIZIONE [NOME]`/`DISISCRIZIONE`/`<TEAM> <ESITO>` nel subject o corpo, MAI chiamate LLM per la classificazione). Con entrambi i flag AI false `LLM_API_KEY` non è richiesta (run senza IA) |
| Database path | `DB_PATH` | `./data/survivor.db` | |
| Database piattaforma path | `PLATFORM_DB_PATH` | `./data/platform.db` | DB **separato** per gli account piattaforma (ADR-009, RF-P7): MAI uguale a `DB_PATH`; `platform:migrate` lo migra; `channel:email:process`/`simulate:*` lo richiedono (errore esplicito se assente). `simulate:*` rifiuta/avvisa se coincide col valore di produzione |
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
│   │   ├── schema.ts             # DDL e migrazioni (DB torneo, DB_PATH)
│   │   ├── platform-schema.ts    # DDL e migrazioni del DB PIATTAFORMA (PLATFORM_DB_PATH, ADR-009)
│   │   └── seed.ts               # Popolamento dati test
│   ├── platform/
│   │   └── registry.ts           # PlatformRegistry: interfaccia + impl SQLite (ADR-009, §6.6)
│   ├── game/
│   │   ├── round-manager.ts      # Apertura/chiusura round
│   │   ├── pick-processor.ts     # Validazione e registrazione pick
│   │   ├── rules.ts              # Regole (squadre bruciate, gironi)
│   │   ├── elimination.ts        # Logica eliminazione
│   │   ├── winner.ts             # Determinazione vincitore
│   │   ├── eligibility.ts        # Seam checkEligibility(ExternalIdentity) (ADR-008/009, §6.5)
│   │   ├── registration.ts       # autoJoinFromPick (RF-P5) + stub @deprecated (rimossi nel Task 10)
│   │   ├── simulation.ts         # Simulazione seeded full/round (mulberry32, clock derivato dai dati)
│   │   └── scheduler.ts          # Automazione round via cron (solo produzione)
│   ├── channel/
│   │   ├── adapter.ts            # Interfaccia ChannelAdapter
│   │   ├── email-adapter/
│   │   │   ├── index.ts          # EmailAdapter: implementazione concreta (fetch+send)
│   │   │   ├── imap-client.ts    # Ricezione email (imapflow) — seam: conn passata dal chiamante
│   │   │   ├── message-router.ts # Normalizzazione identità + {kind:'classified', identity, body} (ADR-009)
│   │   │   └── smtp-client.ts    # Invio email (nodemailer) — seam: transport passato dal chiamante
│   │   └── email-processor.ts    # Wiring channel:email:process: fetch → router → Intent Classifier →
│   │                             # subscribe/unsubscribe (registry) / pick (auto-join + moduli di gioco);
│   │                             # flag \Seen a successo (D7); mittenti attivi rivalutati per messaggio
│   ├── llm/
│   │   ├── parser.ts             # LLM: email → {team, outcome} (interfaccia + impl OpenAI)
│   │   ├── intent-classifier.ts  # LLM: email → {intent, pick} in UNA chiamata (ADR-009, §6.2)
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
│       │                         # dai config e li inietta nel GameContext; espone anche il wiring del registry
│       ├── commands/
│       │   ├── round.ts          # round:open, round:close, round:score, round:status, round:deadline
│       │   ├── pick.ts           # pick:validate, pick:register, pick:list
│       │   ├── rules.ts          # rules:burned-teams, rules:available-teams, rules:check-half
│       │   ├── elimination.ts    # elimination:check, elimination:list
│       │   ├── winner.ts         # winner:check
│       │   ├── llm.ts            # llm:parse, llm:classify, llm:generate
│       │   ├── channel.ts        # channel:email:fetch, channel:email:process (migra ENTRAMBI i DB), channel:email:send
│       │   ├── platform.ts       # platform:migrate, platform:register, platform:unregister, platform:list (ADR-009)
│       │   ├── tournament.ts     # tournament:start (broadcast tournament_open), tournament:status, tournament:history,
│       │   │                     # tournament:leaderboard, tournament:export (senza register:open/close/register, ADR-009)
│       │   ├── data.ts           # data:import, data:refresh, data:calendar, data:results
│       │   ├── scheduler.ts      # scheduler:tick, scheduler:status (senza azioni finestra iscrizione)
│       │   └── simulate.ts       # simulate:full, simulate:round (PLATFORM_DB_PATH dedicato + guardia)
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

### 6.2 LLM Parser e Intent Classifier

> **Emendamento ADR-011 (nome del giocatore, RF-P1).** L'output della classificazione diventa `{intent, pick, name?}`: `name` è il nome del giocatore dedotto dalla mail di REGISTRAZIONE (valorizzato SOLO per `subscribe`, null altrimenti). Il prompt del classificatore istruisce a dedurlo (es. "mi chiamo Mario e voglio iscrivermi" → `"name": "Mario"`); senza nome nel testo → `null` (il sistema usa l'email al posto del nome).
>
> **Emendamento ADR-014 (email v3 Parte B, parser deterministico).** `LLMIntentClassifier` ha due implementazioni selezionate da `AI_EMAIL_PARSER` (default `false`): `OpenAIIntentClassifier` (LLM, invariato) e `DeterministicIntentClassifier` (`src/llm/deterministic-parser.ts`) con FORMULE UNIVOCHE riconosciute nel subject (`opts.subject`) O nel corpo — `ISCRIZIONE [NOME]` (nome a fine riga, trim, max 40 char), `DISISCRIZIONE`, `<TEAM> <ESITO>` (lista canonica + tabella alias, longest-match, normalizzazione maiuscole/accenti; sinonimi esito); altrimenti `other`. Le formule libere ("voglio iscrivermi") NON sono riconosciute; l'istruzione d'iscrizione ovunque è `ISCRIZIONE [NOME]` (sostituisce la vecchia "dici voglio iscrivermi"). Con `AI_EMAIL_PARSER=true` l'LLM è avvolto da `FallbackIntentClassifier` (su `LLMError` → deterministico, batch continua). `IncomingMessage.subject` è plumbato dal router.

```typescript
// Definito UNA volta in src/llm/parser.ts e riusato da game/registration.ts
// (auto-join RF-P5; re-export come ParsedPickContent per compatibilità).
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

// --- Intent Classifier (ADR-009, RF-P1/P2; src/llm/intent-classifier.ts) ---
// UNA sola chiamata LLM per messaggio: intento + estrazione del pick (stesso
// vincolo json_object e lista canonica iniettata, ADR-004). La barriera
// deterministica esatta sul pick resta (qui e nel Pick Processor, doppia barriera).

type MessageIntent = 'subscribe' | 'unsubscribe' | 'pick' | 'other';

interface IntentClassification {
  intent: MessageIntent;
  pick: PickExtraction | null;  // valorizzato solo quando intent = 'pick'
}

interface LLMIntentClassifier {
  classify(body: string, opts: PickParseOptions): Promise<IntentClassification>;
}
```

**Prompt e output vincolato (classificatore):**
- Il prompt include: il testo dell'email + la lista canonica delle squadre da `SeasonDataProvider.getTeams()` (data-driven) + il contenuto di `src/llm/team-aliases.md`; il contratto chiede `{ intent, pick }` con `json_object`
- Output vincolato: `team` come esatto nome canonico dalla lista (JSON schema/enum se supportato dall'API); ambiguo/non riconducibile → `null`
- **Contratto d'errore (D3):** il Classificatore NON lancia mai eccezioni per il *contenuto* (email ambigua, output non-JSON, squadra fuori lista) → intento `other`/`pick: null`; lancia `LLMError` (src/llm/openai-client.ts) SOLO per problemi di trasporto/HTTP/timeout/body malformato — il wiring tratta `LLMError` come "non processato, resta non letto, retry al tick successivo" (stop batch, D7)
- **Doppia barriera (D2/C):** il filtro deterministico esatto (team non nella lista → `pick: null`) vive nel classificatore (confine I/O, ADR-004); il check esatto del Game Engine (Pick Processor, passo 2 della cascata → motivo `unknown_team`) resta come seconda barriera di difesa in profondità
- `OpenAIParser` resta per `llm:parse` (riusa internamente il classificatore dove possibile); il corpo/mittente vuoto è gestito PRIMA della chiamata LLM dal router/wiring (`unknown`), mai dal classificatore

**Prompt e output vincolato:**
- Il prompt include: il testo dell'email + la lista canonica delle squadre da `SeasonDataProvider.getTeams()` (data-driven: i cambi di squadra stagionali non richiedono modifiche al codice) + il contenuto di `src/llm/team-aliases.md` (file Markdown editabile a mano con alias noti, es. "Juve → Juventus FC"; è una risorsa del prompt, non codice)
- Output vincolato: `team` come esatto nome canonico dalla lista (JSON schema/enum se supportato dall'API); ambiguo/non riconducibile → `null`
- **Contratto d'errore (D3):** il Parser NON lancia mai eccezioni per il *contenuto* (email ambigua, output non-JSON, squadra fuori lista) → `null`; lancia `LLMError` (src/llm/openai-client.ts) SOLO per problemi di trasporto/HTTP/timeout/body malformato — il wiring tratta `LLMError` come "non processato, resta non letto, retry al tick successivo"
- **Doppia barriera (D2/C):** il filtro deterministico esatto (team non nella lista → `null`) vive nel Parser (confine I/O, ADR-004: nessun nome spurio esce dall'I/O); il check esatto del Game Engine (Pick Processor, passo 2 della cascata → motivo `unknown_team`) resta come seconda barriera di difesa in profondità
- **Check deterministico post-parse** lato Game Engine: solo exact-match sulla lista canonica, altrimenti trattato come `null` (rifiuto con richiesta di chiarimento al giocatore). Nessun nome inventato entra nello stato di gioco

### 6.3 LLM Generator

> **Emendamento ADR-011 (email v2), ADR-013 (email v3, plain-text senza riquadri) e ADR-015 (email v4).** L'LLM produce SOLO il testo NARRATIVO (2-4 frasi brevi, tono entusiasta); il corpo completo è composto DETERMINISTICAMENTE dal renderer di canale `src/llm/email-renderer.ts` attorno alla narrativa: header con coppia UMANA "Round del torneo N · Turno di Campionato M" (mai sigle TT/TC nelle mail), **sezioni a righe con titolo emoji + MAIUSCOLO** (esito ✅/❌, deadline+countdown, squadre già usate, partite/risultati, stato aggregato — NIENTE riquadri ASCII), messaggio chiave `keyMessage(ctx)` in MAIUSCOLO, sezioni dati e CTA per tipo. Il countdown è calcolato DAL SISTEMA con `formatRemaining(now, deadline)` (src/game/round-time.ts, clock iniettato — mai dall'LLM né dal renderer, RNF1). Le mail di esito hanno soggetti NEUTRI ("Esito Round"); MAI elenchi nominativi di partecipanti (solo conteggi), **con carve-out ADR-015** per i soli tipi retrospettivi `round_closed_survived` e `tournament_closed` (sezione `👥 GIOCATORI DEL ROUND` / `📜 STORICO DEL TORNEO` dai campi `players`/`tournamentHistory`). Email v4 aggiunge inoltre la sezione co-vincitori `🤝 HAI CONDIVISO LA VITTORIA CON` (`coWinners`) e il nuovo tipo `tournament_closed`. La narrativa è prodotta da `DeterministicGenerator` (default) o dall'LLM con fallback (`AI_EMAIL_GENERATOR`, ADR-013). Il vecchio prompt-set V1 è stato RIMOSSO (2026-08-23). Canale email = SOLO text/plain (niente HTML né riquadri).

```typescript
type EmailType = 
  | "platform_registered"          // conferma iscrizione piattaforma (RF-P1, ADR-009)
  | "platform_unsubscribe_confirm" // barriera due passi: primo unsubscribe → pending_unsubscribe (RF-P2)
  | "platform_unsubscribed"        // soft-delete confermata (secondo messaggio, RF-P2)
  | "platform_already_registered"  // re-iscrizione da account già active: "già iscritto" (RF-P1, ADR-010)
  | "tournament_open"              // apertura torneo: SOLO annuncio (ADR-011), iscritti attivi (RF-P6)
  | "pick_instructions"
  | "pick_confirmed"               // conferma pick; per l'auto-join è l'UNICO messaggio (RF-P5, D5)
  | "pick_rejected"
  | "pick_missing_elimination"
  | "round_result_correct"
  | "round_result_wrong"
  | "pick_postponed"
  | "round_closed_survived"        // riepilogo chiusura round ai SOLI sopravvissuti (RF-P6)
  | "tournament_won"
  | "tournament_shared_win"
  | "clarification"                // ADR-011 (Task 7): messaggio non interpretabile (soggetto "Non ho capito")
  | "tournament_closed";           // ADR-015 (email v4): chiusura torneo con storico per-round a TUTTI i partecipanti

// RIMOSSI rispetto a v0.4.0 (ADR-009): "welcome", "registration_open_invite",
// "auto_registered", "round_closed_eliminated".

interface EmailContext {
  type: EmailType;
  playerName?: string;
  round?: number;              // round del TORNEO (ex tt), iniettato (ADR-008, RF-25); reso "Round del torneo N" dal renderer
  championshipRound?: number;  // turno di CAMPIONATO (ex tc), iniettato; reso "Turno di Campionato M"
  roundStart?: Date;           // inizio del round (kickoff prima partita)
  deadline?: Date;
  deadlineRemaining?: string;  // countdown pre-calcolato dal Game Engine (formatRemaining, RNF1)
  subject?: string;            // oggetto esplicito opzionale (D1): se assente lo compone subjectFor(ctx)
  team?: string;
  outcome?: string;
  reason?: string;
  availableTeams?: string[];
  burnedTeams?: { team: string; round: number }[]; // squadre già usate + round di utilizzo (sezione dedicata)
  matches?: { home: string; away: string; date: Date; score?: { home: number; away: number }; postponed?: boolean }[];
  inGameCount?: number;        // conteggi AGGREGATI (mai elenchi nominativi)
  eliminatedWrong?: number;
  eliminatedMissing?: number;
  platformCount?: number;      // iscritti alla piattaforma (annuncio apertura torneo)
  playerResult?: "correct" | "wrong" | "missing";
  players?: EmailPlayerResult[];      // ADR-015: elenco giocatori del round (round_closed_survived/tournament_closed)
  coWinners?: string[];               // ADR-015: nomi degli ALTRI vincitori (tournament_shared_win)
  tournamentHistory?: EmailTournamentRound[]; // ADR-015: storico per-round (tournament_closed)
}

// ADR-015 (email v4): partecipante in un elenco retrospettivo; nome con fallback sull'email.
interface EmailPlayerResult {
  name: string;
  team?: string;              // squadra del pick (assente = nessun pick)
  outcome?: string;           // win|draw|lose (assente = nessun pick)
  eliminated: boolean;        // true = eliminato IN QUESTO round
}

// ADR-015 (email v4): storico per-round del torneo (riusa EmailPlayerResult).
interface EmailTournamentRound {
  round: number;              // TT
  championshipRound: number;  // TC
  players: EmailPlayerResult[];
}

interface LLMGenerator {
  generate(ctx: EmailContext): Promise<string>;
}
```

> **Coppia umana (ADR-011, emendata ADR-015):** `round`/`championshipRound` sono i numeri di torneo/campionato iniettati dal Game Engine (ADR-008). **Nessun numero di turno entra nel prompt** (ADR-004, D4): la coppia è scritta dal renderer in forma umana "Round del torneo N · Turno di Campionato M" (label dedicate `roundHeaderLabel`/`championshipHeaderLabel`; il box bruciate resta "(Round N)"); le forme compatte TT2TC7 restano SOLO per log/CLI (src/game/turn.ts, invariato).
>
> **Soggetto (D1, emendato ADR-013/ADR-015):** composto DETERMINISTICAMENTE dal chiamante con l'helper `subjectFor(ctx)` — forma `⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - {etichetta}` (TC assente → `⚽🏆SURVIVOR LEAGUE🏆⚽ - {etichetta}`); il soggetto porta il SOLO turno di campionato, la coppia "Round del torneo N · Turno di Campionato M" resta nel corpo. Etichette iper-condensate e NEUTRE per gli esiti ("Esito Round", convenzione 4); `tournament_closed` non porta il turno ("Chiusura Torneo"); mai dall'LLM, mai numeri inventati. `ctx.subject` permette a un chiamante di fornire un oggetto esplicito (priorità).
>
> **Formato date nei testi (D9/ADR-011):** le date sono istanti UTC; i testi email le mostrano con `formatItDate(date, timeZone)` nel FUSO DI SISTEMA (`TIMEZONE`, default Europe/Rome, validato al boot) — fuso esplicito = determinismo (RNF1). Il fuso conta SOLO nella comunicazione verso l'esterno (email e log): le decisioni di gioco restano su UTC.
>
> **Errori (D3):** problemi di trasporto/HTTP → `LLMError` rilanciata (mai silenziosa: il chiamante decide se notificare); nessuna eccezione su contenuto (la narrativa è incastonata deterministicamente nel corpo dal renderer, mai validata in modo bloccante).

### 6.4 ChannelAdapter

> **Emendamento ADR-011/ADR-013 (principio "resa = canale, dati = canale-agnostici").** La RESA dei testi appartiene al CANALE: il renderer `src/llm/email-renderer.ts` è il renderer DEDICATO del canale email (header/sezioni/CTA deterministici attorno alla narrativa). Il Game Engine compone SOLO `EmailContext` (dati) e chiama `generator.generate` + `channel.sendMessage` (flusso invariato): un futuro WebAdapter riusa gli stessi dati con un renderer dedicato, senza toccare la logica di gioco. Il banner TEST MODE anteposto dall'EmailAdapter resta indipendente dal corpo e si preserva automaticamente.

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
- **POC (ADR-009)** — il gate legge lo stato dell'account dal **Platform Registry** (§6.6): account `active` → `{ eligible: true }`; account `pending_unsubscribe`/`unsubscribed` o sconosciuto → `{ eligible: false, reason: 'account_not_active' }`. È la **seam** che in Fase 1 ospiterà il controllo quota (`ENTRY_FEE_EUR`, LLD §4.1: attivo + pagato)
- **Override US10** — gli override del commissioner passano per la stessa funzione: il comando CLI specifica esito forzato + motivo (`--reason` obbligatorio, audit) e la chiamata resta registrata nei log

**Uso nel flusso (PRD §4.1, US10):** l'auto-join (RF-P5) invoca `checkEligibility` prima di creare il profilo; esito negativo → rifiuto con `reason`.

### 6.6 PlatformRegistry (ADR-009)

```typescript
// src/platform/registry.ts — interfaccia astratta + impl SQLite (DbPlatformRegistry).
// Sorgente degli account piattaforma; SOLO LETTA dai flussi di torneo (gate):
// nessuna transazione cross-DB (ADR-009, RF-P7).

type PlatformAccountStatus = 'active' | 'pending_unsubscribe' | 'unsubscribed';

interface PlatformAccount {
  registerId: number;       // registerID INTERNO STABILE (riusato alla re-iscrizione, RF-P3)
  email: string;
  name: string | null;      // ADR-011 (RF-P1): nome dedotto dalla mail di registrazione; null → si usa l'email
  status: PlatformAccountStatus;
  createdAt: string;        // clock iniettato (RF-P8, RNF1)
  unsubscribedAt: string | null;
}

interface PlatformRegistry {
  /** Crea/riattiva l'account (stesso registerID, RF-P1/P3); già active → invariato. */
  register(email: string, now: Date): PlatformAccount;
  /** Soft-delete DIRETTO (CLI platform:unregister, RF-P2): status → unsubscribed. */
  unregister(email: string, now: Date, reason?: string): PlatformAccount | null;
  /** Primo unsubscribe via email (RF-P2): active → pending_unsubscribe. */
  beginUnsubscribe(email: string, now: Date): PlatformAccount | null;
  /** Secondo unsubscribe (RF-P2): pending_unsubscribe → unsubscribed (soft-delete). */
  confirmUnsubscribe(email: string, now: Date): PlatformAccount | null;
  /** Ritorno ad active da pending_unsubscribe/unsubscribed (stesso registerID, RF-P3). */
  reactivate(email: string, now: Date): PlatformAccount | null;
  /** Lookup per email (null se mai iscritto). */
  find(email: string): PlatformAccount | null;
  /** Email degli account SOLO active (destinatari notifiche, RF-P6). */
  activeEmails(): string[];
  /** Tutti gli account, ordinati per register_id (vista CLI platform:list). */
  list(): PlatformAccount[];
}
```

**Vincoli (RF-P2):** il primo unsubscribe non elimina MAI: `beginUnsubscribe` → `pending_unsubscribe` + `unsubscribed_at` NULL; `confirmUnsubscribe` soft-delete SOLO da `pending_unsubscribe` (imposta `unsubscribed_at` dal clock iniettato); `unsubscribe` da `unsubscribed`/sconosciuto → `null` (log silenzioso nel chiamante); `register`/`reactivate` da qualunque stato → `active` con lo **stesso** `registerID`. Tutti i metodi ricevono `now` esplicito (RF-P8): mai `datetime('now')` né `new Date()`.

---

## 7. Comandi CLI

Ogni componente del sistema espone comandi CLI dedicati. I comandi sono organizzati in tre livelli: setup, operazioni atomice di componente, e operazioni composte di alto livello.

### 7.1 Setup

```bash
npm run db:migrate                            # Crea/migra le tabelle del DB TORNEO (DB_PATH)
npm run cli -- platform:migrate               # Crea/migra le tabelle del DB PIATTAFORMA (PLATFORM_DB_PATH, ADR-009)
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

> **Emendamento ADR-011 (chiusura automatica e completa) e ADR-015 (email v4).** `checkWinner` resta SOLA LETTURA e senza gate sullo stato; il Round Manager espone l'hook `settleWinnerIfNeeded` (invocato dopo `closeRound` e dopo `scoreRound`) che, alla identificazione del/i vincitore/i, esegue in sequenza: guardia atomica idempotente (`tournament_state.winner_notified = 1` + `finished_at` dal clock — migrazioni additive), notifica ai vincitori (`tournament_won`/`tournament_shared_win` con la lista `coWinners` degli altri vincitori, best-effort per destinatario con filtro account `active`), notifica di chiusura `tournament_closed` con lo storico per-round a TUTTI i partecipanti (profili con almeno un pick, vincitori inclusi — ADR-015), EXPORT AUTOMATICO (riuso di `tournamentExport` → file JSON in `TOURNAMENT_EXPORT_DIR`, filename dal clock iniettato — archivio per il reset) e inibizione dello scheduler (`computeActions` → `[]` a torneo chiuso). `tournament:start` è RIAMMISSIBILE su torneo chiuso: reset atomico del DB di GIOCO (pick/profile/player/round_state) + reset di `tournament_state`; il DB piattaforma non è toccato (ADR-009). `winner:check` resta invocabile in qualunque momento, anche a torneo ultimato (stesso risultato della chiusura, senza side-effect); dopo il reset, lo storico del torneo precedente è consultabile SOLO nell'export automatico. La rimozione della riga crontab fisica a torneo chiuso resta attività operativa del commissioner (guida test-mode).

```bash
npm run cli -- winner:check                   # Verifica se il torneo è finito (SOLA LETTURA). Output: JSON {finished, winners, case}
```

### 7.8 LLM Adapter

```bash
npm run cli -- llm:parse --input <text> [--mode <llm|deterministic>]
                                               # Estrae {team, outcome} da testo libero. Output: JSON.
                                               # Lista canonica da getTeams() (DB reale) + contenuto di
                                               # team-aliases.md iniettati per chiamata; DB vuoto → lista
                                               # vuota → {team: null} con messaggio chiaro. --mode forza
                                               # llm o deterministic (default = AI_EMAIL_PARSER, ADR-014)
npm run cli -- llm:classify --input <json> [--mode <llm|deterministic>]
                                               # Classifica {intent, pick, name} da JSON {"intent": "...", "pick": {...}}
                                               # o testo: LLM (ADR-009, RF-P1/P2) o deterministico con formule
                                               # univoche (ADR-014); output JSON {intent: subscribe|unsubscribe|pick|other, pick, name}
                                               # --mode forza llm o deterministic (default = AI_EMAIL_PARSER)
npm run cli -- llm:generate --type <email-type> [--player-name <name>] [--tt <n>] [--tc <n>] [--team <name>] [--outcome <outcome>] [--reason <text>] [--deadline <datetime>] [--available-teams <comma,sep>] [--mode <llm|deterministic>]
                                               # Genera email da contesto strutturato. Output: SOGGETTO
                                               # (subjectFor: "⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - {etichetta}",
                                               # ADR-013) + corpo renderizzato (header/sezioni/CTA deterministici
                                               # attorno alla narrativa, date nel TIMEZONE di sistema). --mode
                                               # forza llm o deterministic (default = AI_EMAIL_GENERATOR)
```

### 7.9 Channel Adapter

```bash
npm run cli -- channel:email:fetch             # Recupera email non lette dalla casella IMAP. Output: JSON array
npm run cli -- channel:email:process           # Fetch + processa (intento LLM: subscribe/unsubscribe/pick) tutte le
                                               # email non lette. Migra ENTRAMBI i DB (torneo + piattaforma, ADR-009)
npm run cli -- channel:email:send --to <email> --subject <subject> --body <text>
                                               # Invia un'email via SMTP
```

### 7.10 Piattaforma (ADR-009)

```bash
npm run cli -- platform:register --email <email> [--name <name>] [--reason <motivo>]
                                               # UNICO comando di creazione account (RF-P1): NON crea profili.
                                               # Crea/riattiva l'account con registerID stabile; --reason auditato
npm run cli -- platform:unregister --email <email> [--reason <motivo>]
                                               # Soft-delete DIRETTO dell'account (RF-P2, US8): status → unsubscribed
                                               # con unsubscribed_at dal clock iniettato; il profilo torneo resta intatto
npm run cli -- platform:list [--json]          # Elenco account (registerID, email, status, created_at, unsubscribed_at)
                                               # ordinato per registerID (US7)
```

### 7.11 Torneo (vista aggregata)

```bash
npm run cli -- tournament:start [--start-round <n>]   # Avvia la stagione (US6): verifica il calendario, esegue le operazioni
                                                      # preliminari (parametri data-driven, round in stato pending, stato stagione).
                                                      # --start-round <n> = aggancio del torneo a un TC arbitrario (RF-20, ADR-008; default 1).
                                                      # Validazioni RF-21: TC esistente, con partite, deadline TT1 futura → rifiuto atomico
                                                      # senza stato parziale; aggancio all'ultimo TC → warning informativo (CL12).
                                                      # DOPO le scritture atomiche invia il broadcast `tournament_open` a tutti gli
                                                      # account piattaforma active (RF-P6, ADR-009; no-op senza componenti email)
npm run cli -- tournament:status               # Stato torneo: round corrente, profili attivi/eliminati, conteggio iscritti
                                               # piattaforma (dal Platform Registry, ADR-009), vincitore; anomalie (RF-30).
                                               # NESSUNA "finestra di iscrizione" (deprecata)
npm run cli -- tournament:history <email>      # Storico pick di un profilo (output con coppia TT/TC)
npm run cli -- tournament:leaderboard          # Classifica profili ancora in gara (output con coppia TT/TC)
npm run cli -- tournament:export               # Dump JSON di tutte le tabelle + metadati (timestamp, parametri derivati,
                                               # start_round e mappatura TT/TC)
                                               # Usi: verifica del determinismo della simulazione (diff tra run),
                                               # trasparenza verso i giocatori, audit pre/post correzioni
```

**Comandi RIMOSSI (ADR-009):** `tournament:register:open`, `tournament:register:close`, `tournament:register` (deprecati nel Task 7 come stub, rimossi nel Task 10): non esiste più alcuna finestra di iscrizione e `platform:register` è l'unico comando di creazione account.

### 7.12 Simulazione

```bash
npm run cli -- simulate:full [--start-round <n>] [--seed <n>]   # Simula intera stagione 2025/26 (o dalla finestra [start_round..N] con
                                                                 # aggancio, ADR-008/RF-20: TT1 = start_round, pool/girone secondo i dati)
npm run cli -- simulate:round --round <n> [--seed <n>]          # Simula round singolo (open → close → score) sul TC n
```

- Seed del RNG deterministico (mulberry32, funzione pura) — default `42`; stessa
  seed + stesso clock + **DB piattaforma pulito** → `tournament:export` identici (RNF1).
- Il seed crea gli **account piattaforma** sintetici (`sim-XX@survivor.test`) via
  `PlatformRegistry.register` su un `PLATFORM_DB_PATH` **DEDICATO e distinto** da
  quello di produzione (mai `./data/platform.db`); i **profili** nascono via
  **auto-join al primo pick** del round di avvio (TT1) in `simulateRound`, NON più
  creati dal seed. Guardia: `simulate:*` rifiuta/avvisa se `PLATFORM_DB_PATH`
  coincide col valore di produzione. Clock di ogni fase DERIVATO dai dati
  (open/receivedAt a deadline − 1min, close a deadline + 1min, score a
  tcClose + 1min) — mai orologio reale.
- Rifiuta su DB con `season_started=1` o con round non-pending (la simulazione
  richiede un DB senza stato di gioco). I comandi `simulate:*` costruiscono il
  contesto SENZA canale/generatore email (R1): nessuna notifica reale.

### 7.13 Scheduler (solo produzione)

```bash
npm run cli -- scheduler:tick                   # Orchestratore sottile: verifica quali azioni eseguire in base al
                                                # calendario e allo stato dei round (open/close/score; chiusura di sicurezza
                                                # allo scadere del TC se deadline NULL — log safety_close, RF-30).
                                                # Non contiene logica di gioco; invoca i comandi del Game Engine. Idempotente.
                                                # Esce senza effetti se SCHEDULER_ENABLED=false (sviluppo/test).
npm run cli -- scheduler:status                 # Mostra lo stato COMPUTATO dello scheduler (R5: nessuna "ultima
                                                # esecuzione" persistita — l'audit sta nel log pino): round, anomalie
                                                # (deadline mancanti, RF-30) e prossime azioni. NESSUN campo
                                                # registrationOpen (ADR-009; al suo posto il conteggio iscritti dal registry).
```

In produzione, `scheduler:tick` è invocato ogni minuto da cron. In sviluppo (`SCHEDULER_ENABLED=false`), il comando esiste ma non esegue azioni automatiche — il commissioner usa i comandi manuali (`round:open`, `round:close`, `round:score`, `platform:*`).

### 7.14 Principi di design per i comandi

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

**Finestra di iscrizione (RF-22/24/27/28, CL2/CL5):** — *superata da ADR-009 (v0.5.0); sostituita dalla sezione 8.2.*

**Chiusura forzata finestra pick (RF-29) e guard anti-frode (RF-31, CL17/CL18):**
- `round:close --force --reason` anticipata: consolidamento immediato (eliminazioni `missing_pick` + notifiche)
- pick dopo il fischio d'inizio effettivo con deadline NULL → respinto (guard anti-frode)
- pick dopo il kickoff effettivo con deadline nominale più tarda (anticipo di calendario, CL18) → respinto; rimedio = override US10 `--reason`
- `round:close --force` senza `--reason` → comando rifiutato (audit obbligatorio)

**Chiusura di sicurezza (RF-30):**
- deadline NULL → consolidamento alla chiusura del TC con log `safety_close` (causa `deadline_missing`); nessun pick accettato nel frattempo (guard attivo)
- chiusura TC non calcolabile → nessuna auto-chiusura, log `warn` + anomalia in `tournament:status`, uscita via chiusura forzata

**Comunicazione e audit (RF-25, ADR-008):**
- coppia (tt, tc) presente in email (forma estesa), log strutturati `{tt, tc}` e output CLI (forma compatta)
- coppia iniettata deterministicamente nei template: il numero nel testo email proviene dai dati, mai dall'LLM (ADR-004)
- eligibilità invocata e loggata a ogni auto-join (seam POC = account `active`)
- override con `--reason` auditato (pick fuori accettazione)

**Regressione:** simulazione full-season da TC 1 (nessun aggancio) con esito invariato rispetto al comportamento legacy (CS3); `tournament:export` identico a parità di seed (RNF1).

### 8.2 Casi di test dell'iscrizione piattaforma (ADR-009, PRD RF-P1…P8 / CL2/CL5)

**Platform Registry (unit, TDD — Task 5):**
- `register` nuovo mittente → account `active` con `register_id` stabile e `created_at` = clock iniettato (RF-P8)
- `register` su email esistente `unsubscribed` → riattiva `active` con lo **stesso** `register_id` (RF-P3)
- unsubscribe a due passi: `beginUnsubscribe` → `pending_unsubscribe` (nessuna soft-delete); `confirmUnsubscribe` → `unsubscribed` con `unsubscribed_at` dal clock (RF-P2)
- `reactivate` da `pending_unsubscribe`/`unsubscribed` → `active`, stesso `register_id`
- `unsubscribe` da `unsubscribed`/sconosciuto → `null` (log silenzioso nel chiamante)
- `activeEmails()` restituisce SOLO account `active`; `list()` ordinata per `register_id`
- migrazione `platform:migrate` idempotente (riesecuzione no-op)

**Intent Classifier (contract, Task 6):**
- una chiamata LLM per messaggio (fetch mockato): prompt contiene lista canonica + alias
- classi di messaggi → intento: iscrizione → `subscribe`, disiscrizione → `unsubscribe`, pick → `pick` (con estrazione), resto → `other`
- contenuto ambiguo/malformato → `other`/`pick: null` SENZA eccezioni (CS7); trasporto/HTTP → `LLMError`
- filtro esatto sul pick: squadra fuori lista → `pick: null`
- contract test dedicato per il comando `llm:classify --input`

**Eligibilità + auto-join (unit/integration, Task 7):**
- account `active` senza profilo + pick valido nel TT1 → profilo + pick atomici, risposta `pick_confirmed` (RF-P5)
- pick invalido nel TT1 → rollback senza profilo (nessun profilo orfano)
- pick da iscritto senza profilo dopo il TT1 → rifiuto con risposta
- `register_id` replicato su `player`/`profile` alla creazione
- `pick:register` (CLI) risolve l'email e verifica account `active` (nessun bypass del gate)

**Wiring email (integration, Task 8):**
- subscribe → `platform_registered`; già `active` → "già iscritto"; da `pending_unsubscribe`/`unsubscribed` → riattiva con stesso `register_id`
- unsubscribe (primo) → `pending_unsubscribe` + `platform_unsubscribe_confirm`; secondo (intento o body `confermo`/`sì`/`si`/`yes`) → `unsubscribed` + `platform_unsubscribed`
- unsubscribe da `unsubscribed`/sconosciuto → log silenzioso, marcato letto
- pick da sconosciuto/disiscritto → log interno, nessuna risposta (RF-P4)
- subscribe+pick dello stesso mittente nello stesso batch → il pick vede l'account appena attivato (mittenti attivi rivalutati per messaggio, HIGH-2)
- disiscrizione a torneo in corso: profilo intatto, nessuna email al disiscritto; re-iscrizione prima della deadline → stesso profilo
- `LLMError` → stop batch invariato (D7)

**Notifiche filtrate (unit/integration, Task 9):**
- `tournament:start` → `tournament_open` a tutti gli `activeEmails()` (una sola volta); no-op senza componenti email
- `round:open` → `pick_instructions` ai soli partecipanti attivi (`eliminated = 0`) con account `active`; **all'apertura del TT 1 anche agli account `active` SENZA profilo** (emendamento RF-P6, 2026-08-21), con dedup sulle email dei profili
- `round:close` → `pick_missing_elimination` ai soli account `active`
- `round:score` → `round_result_correct`/`round_result_wrong` ai soli account `active`; alla transizione `closed→scored` `round_closed_survived` ai soli sopravvissuti con `summary_sent = 1` (con l'elenco `players` dei partecipanti del round, ADR-015); riapertura `round:score` → nessun ri-invio (idempotente)
- chiusura automatica → `tournament_won`/`tournament_shared_win` ai vincitori (con `coWinners`, ADR-015) + `tournament_closed` a TUTTI i partecipanti (profili con almeno un pick, vincitori inclusi), UNA sola volta
- `unsubscribed` e `pending_unsubscribe` esclusi da OGNI email; nessun `round_closed_eliminated`, nessun criterio `eliminated_at >= opened_at`

**Scheduler + simulazione (Task 10):**
- nessuna azione `register_close_auto`/`register_close_safety`; `scheduler:status` senza `registrationOpen` (con conteggio iscritti dal registry)
- `simulate:*` crea account piattaforma (registry) e profili via auto-join al TT1; export deterministici a parità di seed con DB piattaforma pulito (RNF1)
- guardia `simulate:*`: rifiuto/avviso se `PLATFORM_DB_PATH` coincide col valore di produzione