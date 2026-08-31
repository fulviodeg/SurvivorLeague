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
| [ADR-011](#adr-011-email-v2-chiusura-automatica-del-torneo-nome-giocatore-e-timezone) | Email v2, chiusura automatica del torneo, nome giocatore e timezone | Accepted (2026-08-21) |
| [ADR-012](#adr-012-emendamenti-adr-011-post-revisione-2026-08-21) | Emendamenti ADR-011 post-revisione 2026-08-21 | Accepted (2026-08-21) |
| [ADR-013](#adr-013-email-v3--restyle-plain-text-senza-riquadri-e-generatore-deterministico) | Email v3 — restyle plain-text senza riquadri e generatore deterministico | Accepted (2026-08-24) |
| [ADR-014](#adr-014-email-v3-parte-b--parser-deterministico-dellinput-con-interruttore) | Email v3 Parte B — Parser deterministico dell'input con interruttore | Accepted (2026-08-24) |
| [ADR-015](#adr-015-email-v4--riepilogo-con-elenco-giocatori-vittoria-condivisa-con-nomi-e-chiusura-torneo-con-storico) | Email v4 — riepilogo con elenco giocatori, vittoria condivisa con nomi, chiusura torneo con storico | Accepted (2026-08-25) |
| [ADR-016](#adr-016-modalità-win_only-pick-con-la-sola-squadra-vincente) | Modalità `win_only` — pick con la sola squadra vincente | Accepted (2026-08-28) |
| [ADR-017](#adr-017-auto-pick-al-mancato-invio-autopick_on_missing) | Auto-pick al mancato invio (`AUTOPICK_ON_MISSING`) | Accepted (2026-08-30) |
| [ADR-018](#adr-018-jolly--token-che-salva-dal-pareggio-in-win_only-jollies_per_player) | Jolly — token che salva dal pareggio in `win_only` (`JOLLIES_PER_PLAYER`) | Accepted (2026-08-30) |
| [ADR-019](#adr-019-partecipazione-opt-in-registration-vs-join-e-rimozione-dellauto-join-al-primo-pick) | Partecipazione opt-in (registration ≠ join) e rimozione dell'auto-join al primo pick | Accepted (2026-08-30) |
| [ADR-020](#adr-020-guardia-temporale-pick_before_round_open-e-riordino-della-cascata-pick) | Guardia temporale `pick_before_round_open` e riordino della cascata pick | Accepted (2026-08-31) |

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

- **Status:** Accepted — *le decisioni 6 (auto-join al TT1) e 7 (matrice notifiche) sono EMENDATE da ADR-019 (2026-08-30): l'auto-join al primo pick valido è RIMOSSO e sostituito dalla partecipazione opt-in (registration ≠ join) con due flag per-account.*
- **Date:** 2026-08-20
- **Riferimenti:** PRD v0.6.0 (RF-P1…P8, §4.1/§4.7 riscritti) · HLD v0.5.0 (§2.2, §5, §6) · LLD v0.5.0 (§3, §4.2, §6, §7) · Piano `tasks/iscrizione-piattaforma/plan-iscrizione-piattaforma.md` §2 · ADR-004, ADR-006, ADR-008

**Contesto.** L'iscrizione viveva interamente nel DB di torneo (`player` + `profile`), gated da una finestra `registration_open` `[apertura torneo, deadline TT1]` gestita dal commissioner (RF-22/RF-28, ADR-008). L'analisi 2026-08-20 (`tasks/iscrizione-piattaforma/brainstorming-iscrizione-piattaforma.md` + review dell'utente) ha evidenziato che l'iscrizione è una relazione tra il **giocatore e la piattaforma** (stabile nel tempo, indipendente dai singoli tornei), non tra il giocatore e il torneo: serve un **modello a due livelli** — un account persistente di piattaforma e una partecipazione per-torneo — con iscrizione/disiscrizione via email **sempre disponibili**, non confinate a una finestra.

**Decisione.**

1. **Modello a due livelli.** Livello **Piattaforma**: account persistente in uno **storage separato** (`PLATFORM_DB_PATH`, default `./data/platform.db`) con `registerID` interno **stabile** (riusato alla re-iscrizione), email, status `active | pending_unsubscribe | unsubscribed` (soft-delete). Livello **Torneo**: `profile` resta la partecipazione; un iscritto entra nel torneo **solo entro la deadline del TT1** — la modalità di ingresso è stata **emendata da ADR-019**: l'auto-join al primo pick valido è RIMOSSO, sostituito da auto-join a `tournament:start` o dichiarazione esplicita (sostituisce RF-27/auto-iscrizione e `tournament:register`).
2. **Due DB, due connessioni separate, nessuna transazione cross-DB.** La piattaforma è **solo letta** dai flussi di torneo (gate): ogni scrittura resta in un singolo DB. Nessuna migrazione dati: il DB piattaforma parte vuoto. `register_id` è **replicato** su `player` e `profile` (colonne additive) come riferimento, senza vincoli cross-DB.
3. **Soft-delete a due passi (barriera unsubscribe).** Il primo messaggio di disiscrizione **non** elimina: imposta `pending_unsubscribe` e invia `platform_unsubscribe_confirm`; la soft-delete (`unsubscribed`) avviene solo su un **secondo** messaggio con intento `unsubscribe` o body nella lista di conferma (`confermo`/`sì`/`si`/`yes`). `subscribe`/`pick` da `pending_unsubscribe` → torna `active` (stesso `registerID`). `unsubscribe` da `unsubscribed` o sconosciuto → **log silenzioso**. Il sistema ricorda l'email (univocità).
4. **Anti-spam.** Pick da mittente **sconosciuto** (mai iscritto o disiscritto) → **solo log interno, nessuna risposta** (marcato letto).
5. **Intento via LLM.** Iscrizione/disiscrizione/pick sono classificati **dall'LLM** in **una sola chiamata** (intento + estrazione pick, ADR-004); le keyword `REGISTRATION_KEYWORDS` del router sono rimosse. Resta la normalizzazione dell'identità e il caso "corpo vuoto → unknown". Il filtro deterministico esatto sul pick (ADR-004) resta invariato.
6. **Auto-join al TT1.** ~~Il profilo nasce **al primo pick valido** nel TT1 (round = `start_round`, round aperto, pick che passa la cascata RF-31) con profilo + pick atomici; la risposta è `pick_confirmed` (nessuna conferma di iscrizione separata). Iscrizione piattaforma durante un torneo aperto NON crea subito il profilo; chi non invia mai un pick non è partecipante. Dopo il TT1: rifiuto con risposta. Un pick da sconosciuto non auto-iscrive più.~~ **EMENDATA DA ADR-019 (2026-08-30):** l'auto-join al primo pick è RIMOSSO; il profilo nasce per **auto-join a `tournament:start`** (account `active` con `tournament_auto_join = ON`) o per **dichiarazione esplicita** (email `PARTECIPO` o CLI `tournament:join`) nella finestra del TT1. La risposta al join è `tournament_join_confirmed`; un pick da iscritto senza profilo NON crea più profili.
7. **Matrice notifiche.** Apertura torneo (`tournament:start`) → `tournament_open` a **tutti gli iscritti attivi**. Apertura round → `pick_instructions` ai **soli partecipanti attivi** (`eliminated = 0`). Chiusura round (`closed → scored`) → riepilogo `round_closed_survived` **solo ai sopravvissuti** (`eliminated = 0`), invio **unica volta** (guardia `round_state.summary_sent`). Gli eliminati ricevono **solo** `pick_missing_elimination` / `round_result_wrong`; **nessun** `round_closed_eliminated`, nessun criterio `eliminated_at >= opened_at`. **Ogni email in uscita è filtrata sullo stato dell'account piattaforma al momento dell'invio**: `unsubscribed`/`pending_unsubscribe` non ricevono alcuna email. *~~(Emendamento 2026-08-21: all'apertura del TT 1 `pick_instructions` anche agli iscritti attivi SENZA profilo — decisione RIMOSSA da ADR-019: la nascita dei profili non è più legata al pick; il broadcast `tournament_open` è filtrato sul flag `receive_tournament_start_notification`.)~~*
8. **Eligibilità.** Il seam `checkEligibility` (ADR-008) resta; l'implementazione POC diventa "account piattaforma attivo". Il gate del pick = piattaforma attiva + profilo. *(La parentesi "o auto-join al TT1" è superata da ADR-019: il pick non crea più profili.)* `platform:register` è l'**unico** comando di creazione account e **non** crea profili.
9. **Deprecazioni.** `tournament:register:open/close`, `registration_open`, `registration_notified`, azioni scheduler `register_close_auto`/`register_close_safety`, template `welcome`/`registration_open_invite`/`auto_registered`, RF-27; RF-22/RF-28 **sostituiti** (non reinterpretati) dai nuovi RF-P. La disiscrizione a torneo in corso NON tocca il profilo (storico intatto): ferma solo comunicazioni e pick; il profilo muore naturalmente alla prossima chiusura round; la re-iscrizione prima della prossima deadline riprende con lo stesso `registerID` e profilo.
10. **Config e CLI.** Nuova env `PLATFORM_DB_PATH` (replicata in `.env.example`/`.env`/`.env.uat`/`.env.uat-replay`); nuovi comandi `platform:migrate`, `platform:register`, `platform:unregister`, `platform:list`; `channel:email:process` migra entrambi i DB. `created_at`/`unsubscribed_at` piattaforma scritti **sempre** dal clock iniettato (RNF1). I comandi `simulate:*` usano un `PLATFORM_DB_PATH` dedicato con guardia contro il valore di produzione.

**Alternative considerate.**
- *Iscrizione nel solo DB torneo (status quo)* — scartata: confonde la relazione piattaforma↔giocatore con la partecipazione per-torneo; ogni torneo dovrebbe "dimenticare e ri-imparare" gli iscritti, e la disiscrizione globale sarebbe impossibile.
- *Un solo DB condiviso* — scartata: il piano della Fase 1 (quota `paid` in lettura al pick/join) richiede una sorgente account indipendente dal ciclo di vita del DB di torneo (RF-P7); due connessioni separate impongono per costruzione l'assenza di transazioni cross-DB.
- *Keyword deterministiche per l'intento (status quo del router)* — scartata: fragile sul linguaggio naturale; coerente con ADR-004 (l'LLM interpreta il linguaggio), con barriera deterministica solo sull'estrazione del pick.
- *Finestra di iscrizione gestita dal commissioner (RF-22/28)* — scartata: non esiste più alcuna finestra da aprire/chiudere; l'iscrizione è sempre disponibile e la partecipazione è gated dalla deadline del TT1.
- *Conferma di iscrizione separata all'auto-join* — scartata: `pick_confirmed` unisce iscrizione ed esito del pick (un solo messaggio, D5).
- *Riepilogo di chiusura round a tutti (inclusi eliminati)* — scartato: gli eliminati ricevono solo le notifiche puntuali; il riepilogo `round_closed_survived` ai soli sopravvissuti evita duplicazioni e contenuti irrilevanti (opzione B della review).

**Conseguenze.** Iscrizione/disiscrizione sempre disponibili via email, indipendenti dallo stato del torneo; il DB piattaforma sopravvive ai reset del DB torneo; la partecipazione è gated dalla deadline del TT 1 (auto-join a `tournament:start` o dichiarazione, vedi ADR-019). Ogni notifica passa dal filtro account `active` (nessuna email a `unsubscribed`/`pending_unsubscribe`). La barriera a due passi riduce il rischio di disiscrizioni accidentali per misclassificazione LLM; il silenzio verso sconosciuti è voluto (anti-spam, accettato dalla review). I flussi di torneo leggono la piattaforma ma non vi scrivono mai: nessuna transazione cross-DB. Il determinismo della simulazione richiede un DB piattaforma pulito tra due run.

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

## ADR-011: Email v2, chiusura automatica del torneo, nome giocatore e timezone

- **Status:** Accepted
- **Date:** 2026-08-21
- **Riferimenti:** ADR-004, ADR-008, ADR-009, ADR-010 · PRD v0.6.x (RF-P1, RF-P6, RF-18, RF-26) · LLD §6.2/§6.3/§6.4/§6.6/§7.7 · Piano `.kilo/plans/1787325393233-email-templates-v2.md` · Decisioni PO 2026-08-19/21 ("note personali", correzioni `email_*`, `tournament_auto_close_on_winner`, `winner_check_automatic_on_round_close`, `registered_user_name`)

**Contesto.** Tre esigenze convergono: (1) le email del POC avevano uno stile "neutro" che il PO ha chiesto di rinnovare — stile unico più entusiasta, breve, focalizzato sugli eventi principali e sui prossimi passi, con riquadri di testo strutturato **plain-text** (opzione 2 approvata: NIENTE HTML), mai elenchi nominativi di partecipanti, soggetti neutri per le mail di esito; (2) il torneo terminava "a metà": `checkWinner` era invocato solo da CLI/status/simulazione e le mail `tournament_won`/`tournament_shared_win` non erano inviate da nessun punto (TODO utente del 2026-08-19, la spec già prevedeva l'hook "in Fasi successive" dal Round Manager); (3) i registrati senza profilo non avevano un nome da usare nelle mail e le date/timestamp erano ancorati a un fuso fisso non configurabile.

**Decisione.**

1. **Resa = canale, dati = canale-agnostici (architettura).** Nuovo `src/llm/email-renderer.ts`: renderer deterministico e PURO del canale email che compone header (coppia UMANA "Round N · Turno di campionato M", mai sigle TT/TC nelle mail), box ASCII (esito ✅/❌, deadline+countdown, squadre bruciate, partite/risultati, stato aggregato), sezioni dati e CTA per tipo. L'LLM produce SOLO il testo narrativo (2-4 frasi, ADR-004). Il Game Engine compone solo `EmailContext` (dati) e resta trasparente: un futuro WebAdapter riusa gli stessi dati con un renderer dedicato. `src/llm/templates.ts` è RISC RITTO (16 prompt, incluso `clarification`); il vecchio file resta come `templates.old.ts` morto (riferimento/retrocompatibilità, non importato). Niente parametro di selezione dello stile: un solo stile.
2. **Stile unico "energetic" (convenzioni 1-11 approvate col PO).** Box deadline = elemento n.1 nelle mail che richiedono un pick, con countdown calcolato DAL SISTEMA (`formatRemaining(now, deadline)`, mai dall'LLM né dal renderer — clock iniettato, RNF1); box esito subito dopo l'header con testi esatti ✅/❌; mail di apertura torneo = SOLO annuncio ("il round 1 parte a breve: stai pronto!", niente invito al pick né date, riferimento "Iscritti alla piattaforma: N"); chiusura fissa dell'eliminato "Il torneo continua con N giocatori in gara. Grazie per essere stato con noi!" (mai "grazie per averci giocato", mai "seguire i prossimi round" per gli eliminati); soggetti NEUTRI per le mail di esito ("riepilogo del round"/"esito del round"); mai elenchi nominativi (solo conteggi aggregati). La matrice destinatari RF-P6 e la barriera unsubscribe restano INVARIATE (ADR-009/010): cambiano solo i testi.
3. **Soggetti in forma umana.** `subjectFor` diventa "Survivor League — Round N · Turno di campionato M: etichetta" (coppia assente → senza prefisso); le forme compatte TT2TC7 restano SOLO per log/CLI (ADR-008).
4. **Nome del giocatore end-to-end (RF-P1).** Il classificatore di intento restituisce `{intent, pick, name?}`: il nome è dedotto dalla mail di REGISTRAZIONE (formula di iscrizione ovunque: "dimmi il tuo nome e scrivi voglio iscrivermi"). `platform_account.name` (colonna additiva), `register(email, name, now)`, auto-join con `player.name = account.name ?? email` (un registrato senza nome usa l'email — correzione `registered_user_name`).
5. **Chiusura AUTOMATICA e COMPLETA del torneo.** Nuovo hook `settleWinnerIfNeeded` del Round Manager, invocato dopo `closeRound` e dopo `scoreRound`: (a) `checkWinner` (invariato, sola lettura); (b) GUARDIA ATOMICA idempotente `tournament_state.winner_notified = 1` + `finished_at = <clock>` (migrazione additiva; ri-avvii/CL9 non duplicano); (c) notifica vincitori (`tournament_won`/`tournament_shared_win`, best-effort per destinatario con filtro account `active`); (d) EXPORT AUTOMATICO (riuso di `tournamentExport`, dump JSON in `TOURNAMENT_EXPORT_DIR` con filename dal clock iniettato) — l'archivio che rende sicuro il reset; (e) inibizione dello scheduler: `computeActions` ritorna `[]` a torneo chiuso; (f) `tournament:start` RIAMMISSIBILE su torneo chiuso: reset ATOMICO del solo DB di GIOCO (pick/profile/player/round_state) + reset di `tournament_state`; il DB piattaforma NON è toccato (ADR-009: account e nomi sopravvivono). `winner:check` resta comando di SOLA LETTURA (vista/audit), senza side-effect. La riga crontab fisica resta responsabilità operativa del commissioner (documentata nella guida test-mode).
6. **Timezone di sistema.** Nuovo parametro `TIMEZONE` (stringa IANA, default `Europe/Rome`, VALIDATA al boot con prova `Intl.DateTimeFormat`): il sistema di gioco lavora su istanti UTC assoluti; il fuso conta SOLO per la comunicazione verso l'esterno — formattazione delle date nelle email e timestamp dei log pino (con offset esplicito, es. `2026-08-21T18:23:15+02:00`). Default del logger = comportamento attuale (UTC) per il path di emergenza ConfigError.

**Alternative considerate.**
- *Email in HTML/multipart* — scartata: opzione 2 approvata (plain-text strutturato con riquadri ASCII), canale più semplice e robusto.
- *Parametro `.env` per selezionare lo stile email* — scartata (correzione PO `email_style_new_variant`): lo stile è proprio dell'email adapter; esiste un solo stile, il vecchio resta solo per retrocompatibilità come file morto.
- *Chiusura del torneo via comando CLI separato* — scartata: l'automazione vive nel Round Manager (la spec già lo prevedeva); `winner:check` resta sola lettura per l'audit.
- *Unificazione degli offset UAT* — fuori da questa ADR (gestita dal piano UAT).
- *Check vincitore a ogni invocazione di `tournament:status`* — scartata: gli status restano sola lettura; l'hook è solo su close/score (idempotente), il check dello stato resta comunque consultabile via `winner:check`/status.

**Conseguenze.** I testi email sono composti in modo deterministico attorno a una narrativa LLM breve (mitigazione del rischio "LLM ripete numeri/date": i prompt v2 lo vietano); il torneo si chiude da solo con notifica, export archivio e scheduler fermo, ed è riavviabile dallo stesso sistema senza perdere lo storico (che sta nell'export); i nomi dei giocatori viaggiano dalla mail di registrazione fino alle email e ai profili; date e log rispettano il fuso configurato senza toccare le decisioni di gioco (sempre UTC). `winner_notified`/`finished_at` e `platform_account.name` sono migrazioni additive idempotenti.

---

## ADR-012: Emendamenti ADR-011 post-revisione 2026-08-21

- **Status:** Accepted
- **Date:** 2026-08-21
- **Riferimenti:** ADR-011 · ADR-004 · ADR-006 · Piano `.kilo/plans/1787340283469-review-findings-fix.md` (D1–D5, HIGH-1/HIGH-2, MEDIUM-1/2/3, LOW-1/3/4/5)

**Contesto.** La revisione tecnica indipendente del 2026-08-21 sull'implementazione di ADR-011 (email v2, chiusura automatica) ha rilevato: (HIGH-1) l'export automatico scriveva direttamente con `node:fs` DENTRO il Game Engine (`round-manager.ts`), violando il confine architetturale ADR-004/§1.3 ("mai I/O nei moduli di gioco") e rendendo il riavvio insicuro — il reset del DB di gioco poteva distruggere l'unico storico se l'export non era stato scritto; (MEDIUM-1/2) a torneo chiuso i comandi `round:open`/`round:score` restavano invocabili, con `round:score` che inviava ancora email di esito dopo la chiusura; (LOW-3/4/5 e minori) countdown fuorviante oltre la deadline, campo morto `EmailMatchContext.date`, export scritto anche in simulazione dry-run, numeri di turno nel prompt, sonda timezone dipendente dal locale.

**Decisione.**

1. **Seam di archiviazione (§1.3).** L'export automatico della chiusura NON usa più `node:fs` nei moduli di gioco: il `GameContext` espone un seam opzionale `archiveTournament?: (dump, now) => string` iniettato dalla CLI tramite il nuovo `src/cli/archive-wiring.ts` (`archiveTournamentFile`, `makeArchiveTournament`, `attachArchiveToContext`). Il filename resta derivato dal clock iniettato (`exportFilename`, puro, determinismo RNF1) e il dedup `-N` su file esistente è deterministico (MEDIUM-3, nessun RNG/UUID).
2. **`export_path` + gate di riavvio (HIGH-1).** Nuova colonna additiva `tournament_state.export_path TEXT` (NULL = export non archiviato), scritta SOLO dopo una `writeFileSync` riuscita (sincrona ⇒ non-null ⇒ file archiviato). `tournament:start` su torneo chiuso è RIAMMESSO solo se `export_path` è valorizzato; altrimenti rifiuta ("Torneo chiuso senza export archiviato: riavvio rifiutato"). Il reset del DB di gioco azzera anche `export_path = NULL`. Un torneo chiuso PRIMA di questo fix (winner_notified=1 ma export_path NULL) non è riavviabile: accettato, l'export non era mai stato garantito.
3. **`round:open` rifiuta a torneo chiuso (MEDIUM-1).** Nuovo helper `isTournamentClosed(db)` (winner_notified=1): `openRound` lancia se il torneo è chiuso — l'unica prosecuzione è `tournament:start`.
4. **`round:score` tace a torneo chiuso (MEDIUM-2).** A torneo chiuso una ricontabilizzazione aggiorna comunque lo stato DB (idempotenza RF-17) ma NON invia email di esito: `round_result_*`, `pick_postponed` e il riepilogo `round_closed_survived` sono saltati.
5. **Export assente in simulazione (dry-run, LOW-5).** `simulate:*` NON inietta il seam: senza `archiveTournament` la chiusura logga un warn ("no archive dependency") e non scrive file né `export_path` — coerenza con R1 (nessun I/O) e niente più file spuri in `./data/exports/` dai test.

**Alternative considerate.**
- *Export con `node:fs` diretto nel Game Engine (status quo)* — scartato: viola ADR-004/§1.3 (I/O nei moduli di gioco) e rende il dry-run non sicuro.
- *Riavvio ammesso anche senza export archiviato* — scartato: distruggerebbe l'unico storico del torneo precedente (nessun altro archivio).
- *`round:score` che invia ancora le email a torneo chiuso (status quo)* — scartato: email di esito fuorvianti dopo la fine del torneo.

**Conseguenze.** Il confine I/O/game è ripristinato (mai `node:fs` nei moduli di gioco); il riavvio è sicuro e ancorato alla presenza dell'archivio; `round:open`/`round:score` rispettano lo stato chiuso; la simulazione resta dry-run pura. `export_path` è una migrazione additiva idempotente; i test di integrazione e la simulazione non scrivono più in `./data/exports/`.

---

## ADR-013: Email v3 — restyle plain-text senza riquadri e generatore deterministico

- **Status:** Accepted
- **Date:** 2026-08-24
- **Riferimenti:** ADR-011 (emendata), ADR-004, ADR-008 · PRD RF-25, RF-P6 · LLD §6.2/§6.3/§6.4 · Piano `.kilo/plans/1787519052097-email-v3-restyle.md` · correzioni PO `email_restyle_plain_text_ascii`, `ai_email_generator_env_var`

**Contesto.** Il PO ha rivisto il restyle delle email (correzione `email_restyle_plain_text_ascii`): niente HTML e niente riquadri ASCII, testo plain-text strutturato a righe con emoji ammesse e messaggio chiave in MAIUSCOLO. Contestualmente ha chiesto che la generazione dei testi sia **deterministica di default**, con l'LLM come opzione opt-in governata da una variabile d'ambiente (correzione `ai_email_generator_env_var`). Queste decisioni emendano ADR-011 (che prevedeva "box ASCII" e narrativa LLM come unico percorso).

**Decisione.**

1. **Soggetto (emenda ADR-011 §3, RF-25).** `subjectFor(ctx)` diventa `⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - {etichetta}` con TC noto, e `⚽🏆SURVIVOR LEAGUE🏆⚽ - {etichetta}` senza TC (soli flussi di piattaforma). Il soggetto porta il **solo turno di campionato** (TC): la coppia "Round N · Turno di campionato M" resta nel CORPO. `tournament_won`/`tournament_shared_win` includono il turno (la vittoria avviene alla chiusura del round finale, TC noto). Etichette iper-condensate ("Esito Round" resta neutro, non rivela l'eliminazione); `ctx.subject` esplicito continua a prevalere.
2. **Corpo senza riquadri (emenda ADR-011 §1/§2).** Rimozione di `makeBox`: i box ASCII (esito, deadline, bruciate) diventano sezioni a righe con titolo **emoji + MAIUSCOLO**; nuovo `keyMessage(ctx)` deterministico per tipo in MAIUSCOLO (l'equivalente plain-text del "grassetto"). Gli esiti restano sui messaggi ✅/❌ del renderer; deadline con data+countdown sulla STESSA riga (`· Mancano circa …`); "SQUADRE GIÀ USATE" con formato "(Round N)"; titolo partite dinamico ("RISULTATI DEL ROUND" con punteggi, "PARTITE DEL ROUND" altrimenti). Ordine dei blocchi: header → saluto → esito → deadline → messaggio chiave → narrativa → partite/risultati → squadre già usate → stato → CTA → iscritti piattaforma → chiusura.
3. **Separatore di brand (emenda ADR-011, piano reply-quote-stripping).** `SYSTEM_EMAIL_SEPARATOR` passa da `───` a `─── Survivor League ───` (costante UNICA condivisa tra invio `EmailAdapter.sendMessage` e taglio `reply-cleaner`, logica `startsWith(separator)` invariata).
4. **Generatore deterministico con interruttore (emenda ADR-011).** Nuovo `src/llm/deterministic-generator.ts`: `DeterministicGenerator implements LLMGenerator` produce il corpo con la narrativa FISSA per tipo (`DETERMINISTIC_NARRATIVES`, rinominata da `FALLBACK_NARRATIVES`, testo vuoto per il riepilogo → blocco omesso) — ZERO chiamate di rete. Nuovo parametro `AI_EMAIL_GENERATOR` (boolean, default `false`): `false`/assente → generatore deterministico (mai chiamate LLM per i testi email); `true` → `OpenAIGenerator` avvolto da `FallbackGenerator`, che su `LLMError` ripiega sul corpo deterministico con warn pino `{reason, type}` (il giocatore riceve comunque l'email, il batch non si ferma). La narrativa degenerata è già coperta dalla guardia `deterministicNarrative`. Parser/Classificatore (lato input) restano sempre LLM. La CLI `llm:generate` guadagna `--mode llm|deterministic` per confrontare le due strade senza toccare la config.

**Alternative considerate.**
- *HTML/CSS inline* — scartata (correzione PO): plain-text, niente HTML.
- *Riquadri ASCII (status quo ADR-011)* — scartata (correzione PO `email_restyle_plain_text_ascii`): sezioni a righe più semplici e robuste nei client.
- *File di configurazione dedicato al design email* — scartata: niente configurazione, un solo stile (regole in `tasks/llm/regole-email-design.md`, non toccate).
- *LLM come unico generatore (status quo)* — scartata: il default deterministico è la fonte di verità; l'LLM è opt-in.

**Conseguenze.** L'output email è deterministico e riproducibile di default (zero dipendenza dall'LLM per l'invio, R1 mitigato); il subject porta il solo TC; il corpo è plain-text a righe senza riquadri; il separatore di brand unifica invio e taglio della citazione. `AI_EMAIL_GENERATOR` è un parametro di configurazione letto a ogni invocazione (nessun daemon da riavviare). I test del renderer asseriscono gli output esatti dei 16 template; `DeterministicGenerator`/`FallbackGenerator` sono coperti da test unitari dedicati.

**Emendamento 2026-08-31 (richiesta PO, working tree `vaulted-night`).** La decisione 1 è rivista sul formato del soggetto: `subjectFor(ctx, testMode = false)` diventa `{brand} - {etichetta}` — rimosso `Turno {TC} di Campionato` in ENTRAMBE le modalità (il numero di turno è già nel corpo, header "Round del torneo N · Turno di Campionato M") e, con `TEST_MODE=true`, il brand è preceduto da `🚧⚠️TEST MODE⚠️🚧 - ` (mai confondere una mail di test con una reale). `ctx.subject` esplicito continua ad avere priorità; nessuna modifica a corpo, etichette o convenzione 4.

---

## ADR-014: Email v3 Parte B — Parser deterministico dell'input con interruttore

- **Status:** Accepted
- **Date:** 2026-08-24
- **Riferimenti:** ADR-009 (decisione 5, emendata), ADR-013, ADR-004 · LLD §6.2 · Piano `.kilo/plans/1787519052097-email-v3-deterministic-parser.md` · correzione PO `ai_email_generator_env_var` (estesa al parser)

**Contesto.** ADR-009 (decisione 5) prevede la classificazione di intento SOLO via LLM ("intento + pick in una chiamata"). Email v3 Parte B estende all'INPUT il principio del generatore deterministico (ADR-013): il PO ha chiesto di poter eseguire il sistema SENZA LLM (run senza IA, `LLM_API_KEY` non richiesta quando entrambi i flag AI sono false). Serve quindi una seconda implementazione del classificatore, deterministica, selezionabile via config.

**Decisione.**

1. **Interfaccia con due implementazioni (emenda ADR-009 decisione 5).** `LLMIntentClassifier` resta il contratto `{intent, pick, name}` (mai eccezioni di contenuto, CS7). Due implementazioni: `OpenAIIntentClassifier` (LLM, invariato) e `DeterministicIntentClassifier` (`src/llm/deterministic-parser.ts`), selezionate da `AI_EMAIL_PARSER` (default `false` = deterministico). Il filtro deterministico esatto sul pick (ADR-004) resta invariato in entrambe.
2. **Formule univoche (deterministico).** `ISCRIZIONE [NOME]` → `subscribe` (nome = testo dopo la keyword, fine riga, trim, max ~40 char; vuoto → `null` → il sistema usa l'email, RF-P1); `DISISCRIZIONE` → `unsubscribe`; `<TEAM> <ESITO>` → `pick` (lista canonica + tabella alias parse, longest-match, normalizzazione minuscolo/trim/accenti; sinonimi esito win/draw/lose). Formule riconosciute nel subject O nel corpo (`IncomingMessage.subject` plumbato); il resto dell'email è scartato. Qualunque altra cosa → `other` → chiarimento (CL5) che insegna le formule. Le formule libere ("voglio iscrivermi", "mi iscrivo", "partecipo") NON sono riconosciute. Lista squadre vuota → `other` senza chiamate.
3. **Sostituzione del vincolo `registration_invitation_name_wording`.** L'istruzione d'iscrizione ovunque diventa `ISCRIZIONE [NOME]` (le mail di chiarimento della Parte A la insegnano già); la vecchia formula "dici voglio iscrivermi" è superata.
4. **Fallback in modalità LLM.** Con `AI_EMAIL_PARSER=true` l'`OpenAIIntentClassifier` è avvolto da `FallbackIntentClassifier`: su `LLMError` il messaggio è classificato dal deterministico e il batch **continua** (warn pino `{reason}`, nessuno stop-and-retry); gli esiti di contenuto `other`/`pick:null` NON vengono rieseguiti. In modalità LLM il subject NON è iniettato nel prompt (comportamento invariato): la formula va nel corpo. *Emendamento 2026-08-31 (bug UAT 2026-08-30, piano `.kilo/plans/1788161325462-abbreviated-name-never-fail.md`):* gli esiti di contenuto "dubbiosi" (`other` o `pick` con pick null) ORA vengono rieseguiti dal deterministico come **seconda opinione sul pick**: se il deterministico riconosce un pick, vince lui con warn `{reason: 'llm_false_negative'}` (un nome abbreviato valido — es. "Parma" — non deve MAI finire in clarification); altrimenti resta l'esito LLM. Regole: SOLO upgrade a `pick` (subscribe/unsubscribe/join restano come classificati dall'LLM), MAI il contrario (doppia barriera D2/C: nessun pick è accettato se il deterministico non lo conferma). Inoltre il filtro esatto del classificatore (D2, soluzione B) è diventato **alias-aware**: il campo `team` dell'output LLM è risolto contro canonici + alias tramite il modulo condiviso `src/llm/team-terms.ts` (stessi termini del parser deterministico, AGENTS.md §1.3), e il prompt è stato rafforzato con esempi di squadra nuda/alias (soluzione C).
5. **`LLM_API_KEY` opzionale (run senza IA).** Con `AI_EMAIL_GENERATOR=false` e `AI_EMAIL_PARSER=false` la chiave non è richiesta; con almeno un flag `true` resta obbligatoria (validazione condizionale).

**Alternative considerate.**
- *Solo LLM (status quo ADR-009)* — scartata: non consente il run senza IA richiesto dal PO.
- *Keyword deterministiche libere (status quo del router pre-ADR-009)* — scartata: fragili sul linguaggio; le formule univoche sono esatte e l'ambiguità va al chiarimento (CL5).
- *Subject iniettato nel prompt LLM* — scartata: il subject resta un'ancora del solo parser deterministico; il comportamento LLM è verificato invariato.

**Conseguenze.** Con i flag AI false il sistema gira senza LLM e senza `LLM_API_KEY`; il parser deterministico è più rigido (più chiarimenti, mitigati dal file alias editabile e dalle mail che insegnano le formule); il fallback per-messaggio in modalità LLM rende la classificazione robusta ai blackout (il batch non si ferma). `DeterministicIntentClassifier`/`FallbackIntentClassifier` sono coperti da test unitari; i body reali UID 291/295 sono regressione.

---

## ADR-015: Email v4 — riepilogo con elenco giocatori, vittoria condivisa con nomi, chiusura torneo con storico

- **Status:** Accepted
- **Date:** 2026-08-25
- **Riferimenti:** ADR-011 (emendata), ADR-013 (emendata), ADR-004, ADR-008, ADR-009 (RF-P6) · PRD RF-25 · LLD §6.2/§6.3/§6.4 · Piano `.kilo/plans/1787675020248-email-v4-chiusura-torneo.md` · correzioni PO `email_pick_registered_no_correction_phrase`, `email_round_result_subject_wording`, `email_shared_win_coincludes_names`, `email_tournament_closing_round_history`, `email_key_message_caps_first`

**Contesto.** Il PO ha chiesto quattro ritocchi alle email (D1–D5) e due verifiche trasversali (D6–D7): (1) la mail di pick confermato conteneva una frase fattualmente errata ("puoi correggere la scelta…") — verificato sui sorgenti che un secondo pick entro la deadline NON sovrascrive: la cascata di `pick-processor` rifiuta con `pick_already_exists` (CL6, RF-08) e il vincolo `UNIQUE(profile_id, round)` lo garantisce a livello DB; (2) il riferimento testuale "Round N · Turno di campionato M" doveva diventare "Round del torneo N · Turno di Campionato M"; (3) il riepilogo di chiusura round e la vittoria condivisa dovevano arricchirsi con dati nominativi; (4) alla chiusura del torneo mancava una mail di riepilogo con lo storico per-round. Tutti e quattro i cambi restano sul canale email e sul Game Engine: nessuna modifica alle interfacce `ChannelAdapter`/`LLMGenerator`/`LLMIntentClassifier`, nessuna modifica a `tasks/llm/regole-email-design.md`.

**Decisione.**

1. **`pick_confirmed` senza frase di correzione (D1).** `DETERMINISTIC_NARRATIVES.pick_confirmed` diventa stringa vuota (blocco narrativa omesso) e il template LLM perde l'istruzione "può correggere la scelta". Resta solo il messaggio chiave deterministico `PICK REGISTRATO → {TEAM} → {ESITO}` + deadline in coda.
2. **Header "Round del torneo N · Turno di Campionato M" (D2).** Nuove label DEDICATE all'header in `src/game/turn.ts`: `roundHeaderLabel(tt)` → "Round del torneo N" e `championshipHeaderLabel(tc)` → "Turno di Campionato M" (maiuscolo, coerente col subject). Il box "squadre già usate" resta sulla forma compatta "(Round N)" (`roundLabel`, invariata); `championshipLabel` diventa morto e viene rimosso. Vale per TUTTE le mail con header.
3. **Elenco giocatori nel riepilogo (D3) e nello storico (D5) — carve-out della convenzione 6 (ADR-011 §2/ADR-013).** Nuovo campo canale-agnostico `EmailContext.players?: EmailPlayerResult[]` (nome/squadra/esito/eliminato nel round), popolato dal Game Engine con una query per-round (partecipanti = `eliminated = 0 OR eliminated_at >= opened_at`, LEFT JOIN pick, computata UNA volta, stesso valore per ogni destinatario). Il renderer rende `👥 GIOCATORI DEL ROUND` SOLO se `players` è presente. Il vincolo "mai elenchi nominativi, solo conteggi aggregati" è quindi CARVED-OUT per i SOLI due tipi retrospettivi `round_closed_survived` e `tournament_closed`; le mail di istruzione/pick/esito restano sui soli conteggi (`stateSection` invariata). I nomi sono SOLO LETTI (mai generati); fallback del nome = email.
4. **Nomi dei co-vincitori (D4).** Nuovo campo `EmailContext.coWinners?: string[]` (gli ALTRI vincitori, escluso il destinatario), popolato in `settleWinnerIfNeeded` da una mappa `profileId → nome` costruita PRIMA del loop. Il renderer rende `🤝 HAI CONDIVISO LA VITTORIA CON` SOLO se presente (quindi solo `tournament_shared_win`).
5. **Nuova mail `tournament_closed` (D5).** 17° `EmailType`, soggetto `⚽🏆SURVIVOR LEAGUE🏆⚽ - Chiusura Torneo` (senza turno), `keyMessage` `🏆 TORNEO CONCLUSO!`, narrativa deterministica vuota, sezione `📜 STORICO DEL TORNEO` dal nuovo campo `EmailContext.tournamentHistory?: EmailTournamentRound[]` (riusa `EmailPlayerResult`). Generata dal Game Engine con `buildTournamentHistory` (SOLA lettura: per ogni round non `pending` applica la query di D3 con lo snapshot di quel round; NON riusa `tournamentExport`, che resta il dump JSON di archivio). Invio in `settleWinnerIfNeeded`, UNA sola volta (guardia `guarded.changes === 1`), best-effort, a TUTTI i partecipanti (profili con almeno un pick, vincitori inclusi), filtrati su account `active`.
6. **Verifiche trasversali (D6/D7).** Deadline+countdown già in coda (nessuna modifica); keyMessage MAIUSCOLO e primo dopo il saluto già rispettato. Aggiunti test strutturali: (a) il corpo dei 4 tipi con pick termina con la riga deadline; (b) per i 17 tipi la riga chiave è in MAIUSCOLO (parte fissa) e precede la narrativa. Finding documentato: `pick_rejected` include il `reason` in minuscolo (dato dinamico) — il prefisso `PICK NON REGISTRATO:` resta MAIUSCOLO, il reason resta verbatim.

**Alternative considerate.**
- *Cambio globale della label "Round N" → "Round del torneo N"* — scartato: renderebbe il box bruciate "(Round del torneo N)", rumore non richiesto; si usano label dedicate all'header.
- *Elenco nominativo esteso a tutte le mail* — scartato: il carve-out è limitato ai due tipi retrospettivi; le mail di istruzione/pick/esito restano sui conteggi (scalabilità 50+).
- *Testo sostitutivo alla frase di correzione in `pick_confirmed`* — scartato (default raccomandato): resta solo il messaggio chiave; un'eventuale frase "contatta il commissioner" è domanda aperta PO.
- *Riuso di `tournamentExport` per lo storico della mail* — scartato: è il dump JSON di archivio (per il file), non dati email strutturati; la mail usa un elenco per-round snello e canale-agnostico.
- *Recap vincitori in coda allo storico* — scartato (default raccomandato): già nelle mail di vittoria.

**Conseguenze.** Il renderer resta PURO e deterministico (nuove sezioni composte solo dai campi iniettati; nessun clock/DB nel renderer); `players`/`coWinners`/`tournamentHistory` sono campi canale-agnostici (un futuro WebAdapter li riusa); il 17° tipo forza l'esaustività dei `Record<EmailType, …>` (typecheck); la mail di chiusura è inviata una sola volta e non duplica l'export; i vincitori ricevono vittoria + chiusura (comportamento intenzionale). Documentazione allineata (LLD §6.2/§6.3/§6.4, guida test-mode, cli-reference, manuale).

---

## ADR-016: Modalità `win_only` — pick con la sola squadra vincente

- **Status:** Accepted
- **Date:** 2026-08-28
- **Riferimenti:** ADR-004 (LLM confinato all'I/O), ADR-008 (aggancio TC), ADR-011/013/015 (email) · LLD §4 (config) · Piano `.kilo/plans/1787928380301-win-only-mode.md`

**Contesto.** Il PO ha chiesto una modalità di gioco opzionale **`win_only`** in cui il giocatore sceglie **solo la squadra** che vincerà la partita: il sistema interpreta il pick come "squadra vincente" (`outcome = win`). Vittoria → pick corretto (il giocatore resta in gara); pareggio o sconfitta → pick sbagliato → eliminazione. In modalità classica il pareggio è invece un esito corretto (win/draw/lose). La modalità è attivata dalla variabile d'ambiente `WIN_ONLY` (`true`/`false`, default `true`): `win_only` è la modalità di DEFAULT, la modalità classica resta disponibile con `WIN_ONLY=false`. Nessuna regola di gioco duplicata; il Jolly (futuro) dipenderà da `win_only` e ne è il naturale secondo incremento.

**Decisione.**

1. **Nessuna modifica allo schema `pick`.** In win_only si memorizza sempre `outcome='win'`; il confronto `actual === pick.outcome` di `round:score` implementa già "win → corretto; draw/lose → sbagliato" (il motore calcola `actual = pickOutcomeFor(...)` = `'win'|'draw'|'lose'` PRIMA del confronto, distinzione draw/lose preservata per il futuro Jolly).
2. **La modalità è FISSATA nel DB** (`tournament_state.win_only`, colonna additiva `INTEGER NOT NULL DEFAULT 0`) a `tournament:start` e riscritta al riavvio su torneo chiuso. Una **guardia fatale generica** `assertModeConsistent(ctx)` (`src/game/mode.ts`) confronta il valore persistito con `config.WIN_ONLY` a torneo APERTO e, su mismatch, logga `fatal` e **abortisce il processo** (throw non assorbito dai try/catch per-azione/per-messaggio): nessuno stato parziale, nessun invio con semantica mista. È agganciata all'INIZIO di tutti i percorsi di scrittura/invio (`schedulerTick`, `processEmailBatch`, `openRound`/`closeRound`/`scoreRound`, `validatePick`); i comandi read-only e `tournament:start` (il punto che SCRIVE la modalità) non sono guardati. Il nome è GENERICO: estensibile per chiave a futuri parametri di modalità (es. Jolly) senza una seconda guardia.
3. **Motore mode-aware.** `validatePick` restringe la cascata `invalid_outcome` al solo `'win'` quando `WIN_ONLY=true` (difesa in profondità: il parser emette già solo `'win'`).
4. **Confini I/O consapevoli della modalità (ADR-004).** `PickParseOptions.winOnly` è iniettato per chiamata (come `testMode`): il parser deterministico riconosce una **squadra nuda** (`{team, 'win'}`, decisione P1 — nessuna formula esplicita richiesta), rifiuta `draw`/`lose` espliciti (→ chiarimento); il classificatore LLM istruisce "solo la squadra vincente, outcome sempre 'win'" e azzera il pick su draw/lose. I testi email (narrative/prompt/CTA/key/righe giocatore) diventano win_only-aware via un **overlay** (`WIN_ONLY_NARRATIVE_OVERRIDES`/`WIN_ONLY_TEMPLATE_OVERRIDES` + `narrativeFor`/`templateFor`) senza riscrivere i 17 template; la riga giocatore in win_only omette "· esito" (sempre 'win', mostrare "· vittoria" accanto a "❌ eliminato" è fuorviante).
5. **CLI e simulazione.** `pick:* --outcome` diventa opzionale con NESSUN default lato CLI (omesso → `invalid_outcome` dalla cascata, decisione P2: il CLI non decide la modalità); `llm:parse`/`llm:classify`/`llm:generate` iniettano `winOnly`. La simulazione genera pick con solo `win` in win_only (il risultato REALE dai dati determina comunque correct/wrong, quindi draw/lose nei dati eliminano i profili simulati).

**Alternative considerate.**
- *Default `'win'` lato CLI quando `--outcome` è omesso* — scartato (decisione P2): il CLI resterebbe un interprete della modalità; è il canale email/parser a decidere, il CLI passa solo l'esito fornito.
- *Nuovo `pick.outcome='win_only'` o campo `mode` sul pick* — scartato: lo schema `pick` resta invariato, la semantica è determinata dalla modalità persistita in `tournament_state`, non da un marcatore per-pick.
- *Guardia win_only-specifica (`assertWinOnlyConsistent`)* — scartato: il nome generico evita una seconda guardia quando arriverà il Jolly.
- *Riscrivere i 17 template per win_only* — scartato: l'overlay minimale è meno invasivo e forward-compatible con un futuro oggetto `GameMode`.
- *Mostrare "· vittoria" nella riga giocatore in win_only* — scartato: ridondante e fuorviante accanto a "❌ eliminato".

**Conseguenze.** Il Game Engine resta l'unica fonte delle decisioni di gioco (la modalità restringe SOLO gli esiti validi; l'LLM resta confinato all'I/O). La colonna `tournament_state.win_only` è additiva (nessun rebuild della tabella); l'export la include (determinismo RNF1). Il toggle a metà torneo è impedito dalla guardia fatal; su torneo chiuso il riavvio via `tournament:start` riscrive la modalità dal nuovo `.env`. La squadra nuda come pick è comportamento VOLUTO (falso positivo accettato, mitigato dal classificatore LLM col prompt win_only). Il piano win_only è progettato forward-compatible per il Jolly (guardia generica, distinzione draw/lose preservata nello scoring, `PickExtraction` estensibile).

---

## ADR-017: Auto-pick al mancato invio (`AUTOPICK_ON_MISSING`)

- **Status:** Accepted
- **Date:** 2026-08-30
- **Riferimenti:** ADR-004 (LLM confinato all'I/O), ADR-011/013/015 (email), ADR-016 (`win_only`) · LLD §3/§4/§6/§7 · Piano `.kilo/plans/1788074961317-autopick-on-missing.md`

**Contesto.** Il PO ha chiesto una modalità opzionale **`AUTOPICK_ON_MISSING`** (bool, **default `false`**, attiva **solo in `win_only`**, terzo incremento di `win_only`): se un giocatore in gara non invia un pick entro la deadline, alla **chiusura** del round il sistema gli assegna automaticamente la **prima squadra disponibile in ordine alfabetico** (per il nome generico `shortName` dell'API football-data.org, es. "Inter"), escludendo le squadre **bruciate** nel girone e quelle **non in giornata**. Il pick auto-assegnato segue poi il normale scoring (corretto → resta in gara; sbagliato → eliminazione). Tutte le altre meccaniche restano inalterate. Il Jolly non è ancora implementato: questa ADR occupa ADR-017; se il piano Jolly la precedesse, la numerazione successiva slitta.

**Decisione.**

1. **Nome generico = `shortName` dell'API, salvato nel DB.** Nuova tabella additiva `team (name TEXT PRIMARY KEY, short_name TEXT NOT NULL)` (schema `src/db/schema.ts`), popolata via UPSERT su `name` da `data:import`/`data:refresh`/`data:seed-synthetic` (`upsertTeams` in `src/data/importer.ts`, derivazione `deriveTeams` dai campi transitori `Match.homeTeamShort`/`awayTeamShort` estratti da `FootballDataClient.parseMatch` e valorizzati dal generatore sintetico via `SYNTHETIC_TEAM_SHORT_NAMES`). Il `name` resta il canonico dell'API (usato ovunque nel gioco); lo `short_name` serve SOLO all'ordinamento alfabetico dell'auto-pick e al comando `rules:teams`. Su un DB legacy con tabella `team` vuota il motore degrada all'ordine canonico (fallback sicuro, mai un errore).
2. **Comando CLI `rules:teams`** (`src/cli/commands/rules.ts`, registrato in `src/cli/index.ts`): legge la tabella `team` dal DB corrente e la mostra **ordinata per `short_name`** (coppia generico + canonico, output testo `<shortName> (<name>)` per riga, `--json` → `[{ name, shortName }]`). Nessuna chiamata API live. Serve al commissioner per verificare l'ordinamento dell'auto-pick e come verifica del primo `data:import` reale.
3. **Quando scatta l'auto-assign.** In `closeRound` (`src/game/round-manager.ts`), **se e solo se** `rs.deadline !== null` (e `autopickEnabled`): chiusura a deadline ✅, chiusura forzata `--force` su round con deadline ✅, **`close_safety` (deadline NULL, RF-30) → niente auto-assign** — i mancanti restano eliminati `missing_pick` come oggi. Razionale: "AUTOPICK_ON_MISSING" = "hai mancato una *deadline reale*".
4. **Inserimento DIRETTO.** Il pick auto-assegnato è scritto con `insertPendingPick(..., autoPick = 1)` (`src/game/pick-processor.ts`, colonna additiva `pick.auto_pick`), bypassando la cascata `validatePick` (che a chiusura rifiuterebbe con `after_acceptance`/`round_not_open`), con `outcome='win'` (win_only) e `status='pending'`. La disponibilità (in giornata + non bruciata) è calcolata dal motore stesso: helper `getFirstAvailableTeamByShortName` (`src/game/rules.ts`), che riusa `getBurnedTeams` + filtro in-giornata + ordinamento stabile per `short_name` (tie-break sul nome canonico; dati letti UNA volta dal chiamante). Il pick segue poi lo scoring normale di `round:score` (win → correct; draw/lose → wrong → eliminazione). Nessun nuovo `status` su `pick`.
5. **Gating.** `autopickEnabled = config.WIN_ONLY && config.AUTOPICK_ON_MISSING` (speculare al Jolly: in modalità classica è inattivo, nessun errore — gating silenzioso). Il valore `AUTOPICK_ON_MISSING` è comunque persistito in `tournament_state.autopick_on_missing` a `tournament:start` anche con `WIN_ONLY=false` (la sola derivazione lo ignora).
6. **Fallback senza squadre disponibili** (caso difensivo: tutte bruciate in giornata): resta `missing_pick` (eliminazione come oggi) + `warn` log in inglese `round:close: auto-pick skipped (no available team) — profile eliminated as missing_pick`; non si assegna MAI una squadra non in giornata.
7. **Persistenza simmetrica a `WIN_ONLY`.** Colonna additiva `tournament_state.autopick_on_missing INTEGER NOT NULL DEFAULT 0` (`src/db/schema.ts` + `applyAdditiveMigrations` idempotente), scritta a `tournament:start` nella stessa UPSERT di `win_only` (valore `config.AUTOPICK_ON_MISSING ? 1 : 0`), inclusa in `getTournamentState`/`tournamentExport`. La guardia fatal generica `assertModeConsistent` (`src/game/mode.ts`) confronta anche `autopick_on_missing` (stessa funzione, una chiave in più — estensibile ai futuri parametri di modalità): su mismatch a torneo aperto `fatal` + `throw` con messaggio che nomina `AUTOPICK_ON_MISSING` e i valori persistito vs configurato; su torneo chiuso il riavvio via `tournament:start` riscrive il valore dal nuovo `.env`.
8. **Email `pick_auto_assigned`** (nuovo `EmailType`, `src/llm/generator.ts`, soggetto `SUBJECT_LABELS.pick_auto_assigned` = `'Pick Auto Assegnato'`): conferma **a posteriori** inviata a chiusura ai profili auto-assegnati, **SENZA** sezione deadline/countdown (post-deadline: il tipo NON è in `PICK_EMAIL_TYPES`). `keyMessage` = `PICK AUTO ASSEGNATO → {TEAM}` (squadra in MAIUSCOLO) nel renderer `src/llm/email-renderer.ts`; template e narrativa deterministica in `src/llm/templates.ts`. Le mail `round_result_*` restano identiche; nessuna riga "auto" negli esiti.
9. **Marcatore storico.** Riga ` · 🤖 Auto-assegnato` in coda a `playerResultRow` quando `p.autoPick === true` (campo `EmailPlayerResult.autoPick`): vale in ENTRAMBE le mail retrospettive — `round_closed_survived` ("👥 GIOCATORI DEL ROUND") e `tournament_closed` ("📜 STORICO DEL TORNEO") — senza parametro per distinguerle (speculare al Jolly). `getRoundPlayers` seleziona `pk.auto_pick` e propaga `autoPick: true`.
10. **Flag per-pick.** Colonna additiva `pick.auto_pick INTEGER NOT NULL DEFAULT 0` (analoga a `pick.jolly_used` del piano Jolly). Il flag NON altera lo scoring: serve solo al marcatore storico delle mail retrospettive.
11. **Ambito auto-assign.** SOLO profili **in gara** (già esistenti) senza pick nel round. Gli iscritti piattaforma senza profilo che non si sono mai iscritti al torneo NON vengono auto-joinati (fuori scope).
12. **Simulazione.** Nessuna modifica: `simulate:*` genera un pick per ogni profilo → non produce mancanti → l'auto-assign non è esercitato. La validazione avviene con smoke manuale in UAT.

**Alternative considerate.**
- *`shortName` calcolato al volo dall'API senza tabella `team`* — scartato: il motore legge solo dal DB (ADR-007); la tabella additiva rende l'ordinamento deterministico e verificabile anche offline.
- *Auto-assign anche su chiusura di sicurezza (deadline NULL)* — scartato (D3): senza deadline reale non c'è "mancato invio"; si eliminano i mancanti come oggi.
- *Pick auto registrato tramite `validatePick`* — scartato (D4): a chiusura la cascata rifiuterebbe con `after_acceptance`/`round_not_open`; l'inserimento diretto con `auto_pick=1` è l'unico percorso coerente.
- *Nuovo `status` dedicato (es. `auto_pending`) su `pick`* — scartato: nessuna regola di gioco duplicata, il flag `auto_pick` basta al marcatore; lo scoring resta identico.
- *Seconda guardia dedicata `assertAutopickConsistent`* — scartato: la stessa `assertModeConsistent` è estensibile per chiave (ADR-016), una chiave in più senza nuova funzione.
- *Sezione deadline nella mail `pick_auto_assigned`* — scartato (D8): è una conferma post-deadline, il countdown non ha senso.

**Conseguenze.** La decisione di auto-assign vive SOLO nel Game Engine (`round-manager`/`rules`); canale e LLM ricevono dati già composti (`pick_auto_assigned` con `team`, righe giocatore con `autoPick`). Lo `shortName` è dato (non logica) e arriva da import/provider; la tabella `team` è additiva e vuota sui DB legacy fino al primo `data:import`/`data:seed-synthetic` (il motore degrada all'ordine canonico). Le colonne `tournament_state.autopick_on_missing` e `pick.auto_pick` sono additive (nessun rebuild); l'export le include (determinismo RNF1: l'ordine alfabetico dipende solo dai dati, mai dal clock/LLM). Il toggle a metà torneo è impedito dalla guardia fatal estesa; `AUTOPICK_ON_MISSING=true` con `WIN_ONLY=false` è inerte (gating silenzioso). Il design resta forward-compatible col piano Jolly (guardia generica, flag per-pick analogo a `jolly_used`, marcatore speculare).

---

## ADR-018: Jolly — token che salva dal pareggio in `win_only` (`JOLLIES_PER_PLAYER`)

- **Status:** Accepted
- **Date:** 2026-08-30
- **Riferimenti:** ADR-004 (LLM confinato all'I/O), ADR-011/013/015 (email), ADR-016 (`win_only`), ADR-017 (auto-pick) · LLD §3/§4/§6/§7 · Piano `.kilo/plans/1788027046413-jolly-feature.md`

**Contesto.** Il PO ha chiesto il **Jolly** (per il piano il "secondo incremento" di `win_only`; in realtà implementato e committato DOPO l'auto-pick, che ha occupato ADR-017, perciò questa voce è ADR-018): un token spendibile per giocatore — numero configurabile via **`JOLLIES_PER_PLAYER`** (int ≥ 0, **default `1`**, `0` = feature disattivata) — che in modalità **`win_only`** salva dall'eliminazione in caso di **pareggio** (ma NON in caso di sconfitta). Il jolly si dichiara nel pick email con la keyword "jolly" (es. "Napoli Jolly"), è **bruciato alla dichiarazione** (alla registrazione del pick, a prescindere dall'esito), è una feature della **sola** modalità `win_only` (in classica il pareggio è già esito corretto), ed è persistito e coperto dalla guardia generica `assertModeConsistent` in **simmetria totale** con `WIN_ONLY`/`AUTOPICK_ON_MISSING`.

**Decisione.**

1. **Rappresentazione "salvato dal jolly" (D1): riuso `status='correct'` + flag `pick.jolly_used=1`.** Nessun nuovo `pick.status` (il CHECK `status IN (...)` è "baked" nella DDL; un nuovo stato richiederebbe il rebuild della tabella, contro la filosofia additiva). La distinzione "pareggio salvato" è nota SOLO in `evaluatePick` (`src/game/round-manager.ts`, dove `actual='draw'` è già calcolato) e trasportata alle email via flag di runtime (`savedByJolly`), mai ricostruita dopo. Classifica/storico lo contano come pick corretto (il giocatore è comunque rimasto in gara).
2. **Persistenza simmetrica a `WIN_ONLY` (D2).** Colonna additiva `tournament_state.jollies_per_player INTEGER NOT NULL DEFAULT 1`, scritta a `tournament:start` nella STESSA UPSERT di `win_only`/`autopick_on_missing` (valore `config.JOLLIES_PER_PLAYER`), inclusa in `getTournamentState`/`tournamentExport`. Invariante unico: "modalità = { win_only, autopick_on_missing, jollies_per_player }, fissata all'avvio, persistita, esportata, guardata".
3. **Contatore per-profilo (D3).** Colonna additiva `profile.jollies_remaining INTEGER NOT NULL DEFAULT 1`, inizializzata a `JOLLIES_PER_PLAYER` alla creazione del profilo (auto-join, `src/game/registration.ts`) e decrementata alla dichiarazione. Il motore legge SOLO il contatore (mai la config) per decidere `no_jollies_left`.
4. **Parsing (D4).** La keyword "jolly" è riconosciuta dal parser **solo quando i jolly sono attivi** (`jollyEnabled` iniettato per-chiamata in `PickParseOptions`, pari a `WIN_ONLY && JOLLIES_PER_PLAYER >= 1`): parser deterministico (`deterministic-parser.ts`) con word boundary case/accenti-insensibile (`\bjoll[yi]\b`) OVUNQUE nel testo, keyword rimossa prima di risolvere squadra+esito (la risoluzione resta quella win_only: squadra nuda → `win`, draw/lose esplicito → chiarimento); classificatore LLM con campo `jolly` nel pick e istruzioni nel prompt. Jolly off → "jolly" è rumore → pick normale (identico a oggi). In win_only "Napoli Jolly pareggia" resta non riconosciuto (draw esplicito → chiarimento).
5. **Cascata (D5).** I due controlli jolly vanno DOPO `pick_already_exists` e PRIMA dei check temporali in `validatePick` (`src/game/pick-processor.ts`): `jolly_not_allowed` (jolly in modalità classica — difensivo, raggiungibile via CLI) e `no_jollies_left` (contatore esaurito). Il jolly è SOLO win_only: con `JOLLIES_PER_PLAYER=0` il sistema si comporta esattamente come oggi.
6. **Atomicità (D6).** Il decremento di `jollies_remaining` avviene nella STESSA transazione dell'inserimento pick: `db.transaction` in `registerPick` (insert + `UPDATE profile SET jollies_remaining = jollies_remaining - 1` solo se `input.jolly === true`); dentro il `BEGIN/COMMIT` esistente in `autoJoinFromPick`. Violazione UNIQUE → `pick_already_exists` (invariato). Mai un consumo senza pick e mai un pick con jolly senza consumo. *(Nota ADR-019: `autoJoinFromPick` è stato RIMOSSO — la creazione dei profili ora vive in `createProfileForAccount` (`src/game/registration.ts`), che inizializza `jollies_remaining` a `JOLLIES_PER_PLAYER`; l'atomicità decremento+pick resta in `registerPick`.)*
7. **`GameMode` estensibile (D7).** Il booleano `winOnly` è promosso a un oggetto **`GameMode { winOnly, jollyEnabled }`** con factory pura `modeFor(winOnly, jolliesPerPlayer)` (`src/game/mode.ts`): destinato a crescere con le future feature di `win_only` — unico punto di derivazione (mai `getConfig()` nei moduli). Iniettato a renderer/generatori/template (`renderEmailV2`, `narrativeFor`, `templateFor`, `deterministicNarrative`, `OpenAIGenerator`, `DeterministicGenerator`) e al parser (`PickParseOptions.jollyEnabled`). Refactor meccanico senza cambio di comportamento.
8. **Comunicazione email (D8, tabella testi nel piano).** La chiave in MAIUSCOLO resta SEMPRE la prima informazione; il jolly è riga esplicativa successiva: `pick_confirmed` con jolly → "PICK REGISTRATO CON JOLLY → {SQUADRA}" + "Jolly rimasti: N."; `pick_instructions` con jolly attivo → riga "🎯 Jolly: scrivi «SQUADRA Jolly» per usarlo — un pareggio non ti eliminerà (la sconfitta sì)." + "Jolly rimasti: N."; esito salvato dal pareggio → "🎯 Il tuo jolly ti ha salvato: {SQUADRA} ha pareggiato."; vittoria con jolly → "🎯 Jolly usato"; sconfitta con jolly → "🎯 Il jolly non salva dalla sconfitta."; `round_closed_survived` → "🎯 Jolly rimasti: N." per destinatario. `pick_rejected` per `no_jollies_left` → "non hai più jolly disponibili"; per `jolly_not_allowed` → "il jolly non è ammesso in questa modalità" (D11). Con `JOLLIES_PER_PLAYER=0` nessuna riga jolly appare.
9. **Marcatore "🎯 Jolly" per giocatore (D9).** Mostrato in `playerResultRow` (campo `EmailPlayerResult.jolly`, da `pk.jolly_used` in `getRoundPlayers`), quindi in ENTRAMBE le mail retrospettive — `round_closed_survived` e `tournament_closed` — senza parametro per distinguerle (speculare all'auto-pick).
10. **Simulazione (D10).** Seed jolly deterministico gated su `jollyEnabled`: un singolo `rng()` extra per pick (probabilità `0.25`) DOPO la scelta squadra/esito, SOLO se il profilo ha `jollies_remaining > 0`. Con jolly off NESSUN extra `rng()`: la sequenza classica resta invariata (RNF1). `simulateRound` scrive anche `jollies_per_player` nell'UPSERT locale di `tournament_state` (coerenza export).
11. **Scoring (D1).** In `evaluatePick`: `let result = actual === pick.outcome ? 'correct' : 'wrong'`; `savedByJolly = result === 'wrong' && pick.jolly_used === 1 && actual === 'draw'`; se `savedByJolly` → `result = 'correct'` (nessuna eliminazione: il ramo `wrong` è saltato). `ScoredPick`/payload notifiche portano `jollyUsed`/`savedByJolly`. Il jolly NON salva dalla sconfitta e il consumo avviene comunque anche su vittoria.

**Alternative considerate.**
- *Nuovo `pick.status` "salvato dal jolly"* — scartato (D1): il CHECK della DDL è "baked"; un nuovo stato richiederebbe il rebuild della tabella contro la filosofia additiva. Il flag `jolly_used` + runtime `savedByJolly` bastano (classifica/storico contano il pick corretto).
- *Contatore derivato dalla config a ogni pick* — scartato (D3): il motore legge SOLO il contatore persistito (`profile.jollies_remaining`), mai la config, così la decisione `no_jollies_left` è coerente con lo stato reale anche a torneo aperto.
- *Seconda guardia dedicata `assertJollyConsistent`* — scartato: la stessa `assertModeConsistent` è estensibile per chiave (ADR-016/017), una chiave in più senza nuova funzione.
- *Rimborso del jolly su pick `wrong`/`frozen`* — scartato (regola 5): il jolly è bruciato alla dichiarazione, a prescindere dall'esito; nessun rimborso.
- *Jolly attivo anche in modalità classica* — scartato: in classica il pareggio è già esito corretto, il jolly non avrebbe effetto; la dichiarazione in classica è rifiutata (`jolly_not_allowed`).

**Conseguenze.** La decisione jolly vive SOLO nel Game Engine (cascata, contatore, scoring `savedByJolly`); canale e LLM ricevono dati già composti (`PickExtraction.jolly`, `jollyUsed`/`savedByJolly`/`jolliesRemaining` in `EmailContext`). Le colonne `tournament_state.jollies_per_player`, `profile.jollies_remaining` e `pick.jolly_used` sono additive (default `1`/`1`/`0` — i profili legacy ricevono un jolly, accettato pre-lancio e documentato); l'export le include (RNF1). Il toggle a metà torneo è impedito dalla guardia fatal estesa (stessa funzione, una chiave in più); `JOLLIES_PER_PLAYER=0` è inerte (sistema identico a oggi, keyword ignorata). `GameMode`/`modeFor` diventano l'unico punto di derivazione della modalità per renderer/generatori, pronti per le future feature di `win_only`. Il determinismo RNF1 è preservato: `jolly_used`/`jollies_remaining`/`jollies_per_player` sono scritti dal clock/seed iniettati e il seed jolly usa `rng()` gated su `jollyEnabled`.

---

## ADR-019: Partecipazione opt-in (registration ≠ join) e rimozione dell'auto-join al primo pick

- **Status:** Accepted
- **Date:** 2026-08-30
- **Riferimenti:** ADR-009 (decisioni 6/7, EMENDATE), ADR-008 (override US10), ADR-010, ADR-011 (nome, email), ADR-014 (parser deterministico), ADR-017 (auto-pick) · PRD v0.6.x (RF-P1…P8, §4.1/§4.3/§4.7 riscritti) · HLD v0.5.x · LLD v0.6.x · Piano `.kilo/plans/1788106316564-optin-tournament-participation.md`

**Contesto.** Con ADR-009 il profilo nasceva **al primo pick valido nel TT 1** (auto-join al primo pick, RF-P5): un iscritto alla piattaforma che **non inviava mai il primo pick** non aveva profilo → non era "in gara" → l'**autopick** (ADR-017) non poteva scattare per lui → restava **escluso dal torneo in silenzio** (nessuna email di round, nessuna eliminazione). Questo contraddiceva lo spirito dell'autopick ("salvare dal `missing_pick`"). Il problema è lo stesso tipo di **collisione architetturale** già vista tra auto-join e auto-pick: due meccanismi che si escludevano a vicenda sul confine "chi è in gara".

**Decisione.**

1. **Registration ≠ join (terminologia vincolante).** Due concetti distinti e non intercambiabili: la **registration** è la relazione giocatore↔**piattaforma** (persiste alla creazione/distruzione dei tornei; `platform_account`, intenti `subscribe`/`unsubscribe`, comandi `platform:*`); il **join** è la partecipazione al **singolo torneo** (nasce e muore col torneo; `profile`, intento `join`, comando `tournament:join`). `platform:register` crea l'account ma **non** crea profili; `tournament:join` crea il profilo ma **non** crea l'account.
2. **Rimozione dell'auto-join al primo pick (emenda ADR-009 decisione 6).** `autoJoinFromPick` è RIMOSSO (src/game/registration.ts): il pick **non crea più profili**. Un iscritto `active` senza profilo che invia un pick nel TT1 riceve `tournament_join_rejected` reason `not_in_tournament` (testo "per partecipare invia PARTECIPO"); dal TT2 → `rejected_tt2` invariato.
3. **Due flag per-account, canale-agnostici, default ON (D2/D3).** Due colonne additive su `platform_account` (DDL + `applyPlatformAdditiveMigrations` idempotente, stesso pattern della colonna `name`): `receive_tournament_start_notification INTEGER NOT NULL DEFAULT 1` e `tournament_auto_join INTEGER NOT NULL DEFAULT 1`. Default `1`: gli account pre-esistenti diventano auto-join ON + notifiche ON (**opt-out de facto**: il comportamento reale è "tutti auto-iscritti", conseguenza voluta e documentata). I flag sono **dati** di piattaforma, non logica: vivono nel DB piattaforma e sono letti dal Game Engine.
4. **Gestione SOLO via CLI (D4).** `platform:register --email [--name] [--auto-join] [--receive-notifications]` (bool, default `true`; applicati via `setPreferences` **SOLO alla prima creazione** — le riattivazioni NON toccano i flag, registration-pure) e nuovo `platform:preferences --email [--auto-join on|off] [--receive-notifications on|off] [--json]` (senza flag = lettura). **Nessuna email** per togglarli. `platform:list` mostra i due flag. Cambio flag → impatta **solo i tornei successivi** (snapshot a `tournament:start`, D5).
5. **Due ingressi al torneo (D6/D11).** (a) **Auto-join bulk a `tournament:start`** (`autoJoinProfilesAtStart`): per ogni account `active` con `tournamentAutoJoin === true` crea il profilo se non già presente (idempotente; `ctx.platform === undefined` → no-op); è lo **snapshot unico** — un account diventato `active` DOPO `tournament:start` (late registrant) NON è auto-joinato e deve dichiarare. (b) **Dichiarazione esplicita** (`declareParticipation`): via email `PARTECIPO` o CLI `tournament:join --email [--reason]`, ammessa nella finestra del TT1 (round 1 `pending` o `open`, anche PRIMA di `round:open`, simmetrico all'auto-join). `StartTournamentResult` aggiunge `autoJoined: number`.
6. **Finestra e override (D7/D10/D12).** Dopo la chiusura del TT1 la lista partecipanti è **blindata**: la dichiarazione è rifiutata (`late_requires_reason`, testo al giocatore "il torneo è iniziato"); unico escape = override CLI `tournament:join --reason` (obbligatorio, ADR-008 §6, profilo creato con pool intatto). Il percorso email NON passa mai `reason`. Il **CLI join non invia email** (azione amministrativa; il giocatore apprende via `tournament_open`/`pick_instructions`).
7. **Matrice notifiche (emenda ADR-009 decisione 7, D9).** `tournament_open` → ai soli account `active` con `receiveTournamentStartNotification === true` (filtro su `activeAccounts()`); `pick_instructions` → ai soli partecipanti (profili) — **cade l'eccezione TT1** "anche agli iscritti attivi senza profilo" (il blocco `registeredNotified` di `openRound` è RIMOSSO, campo `registeredNotified` tolto da `RoundOpenResult`); nessun reminder separato al TT1. Le mail di **join** sono parte del flusso di partecipazione (ADR-019), come le conferme di registration: partono sempre.
8. **Nuovo intento `join` (D13).** `MessageIntent` += `'join'` (src/llm/intent-classifier.ts): formula email univoca **`PARTECIPO`** (src/llm/deterministic-parser.ts, `partecipo` spostato dagli esempi di `subscribe` a `join` — altrimenti l'LLM classificherebbe la registrazione con la partecipazione); prompt LLM con descrizione dedicata ("già iscritto, dichiara di voler partecipare al torneo in corso"). L'ordine del parser deterministico: `disiscrizione` → `iscrizione` → `partecipo` → pick.
9. **Wiring email.** Nuovo ramo `join` in `channel:email:process` (PRIMA del gate round): account null/`unsubscribed` → log silenzioso + markSeen (RF-P4, un join non è mai una registration); `pending_unsubscribe` → `reactivate` (come pick); poi `declareParticipation` → `tournament_join_confirmed` / `tournament_already_joined` (idempotenza D8: flag ON + `PARTECIPO` → "già in gara") / `tournament_join_rejected` con `reason` (`no_tournament` / `tournament_started` / `not_in_tournament`). `ProcessedAction` += `join_confirmed`/`join_rejected`/`already_joined`; il chiarimento insegna la formula `PARTECIPO`.
10. **Nuovi `EmailType` (D14).** `tournament_join_confirmed` (soggetto `Partecipazione Confermata`), `tournament_already_joined` (soggetto `Già in Gara`), `tournament_join_rejected` (soggetto `Partecipazione Non Confermata`, con `reason`). La CTA di `tournament_open` insegna la partecipazione: **"Per partecipare al torneo, rispondi con \"PARTECIPO\"."** `tournament_join_confirmed` è in `PICK_EMAIL_TYPES` (box deadline in coda SOLO se un round è aperto).
11. **Unica fonte di creazione profilo.** `createProfileForAccount(db, account, now, jolliesPerPlayer)` (src/game/registration.ts) è l'UNICA fonte della nascita dei profili (AGENTS.md §1.3): riusa/backfill il `player` legacy con `register_id` (B7), crea il `profile` con `jollies_remaining = JOLLIES_PER_PLAYER` (ADR-018). Usata da `autoJoinProfilesAtStart` e `declareParticipation`.
12. **Simulazione (T7).** `simulateSeason` registra gli account sim **PRIMA** di `startTournament` (così l'auto-join bulk li vede); `simulateRound` (che non passa da `startTournament`) invoca esplicitamente `autoJoinProfilesAtStart` DOPO la registrazione. Rimosso il ramo TT1 speciale che usava `autoJoinFromPick`: il seed RNG cambia sequenza (accettato, resta deterministico RNF1). `registerSimAccounts` non cambia (tutti i sim nascono `tournament_auto_join = ON`); il join/dichiarazione è validato via unit test + smoke UAT, non dalla simulazione.

**Alternative considerate.**
- *Mantenere l'auto-join al primo pick e "farlo convivere" con l'autopick* — scartata: la collisione è strutturale (un account senza profilo non è mai "in gara" e l'autopick non può coprirlo); i due meccanismi si escludono.
- *Opt-out implicito (nessun flag, tutti dentro)* — scartata (D1): la partecipazione esplicita è richiesta dall'operatore; i flag per-account con default ON bilanciano semplicità e controllo.
- *Flag gestiti via email* — scartata (D4): niente nuove formule/template; la CLI è il punto di gestione (ADR-006).
- *Auto-join per qualunque account `active` a ogni avvio di round* — scartata (D11): l'auto-join è uno snapshot unico a `tournament:start`; gli iscritti successivi dichiarano (finestra TT1).
- *Secondo intento LLM "join" separato dal parser deterministico* — scartata (D13): entrambi gli implementatori del classificatore riconoscono `join`/`PARTECIPO`.

**Conseguenze.** Il profilo esiste a partire da `tournament:start` (per gli auto-join ON) o dalla dichiarazione (per gli OFF/late): **l'autopick torna a coprire chi è in gara ma dimentica il pick**, che è il suo scopo (ADR-017). La decisione "chi partecipa" vive SOLO nel Game Engine (`registration.ts`/`tournament.ts`/`round-manager.ts`); canale e LLM ricevono dati già composti. I flag sono colonne additive (nessun rebuild, migrazioni idempotenti, default 1 coerente col comportamento reale). Nessuna nuova env var. La terminologia registration/join è vincolante nella documentazione e nel codice (intento `join` vs `subscribe`, `tournament:join` vs `platform:register`). L'**ADR-009 decisione 6 (auto-join al TT1) e il concetto "auto-join al primo pick" (RF-P5) sono sostituiti** dal modello qui descritto; la decisione 7 è emendata sulla matrice notifiche.

---

## ADR-020: Guardia temporale `pick_before_round_open` e riordino della cascata pick

- **Status:** Accepted
- **Date:** 2026-08-31
- **Riferimenti:** ADR-001 (`receivedAt` autorevole) · ADR-003 · ADR-008 (US10 override) · ADR-016 (cascata `invalid_outcome`) · PRD (RF-08 un pick per profilo per round, RF-10/CS5 squadre bruciate) · LLD §3.1 (cascata pick) · Piano `.kilo/plans/1788191141330-fix-post-uat-residual-email-pick.md` (incidente UAT 2026-08-31)

**Contesto.** Nel run UAT del 2026-08-31 (scheduler automatico) un'email **residua** di un run precedente (reply "milan", rimasta non letta in casella dopo il reset del solo DB torneo) è stata letta dal primo `channel:email:process` del nuovo run e registrata come **pick fantasma** per il round corrente (il processore assegna ogni email al round attualmente aperto; la casella non era stata pulita prima dell'avvio). Il vero pick del giocatore è stato poi rifiutato con il motivo fuorviante `team_already_used` (la cascata valuta `isBurned` — che include il pick del round corrente — PRIMA del check "pick già esistente"). Due difetti distinti: (1) **nessuna guardia temporale** contro pick ricevuti PRIMA dell'apertura del round; (2) **ordine della cascata** che maschera l'invariante primario RF-08 dietro il motivo squadra-bruciata.

**Decisione.**

1. **Guardia temporale `pick_before_round_open`.** In `checkAcceptance` (pick-processor) il round aperto è accettato solo se `receivedAt >= round_state.opened_at`: un pick ricevuto prima dell'apertura è un **residuo di un run precedente**, mai un pick legittimo (le istruzioni di pick partono con `round:open`, quindi un giocatore non può rispondere prima). Rifiuto con nuovo reason `pick_before_round_open` (catalogo `PICK_REJECT_REASONS`), tradotto in italiano nel canale email. La colonna `opened_at` è già nello schema (nessuna migrazione). **È un check temporale** → coperto dall'override US10 `pick:register --reason` (come `after_acceptance`/`after_kickoff`). Con `TEST_OFFSET_DAYS>0` (replay) `opened_at` e `receivedAt` sono shiftati dello STESSO delta → ordine preservato, nessun falso positivo.
2. **Riordino della cascata (RF-08 primario).** In `validatePick` il check "esiste già un pick per profilo+round" (`pick_already_exists`) viene PRIMA del check delle squadre bruciate (`team_already_used`): qualunque nuovo invio a round già coperto è un **duplicato** a prescindere dalla squadra. `team_already_used` resta per squadre bruciate in round PRECEDENTI (profilo senza pick nel round corrente). Nessuna modifica a `isBurned`/`getBurnedTeams` (i frozen contano, include il round corrente) e nessun cambiamento di accettazione: i pick rifiutati restano rifiutati, cambia solo il motivo per i duplicati.
3. **Difesa in profondità + pratica operativa.** La guardia (1) rende innocuo un residuo processato per errore, ma la pratica corretta resta il **pre-flight casella**: `channel:email:fetch` prima di `tournament:start` e dopo un reset/run abortito (guida test-mode §2.4/§2.5/§8, manuale §6.3/§6.7). Nessuna pulizia automatica della casella (fuori scope POC, LLD §6.4).

**Alternative considerate.**
- *Pulizia automatica della casella a `tournament:start`* — scartata: il reset del DB non deve toccare il canale email (mai cancellare registrazioni valide; la decisione resta dell'operatore).
- *Ancorare il pick al round "più recente" via subject/header* — scartata: fragile e fuori dal contratto ADR-001 (`receivedAt` è l'unico timestamp autorevole).
- *Filtrare il residuo nel processor (confronto con `opened_at` lì)* — scartata: la regola temporale è logica di gioco e vive nel Game Engine (AGENTS.md §1.3), non nel wiring.
- *Tenere `team_already_used` per i duplicati* — scartata: motivo fuorviante per il giocatore (l'email dice "squadra già scelta" quando il problema è "pick già inviato") e incoerente con RF-08.

**Conseguenze.** Un'email residua processata a round aperto è rifiutata con `pick_before_round_open` e NON crea più pick fantasma (nessun impatto sullo stato di gioco; il messaggio resta non letto → visto dal pre-flight o marcato letto dal processore come rifiuto). I duplicati nello stesso round restituiscono `pick_already_exists` (messaggi più chiari, "First valid Pick wins" invariato). `PICK_REJECT_REASONS` cresce di un motivo (13) e l'enum riflette il nuovo ordine di applicazione; test unit/integrazione aggiornati (incluso il test anti-codici del renderer). Documentazione operativa aggiornata col pre-flight casella.

---

*Fine del log ADR.*
