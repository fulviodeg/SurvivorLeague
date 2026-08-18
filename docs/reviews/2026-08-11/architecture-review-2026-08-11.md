# Architecture Review: Survivor League — POC

**Data:** 2026-08-09
**Aggiornata:** 2026-08-11 — rimossi i finding risolti dalle modifiche di design del 2026-08-11 (terminologia TC/TT, deadline e finestra di pick, chiusura del TC = fine prevista UPP + scarto, stato Freeze, CL1/CL7/CL8, roadmap BRIEF §7). **Aggiornata: 2026-08-12** — risolti l'unico bloccante residuo HIGH-02 (timestamp della deadline: fa fede la ricezione sul server, vedi §0.1), il raccomandato MED-02 (partite sospese = rinviate, vedi §0.2) e CRITICAL-02 (completezza risultati, risolto con la contabilizzazione incrementale, vedi §0.3). Gli ID originali sono conservati per tracciabilità; i punti chiusi sono riepilogati in §0. Nessun finding prioritizzato resta aperto.**
**Revisore:** Principal Product & System Architect (peer review indipendente)
**Documenti analizzati:**
- `BRIEF/BRIEF.MD` (dal 2026-08-11 documento storico congelato: fanno fede i documenti di design)
- `BRIEF/FUTURE_EXPLORATIONS.MD`
- `docs/POC/POC_PRD.md`
- `docs/POC/POC_HLD.md`
- `docs/POC/POC_LLD.md`

---

## 0. Finding chiusi il 2026-08-11 (rimossi dalle sezioni successive)

| ID | Titolo | Esito |
|---|---|---|
| CRITICAL-01 | Derivazione squadre bruciate | Risolto dal modello **Freeze** (PRD §4.4): i pick su partite rinviate non si annullano più, la squadra resta bruciata nel girone e la query del LLD §1.1 senza filtri è corretta. **Il fix proposto (`AND result IS NOT NULL`) è superato e NON va applicato** |
| HIGH-01 | WhatsApp POC vs Fase 1 | Risolto: BRIEF §7 — la POC è la fase 0; WhatsApp è tra le 6 capability della Fase 1 di Produzione |
| HIGH-03 | Rinvio entro la finestra | Risolto: PRD §4.4 + CL7/CL8 — recupero entro la finestra del TC → pick contabilizzato alla chiusura del TC; fuori finestra → Freeze (CL1); UPP non giocata → chiusura comunque. `rescheduled_date` su `match` rimandato a Fase 1 (LLD §3.1) |
| MED-01 | Ultima giornata girone + rinvio | Risolto: le regole del Freeze coprono il caso — nessuna eliminazione per rinvio, pick in attesa (PRD §4.4) |
| MED-04 | Cross-reference errati | Risolto: `lld.md` → `POC_LLD.md`/`POC_HLD.md` in HLD e LLD (header e albero `docs/`) |
| MED-05 | Entry fee / winner share | Risolto: righe del LLD §4.1 marcate placeholder per la Fase 1 — pagamenti e montepremi fuori scope POC (PRD §10, BRIEF §7.2) |
| LOW-04 | Stagione hardcodata (38) | Risolto: PRD §3.6 con nota data-driven |

---

## 0.1. HIGH-02 — Timestamp della deadline: **RISOLTO il 2026-08-12**

**Decisione del PO** (domanda §15.2, HIGH-02): fa fede la **ricezione sul server**, non l'header `Date` dell'email.

**Motivazione della scelta.** L'header `Date` è un timestamp di un servizio esterno che non controlliamo: è prodotto dalla catena di invio (client/SMTP del mittente) e non conosciamo quanto tempo impiega il server di mail a effettivamente consegnare il messaggio. L'unica data che può far fede è quella in cui **il nostro server riceve il pick**, perché è l'istante su cui abbiamo controllo.

**Impatto della latenza del polling (risolto).** La preoccupazione del finding (un pick inviato 59 secondi prima della deadline processato dopo e respinto, con `IMAP_POLL_MS` = 60000) è risolta definendo operativamente la ricezione: per l'email, `receivedAt` = **`internaldate` IMAP**, cioè l'istante in cui il server di posta ricevente registra il messaggio nella casella. La latenza del polling non penalizza il giocatore: conta l'arrivo in casella, non l'istante in cui il poll lo legge. `receivedAt <= deadline` → pick valido.

**Modifiche applicate:**
- **PRD §4.3**: aggiunto il bullet che definisce il timestamp di ricezione sul server come autorevole (`receivedAt`, `internaldate` IMAP per l'email), con motivazione; `Date` header escluso
- **PRD §3.3**: regola "pick ricevuti dopo la deadline respinti" agganciata a `receivedAt` (4.3)
- **PRD §8 (CL3)**: riferimento esplicito al timestamp autorevole
- **HLD §5**: aggiunta la nota "Timestamp della ricezione del pick (deadline)" dopo la tabella CL, con decisione del PO e data
- **LLD §6.4**: documentato il significato di `IncomingMessage.receivedAt` nel contratto (ricezione sul server, non `Date` header)
- **LLD §1.3**: responsabilità dell'IMAP Client estesa: popola `receivedAt` con l'`internaldate`
- **LLD §3.1**: vincolo applicativo "pick dopo la deadline → rifiutato" agganciato a `receivedAt` (PRD §4.3)

**Impatto su altre feature:** nessuno. La scelta riguarda solo il confronto pick↔deadline; non tocca determinazione della deadline, contabilizzazione, Freeze, CL1/CL7/CL8, gironi o Scheduler.

---

## 0.2. MED-02 — Partite sospese: **RISOLTO il 2026-08-12**

**Decisione del PO (MED-02):** ai fini del gioco la partita sospesa è **trattata come rinviata**. Il pick non può essere determinato finché il risultato finale non è chiaro: quindi una partita in corso sospesa viene automaticamente considerata rinviata ai fini del gioco, il pick non è contabilizzabile e resta in attesa (Freeze se il recupero è fuori dalla finestra del TC). La partita avrà una data di ripresa e, quando sarà giocata e conclusa con un risultato chiaro, il pick potrà essere contabilizzato.

**Motivazione della scelta.** Rinvio e sospensione sono equiparabili ai fini del gioco perché in entrambi i casi l'esito del pick **non è determinabile** fino a quando la partita non è conclusa: conta il risultato finale chiaro, non se la partita non è iniziata o è stata interrotta a punteggio parziale. Stesso trattamento, stesse regole (PRD §4.4: entro finestra → CL7; fuori finestra → Freeze/CL1), nessuna distinzione di stato nel modello.

**Modifiche applicate:**
- **PRD §4.4**: aggiunto il paragrafo "Partite sospese" — trattate come rinviate, con ripresa in nuova data e contabilizzazione a risultato chiaro
- **PRD §8 (CL1)**: caso esteso a "rinviata (o sospesa, 4.4)"
- **HLD §4.4**: nota gestione partita rinviata estesa alle sospese; **HLD §5 (CL1)** allineato
- **LLD §3.1**: vincolo applicativo esteso a rinviata o sospesa (`postponed = 1`)
- **LLD §3 (DDL)**: semantica di `postponed` documentata (include le sospese nella POC)
- **LLD §6.1**: commento su `Match.postponed` aggiornato

**Impatto su altre feature:** nessuno. Nessun nuovo stato nel modello (la distinzione `suspended` resta una valutazione per la Fase 1, PRD §4.4); Freeze, CL7/CL8, squadre bruciate e contabilizzazione invariati. Nell'LLD §13/I2 il campo `rescheduled_date` resta rimandato a Fase 1.

---

## 0.3. CRITICAL-02 — Completezza dei risultati: **RISOLTO il 2026-08-12**

**Decisione (confronto architetturale col PO):** la contabilizzazione cambia da **batch al TC close** a **incrementale** (pick-by-pick quando il risultato del singolo match è disponibile), con **scheduler sottile** (orchestra *quando* agire, nessuna logica di gioco) e **Round Manager** che implementa tutta la logica di gioco (`round:score`, idempotente, processa i pick `pending`). Il round passa a `scored` quando tutti i pick sono in stato terminale (`correct`/`wrong`/`frozen`), che può avvenire anche **prima della chiusura del TC**.

**Perché supera la raccomandazione del finding (`areAllResultsFinal(round)`).** Il problema originale era: in produzione il provider non sa quando *tutti* i risultati sono disponibili, e non distingue "risultato non arrivato" da "rinviata/sospesa". Con la contabilizzazione incrementale **non serve sapere se tutti i risultati sono pronti**: il Round Manager usa `getMatchesForRound(round)` (già esistente), che espone `homeScore?`/`awayScore?`/`postponed` per ogni match — punteggio presente = concluso (→ contabilizza); `postponed` senza punteggio = rinvio (→ Freeze); nessuno dei due = in corso (→ resta `pending`). **`areAllResultsFinal` NON va aggiunta** (marker esplicito, come CRITICAL-01): è superata dalla scelta architetturale.

**Modifiche applicate:**
- **PRD §3.5**: contabilizzazione incrementale descritta (pick valutati quando il risultato è disponibile; TT chiuso quando tutti i pick sono terminali; idempotenza)
- **PRD §4.4**: TC close non più trigger; è la finestra di riferimento per CL7/CL8/CL1 e per il freeze dei match non giocati
- **PRD §1.2**: nuova sezione "Ruoli e responsabilità dei componenti" (Separation of Concerns)
- **HLD §1.2/§1.3**: `Scored` raggiunto incrementalmente; TC close = finestra di riferimento, non trigger
- **HLD §4.4**: flusso di contabilizzazione riscritto (pick `pending`, stati `correct`/`wrong`/`frozen`, chiusura quando tutti terminali)
- **LLD §1.1**: Round Manager = contabilizzazione incrementale dei pick
- **LLD §1.4**: Scheduler = orchestratore sottile (quando, non cosa); TC close rimosso come trigger
- **LLD §3**: colonna `pick.result` sostituita da `pick.status` enum `pending | frozen | correct | wrong`
- **LLD §3.1**: stato esplicito del pick; Freeze = `status = 'frozen'`
- **LLD §6.1**: nota CRITICAL-02 — `areAllResultsFinal` non serve, non si aggiunge
- **LLD §7.3**: descrizione di `round:score` aggiornata (incrementale, idempotente)
- **LLD §7.12**: `scheduler:tick` aggiornato (orchestratore sottile)
- **AGENTS.md**: principio architetturale vincolante di separazione delle responsabilità

**Impatto su altre feature:** nessuna modifica alle regole (eliminazioni, Freeze, CL7/CL8, gironi, vincitore). Cambia il *quando* della contabilizzazione e la rappresentazione dello stato pick (esplicito): i giocatori apprendono l'esito man mano che la propria partita si conclude, in modo equo perché la squadra è scelta conoscendo l'orario (motivazione in §1 del confronto PO).

---

## 1. Executive Summary

La POC è architetturalmente solida nel suo nucleo: la separazione tra Game Engine deterministico e LLM Adapter probabilistico è corretta, il ChannelAdapter come interfaccia astratta supporta l'estensibilità futura, e il SeasonDataProvider isola la sorgente dati dietro un contratto pulito. La doppia modalità operativa (sviluppo manuale / produzione automatica) è dichiarata esplicitamente nell'HLD e supportata dallo Scheduler nel LLD.

**I problemi più rilevanti rimasti aperti sono due:**

1. **Completezza dei risultati in produzione (CRITICAL-02):** RISOLTO il 2026-08-12 con la contabilizzazione incrementale (pick-by-pick quando il risultato è disponibile) + separazione scheduler/Round Manager — vedi §0.3. Non serve più `areAllResultsFinal`.
2. **Lacune nel passaggio POC → produzione automatica:** la decisione sul timestamp della deadline è stata presa (HIGH-02, vedi §0.1); restano nessuna osservabilità, nessun fallback per l'LLM, nessuna strategia di riconciliazione dati.

L'architettura NON preclude l'evoluzione verso la produzione — anzi, l'ha anticipata con scelte consapevoli (SeasonDataProvider, ChannelAdapter, Scheduler). I punti deboli sono lacune di specifica e un errore di dettaglio implementativo, non errori architetturali strutturali.

**Implementation Readiness aggiornata al 2026-08-12: ~86/100** (era 78/100; risolti tutti i bloccanti, i raccomandati e CRITICAL-02 con la contabilizzazione incrementale, vedi §0.1/§0.2/§0.3). Vedi §17.

---

## 2. Valutazione dello Scope della POC

Lo scope della POC è chiaramente definito nel PRD (§1, §10):

| Incluso | Escluso |
|---------|---------|
| Singolo canale (email) | WhatsApp, Telegram, web |
| Un profilo per giocatore | Profili multipli |
| CLI per amministrazione | Interfaccia web |
| Dati storici 2025/26 | Dati live |
| Regole di gioco complete | Pagamenti, payout, montepremi |
| Simulazione intera stagione | Jolly, auto-pick, ingressi tardivi |

Le esclusioni sono coerenti con `BRIEF/FUTURE_EXPLORATIONS.MD` nella quasi totalità dei casi. L'eccezione WhatsApp (BRIEF §3.8) è stata risolta con la roadmap del BRIEF §7: la POC è la fase 0 e WhatsApp è in Fase 1 di Produzione (vedi §0, HIGH-01).

**Giudizio:** Lo scope è ben delimitato e comunicato. I documenti POC_PRD, POC_HLD, POC_LLD recano tutti l'header "POC ONLY" e rispettano generalmente lo scope dichiarato.

---

## 3. Transizione POC → Produzione (dati storici/manuale → dati live/automatico)

### 3.1 Cosa funziona

L'architettura anticipa esplicitamente la transizione in più punti:

- **SeasonDataProvider** (LLD §6.1): interfaccia astratta con implementazione `StaticProvider` per la POC e `ApiProvider` previsto per il futuro. La logica di dominio (round, pick, eliminazioni) dialoga solo con l'interfaccia, mai con l'implementazione concreta. Questo isola correttamente la sorgente dati.
- **ChannelAdapter** (LLD §6.4): interfaccia astratta con `EmailAdapter` come unica implementazione POC. Aggiungere canali non richiede modifiche al Game Engine.
- **Doppia modalità** (HLD §1.3, LLD §7.12): `SCHEDULER_ENABLED=false` per sviluppo manuale, `true` per produzione automatica via cron + `scheduler:tick`.
- **Configurabilità** (LLD §4): tutti i parametri di gioco sono in env vars, non hardcodati. I parametri del campionato sono derivati dai dati (LLD §3.2).

### 3.2 Cosa manca o è debole

| Lacuna | Impatto |
|--------|---------|
| Nessun meccanismo per determinare se "tutti i risultati del round sono disponibili" (HLD §4.4) | Risolta il 2026-08-12 con la contabilizzazione incrementale: non serve sapere quando sono pronti tutti i risultati (CRITICAL-02, v. §0.3) |
| Nessuna strategia di osservabilità/monitoraggio per il funzionamento automatico | In produzione, un fallimento silenzioso (es. cron non parte, LLM API down) può passare inosservato per ore/giorni |
| Nessuna strategia di retry o resilienza per dipendenze esterne (LLM API, IMAP, SMTP) | Un errore transiente di rete può bloccare l'intero flusso senza recovery |
| Deadline timestamp ambiguity (BRIEF §5) | È stata risolta il 2026-08-12: decisione PO (ricezione sul server, `internaldate` IMAP, non `Date` header) — HIGH-02, vedi §0.1 |
| Nessun audit trail per decisioni automatiche | In produzione, senza commissioner, serve poter ricostruire perché un pick è stato accettato, rifiutato o freezato |
| Nessuna strategia di riconciliazione dati (API veloce vs fonte ufficiale) | In caso di discrepanza tra API terza e Comunicato Ufficiale, il sistema non ha una procedura |

### 3.3 Giudizio complessivo sulla transizione

L'architettura **non preclude** la transizione — le interfacce ci sono. Ma i documenti **sottostimano la complessità operativa** del funzionamento automatico: danno per scontato che i dati arrivino completi e puntuali, che le dipendenze esterne siano sempre disponibili, e che il sistema non abbia bisogno di essere osservato. Per una POC questo è accettabile. Per un sistema che deve girare 38 giornate senza intervento umano, queste sono lacune che vanno colmate prima del go-live.

---

## 4. Problemi critici

### CRITICAL-02: Nessun meccanismo per determinare la completezza dei risultati in produzione — **RISOLTO il 2026-08-12** (vedi §0.3)

- **Severità:** CRITICAL
- **Categoria:** Architettura / Gap funzionale
- **Documenti:** HLD §4.4, LLD §1.4, LLD §6.1
- **Problema:** L'HLD §4.4 dice che in produzione la contabilizzazione scatta "quando tutti i risultati del round sono disponibili nel Season Data Provider". Tuttavia:
  - L'interfaccia `SeasonDataProvider` (LLD §6.1) non espone un metodo per interrogare la completezza dei risultati (es. `areAllResultsAvailable(round)`).
  - Il metodo `getResults(round)` restituisce un array di `Match` ma non indica se l'array è completo o parziale.
  - In produzione, con un feed dati reale, i risultati arrivano in modo incrementale nell'arco di ore/giorni. Il sistema non ha modo di distinguere "ho 9 risultati su 10, il decimo non è ancora arrivato" da "ho 9 risultati su 10, il decimo match è stato rinviato".
- **Perché è importante:** In produzione automatica, il sistema rischia di contabilizzare un round incompleto (pick valutati come "sbagliati" solo perché il risultato non è ancora disponibile) o di attendere indefinitamente un risultato che non arriverà mai (match rinviato senza flag esplicito).
- **Evidenza:**
  - HLD §4.4: "quando tutti i risultati del round sono disponibili"
  - LLD §6.1: `SeasonDataProvider` non ha metodo `areAllResultsAvailable` o equivalente
  - LLD §1.4: lo scheduler controlla "tutti i risultati disponibili" senza definire cosa significhi
- **Risoluzione consigliata (SUPERATA — vedi §0.3):**
  1. Aggiungere a `SeasonDataProvider` un metodo `areAllResultsFinal(round: number): Promise<boolean>` che l'`ApiProvider` implementerà con la logica appropriata.
  2. Per lo `StaticProvider` (POC), restituire sempre `true`.
  3. Documentare che in produzione il metodo deve distinguere "risultato non ancora disponibile" da "match rinviato/posticipato".

**Esito:** la risoluzione consigliata è **superata e NON va applicata** — risolto il 2026-08-12 con la contabilizzazione incrementale e la separazione scheduler/Round Manager (v. §0.3).

---

## 5. Problemi ad alta severità

### ~~HIGH-02: Ambiguità timestamp deadline non risolta - RISOLTO~~

- **Severità:** HIGH
- **Categoria:** Requisiti / Decisione di design
- **Documenti:** BRIEF §5, POC_HLD §5 (CL3)
- **Problema:** Il BRIEF §5 ("Anticipazioni pre-design") pone esplicitamente la domanda: "quale istante fa fede per la deadline, la ricezione da parte del sistema o il timestamp del messaggio sul canale. La differenza conta solo per i pick a cavallo della chiusura, ma va decisa." L'HLD CL3 risolve implicitamente la questione usando `receivedAt` (tempo di ricezione sistema), ma non dichiara di aver preso questa decisione né la giustifica. Con un polling IMAP ogni 60 secondi (LLD §4.2), un pick inviato 59 secondi prima della deadline potrebbe essere processato dopo la deadline ed essere respinto.
- **Perché è importante:** La scelta ha un impatto diretto sull'esperienza del giocatore e sulla fairness del gioco. Usare il timestamp del server penalizza il giocatore per la latenza del polling. Il BRIEF riconosce che va deciso; l'HLD decide senza documentarlo.
- **Evidenza:**
  - BRIEF §5: "Resta da definire quale istante fa fede" (domanda aperta esplicita)
  - POC_HLD §5 (CL3): "Confronta `receivedAt` con `round_state.deadline`" (decisione implicita)
  - LLD §4.2: `IMAP_POLL_MS` default 60000 (1 minuto di latenza possibile)
- **Risoluzione consigliata:**
  1. Documentare esplicitamente la decisione nel PRD o HLD, con motivazione.
  2. Valutare se per l'email il timestamp SMTP `Date` header sia un'alternativa più equa (il BRIEF lo menziona come opzione).
  3. Per la POC su dati storici non è critico, ma per la produzione va risolto prima.

---

### HIGH-04: LLM come single point of failure senza fallback

- **Severità:** HIGH
- **Categoria:** Affidabilità / Produzione
- **Documenti:** POC_HLD §1.1, LLD §1.2, LLD §4.2
- **Problema:** Sia il parsing dei pick in ingresso sia la generazione delle email in uscita dipendono interamente dall'LLM. Se l'API LLM è indisponibile (rate limit, outage, errore di rete), il sistema non può processare nuovi pick né inviare notifiche. Non è previsto alcun meccanismo di fallback (es. parsing regex-based per formati semplici, template email statici pre-generati).
- **Perché è importante:** In produzione automatica, un'ora di downtime dell'LLM durante la finestra di pick può significare che nessun pick viene processato e tutti i profili vengono eliminati per "pick mancante" alla deadline. L'HLD §1.1 dichiara giustamente che "l'LLM è confinato al solo I/O", ma questo non riduce il rischio di dipendenza.
- **Evidenza:**
  - LLD §1.2: Parser e Generator dipendono entrambi da "Qualsiasi LLM API"
  - Nessun riferimento a fallback, retry, o degraded mode in nessun documento
  - LLD §4.2: `LLM_API_KEY`, `LLM_API_BASE_URL`, `LLM_MODEL` come unica configurazione
- **Risoluzione consigliata:**
  1. Per la POC: accettabile. Per la produzione: aggiungere un parser regex-based di fallback per formati semplici (es. "Milan vince", "Inter pareggia") e template email statici pre-generati per le notifiche standard.
  2. Aggiungere retry con backoff esponenziale nell'LLM Adapter.
  3. Documentare il rischio nel PRD/HLD come rischio noto per la produzione.

---

### HIGH-05: Nessuna strategia di osservabilità per il funzionamento automatico

- **Severità:** HIGH
- **Categoria:** Osservabilità / Produzione
- **Documenti:** POC_HLD §1.3, LLD §1.4, LLD §4.2
- **Problema:** L'HLD §1.3 descrive la produzione come "completamente automatizzato tramite cron job" e "il commissioner non deve fare nulla". Tuttavia:
  - Non è previsto alcun meccanismo di alerting (es. se il cron non parte, se una contabilizzazione fallisce, se l'IMAP è inaccessibile).
  - Il logging (pino, LLD §2) produce JSON strutturato ma non c'è strategia di aggregazione, monitoring o alerting.
  - Non c'è un health check o un heartbeat per verificare che il sistema sia vivo.
  - Non c'è un audit trail strutturato per ricostruire decisioni automatiche (perché un pick è stato accettato/rifiutato/annullato, perché un profilo è stato eliminato).
- **Perché è importante:** "Completamente automatico" senza osservabilità significa "completamente cieco". Un guasto scoperto dopo 3 giornate può aver già compromesso l'intero torneo.
- **Evidenza:**
  - HLD §1.3: "Il commissioner non deve fare nulla: il sistema si amministra da solo."
  - LLD §4.2: `LOG_LEVEL` come unico parametro di osservabilità
  - Nessuna menzione di alerting, monitoring, health check in alcun documento
- **Risoluzione consigliata:**
  1. Per la produzione: aggiungere un comando `health:check` che verifichi connettività IMAP, SMTP, LLM API, DB e produca un exit code per il monitoring.
  2. Documentare nel piano di produzione la strategia di monitoring (es. healthchecks.io, UptimeRobot, script su VPS).
  3. Aggiungere logging strutturato per ogni decisione automatica con contesto sufficiente per audit a posteriori.

---

### HIGH-06: Nessuna strategia di riconciliazione dati (API vs fonte ufficiale)

- **Severità:** HIGH
- **Categoria:** Data integrity / Produzione
- **Documenti:** POC_HLD §7 (domanda 1), LLD §6.1
- **Problema:** Il BRIEF §5 cita la necessità di una fonte dati Serie A. L'HLD §7 chiede "Fonte per calendario e risultati?" come domanda aperta. Il LLD §6.1 prevede un futuro `ApiProvider`. Tuttavia, nessun documento affronta:
  - Come gestire discrepanze tra l'API terza (es. API-Football, football-data.org) e la fonte ufficiale (Comunicato Ufficiale Lega Serie A).
  - Che l'API terza può riportare un risultato errato e correggerlo ore dopo.
  - Che in caso di contenzioso su un pick, l'unica fonte autorevole è il Comunicato Ufficiale.
  - Il costo e i rate limit dei provider API (nessun provider specifico è nominato o valutato).
- **Perché è importante:** Un risultato errato dall'API può causare eliminazioni errate irreversibili. Senza un meccanismo di riconciliazione, il sistema non ha modo di correggere a posteriori.
- **Evidenza:**
  - HLD §7.1: domanda aperta sulla fonte dati, nessuna risposta o strategia
  - LLD §6.1: `ApiProvider` come placeholder senza specifiche
  - Nessuna menzione di riconciliazione, ritardo di pubblicazione, o correzioni
- **Risoluzione consigliata:**
  1. Valutare e documentare almeno un provider candidato con costi, rate limit, copertura, SLA.
  2. Progettare (almeno a livello di HLD) un meccanismo di riconciliazione: possibilità di ri-contabilizzare un round se i risultati ufficiali differiscono dall'API.
  3. Per la POC, documentare che `StaticProvider` bypassa il problema e che la strategia va definita prima della produzione.

---

## 6. Problemi a media severità

### MED-02: Partite sospese non distinte dalle rinviate — **RISOLTO il 2026-08-12** (vedi §0.2)

- **Severità:** MEDIUM
- **Categoria:** Edge case / Completezza
- **Documenti:** POC_PRD §8, LLD §3
- **Problema:** I documenti trattano solo il caso "partita rinviata" (postponed). Non viene menzionato il caso "partita sospesa" (iniziata, interrotta per cause esterne, poi ripresa in data successiva). In Serie A, una partita sospesa viene ripresa dal minuto dell'interruzione, con il punteggio parziale mantenuto. Questo è diverso da un rinvio (la partita non inizia proprio) e diverso da un recupero (la partita si gioca da 0-0 in altra data).
- **Perché è importante:** Meno frequente del rinvio, ma quando accade ha implicazioni diverse: il pick è su un evento che è parzialmente accaduto, e il risultato finale arriva in una data diversa da quella originale.
- **Evidenza:**
  - POC_PRD §8: solo CL1 (rinviata), nessun riferimento a "sospesa"
  - LLD §3: tabella `match` ha solo `postponed`, nessun campo per "suspended"
- **Risoluzione consigliata:** Per la POC, documentare che le partite sospese sono trattate come rinviate (o non sono presenti nel dataset storico). Per la produzione, aggiungere un caso limite dedicato.

---

### MED-03: Correzione risultati a posteriori non gestita

- **Severità:** MEDIUM
- **Categoria:** Data integrity
- **Documenti:** POC_HLD §4.4, LLD §3
- **Problema:** I risultati delle partite possono essere corretti dopo la pubblicazione iniziale (es. errore dell'arbitro corretto dal giudice sportivo, risultato omologato con modifiche). Il sistema non ha un meccanismo per ri-contabilizzare un round dopo una correzione. Una volta che `round:score` è stato eseguito e `round_state.status = 'scored'`, non c'è un flusso per tornare indietro.
- **Perché è importante:** In produzione, un risultato corretto a tavolino potrebbe cambiare l'esito di un pick (da corretto a sbagliato o viceversa), alterando la classifica dei sopravvissuti. Senza un meccanismo di ri-contabilizzazione, l'errore è permanente.
- **Evidenza:**
  - LLD §7.3: `round:score` non ha flag di forza/ri-contabilizzazione
  - LLD §3: `round_state.status` può essere `scored` ma non esiste uno stato `rescored`
- **Risoluzione consigliata:** Aggiungere un comando `round:rescore --round <n>` che ri-valuta tutti i pick del round con i risultati aggiornati, con log di audit.

---

## 7. Problemi a bassa severità

### LOW-01: Race condition IMAP polling + scheduler non discussa

- **Severità:** LOW
- **Categoria:** Concorrenza
- **Documenti:** LLD §1.4, LLD §4.2
- **Problema:** In produzione, `scheduler:tick` (ogni minuto, via cron) e `channel:email:process` (polling IMAP, potenzialmente sullo stesso ritmo) potrebbero competere per risorse o operare su stato inconsistente. Non viene menzionato alcun meccanismo di lock o coordinamento.
- **Perché è importante:** Scenario improbabile nella POC (scheduler è disabilitato), ma rilevante per il design della produzione.
- **Risoluzione consigliata:** Documentare che il `scheduler:tick` gestisce internamente anche il polling email quando attivo, oppure usare un file lock per prevenire esecuzioni concorrenti.

---

### LOW-02: Max profil per giocatore configurable ma non usato nella POC

- **Severità:** LOW
- **Categoria:** Configurazione
- **Documenti:** LLD §4.1, POC_PRD §2
- **Problema:** `MAX_PROFILES_PER_PLAYER` è configurabile con default `1`, ma la POC ha vincolo `UNIQUE(player_id)` su `profile` (LLD §3) che impedisce a un giocatore di avere più profili indipendentemente da questo parametro. Il vincolo UNIQUE rende il parametro inutilizzabile senza una modifica allo schema.
- **Perché è importante:** Minore per la POC (dove il limite è 1), ma è un vincolo DB che andrà rimosso quando il limite salirà a 3 (BRIEF §3.3). Segnalarlo ora evita sorprese in fase di evoluzione.
- **Evidenza:**
  - LLD §3: `player_id INTEGER NOT NULL UNIQUE REFERENCES player(id)`
  - LLD §4.1: `MAX_PROFILES_PER_PLAYER` default `1`
- **Risoluzione consigliata:** Aggiungere una nota nel LLD che il vincolo `UNIQUE` su `profile.player_id` è una semplificazione della POC e andrà sostituito con un vincolo applicativo (`COUNT(profile) WHERE player_id = ? <= MAX_PROFILES_PER_PLAYER`) nella versione di produzione.

---

### LOW-03: Tabella match non indicizzata per le query più frequenti

- **Severità:** LOW
- **Categoria:** Performance
- **Documenti:** LLD §3, LLD §3.2
- **Problema:** La query `SELECT MIN(match_date) FROM match WHERE round = ?` (LLD §3.2) e `SELECT DISTINCT home_team FROM match` non hanno indici dedicati. Su SQLite con ~380 righe (38 round × 10 partite) non è un problema pratico, ma è una lacuna di design.
- **Evidenza:**
  - LLD §3: nessun `CREATE INDEX` nel DDL
  - LLD §3.2: query che beneficerebbero di indici
- **Risoluzione consigliata:** Aggiungere `CREATE INDEX idx_match_round ON match(round)` e valutare indici aggiuntivi.

---

## 8. Contraddizioni tra documenti

Nessuna contraddizione aperta residua: C1, C2 e C4 risolte il 2026-08-11 (vedi §0); C3 risolta con la nota placeholder sulle righe del LLD §4.1.

---

## 9. Requisiti mancanti della POC

| # | Requisito | Fonte | Note |
|---|-----------|-------|------|
| 1 | Strategia di completezza risultati per contabilizzazione automatica | HLD §4.4, PRD §4.4 | Risolto il 2026-08-12 (contabilizzazione incrementale, v. §0.3) |
| 2 | Gestione partite sospese (diverse da rinviate) | — | Risolto il 2026-08-12: le sospese sono trattate come rinviate (MED-02, §0.2) |
| 3 | Timestamp deadline: quale istante fa fede | BRIEF §5 | Risolto il 2026-08-12 (HIGH-02, vedi §0.1): ricezione sul server |
| 4 | Meccanismo di ri-contabilizzazione (score correction) | — | Vedi MED-03 |

---

## 10. Funzionalità correttamente rimandate al futuro

Le seguenti esclusioni sono coerenti con `FUTURE_EXPLORATIONS.MD` e appropriate per una POC:

| Funzionalità | Fonte esclusione | Riferimento FUTURE_EXPLORATIONS |
|-------------|-----------------|--------------------------------|
| WhatsApp e altri canali | POC_PRD §10 | §7 — ambiguità risolta: POC = fase 0, WhatsApp in Fase 1 (BRIEF §7.2) |
| Interfaccia web / frontend | POC_PRD §10 | §2 |
| Profili multipli per giocatore | POC_PRD §10 | BRIEF §3.3 + semplificazione POC |
| Pagamento e payout | POC_PRD §10 | — (non in FUTURE_EXPLORATIONS, ma esplicitamente fuori scope POC) |
| Jolly | POC_PRD §10 | §3 |
| Auto-pick | POC_PRD §10 | §5 |
| Ingresso tardivo | POC_PRD §10 | §6 |
| Annullamento pick | POC_PRD §10 | §8 |
| Sistema di notifiche push | POC_PRD §10 | §9 |
| Chatbot conversazionale | POC_PRD §10 | §1 |

---

## 11. Rischi architetturali

| # | Rischio | Probabilità | Impatto | Mitigazione |
|---|--------|------------|---------|-------------|
| R1 | LLM API non disponibile durante finestra pick in produzione | Media | Alto | Fallback regex + retry; vedi HIGH-04 |
| R2 | Cron job non eseguito / silenziosamente fallito in produzione | Bassa | Critico | Health check + monitoring; vedi HIGH-05 |
| R3 | Dati API errati causano eliminazioni errate irreversibili | Bassa | Critico | Riconciliazione + ri-contabilizzazione; vedi HIGH-06 |
| R4 | Rinvio partita non rilevato dalla fonte dati | Media | Alto | Distinzione "dato mancante" vs "rinviata" nel provider; vedi CRITICAL-02 |
| R6 | Modifica regolamento Serie A (es. formato a 18 squadre) | Bassa | Basso | Sistema data-driven (LLD §3.2) mitiga parzialmente |
| R7 | Lock-in su Gmail per IMAP/SMTP | Media | Medio | ChannelAdapter è astratto, ma la configurazione è Gmail-specifica |

---

## 12. Rischi specifici legati al flusso dati Serie A in produzione

### 12.1 Rinvii e variazioni di calendario

Risolti il 2026-08-11: rinvio recuperato il giorno dopo (CL7, PRD §4.4) e rinvio a data da destinarsi (Freeze: il TT si conclude comunque).

| Rischio | Analisi |
|---------|---------|
| Variazione orario partita dopo apertura round | La deadline è calcolata all'apertura del round. Se l'orario della prima partita cambia dopo, la deadline non viene ricalcolata. Non documentato. |
| Variazione sede/campo | Non impatta la logica di gioco (conta il risultato, non il campo). Nessun problema. |

### 12.2 Fonte dati

| Rischio | Analisi |
|---------|---------|
| Nessun provider dati nominato | L'HLD §7 chiede "Fonte per calendario e risultati?" come domanda aperta. Nessuna valutazione di costi, rate limit, copertura. |
| Nessuna strategia di fallback dati | Se l'API primaria è down, non c'è una fonte secondaria. |
| Licenza dati Lega Serie A | L'accesso ai dati ufficiali richiede licenza commerciale. Non menzionato nei documenti. |
| Affidabilità API terze | API gratuite (football-data.org, API-Football) hanno rate limit bassi e possibile latenza. API a pagamento hanno costi. Nessuna valutazione. |

### 12.3 Automazione

| Rischio | Analisi |
|---------|---------|
| Assunzione implicita: "i risultati arrivano sempre in tempo" | Risolta con la contabilizzazione incrementale (v. §0.3) |
| Assunzione implicita: "l'orario del round coincide con l'orario ufficiale" | Deadline calcolata una volta sola all'apertura. Se l'orario cambia, la deadline è potenzialmente errata. |
| Nessun meccanismo di ri-contabilizzazione | Vedi MED-03 |

### 12.4 Distinzione affidabile degli stati di un pick

Il sistema attuale può distinguere solo parzialmente tra:

| Stato | Supportato? | Note |
|-------|-------------|------|
| Partita giocata e conclusa | Sì | `home_score` e `away_score` popolati |
| Partita rinviata (fuori finestra) | Sì | `postponed = 1` → pick in Freeze (CL1) |
| Partita rinviata (entro finestra) | Sì | CL7: attesa del recupero e contabilizzazione alla chiusura del TC (PRD §4.4) |
| Partita non ancora iniziata | Parziale | Dedotto dall'assenza di score, ma ambiguo rispetto a "risultato non ancora disponibile dall'API" |
| Dato mancante/non disponibile | No | Non distinguibile da "non ancora iniziata" |
| Partita sospesa | Sì | Trattata come rinviata (PRD §4.4, MED-02 risolto il 2026-08-12): "postponed = 1" → pick in Freeze se ripresa fuori finestra, contabilizzato a risultato chiaro |

---

## 13. Inconsistenze dati/API

| # | Inconsistenza | Documenti |
|---|--------------|-----------|
| I1 | `SeasonDataProvider.getResults(round)` restituisce `Match[]` ma non indica se l'array è completo | LLD §6.1 |
| I2 | `Match` ha `postponed: boolean` ma non ha data di recupero (rimandata a Fase 1, LLD §3.1) | LLD §6.1 |
| I4 | `PickProcessor` valida "esito valido" (`win`/`draw`/`lose`) ma non specifica se l'esito viene validato contro le quote reali o è free-form | — |
| I5 | `MessageRouter` classifica messaggi in "iscrizione / pick / sconosciuto" ma non definisce i criteri di classificazione | LLD §1.3 |

---

## 14. Assunzioni e ambiguità

### Assunzioni non giustificate

| # | Assunzione | Dove | Rischio |
|---|-----------|------|---------|
| A1 | I risultati delle partite sono sempre disponibili e completi quando serve contabilizzare | HLD §4.4, LLD §1.4, PRD §4.4 | Superata: con la contabilizzazione incrementale non serve la completezza dell'intero round (risolto il 2026-08-12, v. §0.3) |
| A3 | L'LLM API è sempre disponibile e responsiva | HLD §1.1, LLD §1.2 | HIGH-04 |
| A4 | Il formato delle email di pick è sufficientemente chiaro da essere parsato dall'LLM senza ambiguità | POC_PRD §5 | Accettabile per POC; da validare con test |
| A5 | Il calendario non cambia dopo l'apertura del round | HLD §4.2 | Rischio reale in Serie A |
| A6 | Gmail IMAP/SMTP sono sufficientemente affidabili per un uso in produzione | HLD §6 | Accettabile |
| A7 | Il commissioner ha accesso SSH al VPS e sa usare la CLI | HLD §2, §6 | Accettabile |
| A8 | I dati storici 2025/26 non contengono partite sospese | Implicito | Gestione coperta comunque: le sospese sono trattate come rinviate (PRD §4.4, MED-02) |

### Ambiguità

| # | Ambiguità | Dove |
|---|----------|------|
| B1 | Cosa significa esattamente "tutti i risultati sono disponibili"? | Superata: la contabilizzazione incrementale non richiede la completezza dell'intero round (risolto il 2026-08-12, v. §0.3) |
| B3 | Il formato pick nell'email: strutturato o libero? | POC_PRD §11.4, HLD §7.6 |
| B4 | L'email di apertura round mostra tutte le partite o solo le squadre disponibili? | HLD §7.7 |
| B5 | Cosa succede se `round:score` viene chiamato due volte? | LLD §7.3 (non specifica idempotenza) |

---

## 15. Domande da sottoporre al Product Owner

1. **Fonte dati 2025/26:** Chi fornisce i file `calendar.json` e `results.json`? Qual è il formato esatto?
2. **Timestamp deadline:** Quale timestamp fa fede per la deadline — ricezione server o `Date` header dell'email? (HIGH-02, unico bloccante residuo) ***Risolta il 2026-08-12: fa fede la ricezione sul server (vedi §0.1).***
3. **Formato pick:** Quanto deve essere strutturato il formato del pick nell'email? "Milan vince" vs testo libero completo?
4. **Provider dati per la produzione:** C'è già un'idea del provider API da usare nella stagione 2026/27? Budget disponibile per API a pagamento?
5. **Monitoring in produzione:** Qual è il livello atteso di monitoraggio? Basta un health check o servono alert proattivi (es. Telegram/email al commissioner)?
6. **Formato email di apertura round:** Mostrare tutte le partite della giornata o solo le squadre disponibili per il profilo specifico?

*(Risposte già acquisite il 2026-08-11: POC vs Fase 1 → roadmap BRIEF §7; rinvio entro finestra → CL7; ultima giornata girone + rinvio → regole Freeze PRD §4.4; entry fee/payout → placeholder LLD §4.1.)*

---

## 16. Modifiche consigliate prima dell'implementazione

### Bloccanti (devono essere risolti prima di scrivere codice)

1. **HIGH-02 — RISOLTO il 2026-08-12** — decidere e documentare esplicitamente quale timestamp fa fede per la deadline: decisione PO acquisita — fa fede la **ricezione sul server** (`receivedAt`, `internaldate` IMAP per l'email), non l'header `Date`. Documentato in PRD §4.3/§3.3/CL3, HLD §5, LLD §1.3/§3.1/§6.4 (dettagli: §0.1). Nessun bloccante residuo.

### Raccomandati (da risolvere prima del completamento POC)

2. **MED-02 — RISOLTO il 2026-08-12** — aggiungere la nota sulle partite sospese (nella POC: trattate come rinviate, PRD §4.4 — dettagli: §0.2).

### Da affrontare prima della produzione (non bloccanti per la POC)

3. **CRITICAL-02 — RISOLTO il 2026-08-12:** risolto con la contabilizzazione incrementale e la separazione scheduler/Round Manager (v. §0.3). La raccomandazione `areAllResultsFinal` è superata: **non va aggiunta**. `getMatchesForRound(round)` (già esistente) espone `homeScore?`/`awayScore?`/`postponed`, sufficienti per distinguere "risultato non disponibile" da "rinviata/sospesa". Assunzione correlata A1: superata.
4. **HIGH-04** — progettare fallback per indisponibilità LLM (parser regex per formati semplici, template pre-generati, retry con backoff).
5. **HIGH-05** — progettare strategia di osservabilità e monitoring (comando `health:check`, heartbeat, audit delle decisioni automatiche).
6. **HIGH-06** — valutare provider dati (costi, rate limit, SLA, licenza Lega Serie A), definire strategia di riconciliazione con il Comunicato Ufficiale.
7. **MED-03** — aggiungere comando `round:rescore` per la correzione dei risultati a posteriori, con audit.
8. **NEW-02** — calendario e ApiProvider: per ogni match servono orario d'inizio e durata/fine prevista (per la chiusura del TC, PRD §4.4) e la data di recupero `rescheduled_date` (per CL7/CL1); i parametri `TC_CLOSE_SKEW_MIN` e `MATCH_DURATION_MIN` sono già nel LLD §4.1.
9. **LOW-01** — documentare coordinamento scheduler/polling IMAP (lock o integrazione nel tick).
10. **LOW-02** — documentare che il vincolo `UNIQUE` su `profile.player_id` è temporaneo (Fase 1: profili multipli, BRIEF §7.2).
11. **NEW-01** — nota documentale: dal 2026-08-11 il BRIEF è un documento storico congelato e non va più aggiornato; le divergenze BRIEF/PRD si risolvono a favore del PRD (il BRIEF §4.1 contiene opzioni superate, es. l'annullamento del pick sostituito dal Freeze).

---

## 17. Implementation Readiness: ~86/100 (aggiornata al 2026-08-12)

### Criteri di valutazione

| Criterio | Punteggio | Max | Note |
|----------|-----------|-----|------|
| Chiarezza scope POC | 10 | 10 | Ambiguità WhatsApp risolta con la roadmap (BRIEF §7): POC = fase 0, Fase 1 = produzione |
| Copertura requisiti BRIEF nella POC | 8 | 10 | Timestamp della deadline deciso (HIGH-02 risolto il 2026-08-12, vedi §0.1); il punto mancante per il 10 resta il formato pick (B3/§15.3) |
| Coerenza PRD → HLD → LLD | 10 | 10 | Contraddizioni C1-C4 chiuse; terminologia TC/TT/deadline/Freeze allineata; contabilizzazione incrementale coerente nei tre documenti |
| Completezza edge case | 9 | 10 | CL1-CL8 coperti; sospese = rinviate (MED-02 risolto il 2026-08-12); resta la correzione risultati a posteriori (MED-03) |
| Robustezza modello dati | 8 | 10 | Freeze definito con `status` esplicito su `pick`; mancano `rescheduled_date` e `end_time` su `match` (Fase 1, LLD §3.1) |
| Architettura per evoluzione futura | 9 | 10 | ChannelAdapter + SeasonDataProvider; contabilizzazione incrementale (CRITICAL-02, §0.3); multi-torneo tracciato per la Fase 1 |
| Strategia transizione POC → produzione | 5 | 10 | CRITICAL-02 risolto con l'incrementale + separazione scheduler/Round Manager; restano HIGH-04/05/06 |
| Osservabilità e operabilità | 3 | 10 | Solo pino logging; zero monitoring/alerting/audit per produzione |
| Gestione flusso dati reale | 5 | 10 | Contabilizzazione incrementale allineata ai feed dati live; nessuna strategia di provider/riconciliazione |
| Qualità documentale | 9 | 10 | Ref corretti; BRIEF congelato come storico; PRD fa fede; ruoli/responsabilità esplicitati nel PRD |

**Totale: ~86/100** (era ~78/100: risolti HIGH-02, MED-02 e CRITICAL-02 il 2026-08-12 — vedi §0.1, §0.2, §0.3)

### Cosa significa questo punteggio

La POC è **pronta per l'implementazione del nucleo deterministico** (Game Engine, validazione pick, eliminazioni, Freeze) e la strategia di contabilizzazione è ora definita anche per i dati live (incrementale). Restano le lacune operative della produzione automatica: osservabilità/monitoring, fallback LLM e riconciliazione dati con la fonte ufficiale.

Il punteggio salirà a ~90+ affrontando gli item "prima della produzione" (§16, HIGH-04/05/06, MED-03, NEW-02, LOW-01/02) — cioè il grosso del lavoro per il go-live sul 2026/27.

---

*Fine della review.*