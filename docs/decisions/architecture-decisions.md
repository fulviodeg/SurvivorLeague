# Architecture Decision Records — Survivor League (POC)

> **Uso.** Questo file riepilogativo raccoglie le decisioni significative e difficili da invertire del progetto in un unico log append-only. Il BRIEF è un documento storico congelato (2026-08-11): per le scelte valgono i documenti di design (PRD/HLD/LLD) e queste ADR, che conservano contesto, decisione, alternative e conseguenze per evitare di ri-deciderle.
>
> **Formato.** Ogni ADR segue: Stato · Data · Contesto · Decisione · Alternative considerate · Conseguenze.

**Indice delle ADR:**

| ID | Titolo | Stato |
|----|--------|-------|
| [ADR-001](#adr-001-receivedat-come-timestamp-autorevole-per-la-deadline) | `receivedAt` come timestamp autorevole per la deadline | Accepted (2026-08-12) |
| [ADR-002](#adr-002-partite-sospese-trattate-come-rinviate) | Partite sospese trattate come rinviate | Accepted (2026-08-12) |
| [ADR-003](#adr-003-contabilizzazione-incrementale-e-scheduler-sottile) | Contabilizzazione incrementale + scheduler sottile | Accepted (2026-08-12) |
| [ADR-004](#adr-004-game-engine-deterministico-e-llm-confinato-allio) | Game Engine deterministico + LLM confinato all'I/O | Accepted (2026-08-11) |
| [ADR-005](#adr-005-provider-dati-designato-per-la-produzione-football-dataorg) | Provider dati designato per la produzione: football-data.org | Accepted (2026-08-13), integrata da ADR-007 |
| [ADR-006](#adr-006-tutti-i-componenti-gestibili-da-cli-per-orchestrazione-da-agente) | Tutti i componenti gestibili da CLI per orchestrazione da agente | Accepted (2026-08-13) |
| [ADR-007](#adr-007-import-dati-via-api-football-dataorg-anche-nella-poc) | Import dati via API football-data.org anche nella POC | Accepted (2026-08-13) |
| [ADR-008](#adr-008-aggancio-asincrono-del-torneo-a-un-tc-arbitrario-e-forti-chiusure-garantite) | Aggancio asincrono del torneo a un TC arbitrario e chiusure garantite | Accepted (2026-08-14) |

---

## ADR-001: `receivedAt` come timestamp autorevole per la deadline

- **Status:** Accepted
- **Date:** 2026-08-12
- **Riferimenti:** PRD §5.3 · HLD §5.3, §7.2 · LLD §1.3, §3.1, §6.4 · Review §0.1 (HIGH-02)

**Contesto.** Per stabilire se un pick è entro la deadline serve un timestamp univoco. L'header `Date` dell'email è prodotto dalla catena di invio (client/SMTP del mittente), un servizio esterno non controllabile di cui non conosciamo la latenza di consegna; usarlo penalizzerebbe il giocatore per la latenza del polling e renderebbe il confronto non deterministico.

**Decisione.** Fa fede la **ricezione sul server** (`receivedAt`): l'istante in cui il server di posta ricevente registra il messaggio nella casella (per l'email: l'`internaldate` IMAP). Un pick è tempestivo se `receivedAt <= deadline`. La latenza del polling IMAP non penalizza il giocatore: conta l'arrivo in casella, non l'istante di elaborazione.

**Alternative considerate.**
- *Header `Date` dell'email* — scartato: timestamp di un servizio esterno non controllabile, consegna non predicibile.
- *Istante di elaborazione (poll)* — scartato: penalizzerebbe i pick inviati poco prima della deadline e processati dopo (latenza polling fino a 60s).

**Conseguenze.** Il confronto pick↔deadline è deterministico e equo. Serve registrare `receivedAt` alla ricezione (IMAP `internaldate`); il pipeline deve distinguere un pick arrivato in anticipo ma processato in ritardo da uno davvero tardivo (PRD US2/US3).

---

## ADR-002: Partite sospese trattate come rinviate

- **Status:** Accepted
- **Date:** 2026-08-12
- **Riferimenti:** PRD §5.4 · CL1 · HLD §6.4 · LLD §3.1 · Review §0.2 (MED-02)

**Contesto.** Il modello trattava solo le partite rinviate (`postponed`). Il caso "partita sospesa" (iniziata e interrotta, risultato non chiaro) restava non gestito; aggiungere uno stato `suspended` separato complessificava il modello senza valore per la POC.

**Decisione.** Per la POC una partita **sospesa è trattata come rinviata** ai fini del gioco: l'esito del pick non è determinabile finché il risultato finale non è chiaro. Il pick non è contabilizzabile e segue le regole dei rinvii (recupero entro la finestra del TC → CL7; fuori finestra → Freeze, CL1). Nessuna distinzione di stato nel modello.

**Alternative considerate.**
- *Stato `suspended` dedicato* — scartato per la POC: nessun beneficio di gioco, costo di modellazione; da valutare in Fase 1.

**Conseguenze.** `postponed = 1` (o equivalente) copre rinvii e sospese. Il comportamento del giocatore è chiaro e deterministico: non viene penalizzato, la squadra resta bruciata, il pick viene contabilizzato a recupero concluso.

---

## ADR-003: Contabilizzazione incrementale e scheduler sottile

- **Status:** Accepted
- **Date:** 2026-08-12
- **Riferimenti:** PRD §4.5, §5.4 · HLD §6.4 · LLD §1.1, §1.4, §3 · Review §0.3 (CRITICAL-02)

**Contesto.** La contabilizzazione batch "al TC close" presupponeva di sapere quando *tutti* i risultati del round sono disponibili, distinguendo "risultato non ancora arrivato" da "partita rinviata". Con un feed dati reale questo è fragile e può causare eliminazioni errate o attese indefinite.

**Decisione.** La contabilizzazione è **incrementale pickle-by-pick**: ogni pick viene valutato quando il risultato della singola partita è disponibile (punteggio presente = concluso; rinviata = Freeze; nessuno dei due = ancora in corso → resta `pending`). Il TT passa a `scored` quando tutti i pick sono in stato terminale (`correct`/`wrong`/`frozen`), anche prima della chiusura del TC. Lo **Scheduler è un orchestratore sottile**: decide *quando* agire, non *cosa*; tutta la logica di gioco vive nel Round Manager (`round:score`, idempotente).

**Alternative considerate.**
- *Metodo `areAllResultsFinal(round)` sul provider* — Superato: non serve sapere se tutti i risultati sono pronti. **Non va aggiunto** (marker esplicito).

**Conseguenze.** Non serve la completezza dell'intero round; i giocatori apprendono l'esito man mano che la propria partita si conclude, in modo equo (la squadra è scelta conoscendo l'orario). Separazione netta di responsabilità scheduler/Round Manager, con stessa interfaccia per automazione e operatore.

---

## ADR-004: Game Engine deterministico e LLM confinato all'I/O

- **Status:** Accepted
- **Date:** 2026-08-11
- **Riferimenti:** PRD §1.2, §6 (RF-07) · HLD §2, §5.1-5.2 · LLD §1.1, §1.2 · AGENTS.md (principio vincolante)

**Contesto.** Il nucleo del torneo (validazione pick, contabilizzazione, eliminazioni, vincitore) non può sbagliare: ogni esito deve essere deterministico e riproducibile. L'LLM è probabilistico. Mescolare i due domini renderebbe gli esiti di gioco non prevedibili.

**Decisione.** Il sistema è diviso in due domini: un **Game Engine deterministico** (regole, validazione, contabilizzazione, eliminazioni, vincitori) e un **LLM Adapter confinato al solo I/O** (parse del linguaggio naturale in `{team, outcome}` e generazione di email in italiano). L'LLM non prende mai decisioni di gioco e non accede allo stato del torneo; se l'estrazione è ambigua restituisce `null` e il pick viene respinto senza conseguenze irreversibili.

**Alternative considerate.**
- *LLM che valida anche le regole* — scartato: decisioni di gioco non riproducibili.
- *Rule-based puro per il parsing* — scartato: troppo rigido per il linguaggio naturale delle email.

**Conseguenze.** Un errore di parsing è recuperabile (refuso → rifiuto → riprova). La generazione di testo è separata e testabile indipendentemente. Nella POC la strategia di fallback per indisponibilità LLM (parser regex, template pre-generati) è rimandata alla produzione (rischio noto R1).

---

## ADR-005: Provider dati designato per la produzione: football-data.org

- **Status:** Accepted — *l'aspetto "POC con file statici / StaticProvider" è superato da ADR-007 (import diretto via API anche nella POC); resta valida la scelta di football-data.org come provider designato.*
- **Date:** 2026-08-13
- **Riferimenti:** PRD §13 (PO-1 risolta) · HLD §7 · LLD §6.1

**Contesto.** Nella POC i dati 2025/26 sono forniti da file statici (`StaticProvider`, `calendar.json`/`results.json`). Per la produzione (2026/27) serve un provider ufficiale di calendario e risultati con costi, rate limit e copertura noti.

**Decisione.** **football-data.org** è il provider designato come official per i dati Serie A in produzione (API v4, REST, `X-Auth-Token`, competition `SA`, season `2025`). La POC esporta da esso i dati storici 2025/26 per lo `StaticProvider`. Il sistema dialoga sempre con l'interfaccia astratta `SeasonDataProvider`: i dettagli operativi del provider (endpoint, rate limit, piani) sono documentati nell'LLD §6.1 e nella documentazione del provider.

**Alternative considerate.**
- *API-Football* — scartata: valutazione costi/copertura inferiore per Serie A.
- *Comunicato Ufficiale Lega Serie A (fonte diretta)* — riservata alla riconciliazione, non al consumo di massa.

**Conseguenze.** Senza SLA formale, in produzione è necessaria la **riconciliazione** con la fonte ufficiale (HIGH-06, MED-03) e una strategia di ripianificazione in caso di errori API, entrambe fuori scope POC. I dati non sono la fonte ufficiale: un risultato errato può richiedere ri-contabilizzazione (`round:rescore`, MED-03).

---

## ADR-006: Tutti i componenti gestibili da CLI per orchestrazione da agente

- **Status:** Accepted
- **Date:** 2026-08-13
- **Riferimenti:** PRD §4.8 · HLD §5 · LLD §7 (comandi CLI)

**Contesto.** Il sistema deve essere completamente governabile senza accesso al codice o al database: l'automazione (cron) e l'operatore (commissioner via SSH) devono usare gli **stessi entry point**, e in futuro un agente AI deve poter gestire e orchestrare un intero torneo solo invocando comandi.

**Decisione.** **Ogni componente espone comandi CLI dedicati**: non solo le operazioni di alto livello (avvio stagione, apertura/chiusura fase di iscrizione e round, contabilizzazione), ma anche i moduli interni del Game Engine, del LLM Adapter e del Channel Adapter. L'automazione in produzione e l'intervento manuale condividono la stessa interfaccia CLI; un agente orchestra il torneo componendo comandi atomici, senza mai toccare codice o database. L'LLD §7 definisce il catalogo comandi completo e i principi di design (output JSON, idempotenza, comandi di scrittura che restituiscono lo stato).

**Alternative considerate.**
- *Interfaccia di controllo proprietaria/diretta al DB* — scartata: renderebbe l'orchestrazione da agente non sicura e non standardizzabile.
- *Solo scheduler automatico senza CLI* — scartata: toglierebbe l'override manuale e la capacità di intervenire su anomalie.

**Conseguenze.** Sistema orchestrabile in toto da un agente in futuro; il commissioner conserva sempre il controllo umano. La CLI diventa il contratto operativo del sistema: nessuna logica di gioco fuori dal Game Engine, e nessun accesso diretto allo stato da parte dell'agente.

---

## ADR-007: Import dati via API football-data.org anche nella POC

- **Status:** Accepted
- **Date:** 2026-08-13
- **Riferimenti:** ADR-005 · LLD §4.3, §6.1, §7.2 · Piano di implementazione (tasks/plan.md, decisione 2)

**Contesto.** ADR-005 designava football-data.org come provider per la produzione, mentre la POC avrebbe usato file statici (`calendar.json`/`results.json`) esportati dall'API e letti da uno `StaticProvider`. Questo introduceva un'implementazione usa-e-getta, un formato intermedio da mantenere e un rischio di disallineamento tra il comportamento POC e quello di produzione. Inoltre i risultati durante il gioco richiedono comunque aggiornamenti periodici (`data:refresh`): con i file statici il refresh avrebbe richiesto rigenerazione manuale.

**Decisione.** Anche nella POC i dati della stagione 2025/26 arrivano **direttamente dall'API football-data.org**: i comandi `data:import` e `data:refresh` chiamano l'API (`GET /v4/competitions/{competition}/matches?season={season}`, header `X-Auth-Token`, token in env `FOOTBALL_DATA_TOKEN`, competizione/stagione in `FOOTBALL_DATA_COMPETITION`/`FOOTBALL_DATA_SEASON`) e fanno upsert nella tabella `match`. Il Game Engine legge **solo dal DB** tramite l'unica implementazione `DbSeasonDataProvider` dell'interfaccia `SeasonDataProvider`. Il client `FootballDataClient` è usato esclusivamente dai comandi `data:*` e gestisce il throttling leggendo gli header di risposta: `X-RequestsAvailable` (richieste residue) e `X-RequestCounter-Reset` (secondi alla reinizializzazione del contatore, da convertire in ms per l'attesa su 429). Lo `StaticProvider` non esiste.

**Alternative considerate.**
- *StaticProvider con file JSON esportati (ADR-005 originario)* — scartato: doppio formato dati da mantenere, refresh manuale dei risultati, implementazione non riusabile in produzione.
- *Game Engine che interroga direttamente l'API* — scartato: accoppierebbe la logica di gioco a un servizio esterno non deterministico e violerebbe la testabilità del Game Engine.

**Conseguenze.** La POC esercita lo stesso percorso dati della produzione (API → DB → Game Engine), riducendo le sorprese al passaggio in produzione. Serve il token API come env var (fornito dal PO, mai su disco né in git); il rate limit del free tier è mitigato da throttling su header e retry. Il DB SQLite diventa la single source of truth per calendario e risultati; i test usano `DbSeasonDataProvider` reale su SQLite in-memory con fixture sintetiche.

---

## ADR-008: Aggancio asincrono del torneo a un TC arbitrario e chiusure garantite

- **Status:** Accepted
- **Date:** 2026-08-14
- **Riferimenti:** PRD §2, §4.1-§4.4, §5.3-§5.4, RF-20…31, CL11–18 · HLD §6 · LLD §1.1, §1.4, §3, §3.1, §6, §7 · Piano `tasks/plan-aggancio-torneo-asincrono.md`

**Contesto.** Il modello originale legava l'avvio del torneo al TC 1 (il primo TT coincideva con il TC 1 e la finestra di iscrizione era chiusa manualmente dal commissioner, con `tournament:register:close`). Il PO richiede di poter **agganciare l'avvio del torneo a un TC arbitrario** della stagione (es. partire dal girone di ritorno, o a metà di un girone) e di rendere la finestra di iscrizione **ancorata alla deadline del primo TT** invece che a una chiusura manuale, formalizzando inoltre le operazioni di override e le situazioni limite (deadline non registrata, calendario che anticipa una partita). Il tutto restando nel dominio POC mono-torneo: un aggancio non introduce identità torneo composite né multi-torneo (Fase 1).

**Decisione.**

1. **Mappatura TT↔TC derivata, non persistita.** Si aggiunge a `tournament_state` la colonna `start_round INTEGER NULL` (= TC di partenza; `NULL` = comportamento legacy TC 1). Da quel valore si **deriva** sempre la mappatura `TT = TC − start_round + 1`; **nessuna colonna `tt`** viene aggiunta a `pick` o `round_state`. La mappatura è iniettata deterministicamente in ogni comunicazione (email), log strutturato (`{tt, tc}`) e output CLI; la coppia non viene mai generata dall'LLM (ADR-004).
2. **Finestra di iscrizione ancorata alla deadline del TT1.** La finestra è `[apertura torneo, deadline TT1]` e si chiude **da sola** alla deadline del TT1 (RF-04 + RF-13). `registration_open` resta il gate che si chiude automaticamente. Il commissioner dispone inoltre di **chiusure forzate auditate** per entrambe le finestre:
   - `tournament:register:close --reason <testo>`: chiude subito la finestra di iscrizione (prima della deadline TT1, o se la deadline TT1 non è registrata). Le finestre sono indipendenti: i pick restano accettati fino alla deadline del TT1.
   - `round:close --round <n> --force --reason <testo>`: chiude subito la finestra pick, prima della deadline o con deadline NULL. Semantica **identica** alla chiusura a deadline (consolidamento: elimina i profili senza pick valido, invia le notifiche); non esiste "chiudi senza eliminare".
   - Regola comune: `--reason` **obbligatorio e auditato** per ogni chiusura forzata; la chiusura a scheduler (a deadline) non richiede motivazione.
3. **Invariante anti-frode al kickoff effettivo.** Nessun pick è accettato se `receivedAt` > fischio d'inizio **effettivo** della prima partita del TC, indipendentemente dalla deadline registrata. L'accettazione è `min(deadline registrata, kickoff effettivo da dati correnti)`. Con la deadline nominale è ridondante (deadline = kickoff − anticipo); morde quando la deadline è NULL o errata, e quando il calendario anticipa una partita dopo l'apertura del round senza intervento del commissioner (prevale su RF-14). Rifiuto con motivo esplicito; rimedio = override US10 con `--reason`.
4. **Chiusura di sicurezza (consolidamento).** Se la deadline di un round non è registrata (`round_state.deadline` NULL) o non ha mai innescato l'auto-chiusura, lo scheduler chiude il round alla **chiusura del TC** (fine prevista UPP + scarto, PRD §5.4), ricalcolata dai dati correnti. Semantica identica alla chiusura a deadline; evento loggato come `safety_close` con causa `deadline_missing`. Stessa regola per la finestra di iscrizione (agganciata alla deadline del TT1). Se nemmeno la chiusura TC è calcolabile → nessuna auto-chiusura, log `warn` + anomalia esposta in `tournament:status`; uscita = chiusura forzata del commissioner. La chiusura di sicurezza non richiede `--reason` (è comportamento nominale di fallback, non un override).
5. **Eligibilità come seam.** Il Game Engine espone `checkEligibility(identity: ExternalIdentity) → { eligible: boolean; reason?: string }` con `ExternalIdentity { channel; identifier }` normalizzata dal ChannelAdapter (POC: `{channel:'email', identifier:<email>}`). Gate pre-registrazione; implementazione POC sempre `true` con log (Fase 1: controllo quota su `ENTRY_FEE_EUR`). L'override US10 passa per la stessa funzione con esito forzabile + motivo. Riformulare "l'email è l'identificativo del giocatore" in "l'identità è fornita dal canale; nella POC il canale è l'email".
6. **Override US10 auditato.** Iscrizione manuale e pick manuale fuori deadline ammessi **solo con motivazione** (`--reason` obbligatorio, log strutturato); pick manuale solo su round corrente **non contabilizzato**; round già `scored` → flusso di correzione CL9; **nessuna retroattività multi-round**; un nuovo iscritto via override parte dal round corrente con pool intatto (fairness dichiarata nel PRD).

**Alternative considerate.**
- *Colonna `tt` persistita su `pick`/`round_state`* — scartata: duplica una derivazione banale, rischio di disallineamento tra `start_round` e i `tt` persistiti dopo un override.
- *Torneo sempre da TC1 con iscrizioni "a finestra mobile" manuali* — scartata: non soddisfa l'aggancio a TC arbitrario e lascia la finestra di iscrizione dipendente dall'intervento umano.
- *Controllo anti-frode basato solo sulla deadline registrata (RF-14)* — scartato: con deadline NULL o errata, o con anticipi di calendario non gestiti, accetterebbe pick a partita iniziata.
- *Chiusura di sicurezza "chiudi senza eliminare"* — scartata: violerebbe RF-13 e il principio che alla chiusura della finestra i mancanti sono eliminati; il consolidamento tardivo non crea pick spuri perché l'accettazione è già bloccata dall'invariante anti-frode.
- *Auto-iscrizione "attiva per tutta la stagione"* — scartata: la finestra di iscrizione è chiusa alla deadline del TT1; dal TT2 un pick da sconosciuto è respinto senza registrazione (RF-24).

**Conseguenze.** Il torneo è agganciabile a qualunque TC della stagione senza cambi al modello dati oltre a `start_round`; la finestra di iscrizione e quella pick sono deterministiche e auto-chiudenti con fallback garantiti (safety close) e un invariante anti-frode indipendente dalla qualità della deadline registrata. Le chiusure forzate richiedono audit (`--reason`), come tutti gli override. La mappatura TT↔TC non è più presupponibile (niente più TC = TT): ogni comunicazione, log e output CLI deve portare la coppia `(tt, tc)`, iniettata deterministicamente nei template (ADR-004). La migrazione di `start_round` è additiva e idempotente (ALTER TABLE ADD COLUMN guardato), quindi non rompe i DB esistenti.

---

*Fine del log ADR.*
