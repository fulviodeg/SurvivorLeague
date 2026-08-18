# Survivor League — Riepilogo esecutivo · 11 agosto 2026

**Data:** 2026-08-11 · **Owner:** Fulvio de Giovanni · Gioco privato tra amici, fuori dal perimetro commerciale delle scommesse.

## 1. Il progetto

- Torneo a eliminazione tra amici costruito sui risultati della Serie A.
- A ogni turno di campionato ogni partecipante invia un pronostico (pick): squadra + esito (vince, pareggia, perde).
- A fine turno vale l'esito del pronostico: pick corretto → si resta in gara; pick sbagliato o mancante → eliminazione.
- Regola chiave: una squadra si può usare una sola volta per girone; a metà stagione il pool si azzera e tutte le squadre tornano disponibili.
- Vince chi resta solo; in caso di eliminazione collettiva o di fine stagione con più superstiti, la vittoria è condivisa.

## 2. Come si gioca

- Interazione via email nella fase iniziale; WhatsApp, interfaccia web e chatbot nelle fasi successive del progetto.
- A ogni turno il sistema comunica le squadre disponibili e la scadenza del pick (deadline: 30 minuti prima della prima partita del turno, configurabile).
- Il pick si invia in linguaggio naturale e il sistema risponde in italiano: conferma o spiegazione del rifiuto.
- Vale il primo pick valido; i tentativi successivi per lo stesso turno sono respinti.
- L'iscrizione avviene in una **fase di iscrizione** che il commissioner apre e chiude (in produzione, automatica): il sistema accetta iscrizioni **solo a fase aperta**; a fase chiusa possono entrare solo giocatori che il commissioner iscrive manualmente via CLI. Per giocare un turno servono iscrizione completata prima dell'invio del pick e invio entro la deadline.
- Dalla Fase 1 di Produzione: più profili per giocatore, quota di iscrizione, montepremi e più tornei per stagione.

## 3. Architettura del sistema

- Motore di gioco deterministico: regole, validazione dei pick, contabilizzazione, eliminazioni, vincitori. Nessuna decisione di gioco affidata a interpretazioni.
- Intelligenza artificiale confinata alla comunicazione: interpreta i messaggi liberi e genera le risposte in italiano; non prende decisioni di gioco.
- Canali intercambiabili: email oggi; WhatsApp, web e chatbot in fasi successive, senza modificare le regole.
- Fonte dati intercambiabile: dati storici 2025/26 nella POC; dati live in produzione.
- Amministrazione: riga di comando nella POC; automatica con supervisione in produzione.
- Tecnologia: Node.js/TypeScript, database SQLite, Gmail (IMAP/SMTP), API di intelligenza artificiale, VPS Linux senza porte esposte.

## 4. Piano di lancio

### Fase 0 — POC (validazione su dati storici 2025/26)

- Iscrizione via email; un profilo per giocatore; unico canale email.
- Flusso completo del turno: istruzioni, invio del pick, deadline, chiusura della finestra di pick, contabilizzazione.
- Regole complete: una squadra per girone, eliminazioni, gestione delle partite rinviate (pick in attesa di recupero), i tre modi di chiusura del torneo.
- Amministrazione e test via riga di comando; simulazione dell'intera stagione; parametri configurabili; test automatizzati.
- Fuori dalla POC: pagamenti, quota di iscrizione e montepremi (in arrivo nella Fase 1).

### Fase 1 — Produzione (target indicativo: stagione 2026/27)

- Tutte le capacità del brief, escluse le idee future. Sei funzionalità in più rispetto alla POC: canale WhatsApp; profili multipli; avviso di collisione tra profili; quota di iscrizione; montepremi e payout; tornei multipli sullo stesso campionato con inizio in qualsiasi turno.
- Funzionamento automatico con supervisione: il sistema legge il calendario e apre/chiude da solo la fase di iscrizione e i round; il commissioner può sempre intervenire via CLI per correggere lo stato.

### Fasi successive — rilasci incrementali (timeline da definire)

- Integrazione graduale di alcune, tutte o nessuna delle idee future (chatbot, web app, jolly, auto-pick, risultato esatto, notifiche, canali aggiuntivi), secondo priorità ancora da definire.

## 5. Documenti di riferimento

- `BRIEF/BRIEF.MD` — regole e requisiti di alto livello.
- `BRIEF/FUTURE_EXPLORATIONS.MD` — idee future, fuori dalla Fase 1.
- `docs/POC/POC_PRD.md`, `docs/POC/POC_HLD.md`, `docs/POC/POC_LLD.md` — progettazione della POC.