# Regole di Design — Email Survivor League

> Regole di formato valide per **tutte** le email generate dal sistema.

## 1. File di configurazione

Creare un file di configurazione (`parser-conf.json` o `llm-conf.json` — nome a scelta) con i parametri elencati nei punti seguenti.

## 2. Subject dell'email

Formato:

```
⚽🏆SURVIVOR LEAGUE🏆⚽ - [# giornata di campionato] - [messaggio subject]
```

Il `messaggio subject` deve essere **deterministico** (non generato/parsato dal modello IA), iper-condensato, senza articoli o preposizioni. Esempi:

- "Torneo Aperto"
- "Richiesta conferma disiscrizione"
- "Round Aperto"

> ⚠️ Nota: nel testo originale compare "SURVIVOR LEAUE" — refuso, corretto qui in "LEAGUE". Verifica.

**Azione richiesta:** fornire la lista completa dei messaggi subject da validare prima di inserirli nel file di config.

## 3. Mail di Esito Round

Rendere configurabile l'invio della mail "Esito del Round". Default: `false` (non inviata).

Nota: l'esito del pick viene comunque comunicato al giocatore tramite la mail di **Riepilogo Round** (vedi 4.C), quindi il giocatore riceve comunque l'informazione.

## 4. Corpo delle email (regole comuni a tutte)

- Ogni email inizia con la singola riga:
  ```
  ─── Survivor League ───
  ```
- Nessun box con riquadri ASCII (la resa cambia in modo incoerente tra client di posta diversi).
- La richiesta/messaggio chiave della mail va in **grassetto**, con dimensione carattere **+20%** rispetto al resto del corpo.

### A. Invia il tuo pick

```
ROUND APERTO: invia il tuo pick!
Deadline Pick: [data e ora della deadline]

Partite del round
[partite del round — se il risultato non è noto, omettere il risultato, inserire solo il match]
```

### B. Pick registrato

```
PICK REGISTRATO → [scelta deterministica del giocatore]
```

### C. Riepilogo Round

```
[SEI ANCORA IN GARA! / SEI STATO ELIMINATO! + emoji] → [risultato del match del pick del giocatore]

[riepilogo risultati per tutti i giocatori: Nome: scelta pick – in gara/eliminato (+ emoji)]
```

## 5. Altre email

Il formato delle altre email va derivato dalle indicazioni del punto 4.C e dagli esempi sopra.

- Ammesse emoji per abbellire il testo.
- Ammesso testo generato dall'LLM **dopo** il corpo dell'email così come definito sopra (mai prima, mai in sostituzione del corpo).
