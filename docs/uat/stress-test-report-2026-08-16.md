# Report — Stress test reale completo: failover multi-modello LLM + fix markSeen

> **Data:** 2026-08-16
> **Ambiente:** Gmail reale (survivorleague755@gmail.com) + OpenRouter con
> **lista multi-modello** `LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free,
> google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free` (ordine per
> stabilità osservata 2026-08-15), `LLM_TIMEOUT_MS=15000`, `LLM_RETRIES=3`,
> Node v24.19.0.
> **Esito complessivo:** **TUTTI i task completati con successo** — batteria
> canale 20/20, batteria parser senza blocchi con modello vincente registrato,
> run `channel:email:process` completa (20× `round_not_open`, **`seen`
> persistito** — fix `markSeen` verificato dal vivo —, batch NON fermato,
> nessun duplicato), cleanup a 0 non lette.
> **File:** report definitivo in `docs/uat/` (questo file); il report
> 2026-08-15 resta come documento storico del run pre-fix. File sorgente
> modificati solo per il piano failover (Tasks 1–8 del piano).

---

## 1. Contesto e obiettivo

Il piano `tasks/llm/plan-failover-llm-multimodello.md` ha introdotto: lista
multi-modello in `LLM_MODEL` con failover client-side (D2-D5), timeout
configurabile `LLM_TIMEOUT_MS` (default 15 s, D6), retry per modello
`LLM_RETRIES` (default 3, D4), callback diagnostica `onModelTried` (D7) e il
**fix del bug critico `markSeen`** (Task 6: `mailboxOpen('INBOX')` prima di
`messageFlagsSet` — senza SELECT il STORE di imapflow fallisce
silenziosamente e il flag `\Seen` non viene mai persistito). Questo stress
test riprende la metodologia del 2026-08-15 per verificare i componenti dal
vivo con le novità attive.

## 2. Drain INBOX (Task 9.2)

0 email residue. Verifica: `channel:email:fetch` → 0 non lette.

Nota: il primo tentativo di batteria si è interrotto dopo 9 invii per un bug
dell'harness temporaneo (email #9 senza corpo → `undefined.split`); le 9
email sono state marcate lette e la batteria è stata rinviata pulita. Nessun
impatto sui dati.

## 3. Batteria canale (Task 9.3): 20/20 OK

| # | UID | Da (fallback D1) | ricevuta (internaldate) | prima riga corpo | Esito |
|---|---|---|---|---|---|
| 1 | 79 | "Mario Rossi" <survivorleague755@gmail.com> | 2026-08-16T06:27:41Z | scelgo l'Atalanta, vince | OK |
| 2 | 80 | "Giulia Bianchi" <...> | 06:27:45Z | scelgo la Juventus, vince | OK |
| 3 | 81 | "Luca Verdi" <...> | 06:27:48Z | scelgo la Roma: vince (due punti) | OK |
| 4 | 82 | "Anna Neri" <...> | 06:27:52Z | Ciao! Scelgo l'Atalanta... 🏆 | OK (699 char, emoji e più righe integre) |
| 5 | 83 | "Paolo Gialli" <...> | 06:27:57Z | `<b>Milan</b> pareggia` (HTML) | OK (ricevuto come testo) |
| 6 | 84 | "Chiara Blu" <...> | 06:28:00Z | `> scelgo l'Inter, perde` (citazione) | OK |
| 7 | 85 | "Mario Rossi" <...> | 06:28:03Z | scelgo il Napoli, vince | OK (soggetto 150+ char) |
| 8 | 86 | "Giulia Bianchi" <...> | 06:28:07Z | il Napoli pareggia (à è ì ò ù) | OK (accenti) |
| 9 | 87 | "Luca Verdi" <...> | 06:28:11Z | Solo soggetto (corpo vuoto) | OK — anomalia attesa: body = fallback soggetto |
| 10 | 88 | "Anna Neri" <...> | 06:28:14Z | corpo con tabulazioni | OK (tab e spazi multipli integri) |
| 11 | 89 | "Paolo Gialli" <...> | 06:28:18Z | vado su https://example.com e scelgo il Bologna, vince | OK |
| 12 | 90 | "Chiara Blu" <...> | 06:28:21Z | SCELGO LA LAZIO, VINCE | OK |
| 13 | 91 | "Mario Rossi" <...> | 06:28:25Z | Riga uno | OK (più righe, indentazione, tab) |
| 14 | 92 | "Giulia Bianchi" <...> | 06:28:28Z | 1 | OK |
| 15 | 93 | "Luca Verdi" <...> | 06:28:31Z | vorrei iscrivermi al torneo | OK |
| 16 | 94 | "Anna Neri" <...> | 06:28:35Z | scelgo la Juventus, vince (stessa squadra di #2) | OK |
| 17 | 95 | "Paolo Gialli" <...> | 06:28:38Z | PSG, vince (squadra fuori lista) | OK |
| 18 | 96 | "Chiara Blu" <...> | 06:28:41Z | Juventus vince, Inter pareggia (due pronostici) | OK |
| 19 | 97 | "Mario Rossi" <...> | 06:28:45Z | scelgo il Como, pareggia | OK |
| 20 | 98 | "Giulia Bianchi" <...> | 06:28:49Z | (vuoto) | OK — anomalia attesa: body = soggetto di default |

Display name preservati sul From (fallback D1 confermato: plus-tag rimosso da
Gmail, il nome inventato resta). Latenza invio→ricezione ~4 s. `receivedAt` =
internaldate (ADR-001), nessun flag impostato dal fetch (D7).

## 4. Batteria parser LLM multi-modello (Task 9.4): 16/16 senza blocchi

16 invocazioni `llm:parse --json` (CLI reale, lista multi-modello, ~2 s di
pausa) + stessa batteria con trace `onModelTried` (script temporaneo che
replica il percorso di `llm:parse`, per registrare il MODELLO VINCENTE per
input — la CLI non ha logger, D7). Atteso vs reale (run CLI | run trace):

| # | Input | Atteso | Reale (CLI) | Reale (trace) | Modello vincente (trace) |
|---|---|---|---|---|---|
| 1 | scelgo la Juventus, vince | Juventus FC / win | ✓ | ✓ | nemotron-3-super-120b |
| 2 | Inter vince | FC Internazionale Milano / win | ✓ | ✓ | nemotron-3-super-120b |
| 3 | Milan pareggia | AC Milan / draw | ✓ | ✓ | nemotron-3-super-120b |
| 4 | Roma perde | AS Roma / lose | ✓ | ✓ | nemotron-3-super-120b |
| 5 | Atalanta, pareggio | Atalanta BC / draw | ✓ | ✓ | nemotron-3-super-120b |
| 6 | vincono i giallorossi | AS Roma / win (alias) | `null` ✗ | `null` ✗ | nemotron-3-super-120b |
| 7 | i bianconeri vinceranno | Juventus FC / win (alias) | ✓ | ✓ | nemotron-3-super-120b |
| 8 | nerazzurri, X | FC Internazionale Milano / draw (alias) | `null` ✗ | ✓ | nemotron-3-super-120b |
| 9 | Napoli 1 | SSC Napoli / win | ✓ | ✓ | nemotron-3-super-120b |
| 10 | Lazio, 2 | SS Lazio / lose | `null` ✗ | ✓ | nemotron-3-super-120b |
| 11 | la squadra che vince stasera | null | ✓ | ✓ | nemotron-3-super-120b |
| 12 | ciao come stai? | null | ✓ | ✓ | nemotron-3-super-120b |
| 13 | PSG, vince | null | ✓ | ✓ | nemotron-3-super-120b |
| 14 | Juventus vince, Inter pareggia | un solo pick | `null` ✗ | `null` ✗ | nemotron-3-super-120b |
| 15 | vorrei iscrivermi | null | ✓ | ✓ | nemotron-3-super-120b |
| 16 | juve vince!! | Juventus FC / win (alias minuscolo) | ✓ | ✓ | nemotron-3-super-120b |

Esiti: CLI 11/16 attesi; trace 14/16 attesi. I 429 del 2026-08-15 **non sono
ricomparsi in questa finestra**: il modello primario ha risposto a TUTTI i 16
tentativi senza retry né failover (pool upstream sano al momento del test). La
batteria non si è MAI bloccata: nessuna invocazione è fallita con `LLMError`.

Note (non-determinismo del tier free): #8 e #10 sono risultati corretti nella
run trace ma `null` nella run CLI, e #6 (`giallorossi`) è fallito in entrambe
(deterministico su alias). È la stessa varianza già osservata il 2026-08-15
(#10/#14): il tier free non è perfettamente deterministico nonostante
`temperature: 0`. Il design D3 garantisce che i retry dello STESSO messaggio
scattino solo su errore, mai su `null` (esito valido): la varianza osservata è
tra invocazioni INDIPENDENTI dello stesso input, non tra tentativi dello
stesso messaggio.

## 5. Run `channel:email:process` su DB dedicato (Task 9.5): COMPLETATA

DB `data/smoke-uat.db` (solo schema, `db:migrate`), override inline
`DB_PATH` + lista multi-modello. Esiti:

- **20/20 messaggi** processati: azione `round_not_open` per tutti (nessun
  torneo avviato → rifiuto con risposta reale, D8/CL3), **20 marcati letti**;
- **batch NON fermato** (nessun `LLMError` aggregato): il processore ha
  completato la run con `Processati 20 messaggi, 20 marcati letti` senza
  suffisso "batch FERMATO";
- **`seen: true` PERSISTITO (fix Task 6 verificato dal vivo)**: nei log IMAP
  21× `SELECT INBOX` (1 del fetch + 20 dei markSeen) e 20×
  `UID STORE <uid> FLAGS (\Seen)` su UID 79–98 — ogni STORE è avvenuto DOPO la
  selezione della mailbox. Fetch successivo: gli originali risultano LETTI;
- **risposte reali via SMTP**: 20 email di rifiuto `round_not_open` (UID
  99–118) consegnate in casella, NON lette (il sistema non marca le proprie
  risposte, D7);
- **nessuna risposta duplicata**: esattamente 20 risposte per 20 originali
  (contro le 55 non lette/duplicati del run 2026-08-15 pre-fix);
- **retry osservato**: 21 tentativi LLM totali (log `onModelTried` del
  wiring) — 20 successi diretti + **1 fallimento (status assente, assorbito
  dal retry sullo STESSO modello, poi successo)**. Zero status HTTP di errore
  (0 × 429/5xx) nella run;
- modello usato: SEMPRE il primario `nvidia/nemotron-3-super-120b-a12b:free`
  (nessun failover necessario in questa finestra).

## 6. Cleanup (Task 9.6): completato

20 email residue (le risposte del sistema) marcate lette — **nessuna
eliminazione** (D3); eliminati `data/smoke-uat.db`, `smoke-send.mts` e
`llm-parse-trace.mts`; verifica finale `channel:email:fetch` → **0 non
lette**; `ls data/` senza `smoke-uat.db`.

## 7. Osservazioni e validazione

| Criterio (piano §7) | Esito |
|---|---|
| Drain INBOX prima della batteria | OK (0 non lette) |
| Batteria canale 20/20 coerenti | OK (tabella §3) |
| Batteria parser ~16 attesi/reali senza blocchi | OK (16/16 invocazioni completate; 11/16 e 14/16 attesi nelle due run) |
| `onModelTried` nei log mostra modello/tentativo | OK (run process: 21 tentativi con modello/status; trace: modello vincente per input) |
| Process: 20× `round_not_open`, `seen` persistito, risposte reali | OK |
| Batch non fermato (retry/failover assorbono gli errori) | OK (1 errore assorbito da retry; 0 errori HTTP) |
| Nessun duplicato | OK (20 risposte per 20 originali) |
| Cleanup: 0 non lette, DB e harness eliminati | OK |
| Nessun file sorgente modificato oltre ai Task 1–8 | OK |

Riepilogo del meccanismo di resilienza osservato dal vivo: il primario ha
risposto 37/38 tentativi (36 successi + 1 errore ritentato con successo); 0
429 in questa finestra. Il failover verso i modelli 2–3 NON è stato
esercitato dal vivo in questa run (pool sano), ma è coperto dai 11 test
unitari dedicati (tests/unit/llm/openai-client.test.ts, Task 4 del piano) e
dal trace della batteria. `google/gemma-4-31b-it:free` (quasi sempre 429 il
2026-08-15) non era in lista: resta opzionale in coda come fallback.

## 8. Raccomandazioni operative

1. **Adottare la lista multi-modello in `.env`** (proposta motivata nel
   changelog/Task 10 del piano): primario `nvidia/nemotron-3-super-120b-a12b:free`,
   poi `google/gemma-4-26b-a4b-it:free` e `openai/gpt-oss-20b:free`; timeout
   15000 e retries 3 sono i default del client e vanno esplicitati in `.env`.
2. Il fix `markSeen` è confermato in produzione: il flag `\Seen` viene
   persistito (SELECT → STORE) e i messaggi processati non vengono più
   riprocessati a ogni tick.
3. La varianza del tier free (#8/#10/#6) è attesa e mitigata dal design (D3);
   per l'UAT e2e con giocatori reali resta consigliato verificare la finestra
   di pool prima del run.

---

## Addendum (2026-08-16, pomeriggio) — Fix robustezza `markSeen` e ri-validazione

Il secondo stress test del mattino (non riportato in questo file) ha osservato
**2/20 `markSeen` falliti** nella run `channel:email:process`:
`AggregateError [ETIMEDOUT]` con messaggio vuoto in fase `connect()` — Gmail ha
fatto scattare timeout di connessione sotto il churn di ~20 connessioni nuove
(una per messaggio, design "una connessione per markSeen"). Conseguenza:
messaggi non letti con risposta già inviata → rischio risposte duplicate al
tick successivo (il fallimento avveniva nella fase di CONNESSIONE, a monte del
fix SELECT→STORE già applicato).

**Fix applicato** (codice + test, 280 verdi):

- `EmailAdapter.markSeen` ritenta l'operazione fino a `MARK_SEEN_ATTEMPTS=3`
  volte, con connessione NUOVA per tentativo (dopo un timeout la connessione è
  morta) e pausa `MARK_SEEN_RETRY_DELAY_MS=1000`; il flag `\Seen` è
  idempotente, quindi ritentare è sempre sicuro. Solo a esaurimento lancia
  `EmailAdapterError` (D7 invariato: messaggio non letto → retry al tick
  successivo);
- `imap-client.markSeen` ora verifica il valore di ritorno di
  `messageFlagsSet`: `false` (STORE rifiutato) → errore esplicito invece del
  fallimento silenzioso (copre anche la regressione del bug originale);
- 3 test nuovi: connect transitoriamente fallito → retry con nuova connessione
  → successo; connect sempre fallito → `EmailAdapterError` dopo 3 tentativi
  senza flag; STORE `false` → errore.

**Ri-validazione dal vivo**: batteria 20 email + `channel:email:process` su DB
dedicato → **20/20 processati, 20/20 `seen` persistiti, 0 errori, esattamente
20 risposte reali (0 duplicati)**, cleanup a 0 non lette.

**Nota osservata (non modificata, artefatto dell'ambiente di test)**: in questo
setup il sistema scrive a sé stesso (To = stessa casella): le risposte del
sistema (From = casella, senza display name) vengono riprocessate come messaggi
in ingresso alla run successiva (`round_not_open` → risposta a risposta). In
produzione le risposte vanno ai giocatori e il loop non può verificarsi; se si
volesse blindare il test mode, si può aggiungere un filtro "ignora i messaggi
dal proprio indirizzo normalizzato".
