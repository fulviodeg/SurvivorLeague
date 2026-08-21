# Piano — Failover multi-modello LLM + timeout/retry configurabili + fix markSeen + stress test reale

> Stato: pronto per l'esecuzione. Richiede modifiche al codice sorgente e ai
> test, invio di email reali e creazione/cancellazione di un DB di collaudo →
> va affidato a un agente con capacità di implementazione/esecuzione.
> Lingua: italiano (convenzione di progetto per i documenti di lavoro).

## 1. Contesto e obiettivo

Lo stress test reale (2026-08-15) ha dimostrato che il modello free singolo è
un **single point of failure**: `google/gemma-4-31b-it:free` ha risposto 2/16
volte (429 sul pool condiviso upstream), e il batch `channel:email:process` si
ferma su `LLMError` per design (D7). La stessa sessione ha scoperto un **bug
critico in `markSeen`** (flag `\Seen` mai persistito). Obiettivi di questa
modifica:

1. **Failover multi-modello**: `LLM_MODEL` accetta una lista separata da
   virgola; il client prova il primo e, a errori di trasporto/HTTP esauriti i
   retry, passa al successivo. Se TUTTI falliscono → `LLMError` (semantica D7
   invariata: batch fermato, retry al tick successivo).
2. **Timeout configurabile**: nuovo parametro `.env` `LLM_TIMEOUT_MS`
   (default **15000 ms = 15 s**, deciso dall'utente in sessione).
3. **Retry per modello**: nuovo parametro `.env` `LLM_RETRIES` (default **3** =
   1 richiesta iniziale + 2 ritentativi) su errore trasporto/HTTP.
4. **Fix bug critico `markSeen`** (prerequisito dello stress test): il flag
   `\Seen` deve essere realmente persistito.
5. **Stress test reale completo** a valle (come quello di inizio sessione):
   batteria 20 email, batteria parser multi-modello, run
   `channel:email:process` su DB dedicato, cleanup, report in `docs/uat/`.

La scelta del failover è **client-side** (non il fallback nativo OpenRouter
`models[]` + `route: 'fallback'`): più testabile con i fake fetch già
iniettati, portabile su qualsiasi endpoint OpenAI-compatibile, visibilità
piena su quale modello/tentativo risponde (diagnostica, report UAT).

## 2. Costi e benefici delle modifiche (analisi richiesta)

### 2.1 Timeout configurabile

| | |
|---|---|
| **Benefici** | Controllo operativo senza codice: produzione (modelli a pagamento reattivi) può abbassarlo, tier free può alzarlo; parametro esplicito e documentato (coerente con `IMAP_POLL_MS`); il client espone già `timeoutMs` come parametro → modifica piccola |
| **Costi/rischi** | La scelta del default è critica: latenze free misurate ~2 s → >120 s. Default 3 s avrebbe scartato quasi ogni risposta free legittima, bruciando retry e failover su modelli funzionanti ma lenti (torneo più bloccato, non meno). **Decisione utente: default 15 s** — compromesso tra reattività (worst case 3 modelli × 3 tentativi × 15 s = 135 s/messaggio) e copertura del tier free |
| **Note** | Il client ha oggi `timeoutMs` nel costruttore e costante `DEFAULT_TIMEOUT_MS = 30_000`: si allinea a 15 s per coerenza col default env |

### 2.2 Retry per modello (default 3 = 1 + 2)

| | |
|---|---|
| **Benefici** | Assorbe errori TRANSITORI (finestre 429 brevi, 5xx sporadici, strappi di rete) SENZA consumare la lista: il modello primario resta primario, il failover scatta solo su guasto persistente → più resilienza e più determinismo (stesso modello risponde più spesso). I 429 osservati erano "temporarily rate-limited upstream, retry shortly": un ritentativo ha chance reale |
| **Costi/rischi** | Moltiplicatore di latenza per messaggio (tentativi × timeout per modello); ritentare un 429 senza pausa può tenere saturo il pool; ritentare errori DETERMINISTICI (401/403) è tempo perso |
| **Mitigazioni adottate** | Delay fisso breve (~1 s) tra i tentativi dello stesso modello; retry SOLO su errori ritentabili (429, 5xx, timeout, rete, body malformato); 4xx deterministici (400/401/403/404) saltano dritti al modello successivo; più logica nel client → più test (pattern fetch fake già esistente) |

### 2.3 Fix markSeen (prerequisito)

| | |
|---|---|
| **Bug** | `src/channel/email-adapter/imap-client.ts:80-81` — `markSeen` chiama `conn.messageFlagsSet(uid, ['\Seen'], { uid: true })` SENZA `mailboxOpen` prima. Il handler STORE di imapflow (`store.js:20`) con `state !== SELECTED` ritorna `false` **silenziosamente** (nessun errore, nessun flag). `EmailAdapter.markSeen` (index.ts:96-111) crea una nuova connessione per chiamata → in produzione il flag non viene MAI impostato, pur loggando successo (D7) |
| **Impatto** | CRITICO: a ogni tick i messaggi già processati vengono riprocessati e le risposte duplicate reinviate ai giocatori (osservato: casella 20 → 55 non lette durante il test) |
| **Fix** | Aprire la mailbox prima del STORE (come fa `fetchUnseen`): `await conn.mailboxOpen('INBOX')` dentro `markSeen` (imap-client.ts). I fake dei test hanno già `mailboxOpen` (imap-client.test.ts:32, email-adapter.test.ts:34) → adeguare gli assert alla sequenza `mailboxOpen → messageFlagsSet` |

### 2.4 Interazione failover × retry (worst case documentato)

Per un singolo messaggio: Σ sui modelli di (tentativi × timeout). Con
3 modelli × 3 tentativi × 15 s = **max ~135 s/messaggio** (+ delay 1 s ×
tentativi). In pratica i fallimenti reali sono veloci (429/5xx immediati),
quindi l'impatto tipico è di pochi secondi. Documentare nel commento del
client e in LLD §4.2.

## 3. Decisioni di design (confermate in sessione)

- **D1 — Formato `LLM_MODEL`:** lista separata da virgola (es. `a,b, c ,d`).
  Zod trasforma in `string[]`: trim per voce, scarto voci vuote, dedup
  mantenendo l'ordine (Set). Un solo valore → array di 1 (retro-compatibile).
  Lista risultante vuota (es. `LLM_MODEL=`, `,,`) → `ConfigError` che nomina
  la variabile.
- **D2 — Dove vive il failover/retry:** nel client condiviso `OpenAIClient`
  (seam unico usato da Parser E Generator, ADR-004 rispettato). Il costruttore
  passa da `model: string` a `models: string[]`; `chatCompletion(messages,
  responseFormat)` **resta invariata** (Parser/Generator non cambiano).
  Ordine della lista = priorità (il primo è il modello primario).
- **D3 — Quando scatta il failover:** SOLO su `LLMError` (dopo aver esaurito i
  retry del modello corrente). MAI su `null` (CS7): `null` è una risposta
  VALIDA del parser ("pick ambiguo") e non deve far cambiare modello,
  altrimenti lo stesso messaggio produrrebbe esiti diversi nel tempo. Il
  failover vive nel client, che non conosce il `null` del parser — contratto
  rispettato per costruzione.
- **D4 — Retry per modello (`LLM_RETRIES`):** default 3 = 1 richiesta + 2
  ritentativi, su errori RITENTABILI: status 429, status ≥ 500, timeout
  (abort), errore di rete, body malformato/content vuoto (status assente).
  Errori 4xx deterministici (400/401/403/404): nessun retry → failover al
  modello successivo. Delay fisso `RETRY_DELAY_MS = 1000` tra i tentativi
  dello stesso modello (costante interna, non env var: evita esplosione di
  parametri). `LLM_RETRIES=1` → comportamento di oggi (nessun ritentativo).
- **D5 — Tutti i modelli/tentativi esauriti:** il client rilancia un
  `LLMError` aggregato che elenca modelli ed esiti (es. `m1: 3 tentativi
  (429, 429, 500); m2: 1 tentativo (rete)`); `status` = ultimo status con
  valore (se nessuno → `undefined`, come oggi). Il wiring/processor non
  cambia: `LLMError` → batch fermato, retry al tick successivo.
- **D6 — Timeout configurabile (`LLM_TIMEOUT_MS`):** default **15000** (ms),
  `intParam()` zod. Il client espone già `timeoutMs` nel costruttore: il
  wiring/CLI passa `config.LLM_TIMEOUT_MS`; costante interna
  `DEFAULT_TIMEOUT_MS` allineata a 15_000 come fallback.
- **D7 — Diagnostica:** callback opzionale nel costruttore
  `onModelTried?: (model: string, ok: boolean, status?: number) => void`,
  invocata per OGNI tentativo (anche i retry dello stesso modello). Il wiring
  (`email-wiring.ts`) la collega a un logger pino (messaggi in inglese, regola
  progetto). Nessuna modifica agli output CLI: l'osservabilità passa dai log.
- **D8 — Fix `markSeen`:** `mailboxOpen('INBOX')` prima di `messageFlagsSet`
  in `imap-client.ts` (stesso pattern di `fetchUnseen`); nessun cambio di
  firma (D7 invariato: flag a messaggio processato con successo).
- **D9 — Commenti/docs (AGENTS.md §5):** aggiornare i commenti di
  `config.ts` (3 parametri), del client, di `imap-client.ts` e di
  `.env.example`; righe LLD §4.2 (`LLM_MODEL`, `LLM_TIMEOUT_MS`,
  `LLM_RETRIES`). Nota: il commento attuale del client dice "MAI retry
  automatico in POC": va precisato — nessun retry **intra-modello senza
  limiti**, ma retry configurati (N) e failover **tra modelli** (deviazione
  voluta, da registrare nel changelog).

## 4. Task

### Task 1 — Config: 3 parametri (`src/config.ts`)

1. `LLM_MODEL: z.string().min(1).default('gpt-4o-mini').transform(...)` →
   `string[]` (trim, scarto vuoti, dedup ordinato) + `.refine(arr.length > 0)`
   → `ConfigError` che nomina la variabile. Tipo `AppConfig.LLM_MODEL` →
   `string[]`.
2. Nuovo `LLM_TIMEOUT_MS: intParam().default(15000)` — commento: timeout di
   una singola richiesta LLM in ms; effetto: abbassarlo rende il fallback più
   rapido ma scarta risposte lente.
3. Nuovo `LLM_RETRIES: intParam().default(3)` — commento: tentativi TOTALI per
   modello (1 richiesta + N-1 ritentativi su errore trasporto/HTTP); 1 =
   nessun retry.
4. Commenti di parametro (AGENTS.md §5) per tutti e tre.

→ Verify: `npm run test -- tests/unit/config.test.ts` verde con i nuovi casi
(Task 5).

### Task 2 — Client: failover + retry (`src/llm/openai-client.ts`)

1. `OpenAIClientParams`: `model: string` → `models: string[]` (commento: lista
   in ordine di priorità, primo = primario); nuovi `retries?: number` (default
   3) e `onModelTried?`; `timeoutMs` resta (default allineato a 15_000).
2. `chatCompletion`: doppio loop — per ogni modello, fino a `retries`
   tentativi (con `RETRY_DELAY_MS = 1000` tra i tentativi, solo se
   ritentabile); successo → `onModelTried(m, true)` e return; errore
   ritentabile → `onModelTried(m, false, status)` e retry; errore
   deterministico 4xx → esce dal loop del modello (failover); esauriti
   tentativi → modello successivo. Lista esaurita → `LLMError` aggregato (D5).
3. Helper privato per il corpo della richiesta (evita duplicazione nel loop).
4. Aggiornare i commenti di modulo (D3/D9: failover solo su LLMError, retry
   limitati, worst case latenza documentato).

→ Verify: nuovi test in `tests/unit/llm/openai-client.test.ts` (Task 4).

### Task 3 — Call-site: `email-wiring.ts` e `llm.ts`

1. `src/cli/email-wiring.ts:45-49`: `models: config.LLM_MODEL`,
   `timeoutMs: config.LLM_TIMEOUT_MS`, `retries: config.LLM_RETRIES` +
   `onModelTried` collegato a pino (es. `logger.info({ model, ok }, 'LLM
   attempt ...')`, inglese).
2. `src/cli/commands/llm.ts:57-61` e `:141-145`: stessi 3 parametri
   (`onModelTried` omesso, default no-op — lì non c'è logger).

→ Verify: `npm run typecheck` pulito.

### Task 4 — Test nuovi (failover + retry) in `openai-client.test.ts`

Helper `makeClient` aggiornato: `models: string[]`, `retries`, `timeoutMs`.
Casi:
1. primo modello risponde al 1° tentativo → **un solo** fetch, `body.model` =
   primo, testo restituito;
2. primo 429 → retry STESSO modello (fetch 2 con `body.model` invariato) →
   successo al 2° tentativo, testo restituito, `onModelTried` registra
   `[m1,false,429]`, `[m1,true,undefined]`;
3. 429 persistente per `retries` tentativi → failover al secondo modello
   (fetch con `body.model` = secondo);
4. errore di rete al 1° tentativo → retry stesso modello → successo;
5. timeout al 1° tentativo → retry stesso modello;
6. body non-JSON (200) → retry stesso modello (status assente = ritentabile);
7. 401 → NESSUN retry (un solo fetch per m1) → failover a m2;
8. tutti i modelli esauriti (2 modelli, retries 2) → `LLMError` aggregato:
   messaggio nomina modelli ed esiti, `status` = ultimo status valorizzato;
9. `retries: 1` → un solo tentativo per modello (comportamento di oggi);
10. lista di 1 modello → nessun failover (i test esistenti del contratto D3
    restano validi con `models: ['test-model']`, `retries: 1`);
11. `onModelTried` con sequenza completa multi-modello.

→ Verify: `npm run test -- tests/unit/llm/openai-client.test.ts` verde.

### Task 5 — Test esistenti aggiornati + non-regressione

1. `tests/unit/config.test.ts:39`: `toBe('gpt-4o-mini')` →
   `toEqual(['gpt-4o-mini'])`; nuovi casi: `'a'` → `['a']`;
   `'a, b ,c'` → `['a','b','c']`; `'a,,b'` → `['a','b']`; `'a,a,b'` →
   `['a','b']`; `''` e `',,'` → `ConfigError` nomina `LLM_MODEL`; default
   `LLM_TIMEOUT_MS` 15000 e `LLM_RETRIES` 3; conversioni string→number.
2. `tests/unit/llm/parser.test.ts` (righe 28 e 144) e
   `tests/unit/llm/generator.test.ts:40`: `model: 'm'` → `models: ['m']`
   (+ `retries: 1` per non cambiare il comportamento atteso).
3. **Non-regressione parser/generator**: un test per file con client
   `models: ['m1','m2']`, `retries: 1`: quando m1 risponde con contenuto
   valido (parser: JSON con team; generator: testo), m2 **non** viene mai
   chiamato. `null` del parser (es. `{"team": null}`) → un solo fetch, nessun
   secondo tentativo.

→ Verify: `npm run test` completo verde.

### Task 6 — Fix critico `markSeen` + test di regressione

1. `src/channel/email-adapter/imap-client.ts:80-81`: aggiungere
   `await conn.mailboxOpen('INBOX')` all'inizio di `markSeen(conn, uid)`
   (stesso pattern di `fetchUnseen`; il fake dei test ha già `mailboxOpen`).
2. Aggiornare gli assert esistenti: `tests/unit/channel/imap-client.test.ts`
   (sezione markSeen, righe ~61-108) e `tests/unit/channel/email-adapter.test.ts:137-142`
   — devono verificare la sequenza `mailboxOpen → messageFlagsSet` e che il
   flag sia richiesto dopo l'apertura della mailbox.
3. **Test di regressione per il bug reale**: fake con `mailboxOpen` che REGISTRA
   la chiamata; `markSeen` deve fallire/essere verificato solo dopo
   `mailboxOpen` — il test fallirebbe con l'implementazione attuale (STORE
   prima di SELECT), passando solo col fix.

→ Verify: `npm run test -- tests/unit/channel/imap-client.test.ts
tests/unit/channel/email-adapter.test.ts` verde; il nuovo test di regressione
fallisce senza il fix (verificare con `git stash`/revert temporaneo NON
richiesto: la sequenza assert è sufficiente).

### Task 7 — Docs e commenti

1. `.env.example:40-45`: commento `LLM_MODEL` aggiornato (lista separata da
   virgola, ordine = priorità, primo = primario; esempio con 2-3 modelli free)
   + nuove righe `LLM_TIMEOUT_MS=15000` e `LLM_RETRIES=3` con commenti
   (scopo, valori accettati, effetto).
2. `docs/POC/POC_LLD.md` §4.2: riga `LLM_MODEL` → "lista separata da virgola
   (failover in ordine di priorità)" + nota D3 (failover solo su errore di
   trasporto, mai su null) + **2 nuove righe**: `LLM_TIMEOUT_MS` (default
   15000) e `LLM_RETRIES` (default 3). Nota worst case latenza (2.4).
3. Commenti AGENTS.md §5: parametri in `config.ts`, file header del client,
   `imap-client.ts` (markSeen apre la mailbox).

→ Verify: `grep -E 'LLM_MODEL|LLM_TIMEOUT_MS|LLM_RETRIES' .env.example
docs/POC/POC_LLD.md src/config.ts` mostra la semantica aggiornata ovunque.

### Task 8 — Validazione completa (senza rete)

1. `npm run typecheck` e `npm run lint` puliti.
2. `npm run test` completo verde (261 esistenti + nuovi).

→ Verify: tutti i check verdi.

### Task 9 — Stress test reale completo (a valle dei Task 1–8)

Riprende la metodologia dello stress test di inizio sessione (piano
`1786793771358-email-llm-smoke-stress-test.md`), con le novità: lista
multi-modello attiva, timeout/retry configurati, `markSeen` fixato.

1. **Harness temporaneo** `smoke-send.mts` alla root del progetto (cancellato
   a fine test, D3): INVIO via nodemailer (host/porta/auth da `.env`, come
   `email-wiring.ts`) con `from` = display name inventato sull'indirizzo base
   (fallback D1: Gmail riscrive il From togliendo il plus-tag — verificato);
   IMAP per drain/cleanup (`mailboxOpen('INBOX')` → `search({seen:false})` →
   `messageFlagsSet(uid,['\\Seen'])`); parametri `--send-battery`, `--drain`,
   `--mark-all-seen`. Commenti espliciti (AGENTS.md §5), nessuna logica di
   gioco. NOTA: `node_modules` non si risolve da `/tmp/kilo` → harness alla
   root; `npm` richiede nvm (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`).
2. **Drain INBOX**: `--drain` → `channel:email:fetch` → 0 non lette.
3. **Batteria canale 20 email** (stessa tabella §6.1 del piano originale):
   invio reale via SMTP; verifica `channel:email:fetch --json`: 20/20
   ricevute, from/body/receivedAt coerenti (compilare la tabella di verifica).
4. **Batteria parser LLM multi-modello** (~16 invocazioni `llm:parse` con la
   lista di `LLM_MODEL`, pausa ~2 s tra le chiamate): registrare atteso vs
   reale; nei log `onModelTried` deve mostrare modello/tentativo usato; i 429
   del primo modello devono generare retry/failover e NON bloccare la batteria.
   Attenzione: `llm:parse` usa il DB di produzione per la lista squadre
   (`migrate()` = no-op idempotente, innocuo).
5. **Run `channel:email:process` su DB dedicato**: creare
   `DB_PATH=data/smoke-uat.db npm run cli -- db:migrate` (solo schema, vuoto);
   eseguire `DB_PATH=data/smoke-uat.db npm run cli -- channel:email:process`.
   Atteso: 20 messaggi `round_not_open`, `seen: true` **persistito** (fix
   Task 6), risposte reali via SMTP, batch NON fermato (retry/failover
   assorbono gli errori LLM). Dopo ~15 s: `channel:email:fetch` → le risposte
   del sistema risultano non lette, gli originali letti. Nessun errore LLM →
   nessuna risposta duplicata.
6. **Cleanup (D3)**: `--mark-all-seen` (marca lette TUTTE le residue, nessuna
   eliminazione); cancellare `data/smoke-uat.db` e `smoke-send.mts`; verifica
   finale `channel:email:fetch` → 0 non lette; `ls data/` senza `smoke-uat.db`.
7. **Report**: aggiornare `docs/uat/stress-test-report-2026-08-15.md` (o nuovo
   file datato) con: tabella ricezione 20/20, tabella parser atteso/reale con
   modello vincente per input, esiti run process (seen persistito, n. risposte,
   n. retry/failover osservati), osservazioni (latenze, 429, fallback).

→ Verify: checklist completa (probe → drain → 20/20 → parser → process →
cleanup → report); nessun file sorgente modificato oltre a quelli dei Task 1–8.

### Task 10 — Proposta `.env` e stato progetto

1. Proposta per `.env` (ordine per stabilità osservata 2026-08-15, l'utente
   decide): `LLM_MODEL=nvidia/nemotron-3-super-120b-a12b:free,
   google/gemma-4-26b-a4b-it:free,openai/gpt-oss-20b:free`;
   `LLM_TIMEOUT_MS=15000`; `LLM_RETRIES=3`. Note: `gemma-4-31b` (attuale) è
   quasi sempre 429 → metterlo in coda come fallback se lo si vuole tenere.
2. `agent-context/current-status.md`: bump `Last updated` + voce di changelog
   ISO-8601 UTC (failover multi-modello + timeout/retry configurabili, fix
   `markSeen`, stress test reale eseguito con esiti, decisioni D3/D8/D9,
   deviazione dal commento "nessun retry" del client).

→ Verify: changelog presente; `.env` coerente con la decisione utente.

## 5. Rischi e mitigazioni

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Tutti i modelli free 429 contemporaneamente | Batch fermato (D7) | Lista su pool upstream indipendenti (NVIDIA/Gemma/OpenAI); retry 3× con delay 1 s; probabilità bassa; retry al tick successivo |
| Latenza peggiore 3 modelli × 3 tentativi × 15 s = ~135 s/messaggio | Ritardo risposte | Fallimenti reali veloci (429/5xx); worst case documentato (2.4); `LLM_TIMEOUT_MS` abbassabile |
| Retry su 429 senza pausa tiene saturo il pool | Retry tutti falliti | `RETRY_DELAY_MS = 1000` tra i tentativi |
| Non-determinismo: quale modello risponde dipende dalla salute al momento | Esiti non uniformi nel tempo | D3: failover/retry solo su errore, mai su null; retry prima favoriscono il primario; documentato nel changelog |
| `markSeen` non persistito riappare | Risposte duplicate a ogni tick | Fix Task 6 + test di regressione sulla sequenza mailboxOpen→STORE; verifica nello stress test (originali letti, nessun duplicato) |
| Email residue in INBOX inquinano lo stress test | Batteria falsata | Drain preventivo (Task 9.2) e cleanup finale (Task 9.6) |
| Ordine della lista mal configurato (primo sempre giù) | Fallback sistematico | `onModelTried` nei log rende visibile modello/tentativo usato; ordine per stabilità |
| Dedup/trim sorprese (es. spazi) | Config inattesa | Zod normalizza e rifiuta liste vuote con ConfigError esplicito |
| Docs disallineate (LLD/.env.example) | Contratto ambiguo | Task 7 dedicato; commenti AGENTS.md §5 |

## 6. Fuori scope

- Fallback nativo OpenRouter (`models[]` + `route: 'fallback'`): non
  implementato (alternativa documentata, valutabile in futuro).
- Retry con backoff esponenziale/jitter o retry su 4xx deterministici: fuori
  (delay fisso semplice, D4).
- Cambio di nome delle env var (`LLM_MODEL`/`LLM_TIMEOUT_MS`/`LLM_RETRIES`
  restano) o di output CLI.
- Torneo avviato / date shiftate / scenari di gioco oltre `round_not_open`
  nello stress test (portata parziale, come da piano originale).
- Modifiche a `.env` di produzione: proposta in Task 10, decisione dell'utente.

## 7. Validazione complessiva

- [ ] `AppConfig.LLM_MODEL: string[]` con default `['gpt-4o-mini']`; liste
      vuote → ConfigError.
- [ ] `AppConfig.LLM_TIMEOUT_MS` default 15000; `LLM_RETRIES` default 3.
- [ ] Client: retry N sul modello corrente (solo errori ritentabili, delay
      1 s), poi failover in ordine di lista; 4xx deterministici → failover
      diretto; tutti esauriti → LLMError aggregato; nessun failover su
      risposta valida/null.
- [ ] Parser e Generator: firme/comportamento invariati; non-regressione
      verificata (un solo fetch quando il primo risponde).
- [ ] `markSeen` apre la mailbox prima del STORE; test di regressione verde.
- [ ] Call-site aggiornati (wiring con log pino `onModelTried`, CLI senza).
- [ ] typecheck, lint, test completi verdi (senza rete).
- [ ] Stress test reale: drain 0, 20/20 email, parser multi-modello con
      failover osservato, process 20× `round_not_open` + seen persistito +
      nessun duplicato, cleanup 0 non lette, report in `docs/uat/`.
- [ ] Docs (`.env.example`, LLD §4.2) e commenti coerenti con i 3 parametri.
- [ ] `current-status.md` aggiornato con changelog datato.
