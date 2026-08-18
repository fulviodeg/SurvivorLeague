# Report — Stress test reale (I/O) di Email Adapter e LLM Parser + selezione modello LLM gratuito

> **Data:** 2026-08-15
> **Ambiente:** Gmail reale (survivorleague755@gmail.com) + OpenRouter
> (`nemotron-3-ultra-550b-a55b:free`), Node v24.19.0.
> **Esito complessivo:** Task 1–5 e 7 completati; **Task 6 interrotto** — trovato
> un **bug critico in `markSeen`** (flag `\Seen` mai persistito) e confermata
> l'instabilità del modello LLM free. In appendice: ricerca online sui modelli
> LLM gratuiti e raccomandazione del modello ideale per il progetto.
> **File:** report definitivo in `docs/uat/` (questo file); nessun file sorgente
> modificato; `agent-context/current-status.md` aggiornato.

---

## 1. Contesto e obiettivo

I test di unità di `EmailAdapter` (smtp/imap-client) e `OpenAIParser` sono verdi
ma usano fake ai confini. Lo stress test ha esercitato i componenti "dal vivo":
~20 email reali via Gmail SMTP/IMAP con mittenti inventati, una batteria di
parsing con il modello LLM reale (OpenRouter) e una run di
`channel:email:process` su DB dedicato (portata parziale: nessun torneo →
risposte `round_not_open`).

## 2. Esito sonda From plus-addressing (Task 1)

- **Accettata, ma riscritta da Gmail**: il From con plus-addressing viene
  consegnato senza il tag. Header grezzo verificato via IMAP:
  `From: Mario Rossi <survivorleague755@gmail.com>` (display name preservato,
  `+mario.rossi` rimosso).
- **Conseguenza**: applicato il **fallback D1** — solo display name inventato
  sull'indirizzo base. Gli scenari di identità distinte (auto-registrazione
  RF-27 con più giocatori) non sono copribili dal vivo con plus-addressing.

## 3. Drain INBOX (Task 2)

Marcate lette 4 email residue (notifiche Google UID 1–3 + sonda UID 5).
Verifica: `channel:email:fetch` → 0 non lette.

## 4. Batteria canale (Task 3–4): 20/20 OK

| # | UID | Da (fallback D1) | ricevuta (internaldate) | prima riga corpo | Esito |
|---|---|---|---|---|---|
| 1 | 6 | "Mario Rossi" <survivorleague755@gmail.com> | 2026-08-15T12:06:36Z | scelgo l'Atalanta, vince | OK |
| 2 | 7 | "Giulia Bianchi" <...> | 12:06:43Z | scelgo la Juventus, vince | OK |
| 3 | 8 | "Luca Verdi" <...> | 12:06:47Z | scelgo la Roma: vince (due punti) | OK |
| 4 | 9 | "Anna Neri" <...> | 12:06:51Z | Ciao! Scelgo l'Atalanta... 🏆 | OK (699 char, emoji e più righe integre) |
| 5 | 10 | "Paolo Gialli" <...> | 12:06:55Z | `<b>Milan</b> pareggia (HTML nel corpo)` | OK (ricevuto come testo) |
| 6 | 11 | "Chiara Blu" <...> | 12:06:59Z | `> scelgo l'Inter, perde (stile citazione)` | OK |
| 7 | 12 | "Mario Rossi" <...> | 12:07:04Z | scelgo il Napoli, vince | OK (soggetto 150+ char) |
| 8 | 13 | "Giulia Bianchi" <...> | 12:07:08Z | il Napoli pareggia | OK (accenti à è ì ò ù) |
| 9 | 14 | "Luca Verdi" <...> | 12:07:12Z | Solo soggetto (corpo vuoto) | OK — anomalia attesa: body = fallback soggetto |
| 10 | 15 | "Anna Neri" <...> | 12:07:16Z | corpo con tabulazioni: | OK (tab e spazi multipli integri) |
| 11 | 16 | "Paolo Gialli" <...> | 12:07:20Z | vado su https://example.com e scelgo il Bologna, vince | OK |
| 12 | 17 | "Chiara Blu" <...> | 12:07:24Z | SCELGO LA LAZIO, VINCE | OK |
| 13 | 18 | "Mario Rossi" <...> | 12:07:29Z | Riga uno | OK (più righe, indentazione, tab) |
| 14 | 19 | "Giulia Bianchi" <...> | 12:07:34Z | 1 | OK |
| 15 | 20 | "Luca Verdi" <...> | 12:07:39Z | vorrei iscrivermi al torneo | OK |
| 16 | 21 | "Anna Neri" <...> | 12:07:42Z | scelgo la Juventus, vince (stessa squadra di #2) | OK |
| 17 | 22 | "Paolo Gialli" <...> | 12:07:47Z | PSG, vince (squadra fuori lista) | OK |
| 18 | 23 | "Chiara Blu" <...> | 12:07:51Z | Juventus vince, Inter pareggia (due pronostici) | OK |
| 19 | 24 | "Mario Rossi" <...> | 12:07:55Z | scelgo il Como, pareggia | OK |
| 20 | 25 | "Giulia Bianchi" <...> | 12:07:58Z | (vuoto) | OK — anomalia attesa: corpo e soggetto assenti |

Latenza invio→ricezione osservata: ~4–5 s (inferiore alle 15–20 s attese).

## 5. Batteria parser LLM (Task 5): 14/16 attese

16 invocazioni `llm:parse --json` con modello reale. Tabella atteso/reale:

| # | Input | Atteso | Reale | Esito |
|---|---|---|---|---|
| 1 | scelgo la Juventus, vince | Juventus FC / win | Juventus FC / win | OK |
| 2 | Inter vince | FC Internazionale Milano / win | FC Internazionale Milano / win | OK |
| 3 | Milan pareggia | AC Milan / draw | AC Milan / draw | OK |
| 4 | Roma perde | AS Roma / lose | AS Roma / lose | OK |
| 5 | Atalanta, pareggio | Atalanta BC / draw | Atalanta BC / draw | OK |
| 6 | vincono i giallorossi | AS Roma / win | AS Roma / win | OK (alias) |
| 7 | i bianconeri vinceranno | Juventus FC / win | Juventus FC / win | OK (alias) |
| 8 | nerazzurri, X | FC Internazionale Milano / draw | FC Internazionale Milano / draw | OK (alias) |
| 9 | Napoli 1 | SSC Napoli / win | SSC Napoli / win | OK |
| 10 | Lazio, 2 | SS Lazio / lose | `null` | **MISMATCH** (deterministico su retry) |
| 11 | la squadra che vince stasera | null | null | OK |
| 12 | ciao come stai? | null | null | OK |
| 13 | PSG, vince | null | null | OK |
| 14 | Juventus vince, Inter pareggia | un solo pick | `null` | **MISMATCH informativo** (deterministico su retry) |
| 15 | vorrei iscrivermi | null | null | OK |
| 16 | juve vince!! | Juventus FC / win | Juventus FC / win | OK (alias minuscolo) |

Note: #10 "Lazio, 2" → il modello non interpreta "2" come esito (ambiguo);
#14 doppio pronostico → `null` invece del primo pick valido (informativo,
piano §6.3). 3 chiamate iniziali fallite per rate-limit del modello free,
riuscite al retry; una chiamata (#14) ha superato 120 s di timeout una volta.

## 6. Task 6 — Run `channel:email:process` (INTERROTTO)

- Creato DB di collaudo `data/smoke-uat.db` (schema-only, `db:migrate`).
- **Run 1**: 3 messaggi → 2 `round_not_open` + `seen: true`, batch FERMATO su
  `LLMError` al 3° messaggio ("Body JSON malformato nella risposta dell'API LLM").
- **Run 2**: gli STESSI 2 messaggi (UID 6, 7) sono stati riprocessati → i flag
  `\Seen` **non erano stati persistiti** nonostante `seen: true` nell'output.
- Run successive (9 tentativi): batch sempre fermato su `LLMError` in punti
  casuali ("Risposta dell'API LLM senza choices[0].message.content testuale").
  A ogni run i messaggi venivano riprocessati e **risposte duplicate reinviate**
  → la casella è cresciuta da 20 a 55 non lette.

### 6.1 Bug critico trovato: `markSeen` non persiste il flag \Seen

- Punto: `src/channel/email-adapter/imap-client.ts:80-81` — `markSeen` chiama
  `conn.messageFlagsSet(uid, ['\Seen'], { uid: true })` **senza aprire la
  mailbox** prima. Il handler STORE di imapflow
  (`node_modules/imapflow/lib/commands/store.js:20`) con
  `connection.state !== SELECTED` ritorna `false` **silenziosamente** (nessun
  errore, nessun flag impostato).
- `EmailAdapter.markSeen` (src/channel/email-adapter/index.ts:96-111) crea una
  nuova connessione per ogni chiamata e non passa da `mailboxOpen` → in
  produzione il flag non viene mai impostato, pur loggando successo (D7).
- I test unitari usano fake della connessione IMAP che simulano
  `messageFlagsSet` senza stato mailbox → il bug non è coperto dai test.
- **Impatto (CRITICO)**: a ogni `scheduler:tick` i messaggi già processati
  vengono riprocessati e le risposte vengono reinviate (duplicati per i
  giocatori). Questo spiega la crescita 20 → 55 email non lette durante il test.

### 6.2 Instabilità del modello LLM free

Il modello `nemotron-3-ultra-550b-a55b:free` restituisce spesso risposte senza
`choices[0].message.content` testuale o con JSON malformato, con latenze molto
variabili (fino a >120 s). Il batch si ferma su `LLMError` (comportamento D7
corretto: retry al tick successivo), ma con 20 messaggi e risposte dal
generator reale la probabilità di completare una run è bassa. Nota tecnica:
l'API OpenRouter dichiara per questo modello `supported_parameters` **senza**
`response_format` (`json_object: false`) — non adatto al contratto del Parser
(§A.3).

## 7. Cleanup (Task 7) — completato

55 email marcate lette (nessuna eliminazione, D3); eliminati
`data/smoke-uat.db` e `smoke-send.mts`; verifica finale: 0 non lette.

---

## A. Ricerca online: modelli LLM gratuiti (2026-08-15)

### A.1 Metodologia e fonti

Ricerca effettuata via API e pagine pubbliche al 15/08/2026: catalogo OpenRouter
(`GET /api/v1/models`, 413 modelli, di cui **19 a prezzo 0**), documentazione
GroqCloud, Cloudflare Workers AI (catalogo modelli, 83 voci), NVIDIA NIM
(build.nvidia.com), Google AI Studio/Gemini API, Mistral. Sono stati esclusi i
modelli con tier free solo promozionale/crediti iniziali (non "gratuiti" in
modo stabile).

### A.2 Modelli gratuiti su OpenRouter (pricing prompt = completion = 0)

| Modello (id) | Casa | Dimensioni | Contest | `response_format` (json_object) |
|---|---|---|---|---|
| `google/gemma-4-31b-it:free` | Google DeepMind | 30.7B dense, 140+ lingue | 262K | **Sì** |
| `google/gemma-4-26b-a4b-it:free` | Google DeepMind | 26B MoE (3.8B attivi) | 262K | **Sì** |
| `openai/gpt-oss-20b:free` | OpenAI | 21B MoE (3.6B attivi), Apache 2.0 | 131K | **Sì** |
| `nvidia/nemotron-3-super-120b-a12b:free` | NVIDIA | 120B MoE (12B attivi) | 262K | **Sì** |
| `nvidia/nemotron-nano-9b-v2:free` | NVIDIA | 9B | 128K | **Sì** |
| `dots-studio/dots-3-note-preview:free` | Dots Studio | 280B MoE (16B attivi) | 512K | Sì |
| `liquid/lfm-2.5-2.6b:free` | Liquid AI | 2.6B | 128K | Sì |
| `nvidia/nemotron-3.5-lightning:free` | NVIDIA | 30B MoE (3B attivi) | 1M | **No** |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | NVIDIA | 550B MoE (55B attivi) | 1M | **No** (attuale in `.env`) |
| `nvidia/nemotron-3-nano-30b-a3b:free` | NVIDIA | 30B MoE (3B attivi) | 256K | **No** |
| `nvidia/nemotron-nano-12b-v2-vl:free` | NVIDIA | 12B (multimodale) | 128K | **No** |
| `poolside/laguna-s-2.1:free` | Poolside | 118B MoE (8B attivi) | 262K | **No** (coding) |
| `poolside/laguna-xs-2.1:free` | Poolside | 33B MoE | 262K | **No** (coding) |
| `cohere/north-mini-code:free` | Cohere | 30B MoE (3B attivi) | 256K | **No** (coding) |
| `openrouter/free` | OpenRouter | router su free | 200K | Sì (varia per modello) |

Altri free ma non adatti (content-safety/guardrail, embedding, TTS, ecc.):
`nvidia/nemotron-3.5-content-safety:free`, `google/lyria-3-*` (musica).

### A.3 Requisiti del progetto per il modello (da HLD §7.3, LLD §4.2/§6.2-6.3 e sessione)

1. **Endpoint OpenAI-compatibile** (`POST {base}/chat/completions`) — unico
   contratto del client (src/llm/openai-client.ts).
2. **`response_format: {type: 'json_object'}` obbligatorio** per il Parser
   (LLD §6.2): il modello DEVE dichiarare supporto; i fallimenti di JSON
   malformato del modello attuale ne sono la prova.
3. **`temperature: 0`** (RNF1/RNF7: determinismo) — supportato da tutti.
4. **Italiano** di buona qualità: parser su email italiane (nomi squadre +
   alias) e generator di email in italiano; più lingue (140+) è un plus.
5. **Affidabilità e latenza** ragionevole entro il timeout di 30 s del client;
   volume trascurabile (polling 1 min), ma senza fallback in POC (rischio R1 →
   mitigato in produzione) quindi il modello deve rispondere in modo stabile.
6. **Gratuito** e con **adozione sufficiente** (richiesta utente).

### A.4 Modelli gratis "blasonati" fuori OpenRouter (per completezza)

| Piattaforma | Offerta gratuita stabile | Note |
|---|---|---|
| Google AI Studio / Gemini API | Tier free con rate limit (RPM/TPM giornalieri) | Endpoint OpenAI-compatibile; richiede cambio `LLM_API_BASE_URL`/`LLM_API_KEY` |
| Cloudflare Workers AI | ~10.000 neuroni/giorno free, include Llama 4 Scout, Gemma 4, GPT-OSS | API non OpenAI-compatibile nativamente; limite neuroni troppo basso per un batch di 20 risposte |
| NVIDIA NIM (build.nvidia.com) | Crediti free all'iscrizione | Promozionale, non stabile per produzione |
| GroqCloud | Nessun modello più gratuito (solo crediti) | Llama/GPT-OSS a pagamento |
| GitHub Models | **Ritirato il 30/07/2026** | Non più disponibile |

---

## B. Analisi: quale modello LLM gratuito è l'ideale per il progetto

### B.1 Candidati validi (gratis + json_object + OpenAI-compatibile + blasonati)

1. **`google/gemma-4-31b-it:free`** — Google DeepMind, 31B dense, 262K contest,
   140+ lingue (italiano incluso), Apache 2.0, strong su instruction following
   e reasoning. Famiglia Gemma: larghissima adozione (HuggingFace, Cloudflare
   Workers AI, NVIDIA NIM, OpenRouter) e base di numerosi fine-tune NVIDIA.
2. **`openai/gpt-oss-20b:free`** — primo modello open-weight di OpenAI (ago
   2025), 21B MoE, Apache 2.0; adozione altissima (top HF al rilascio,
   presente su Groq, Cloudflare, NVIDIA). Nome blasonato.
3. **`nvidia/nemotron-3-super-120b-a12b:free`** — NVIDIA, 120B MoE (12B attivi),
   hybrid, 262K; continuazione della famiglia Nemotron già in uso nel progetto
   (venditore attuale), con supporto `json_object` (a differenza di Ultra).
4. **`google/gemma-4-26b-a4b-it:free`** — variante MoE efficiente della stessa
   famiglia (3.8B attivi): più economica/latente, stessa qualità per task
   semplici.

### B.2 Confronto con i requisiti

| Requisito | Gemma 4 31B | GPT-OSS 20B | Nemotron 3 Super 120B | Nemotron 3 Ultra (attuale) |
|---|---|---|---|---|
| OpenAI-compatibile | Sì | Sì | Sì | Sì |
| `json_object` | **Sì** | **Sì** | **Sì** | **No** ✗ |
| Italiano (140+ lingue) | Eccellente | Buono | Buono | Buono |
| Affidabilità free | Migliore (modello stabile, adozione massiccia) | Molto buona | Buona | **Instabile (verificato)** |
| Adozione | Altissima (Google/Gemma) | Altissima (OpenAI) | Alta (NVIDIA) | Alta |
| Cambio `.env` | Solo `LLM_MODEL` | Solo `LLM_MODEL` | Solo `LLM_MODEL` | — |

### B.3 Raccomandazione

**Modello ideale: `google/gemma-4-31b-it:free`** (via OpenRouter, stessa
`LLM_API_BASE_URL`/`LLM_API_KEY`).

Motivi:
- soddisfa il requisito **bloccante** del Parser (`response_format:
  json_object`), assente sul modello attuale;
- qualità molto alta per istruzioni, testo italiano (email generator) e
  estrazione da linguaggio naturale (parser);
- nome blasonato (Google DeepMind) con **adozione tra le più ampie** del mondo
  open-weight: disponibile anche su Cloudflare Workers AI, NVIDIA NIM e
  HuggingFace — riduce il rischio di deprecazione improvvisa del tier free;
- cambio minimale: una sola variabile in `.env` (`LLM_MODEL`), nessuna modifica
  al codice (ADR-004 rispettato: il modello è configurabile da env).

**Alternativa secondaria:** `openai/gpt-oss-20b:free` (stesso livello di
adozione, più leggero) o `nvidia/nemotron-3-super-120b-a12b:free` (se si vuole
restare sulla famiglia NVIDIA).

**Da evitare:** `nemotron-3-ultra-550b-a55b:free` (attuale: nessun
`json_object`, instabilità verificata in questa sessione); modelli coding-only
(Poolside, Cohere North); `openrouter/free` (router casuale → non
deterministico, viola RNF1).

**Nota di prudenza:** i tier free di OpenRouter sono comunque soggetti a
rate-limit e possono cambiare nel tempo; il piano HLD §7.3 rimanda il fallback
(parser regex + template + retry) alla produzione (rischio R1). Se la stabilità
dovesse restare insufficiente anche con Gemma 4 31B, l'alternativa è il tier
free di Google Gemini API (cambio di base URL + chiave).

---

## C. Validazione rispetto al piano (§5)

| Criterio | Esito |
|---|---|
| Probe From plus-addressing | Accettato ma RISCRITTO → fallback D1 documentato |
| INBOX drenata prima della batteria | OK (0 non lette) |
| 20/20 inviate e 20/20 ricevute coerenti | OK (tabella §4) |
| ~16 parse LLM, attesi/reali confrontati | OK (14/16; 2 mismatch informativi §5) |
| `channel:email:process`: 20× round_not_open, seen, risposte reali | **NO — batch fermato su LLMError; `seen` non persistito (bug `markSeen`)** |
| Cleanup: 0 non lette, DB e harness eliminati | OK |
| `current-status.md` aggiornato, nessun file sorgente modificato | OK |

## D. Raccomandazioni operative

1. **Fix critico richiesto:** `markSeen` deve aprire la mailbox INBOX prima di
   `messageFlagsSet` (es. `mailboxOpen('INBOX')` o `getMailboxLock`). Da
   correggere in `imap-client.ts` + `EmailAdapter.markSeen`, con test di
   regressione sul flag reale (connessione vera o fake con stato mailbox).
2. **Cambio modello in `.env`:** `LLM_MODEL=google/gemma-4-31b-it:free` (o
   alternativa §B.3) e riprovare la batteria parser + una run
   `channel:email:process`.
3. Gmail riscrive il From eliminando il plus-tag: le identità distinte via
   plus-addressing non sono testabili dal vivo; valutare più caselle o label
   Gmail per scenari multi-identità.
4. `channel:email:fetch` idempotente e senza flag (D7): confermato.
