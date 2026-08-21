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
| [ADR-009](#adr-009-iscrizione-a-livello-di-piattaforma-con-storage-separato-e-auto-join-al-tt1) | Iscrizione a livello di piattaforma con storage separato e auto-join al TT1 | Accepted (2026-08-20) |
| [ADR-010](#adr-010-chiarimenti-adr-009-post-revisione-2026-08-21) | Chiarimenti ADR-009 post-revisione 2026-08-21 | Accepted (2026-08-21) |

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
- **Riferimenti:** PRD §2, §4.1-§4.4, §5.3-§5.4, RF-20…31, CL11–18 · HLD §6 · LLD §1.1, §1.4, §3, §3.1, §6, §7 · Piano `tasks/aggancio-torneo-asincrono/plan-aggancio-torneo-asincrono.md`

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

## ADR-009: Iscrizione a livello di piattaforma con storage separato e auto-join al TT1

- **Status:** Accepted
- **Date:** 2026-08-20
- **Riferimenti:** PRD v0.6.0 (RF-P1…P8, §4.1/§4.7 riscritti) · HLD v0.5.0 (§2.2, §5, §6) · LLD v0.5.0 (§3, §4.2, §6, §7) · Piano `tasks/iscrizione-piattaforma/plan-iscrizione-piattaforma.md` §2 · ADR-004, ADR-006, ADR-008

**Contesto.** L'iscrizione viveva interamente nel DB di torneo (`player` + `profile`), gated da una finestra `registration_open` `[apertura torneo, deadline TT1]` gestita dal commissioner (RF-22/RF-28, ADR-008). L'analisi 2026-08-20 (`tasks/iscrizione-piattaforma/brainstorming-iscrizione-piattaforma.md` + review dell'utente) ha evidenziato che l'iscrizione è una relazione tra il **giocatore e la piattaforma** (stabile nel tempo, indipendente dai singoli tornei), non tra il giocatore e il torneo: serve un **modello a due livelli** — un account persistente di piattaforma e una partecipazione per-torneo — con iscrizione/disiscrizione via email **sempre disponibili**, non confinate a una finestra.

**Decisione.**

1. **Modello a due livelli.** Livello **Piattaforma**: account persistente in uno **storage separato** (`PLATFORM_DB_PATH`, default `./data/platform.db`) con `registerID` interno **stabile** (riusato alla re-iscrizione), email, status `active | pending_unsubscribe | unsubscribed` (soft-delete). Livello **Torneo**: `profile` resta la partecipazione; un iscritto entra nel torneo **solo entro la deadline del TT1**, via **auto-join al primo pick valido** (sostituisce RF-27/auto-iscrizione e `tournament:register`).
2. **Due DB, due connessioni separate, nessuna transazione cross-DB.** La piattaforma è **solo letta** dai flussi di torneo (gate): ogni scrittura resta in un singolo DB. Nessuna migrazione dati: il DB piattaforma parte vuoto. `register_id` è **replicato** su `player` e `profile` (colonne additive) come riferimento, senza vincoli cross-DB.
3. **Soft-delete a due passi (barriera unsubscribe).** Il primo messaggio di disiscrizione **non** elimina: imposta `pending_unsubscribe` e invia `platform_unsubscribe_confirm`; la soft-delete (`unsubscribed`) avviene solo su un **secondo** messaggio con intento `unsubscribe` o body nella lista di conferma (`confermo`/`sì`/`si`/`yes`). `subscribe`/`pick` da `pending_unsubscribe` → torna `active` (stesso `registerID`). `unsubscribe` da `unsubscribed` o sconosciuto → **log silenzioso**. Il sistema ricorda l'email (univocità).
4. **Anti-spam.** Pick da mittente **sconosciuto** (mai iscritto o disiscritto) → **solo log interno, nessuna risposta** (marcato letto).
5. **Intento via LLM.** Iscrizione/disiscrizione/pick sono classificati **dall'LLM** in **una sola chiamata** (intento + estrazione pick, ADR-004); le keyword `REGISTRATION_KEYWORDS` del router sono rimosse. Resta la normalizzazione dell'identità e il caso "corpo vuoto → unknown". Il filtro deterministico esatto sul pick (ADR-004) resta invariato.
6. **Auto-join al TT1.** Il profilo nasce **al primo pick valido** nel TT1 (round = `start_round`, round aperto, pick che passa la cascata RF-31) con profilo + pick atomici; la risposta è `pick_confirmed` (nessuna conferma di iscrizione separata). Iscrizione piattaforma durante un torneo aperto NON crea subito il profilo; chi non invia mai un pick non è partecipante. Dopo il TT1: rifiuto con risposta. Un pick da sconosciuto non auto-iscrive più.
7. **Matrice notifiche.** Apertura torneo (`tournament:start`) → `tournament_open` a **tutti gli iscritti attivi** (sostituisce l'invito `--contacts`). Apertura round → `pick_instructions` ai **soli partecipanti attivi** (`eliminated = 0`). Chiusura round (`closed → scored`) → riepilogo `round_closed_survived` **solo ai sopravvissuti** (`eliminated = 0`), invio **unica volta** (guardia `round_state.summary_sent`). Gli eliminati ricevono **solo** `pick_missing_elimination` / `round_result_wrong`; **nessun** `round_closed_eliminated`, nessun criterio `eliminated_at >= opened_at`. **Ogni email in uscita è filtrata sullo stato dell'account piattaforma al momento dell'invio**: `unsubscribed`/`pending_unsubscribe` non ricevono alcuna email.
8. **Eligibilità.** Il seam `checkEligibility` (ADR-008) resta; l'implementazione POC diventa "account piattaforma attivo". Il gate del pick = piattaforma attiva + profilo (o auto-join al TT1). `platform:register` è l'**unico** comando di creazione account e **non** crea profili.
9. **Deprecazioni.** `tournament:register:open/close`, `registration_open`, `registration_notified`, azioni scheduler `register_close_auto`/`register_close_safety`, template `welcome`/`registration_open_invite`/`auto_registered`, RF-27; RF-22/RF-28 **sostituiti** (non reinterpretati) dai nuovi RF-P. La disiscrizione a torneo in corso NON tocca il profilo (storico intatto): ferma solo comunicazioni e pick; il profilo muore naturalmente alla prossima chiusura round; la re-iscrizione prima della prossima deadline riprende con lo stesso `registerID` e profilo.
10. **Config e CLI.** Nuova env `PLATFORM_DB_PATH` (replicata in `.env.example`/`.env`/`.env.uat`/`.env.uat-replay`); nuovi comandi `platform:migrate`, `platform:register`, `platform:unregister`, `platform:list`; `channel:email:process` migra entrambi i DB. `created_at`/`unsubscribed_at` piattaforma scritti **sempre** dal clock iniettato (RNF1). I comandi `simulate:*` usano un `PLATFORM_DB_PATH` dedicato con guardia contro il valore di produzione.

**Alternative considerate.**
- *Iscrizione nel solo DB torneo (status quo)* — scartata: confonde la relazione piattaforma↔giocatore con la partecipazione per-torneo; ogni torneo dovrebbe "dimenticare e ri-imparare" gli iscritti, e la disiscrizione globale sarebbe impossibile.
- *Un solo DB condiviso* — scartata: il piano della Fase 1 (quota `paid` in lettura al pick/join) richiede una sorgente account indipendente dal ciclo di vita del DB di torneo (RF-P7); due connessioni separate impongono per costruzione l'assenza di transazioni cross-DB.
- *Keyword deterministiche per l'intento (status quo del router)* — scartata: fragile sul linguaggio naturale; coerente con ADR-004 (l'LLM interpreta il linguaggio), con barriera deterministica solo sull'estrazione del pick.
- *Finestra di iscrizione gestita dal commissioner (RF-22/28)* — scartata: non esiste più alcuna finestra da aprire/chiudere; l'iscrizione è sempre disponibile e la partecipazione è gated dalla deadline del TT1.
- *Conferma di iscrizione separata all'auto-join* — scartata: `pick_confirmed` unisce iscrizione ed esito del pick (un solo messaggio, D5).
- *Riepilogo di chiusura round a tutti (inclusi eliminati)* — scartato: gli eliminati ricevono solo le notifiche puntuali; il riepilogo `round_closed_survived` ai soli sopravvissuti evita duplicazioni e contenuti irrilevanti (opzione B della review).

**Conseguenze.** Iscrizione/disiscrizione sempre disponibili via email, indipendenti dallo stato del torneo; il DB piattaforma sopravvive ai reset del DB torneo; la partecipazione resta gated dalla deadline del TT1 (auto-join), nessun profilo senza pick valido. Ogni notifica passa dal filtro account `active` (nessuna email a `unsubscribed`/`pending_unsubscribe`). La barriera a due passi riduce il rischio di disiscrizioni accidentali per misclassificazione LLM; il silenzio verso sconosciuti è voluto (anti-spam, accettato dalla review). I flussi di torneo leggono la piattaforma ma non vi scrivono mai: nessuna transazione cross-DB. Il determinismo della simulazione richiede un DB piattaforma pulito tra due run.

---

## ADR-010: Chiarimenti ADR-009 post-revisione 2026-08-21

- **Status:** Accepted
- **Date:** 2026-08-21
- **Riferimenti:** ADR-009 · PRD v0.6.1 · Report `tasks/iscrizione-piattaforma/report-revisione-tecnica-2026-08-21.md` (D1–D8) · Piano `tasks/iscrizione-piattaforma/plan-test-e-fix-findings.md` (§2, decisioni (a)–(g))

**Contesto.** La revisione tecnica del 2026-08-21 ha rilevato due incoerenze tra la lettera dell'ADR-009 e il comportamento necessario del sistema: (D3) il flusso di conferma della disiscrizione invia per costruzione email verso account non `active` (`platform_unsubscribe_confirm` verso `pending_unsubscribe`, `platform_unsubscribed` verso `unsubscribed`), in apparente contraddizione con la decisione 7 "nessuna email a `unsubscribed`/`pending_unsubscribe`"; (D1/D2) la condizione di soft-delete era più restrittiva della spec e dipendeva dalla classificazione LLM del testo di conferma ("confermo" classificato `other` → deadlock: l'utente non completa mai la disiscrizione). Il report ha inoltre raccomandato un insieme di correzioni operative (dead-write, commenti, contract test, conteggio test), poi eseguite nel piano test-e-fix.

**Decisione.**

1. **Carve-out esplicito al filtro `active` (chiarimento della decisione 7/ADR-009 e di RF-P6).** La regola "ogni email in uscita è filtrata sullo stato dell'account: nessuna email a `unsubscribed`/`pending_unsubscribe`" si applica alle notifiche di torneo e alla comunicazione generica, **non** al flusso di conferma dell'iscrizione/disiscrizione (RF-P1/P2): le conferme `platform_unsubscribe_confirm` (verso `pending_unsubscribe`), `platform_unsubscribed` (verso `unsubscribed`) e le risposte subscribe (`platform_registered` su account nuovo/riattivato, `platform_already_registered` su account già `active`) partono **SEMPRE**, anche verso account non `active`, perché **sono** il flusso di conferma stesso: senza di esse la barriera a due passi non potrebbe mai completarsi né informare l'utente.
2. **Semantica esatta della barriera a due passi (allineamento della decisione 3/ADR-009).** Il completamento della soft-delete richiede **solo**: account in stato `pending_unsubscribe` **e** body del messaggio nella lista di conferma (`confermo`/`sì`/`si`/`yes`, match esatto normalizzato) — **indipendente dall'intento** classificato dall'LLM. Copre il caso reale "confermo" classificato `other` (D2: deadlock). Il ramo `unsubscribe` con intento `unsubscribe` e body NON nella lista continua a ri-chiedere la conferma (la barriera resta a due passi); il prompt del classificatore cita "confermo"/"sì"/"si" tra gli esempi `unsubscribe` come ulteriore contesto, ma il completamento resta ancorato al body deterministico, non all'intento.
3. **Decisioni operative del piano test-e-fix registrate** (da `tasks/iscrizione-piattaforma/plan-test-e-fix-findings.md` §2):
   - **(a)** barriera intento-agnostica (punto 2 di questo ADR) + prompt classificatore aggiornato (B1);
   - **(b)** `summary_sent` scritto **prima** del loop di invio del riepilogo, nella **stessa `UPDATE` atomica** della transizione a `scored` (`SET status='scored', scored_at=?, summary_sent=1`): non esiste più lo stato intermedio `scored` + `summary_sent=0`; invio **best-effort per destinatario** (errori loggati warn, mai bloccanti) (B2);
   - **(c)** filtro notifiche **fail-closed**: senza registry iniettato nessuna email parte (simmetria con `checkEligibility` → `platform_unavailable`) (B3);
   - **(d)** guardia `simulate:*` ancorata alla costante unica `PLATFORM_DB_PATH_DEFAULT` esportata da `src/config.ts` (usata sia dal default zod sia dalla guardia; nessuna costante locale duplicata) (B4);
   - **(e)** politica del ramo `other`: chiarimento **solo** ad account `active`; silenzio (log interno + markSeen) per `unsubscribed`/`pending_unsubscribe` (B5);
   - **(f)** nuovo `EmailType` `platform_already_registered` (soggetto deterministico "Già iscritto alla piattaforma") per il ramo subscribe su account già `active`, al posto del riuso improprio di `pick_rejected` (B6);
   - **(g)** rimozione del dead-write `registration_open` in `startTournament` (colonna DEPRECATA che resta nello schema per compatibilità, default 0); pulizia dei commenti stale; contract test `llm:classify`; correzione del conteggio test in `agent-context/current-status.md` (B7/B8).

**Alternative considerate.**
- *Riscrittura della decisione 7 senza eccezioni (nessuna email a non `active`)* — scartata: renderebbe impossibile il flusso di conferma della barriera a due passi (il mittente non riceverebbe mai la richiesta di conferma né l'esito della disiscrizione).
- *Completamento della barriera ancorato all'intento `unsubscribe` (lettera della decisione 3)* — scartato: dipendente dalla classificazione LLM di testi brevissimi ("confermo"), fragile sul linguaggio reale (D1/D2).
- *Chiarimento `other` anche verso account non `active` (comportamento pre-fix)* — scartato: viola il filtro della decisione 7 per comunicazioni non richieste dal flusso di conferma.
- *Nuovo ADR separato per ogni correzione operativa* — scartato: sono correzioni puntuali emerse da un'unica revisione della stessa feature; un unico ADR di chiarimento le registra senza frammentare il log.

**Conseguenze.** Il filtro `active` resta valido per tutte le notifiche di torneo e la comunicazione generica; il flusso di conferma iscrizione/disiscrizione funziona end-to-end anche verso account non `active` (carve-out documentato in PRD RF-P6). Il completamento della disiscrizione non dipende più dalla classificazione LLM (robusto su "confermo"→`other`); la matrice barriera/silenzio è coperta dai test (A1/A2/A6a/A6b). Le notifiche senza registry non partono più (fail-closed); la guardia di simulazione segue la fonte unica del default di produzione; il riepilogo di chiusura round non si perde più su errori di invio (guardia atomica con la transizione).

---

*Fine del log ADR.*
