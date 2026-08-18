# Survivor League (nome provvisorio) — Project Brief

**Data di creazione:** 2026-08-08
**Data ultimo aggiornamento:** 2026-08-11
**Owner:** Fulvio de Giovanni

> **STATO: DOCUMENTO STORICO — NON AGGIORNARE OLTRE IL 2026-08-11.**
> Questo documento documenta la fase di **raccolta dei requisiti**, conclusa il 2026-08-11. Il lavoro di design successivo ha richiesto ulteriori negoziazioni e decisioni (terminologia TC/TT, deadline e finestra di pick, chiusura del TC, partite rinviate e Freeze, tornei multipli, roadmap di lancio), per cui il contenuto **non rispecchia completamente** quanto discusso e deciso: fanno fede `docs/POC/POC_PRD.md` (v0.3.0+), `docs/POC/POC_HLD.md` e `docs/POC/POC_LLD.md`. Il BRIEF resta come riferimento storico per la raccolta dei requisiti e **non verrà più aggiornato**; eventuali divergenze sono da risolvere a favore del PRD.

Questo documento raccoglie e analizza i requisiti di alto livello. I requisiti funzionali e il design del sistema seguiranno in un documento HLD separato.

> **Disclaimer sullo scope.** Questo progetto è un gioco privato tra amici. Non è un prodotto commerciale di scommesse e non è pensato per un'operatività pubblica. Qualsiasi passaggio verso un'operatività pubblica con denaro reale farebbe entrare in scope la normativa italiana sul gioco d'azzardo (ADM) e richiede prima un parere legale qualificato. Vedi `FUTURE_EXPLORATIONS.MD`.

---

## Indice

- [1. Concept](#1-concept)
- [2. Glossario di dominio](#2-glossario-di-dominio)
- [3. Regole confermate](#3-regole-confermate)
  - [3.1 Riutilizzo delle squadre — unica per girone](#31-riutilizzo-delle-squadre-unica-per-girone)
  - [3.2 Fine del torneo e vittoria condivisa](#32-fine-del-torneo-e-vittoria-condivisa)
  - [3.3 Profili — iscrizioni multiple per giocatore](#33-profili-iscrizioni-multiple-per-giocatore)
  - [3.4 Collisione tra profili dello stesso giocatore — permessa](#34-collisione-tra-profili-dello-stesso-giocatore-permessa)
  - [3.5 Pick mancante — eliminazione](#35-pick-mancante-eliminazione)
  - [3.6 Quota di iscrizione](#36-quota-di-iscrizione)
  - [3.7 Deadline del pick — una deadline per round](#37-deadline-del-pick-una-deadline-per-round)
  - [3.8 Canali di invio del pick](#38-canali-di-invio-del-pick)
  - [3.9 Ripartizione del montepremi](#39-ripartizione-del-montepremi)
  - [3.10 Tornei multipli nello stesso campionato — Fase 1 di Produzione](#310-tornei-multipli-nello-stesso-campionato-fase-1-di-produzione)
- [4. Domande aperte](#4-domande-aperte)
  - [4.1 Partite rinviate, riprogrammate o sospese](#41-partite-rinviate-riprogrammate-o-sospese)
  - [4.2 Ripartizione del montepremi](#42-ripartizione-del-montepremi)
- [5. Anticipazioni pre-design](#5-anticipazioni-pre-design)
- [6. Non-goal per la Fase 1](#6-non-goal-per-la-fase-1)
- [7. Roadmap di lancio](#7-roadmap-di-lancio)
  - [7.1 Fase 0 — POC](#71-fase-0-poc)
  - [7.2 Fase 1 — Produzione](#72-fase-1-produzione)
  - [7.3 Fasi successive — rilasci incrementali](#73-fasi-successive-rilasci-incrementali)

---

## 1. Concept

Survivor League è un torneo a eliminazione costruito sui risultati delle partite di **Serie A**.

Chi partecipa gioca attraverso uno o più **profili**: ogni profilo è un'iscrizione indipendente e paga la propria quota, e un giocatore può attivarne più d'uno per aumentare le proprie chance (vedi 3.3).

Prima di ogni turno di campionato (TC, la "giornata" di Serie A), ciascun profilo invia un pronostico su **una** squadra impegnata in quel turno, dichiarando se vincerà, perderà o pareggerà. Questo pronostico si chiama **Pick**; il round di gioco associato a un TC si chiama **Turno del torneo (TT)**.

Quando il TC finisce, il TT si chiude e i pick vengono contabilizzati:

- Pick corretto → il profilo resta in gara.
- Pick sbagliato → il profilo è eliminato.

**Regola fondamentale:** dentro un girone una squadra può essere scelta una volta sola. Una volta usata, quella squadra è bruciata per quel profilo fino alla fine del girone, quindi ogni round impone una scelta nuova da un pool che si restringe. Al passaggio al girone di ritorno il pool si azzera e tutte le squadre tornano disponibili.

**Perimetro del torneo:** il torneo di default copre l'intera stagione di campionato, dalla prima giornata. Dalla Fase 1 di Produzione il sistema supporta più tornei per stagione, con inizio in qualsiasi TC (regola 3.10).

**Condizione di vittoria:** vince chi resta solo in gara. Quando questo non accade, la vittoria è condivisa secondo i casi della 3.2.

---

## 2. Glossario di dominio

I termini tecnici restano in inglese, come nel resto del progetto.

| Termine | Significato |
|---|---|
| **Pick** | Un pronostico per un round: una squadra più un esito (vittoria / sconfitta / pareggio). |
| **Round** (inglese) / **TT — Turno del torneo** | Il round di gioco associato a un turno di campionato (TC): si apre ai pick, si chiude a una deadline, viene contabilizzato dopo il completamento del TC. |
| **TC — Turno di campionato** | La "giornata" di Serie A: finestra temporale dal fischio d'inizio della prima partita alla chiusura ai fini del gioco (fine prevista dell'ultima partita programmata + scarto configurabile; dettagli nel `POC_PRD.md` §4.4). |
| **Girone** | Metà stagione: andata (giornate 1-19) o ritorno (giornate 20-38). Al cambio di girone il pool di squadre disponibili si azzera. |
| **Profile** | Un'iscrizione a un torneo. Una quota per profilo. Ha la propria storia di pick e la propria lista di squadre bruciate. |
| **Player** | La persona reale. Possiede uno o più profili. |
| **Burned team** | Una squadra che un profilo ha già scelto e non può più usare per il resto del girone. |
| **Elimination** | Rimozione di un profilo dal torneo dopo un pick sbagliato o mancante. |
| **Prize pool** | Totale delle quote raccolte per un torneo, distribuito secondo le regole di payout. |
| **Tournament** | Un'istanza di torneo su un campionato: propri iscritti, propria storia di pick, proprio montepremi. Più tornei possono convivere sulla stessa stagione (3.10). |

---

## 3. Regole confermate

### 3.1 Riutilizzo delle squadre — unica per girone

In ciascun torneo un profilo può scegliere una data squadra **una volta per girone**: dopo l'uso quella squadra è bruciata fino al termine del girone, e all'inizio del girone di ritorno il pool si azzera e ogni squadra torna disponibile. In un torneo che copre l'intera stagione un profilo può quindi usare la stessa squadra due volte, una per girone.

Il vincolo produce due effetti voluti.

La scarsità è il motore del gioco: man mano che le squadre affidabili si bruciano, il pick diventa progressivamente più difficile e il tasso di eliminazione cresce. La pressione sale lungo il girone e riparte da zero al cambio di girone, quindi il torneo ha due fasi con lo stesso profilo di difficoltà invece di una sola curva crescente.

L'azzeramento a metà stagione garantisce che esista sempre un pick possibile: un girone ha 19 TC e le squadre sono 20, quindi un profilo che gioca l'intero girone ne brucia 19 e ne lascia sempre almeno una disponibile. Su 38 TC un profilo dispone di 40 pick, e non esiste un turno in cui si trova senza scelte possibili.

Il margine è di una squadra sola per girone.

### 3.2 Fine del torneo e vittoria condivisa

Alla chiusura di ogni round il torneo prosegue oppure termina. Prosegue nel caso normale, quando restano due o più profili in gara e c'è ancora un round da giocare. Termina in tre casi, e in ciascuno il montepremi viene assegnato.

1. **Resta un solo profilo in gara** → quel profilo vince e prende il montepremi.
2. **Tutti i profili ancora in gara vengono eliminati nello stesso round** → quei profili condividono la vittoria e si dividono il montepremi in parti uguali.
3. **Restano due o più profili e non è più giocabile alcun round**, perché la stagione è conclusa → i profili superstiti condividono la vittoria e si dividono il montepremi in parti uguali.

I tre casi coprono ogni modo in cui il torneo può finire, quindi non esiste una chiusura in cui il sistema non ha un vincitore da dichiarare.

### 3.3 Profili — iscrizioni multiple per giocatore

Un giocatore può avere più profili per aumentare le proprie chance di vittoria. Ogni profilo è un'iscrizione indipendente: quota propria, pick proprio a ogni round, lista di squadre bruciate propria, stato di eliminazione proprio. Un giocatore con 3 profili gioca di fatto 3 partite parallele in contemporanea.

Un giocatore vince se **almeno uno** dei suoi profili vince.

I profili dello stesso giocatore non sono protetti l'uno dall'altro: possono essere eliminati tutti nello stesso round.

Il numero massimo di profili per giocatore non è ancora deciso. Valore provvisorio: **3**.

### 3.4 Collisione tra profili dello stesso giocatore — permessa

I profili di uno stesso giocatore possono inviare pick identici nello stesso round. È consentito, anche se strategicamente controproducente: pick identici significa che quei profili vivono o muoiono insieme, il che vanifica il senso di avere più iscrizioni.

Il sistema avvisa il giocatore quando rileva la duplicazione. L'avviso accompagna la conferma del pick e non lo blocca: il pick resta valido e i profili coinvolti restano in gara.

L'avviso è informativo. Dato che la 3.8 rende il pick definitivo al primo invio valido, il giocatore non può correggere i profili già registrati, e può al più tenerne conto per i profili che non hanno ancora inviato il pick per quel round.

### 3.5 Pick mancante — eliminazione

Un profilo che non invia un pick valido entro la deadline del round è eliminato. La Fase 1 non prevede meccanismi di grazia.

Gestioni più morbide e auto-pick sono parcheggiati in `FUTURE_EXPLORATIONS.MD`.

### 3.6 Quota di iscrizione

L'importo non è ancora deciso. Deve essere **configurabile nel sistema**. Valore provvisorio: **5 EUR** per profilo.

### 3.7 Deadline del pick — una deadline per round

Ogni round ha una **deadline unica condivisa da tutti i profili**. La deadline si colloca a una distanza fissa dal fischio d'inizio della **prima partita della giornata**.

Quel tempo di anticipo è **configurabile**. Valore provvisorio: **30 minuti**. Quindi con una giornata la cui prima partita inizia sabato alle 15:00, il round chiude sabato alle 14:30, e ogni pick per quel round deve arrivare prima.

Questo tiene tutti i profili sullo stesso livello informativo: nessuno può guardare una partita precedente della stessa giornata prima di impegnarsi. Rende anche il round un'unità atomica: si apre, raccoglie, chiude, contabilizza.

### 3.8 Canali di invio del pick

I giocatori inviano il pick via **email** o **WhatsApp**. Il sistema deve ricevere, interpretare e registrare un pick in arrivo su entrambi i canali, e confermarlo o rifiutarlo sullo stesso canale.

L'insieme dei canali non è chiuso: altri canali potranno essere aggiunti in futuro. Il sistema va quindi costruito con la ricezione del pick disaccoppiata dal canale, in modo che aggiungerne uno nuovo non richieda di toccare la logica di gioco. I candidati sono elencati in `FUTURE_EXPLORATIONS.MD`.

**Finalità del pick.** Vale il **primo pick valido** che il profilo invia per quel round, su qualsiasi canale. Una volta registrato non è più modificabile: ogni pick successivo per lo stesso round viene respinto, e il giocatore ne riceve notifica sul canale da cui è arrivato.

Conta il primo pick **valido**, non il primo messaggio. Un messaggio respinto perché illeggibile, o perché la squadra è già bruciata o non gioca in quella giornata, non occupa il posto: il profilo può inviarne un altro. Diversamente un errore di battitura bloccherebbe il round e la 3.5 eliminerebbe il profilo per pick mancante.

Un profilo ha quindi al più un pick valido per round, fissato al primo invio andato a buon fine.

### 3.9 Ripartizione del montepremi

Non ancora decisa. Ipotesi di lavoro: **85% al vincitore**, il resto da allocare. Da definire prima del design.

### 3.10 Tornei multipli nello stesso campionato — Fase 1 di Produzione

Questa capability fa parte della Fase 1 di Produzione, non della POC (vedi §7).

Il sistema consente l'istanziazione e la gestione contemporanea di più tornei nell'ambito dello stesso campionato (stagione di Serie A). Ogni torneo è un'istanza indipendente: propri iscritti, propria storia di pick, proprie squadre bruciate, proprio montepremi e proprie condizioni di vittoria. Le regole 3.1–3.9 si applicano singolarmente a ciascun torneo.

Un torneo non deve necessariamente iniziare alla prima giornata: può avere inizio in corrispondenza di un qualsiasi turno di campionato (TC) e procede dal giorno di inizio fino alla conclusione della stagione. Nuovi giocatori, o giocatori già eliminati in un altro torneo, possono iscriversi a tornei che partono da TC successivi (per esempio dal TC 5 in avanti).

Il sistema deve gestire più tornei contemporaneamente: round di tornei diversi possono essere aperti, chiusi e contabilizzati in parallelo sulla stessa stagione, e lo stato di ciascun torneo è mantenuto separatamente.

**Nota:** il torneo descritto nelle regole 3.1–3.9 (intera stagione, dalla prima giornata) è il caso particolare in cui il torneo inizia al primo TC. Il confine tra i gironi resta derivato dai dati del campionato (§5). L'ingresso tardivo con quota scalata resta un'idea futura (`FUTURE_EXPLORATIONS.MD` §6) e non va confuso con questa capability.

---

## 4. Domande aperte

### 4.1 Partite rinviate, riprogrammate o sospese

Come si contabilizza un pick quando la sua partita viene spostata fuori dalla finestra del round o non viene giocata? Le opzioni includono annullare il pick e restituire la squadra al pool disponibile del profilo, trattarlo come sopravvivenza, o tenere il round aperto. La Serie A rinvia partite, quindi non è un caso limite raro.

Da tenere presente il margine della 3.1: all'ultima giornata di un girone un profilo ha una sola squadra disponibile, e se proprio quella partita viene rinviata resta senza pick possibile. È un caso stretto, si presenta due volte a stagione, e va coperto qui.

### 4.2 Ripartizione del montepremi

Oltre all'ipotesi dell'85% al vincitore, dove va il resto? Costi operativi, secondo classificato, rollover al torneo successivo, o altro.

---

## 5. Anticipazioni pre-design

Temi che non sono questioni di requisiti e si affrontano nel design del sistema. Sono registrati qui perché emersi durante la raccolta e perché condizionano l'effort.

**Interfaccia con i canali, e relativo effort.** È il primo vincolo di design da affrontare. Oggi i canali sono email e WhatsApp, domani potrebbero essere Telegram, un frontend web o altro (vedi `FUTURE_EXPLORATIONS.MD`). Va stimato il costo di sviluppo per canale e va scelta un'architettura in cui il canale è un adattatore verso un'unica logica di ingestione del pick.

**Transazionalità della registrazione del pick.** Discende dalla regola 3.8 e dalla presenza di più canali. Lo stesso profilo può inviare pick in parallelo su canali diversi, anche in contemporanea, quindi la registrazione deve essere transazionale: o il pick viene accettato e registrato per intero, o viene respinto, senza stati intermedi e senza che due pick concorrenti possano registrarsi entrambi.

La regola del primo pick valido rende il problema trattabile. Al sistema non serve stabilire quale pick sia il più recente, cosa che richiederebbe un ordinamento affidabile tra canali con latenze diverse. Gli serve mutua esclusione: il primo pick che riesce a registrarsi vince, gli altri trovano il posto occupato. Un vincolo di unicità su profilo e round è sufficiente.

Resta da definire quale istante fa fede per la deadline, la ricezione da parte del sistema o il timestamp del messaggio sul canale. La differenza conta solo per i pick a cavallo della chiusura, ma va decisa.

**Fonte dati Serie A.** Il sistema ha bisogno sia del calendario, cioè quali squadre giocano in quale giornata e quando, sia dei risultati finali. Vanno scelti il provider e la gestione della sua latenza, della sua affidabilità e del suo comportamento quando sbaglia o è indisponibile al momento della contabilizzazione. Il calendario serve anche prima della contabilizzazione, perché la deadline della 3.7 dipende dall'orario della prima partita della giornata.

**Configurabilità e parametrizzazione.** È un tema trasversale e vale la pena assumerlo come principio di design fin dall'inizio: quasi nulla di ciò che il brief fissa oggi è definitivo. Le regole sono state riscritte più volte durante la sola raccolta dei requisiti, e i valori numerici sono tutti provvisori. Un sistema in cui questi elementi vivono nella configurazione invece che nel codice assorbe i cambiamenti senza riscritture, e permette di far girare edizioni diverse con impostazioni diverse.

Due famiglie distinte di parametri.

*Parametri di gioco*, decisi da chi organizza. Il brief ne ha già fissati tre, tutti con valori provvisori: quota di iscrizione (5 EUR, regola 3.6), numero massimo di profili per giocatore (3, regola 3.3), anticipo della deadline rispetto alla prima partita della giornata (30 minuti, regola 3.7). Vanno trattati come configurazione e non come costanti: il sistema deve supportare un limite di profili variabile, non un 3 cablato, e lo stesso vale per gli altri due.

*Parametri del campionato*, imposti dall'esterno e da derivare dai dati anziché cablare. Numero di squadre, numero di giornate e confine tra i gironi determinano la lunghezza massima del torneo, il momento in cui il pool si azzera e il margine di sicurezza della 3.1. Leggerli dalla fonte dati significa che un cambio di formato del campionato, o l'uso del sistema su un altro campionato, non richiede modifiche al codice.

**Ripartizione del montepremi.** La regola 3.9 non è ancora decisa, l'ipotesi di lavoro è 85% al vincitore con il resto da allocare, e la domanda aperta 4.2 la tiene sul tavolo. Il design non deve attendere quella decisione, deve però assorbirla. Le quote di ripartizione vanno trattate come configurazione, come gli altri parametri di gioco. La logica di payout deve inoltre gestire fin da subito la divisione in parti uguali tra più vincitori, perché i casi 2 e 3 della 3.2 producono un insieme di vincitori e non un vincitore singolo. Da chiarire anche il trattamento degli arrotondamenti, dato che una divisione in parti uguali raramente cade su cifre intere di centesimi.

**Tornei multipli: topologia di deployment.** La regola 3.10 porta con sé una decisione architetturale da prendere prima del design della Fase 1: come far convivere più tornei sullo stesso campionato. Opzioni in campo: **(a) un'istanza del sistema per torneo** (per esempio un container Docker ciascuno) — isolamento totale, costi operativi proporzionali al numero di tornei; **(b) una singola istanza** (un container) che gestisce più tornei — isolamento logico per torneo, condivisione di canali, dati e scheduler. Da valutare: separazione dei dati (database per torneo vs `tournament_id`), routing dei messaggi per torneo, montepremi e payout per torneo, osservabilità e costo della scalata. La scelta condiziona schema dati, canali e CLI della Fase 1; l'architettura della POC non deve precludere nessuna delle due opzioni.

---

## 6. Non-goal per la Fase 1

Tutto ciò che sta in `FUTURE_EXPLORATIONS.MD` è fuori scope per la Fase 1 di Produzione (per la roadmap e le fasi successive vedi §7).

---

## 7. Roadmap di lancio

La timeline di lancio si articola in tre fasi. L'ordinamento tra le fasi è vincolante; le date di completamento sono da definire (le ancore note sono indicate fase per fase).

### 7.1 Fase 0 — POC

Obiettivo: validare le regole di gioco e il flusso di interazione su dati storici (stagione 2025/26), prima di passare alla produzione.

Caratteristiche previste (elenco completo):

1. Iscrizione via email: l'email è l'identificativo unico; un giocatore = un profilo
2. Apertura del TT: il sistema comunica per email TC (giornata), squadre disponibili, deadline unica (prima partita − anticipo configurabile) e formato del pick
3. Invio del pick via email in linguaggio naturale e conferma/rifiuto con spiegazione sullo stesso canale
4. Validazione completa del pick: profilo iscritto al momento dell'invio, squadra in TC, non bruciata nel girone, esito valido, primo pick valido, deadline rispettata (casistiche CL1-CL8 del `POC_PRD.md`)
5. Regola "una squadra per girone" con azzeramento del pool al cambio girone
6. Chiusura della finestra di pick alla deadline: pick mancante → eliminazione; squadra scelta → bruciata
7. Contabilizzazione deterministica alla chiusura del TC (fine prevista dell'ultima partita programmata + scarto configurabile): pick corretto/sbagliato; partita rinviata fuori finestra → pick in Freeze e contabilizzazione a partita conclusa
8. Chiusura del TT quando tutti i pick sono contabilizzati o freezati; fine del torneo nei tre casi (vincitore unico, eliminazione collettiva, fine stagione con vittoria condivisa)
9. Canale unico email (IMAP/SMTP su Gmail)
10. Amministrazione e test via CLI: comandi per round, pick, regole, eliminazioni, vincitore, dati stagione, canale, simulazione
11. Dati storici Serie A 2025/26 (calendario + risultati) e simulazione dell'intera stagione da CLI
12. Configurabilità totale: parametri di gioco e infrastruttura in variabili d'ambiente validate; parametri del campionato derivati dai dati, mai hardcodati
13. Requisiti non funzionali: determinismo, registrazione atomica dei pick, email in italiano, test automatizzati, deployment su VPS Linux senza porte esposte

> **Esclusa dalla POC:** la capability dei tornei multipli nello stesso campionato (regola 3.10) non è inclusa nella Fase 0 — appartiene alla Fase 1 di Produzione (punto 6 della 7.2).

Criteri di uscita: criteri di successo CS1-CS7 del `docs/POC/POC_PRD.md` §9. Prerequisito all'implementazione: aggiornamento dell'LLD secondo la review indipendente (§16 di `docs/reviews/2026-08-11/architecture-review-2026-08-11.md`).

### 7.2 Fase 1 — Produzione

Obiettivo: tutte le capability descritte in questo documento e non previste dalla POC, escluso tutto ciò che sta in `FUTURE_EXPLORATIONS.MD`; go-live su una stagione reale (ancora indicativa: 2026/27).

Rispetto alla POC vengono aggiunte **6 capability**:

1. **Canale WhatsApp** — invio e ricezione di pick, conferme e rifiuti su WhatsApp, con canale email mantenuto; la regola del primo pick valido copre la concorrenza tra canali (3.8)
2. **Profili multipli per giocatore** — fino a `MAX_PROFILES_PER_PLAYER` (provvisorio: 3), ognuno con quota, pick, squadre bruciate ed eliminazione propri (3.3)
3. **Avviso di collisione tra profili** — segnalazione informativa di pick identici, senza blocco (3.4)
4. **Quota di iscrizione** — riscossione della quota configurabile per profilo (3.6)
5. **Montepremi e payout** — ripartizione configurabile e distribuzione, inclusa la divisione in parti uguali nei casi di vittoria condivisa (3.9 + 3.2)
6. **Tornei multipli nello stesso campionato** — più tornei gestiti contemporaneamente, con inizio in qualsiasi TC e durata fino a fine stagione; iscrizione per nuovi giocatori e per giocatori eliminati in altri tornei (3.10)

Nota operativa: la Fase 1 passa a dati live e funzionamento automatico (scheduler, monitoraggio, riconciliazione dati) — requisiti di esercizio della fase, non capability di gioco.

### 7.3 Fasi successive — rilasci incrementali

Rilasci progressivi che incorporeranno gradualmente **alcune, tutte o nessuna** delle caratteristiche di `FUTURE_EXPLORATIONS.MD`, secondo una timeline ancora da definire: chatbot conversazionale, web app, jolly, pick con risultato esatto, gestione morbida del pick mancante e auto-pick, ingresso tardivo con quota scalata (da coordinare con 3.10), canali aggiuntivi (Telegram, web, chatbot), annullamento esplicito del pick, sistema di notifiche, operatività pubblica (solo dopo parere legale, cfr. disclaimer in testa al documento).

Priorità e dipendenze verranno valutate release per release, al completamento della fase precedente.

