# Report di Analisi — UAT Aggancio Asincrono (2026-08-22)

> **File**: `docs/uat/report-analisi-aggancio-asincrono-2026-08-22.md`
> **Data analisi**: 2026-08-22 (~20:45Z) — sessione dedicata, dopo il test
> UAT aggancio asincrono (vedi `docs/uat/report-uat-aggancio-asincrono-2026-08-22.md`).
> **Ambiente**: TEST MODE, `ENV_FILE=.env.uat`, DB `data/uat-synthetic-pippo.db`
> + `data/uat-platform-pippo.db`, modello LLM primario `mistralai/mistral-nemo`.
> Tutte le riproduzioni sono state eseguite con il classificatore REALE
> (`OpenAIIntentClassifier` + client condiviso, `temperature: 0`).

---

## Sintesi

Su 5 commenti accumulati durante il test, **3 sono la stessa causa root**
(un errore di classificazione LLM indotto dal CONTESTO citato nella mail di
risposta), **1 è un falso problema** (invio confermato, mancata ricezione lato
Gmail), e **1 è la conseguenza del precedente** (nessun bug del gate bruciate).

| # | Commento | Causa root | Verdetto |
|---|---|---|---|
| 1 | Mail `tournament_open` non arrivata a fulviodegiovanni@live.com | **INVIO CONFERMATO** in Sent (17:59:07Z) — problema di ricezione Gmail | ❌ Non è un bug del sistema |
| 2 | TC5: inviato "cremonese pareggia" ma DB = US Catanzaro lose | Classificatore LLM confuso dalla citazione (partite/bruciate nel body) | ✅ Bug riprodotto |
| 3 | TC5: Cremonese bruciata ma contabilizzata come correct | Conseguenza del #2: il pick registrato era US Catanzaro (non bruciato), mai Cremonese | ✅ Non è un bug del gate bruciate |
| 4 | TC6: inviato "catanzaro" ma registrato SSC Bari win | Classificatore LLM confuso dalla citazione (stessa causa del #2) | ✅ Bug riprodotto |
| 5 | TC6: "Catanzaro pareggia" non compreso (clarification) | Classificatore LLM instabile con la citazione del rifiuto (SSC Bari draw / null) | ✅ Bug riprodotto |

---

## 1. Metodo

1. **Riproduzione isolata** con `llm:parse --input "<testo>"` → risultati
   CORRETTI per tutti gli input (il parser puro non vede il contesto).
2. **Riproduzione con `llm:classify --input '{"body": "<testo>"}'`** → risultati
   ancora CORRETTI con il solo testo del giocatore.
3. **Riproduzione con il BODY COMPLETO reale** (testo del giocatore + citazione
   della mail precedente del sistema, presa verbatim dalla casella) →
   **ERRORE RIPRODOTTO 3/3 stabile** (temperature 0 → deterministico).
4. **Verifica incrociata** con la cartella `[Gmail]/Posta inviata` per le mail
   di sistema e con il DB per i pick registrati.

Conclusione: il problema è nel **contesto iniettato al classificatore**, non
nel modello, non nel prompt di sistema, non nel parser.

---

## 2. Problema #2 + #4 + #5 — Il classificatore LLM è confuso dalla citazione

### 2.1 Il flusso del body

Quando un giocatore risponde a una mail del sistema (es. "Invia il tuo pick"),
il client Gmail include nel corpo della risposta la **citazione completa della
mail precedente** (inclusi box ASCII, "SQUADRE BRUCIATE", "PARTITE DEL ROUND",
deadline, narrativa). Il flusso è:

```
IMAP → parsed.text (testo completo, con citazione)
     → message-router.classify() → body = message.body.trim()  (NESSUN taglio della citazione)
     → OpenAIIntentClassifier.classify(body, { teams, aliases, testMode })
```

**Il body completo (giocatore + citazione) viene passato al modello. Non esiste
alcuna pulizia/estrazione della sola risposta del giocatore.**

### 2.2 Riproduzione deterministica (temperature 0, 3/3 esecuzioni identiche)

| Caso | Body completo reale (sintesi) | Esito classificatore | Atteso |
|---|---|---|---|
| UID 293 (TC6, Fulvio DG) | `catanzaro` + citazione: "Scegli tra Brescia Calcio e SSC Bari", bruciate: Cremonese + **Catanzaro**, partite: **"SSC Bari - US Catanzaro: 2-0"** | **`pick: SSC Bari win`** | `US Catanzaro` (win o altro esito) |
| UID 291 (TC5, Fulvio DG) | `cremonese pareggia` + citazione: "Scegli tra Brescia Calcio, SSC Bari e **US Catanzaro**", bruciate: **Cremonese**, partite: **"US Catanzaro - Brescia Calcio: 0-1"** | **`pick: US Catanzaro lose`** | `US Cremonese draw` |
| UID 295 (TC6, Pippi) | `Catanzaro pareggia` + citazione del RIFIUTO: "la tua squadra **SSC Bari** è già stata usata" | **`SSC Bari draw`** / **`pick: null`** (instabile) | `US Catanzaro draw` |

**Meccanismo**: il modello, vedendo nel contesto che la squadra scritta dal
giocatore è "bruciata" o assente dalle disponibili, e che una partita del round
menziona un'altra squadra con un punteggio netto (es. "SSC Bari - US Catanzaro:
2-0"), "corregge" la scelta verso la squadra che appare vincente nel contesto.
A parità di prompt e `temperature: 0` il risultato è deterministico (3/3).

Nota: con il solo testo del giocatore (senza citazione) il modello risponde
correttamente in tutti i casi — quindi **non è un problema del modello né del
prompt di sistema**, ma dell'input.

### 2.3 Impatto sui pick registrati

| pick id | Giocatore | TC | Team registrato | Team atteso dal testo | Consequenze |
|---|---|---|---|---|---|
| 7 | Fulvio DG | 5 | US Catanzaro lose (correct) | US Cremonese draw | Il gate bruciate NON scatta (Catanzaro non bruciata); il pick è "correct" solo per caso (Catanzaro ha perso) |
| 9 | Fulvio DG | 6 | SSC Bari win (correct) | US Catanzaro (?) | Il pick registrato NON corrisponde alla scelta dichiarata; la conferma al giocatore dice "SSC Bari" mentre lui aveva scritto "catanzaro" |
| — | Pippi | 6 | (nessun pick — clarification) | US Catanzaro draw | Il sistema chiede chiarimento invece di rispondere con un motivo specifico |

### 2.4 Conseguenze sul commento #3

Il commento #3 ("Cremonese bruciata ma contabilizzata come correct") è la
**conseguenza diretta del #2**: il pick registrato per Fulvio DG al TC5 è
**US Catanzaro lose**, non US Cremonese. Il gate `team_already_used` non poteva
scattare perché la squadra registrata (Catanzaro) non era bruciata per lui.
Se il classificatore avesse interpretato correttamente "cremonese pareggia"
→ US Cremonese draw, il pick SAREBBE stato rifiutato per bruciata (Cremonese
usata in TC3 e TC4 dal profilo 2). Quindi: **il gate bruciate funziona**; il
problema è a monte (classificazione).

### 2.5 Fix candidati (da valutare in una sessione di implementazione)

1. ✅ **ADOTTATO (2026-08-23)** — **Estrarre la sola risposta del giocatore**
   prima della classificazione: tagliare la parte citata (righe che iniziano
   con `>` o dopo il marker "ha scritto:" / "Il giorno ... ha scritto").
   Pro: input pulito, robusto. Contro: i client di posta variano il formato
   della citazione (visti: "Il giorno ... ha scritto:", "Il sab ... ha
   scritto:", "Il giorno ... alle ore ... ha scritto:", con `>` o senza).
   **Implementazione**: modulo puro `src/channel/email-adapter/reply-cleaner.ts`
   (`extractPlayerReply`, max 5 righe non vuote del giocatore; confini di
   taglio: separatore di sistema `───` anteposto a ogni email di sistema,
   righe `>`, marker "ha scritto:"/"wrote:" anche spezzato su due righe)
   applicato in `message-router.classify` — i 3 body reali puliti classificano
   correttamente (`US Cremonese draw`, `US Catanzaro`, `US Catanzaro draw`,
   verificati con il classificatore reale).
2. **Rendere il modello più resistente al contesto**: esplicitare nel prompt
   che "ignora il testo citato e considera SOLO il messaggio del giocatore";
   mantenere comunque un taglio deterministico come salvagente. *(Non adottato:
   il taglio deterministico del fix 1 è sufficiente e il prompt resta stabile.)*
3. **Validazione di coerenza** post-classificazione: se il team classificato
   NON compare nel testo del giocatore (ma compare solo nella citazione),
   chiedere chiarimento invece di registrare. (Approccio difensivo, da pesare
   contro i casi di parafrasi legittime.)
4. **Log diagnostico**: registrare il body esatto passato al classificatore
   (o almeno le prime N righe) per rendere i problemi futuri riproducibili.

---

## 3. Problema #1 — Mail `tournament_open` a fulviodegiovanni@live.com

### 3.1 Falso problema: l'invio è avvenuto

Dalla cartella `[Gmail]/Posta inviata` della casella di sistema:

```
2026-08-22T17:58:59Z → fulviodegiovanni@gmail.com  → "Survivor League — Il torneo è aperto"
2026-08-22T17:59:02Z → sara.zizzari@gmail.com      → "Survivor League — Il torneo è aperto"
2026-08-22T17:59:07Z → fulviodegiovanni@live.com   → "Survivor League — Il torneo è aperto"
```

Il broadcast `tournament_open` (RF-P6) ha inviato a TUTTI gli account `active`,
incluso il nuovo account live (registrato alle ~17:58:47Z, prima di
`tournament:start` alle 17:59:05Z). Il wiring è corretto:
`src/game/tournament.ts` (righe 337-360) itera su `ctx.platform.activeEmails()`.

### 3.2 Causa probabile del mancato arrivo

Problema di **ricezione lato Gmail** dell'account `fulviodegiovanni@live.com`
(spam / promozioni / aggiornamenti / altro tab), NON un bug del sistema.
Verifica consigliata per l'utente: guardare le cartelle Spam/Promozioni
dell'account live, o aggiungere il mittente alla rubrica.

### 3.3 Nota

`tournament:start` non stampa il conteggio `notified` nel ramo testo (lo fa
solo con `--json`): per diagnosi future sarebbe utile esporlo, ma non è un bug.

---

## 4. Problema #3 (dettaglio gate bruciate)

Il gate `team_already_used` (rules/eligibility) NON ha mai ricevuto un pick
"US Cremonese" al TC5 per il profilo 2: ha ricevuto "US Catanzaro" (dal
classificatore). Quindi nessun bug nel gate. Verifiche DB:

```
pick del profilo 2 (fulviodegiovanni@gmail.com):
  TC3 → US Cremonese win   (correct)
  TC4 → US Cremonese win   (correct)
  TC5 → US Catanzaro lose  (correct)   ← doveva essere US Cremonese draw (se corretto)
  TC6 → SSC Bari win       (correct)   ← doveva essere US Catanzaro (se corretto)
```

---

## 5. Punti NON problematici verificati

- **Parser puro** (`llm:parse`): corretto per tutti gli input testati.
- **Prompt di sistema del classificatore**: corretto (lista canonica, alias,
  regole di ambiguità); il problema è l'INPUT non pulito.
- **Client OpenAI**: `temperature: 0` → deterministico; failover su 429/5xx
  funzionante (nessun errore LLM fatale nel test).
- **Gate `team_already_used` / confine girone**: funzionante (vedi #3).
- **Auto-join RF-P5**: 3/3 profili creati correttamente al TC3.
- **Chiusura automatica**: vittoria condivisa (caso 3) + export corretti.
- **Notifiche round**: inviate a chi di dovere (profili attivi, eliminato
  escluso dai round successivi).

---

## 6. Raccomandazioni

1. **Priorità alta**: introdurre l'estrazione del testo del giocatore (taglio
   della citazione) PRIMA di `classifier.classify` nel flusso
   `channel:email:process` (o in `message-router`), con test sui formati di
   citazione osservati ("Il giorno ... ha scritto", "Il sab ... ha scritto",
   righe `>`).
2. **Priorità alta**: rendere riproducibile la diagnosi — log del body passato
   al classificatore (prime righe o hash).
3. **Priorità media**: aggiungere al prompt un'istruzione esplicita "ignora il
   testo citato; considera solo il messaggio del giocatore" come rinforzo.
4. **Priorità bassa**: valutare una validazione di coerenza (team classificato
   presente nel testo del giocatore) come rete di sicurezza.
5. **Per l'utente**: verificare Spam/Promozioni sull'account
   fulviodegiovanni@live.com per la mail "Il torneo è aperto" (17:59:07Z).

---

## 7. Riferimenti

- Report del test: `docs/uat/report-uat-aggancio-asincrono-2026-08-22.md`
- File rilevanti:
  - `src/channel/email-processor.ts` (`processOne`, righe ~212-238: body → classify)
  - `src/channel/email-adapter/message-router.ts` (`classify`: body trim, nessun taglio)
  - `src/channel/email-adapter/imap-client.ts` (riga 62: `parsed.text` completo)
  - `src/llm/intent-classifier.ts` (`classify` + `buildClassifySystemPrompt`)
  - `src/llm/openai-client.ts` (temperature 0, failover)
  - `src/game/tournament.ts` (righe 337-360: broadcast `tournament_open`)
  - `src/platform/registry.ts` (riga 224: `activeEmails`)
- DB: `data/uat-synthetic-pippo.db`, `data/uat-platform-pippo.db`
- Export: `data/exports/tournament-export-2026-08-22T18-26-42.486Z.json`
- Riproduzioni: comandi `llm:classify --input '{"body": "<testo completo>"}'`
  con i body completi in `/tmp/kilo/full-body-*.txt` (non persistiti nel repo)
