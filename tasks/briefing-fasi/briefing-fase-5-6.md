# Briefing — Fase 5 "LLM Adapter" (Task 5.1–5.2) + Fase 6 "Channel Adapter" (Task 6.1–6.2)

> Documento di lavoro preparatorio per l'implementatore. Prodotto in modalità
> di sola lettura a partire da: `tasks/plan.md` (Task 5.1–5.2, 6.1–6.2,
> decisioni 1–12, requisiti ADR-008), `docs/POC/POC_LLD.md` (§1.2, §1.3, §4.2,
> §5, §6.2–6.5, §7.8–7.9, §8), `docs/POC/POC_PRD.md` (§4.1–4.5, §6, §7 RNF6,
> §8 CL1–CL18, §9 CS1/CS7, US1–US10, RF-07…31), `docs/POC/POC_HLD.md` (§5.2,
> §5.3, §6.1–6.4, §7.2–7.3), `docs/decisions/architecture-decisions.md`
> (ADR-001/002/004/008), stato reale di `src/` (interfacce `channel/adapter.ts`,
> `llm/generator.ts`, `game/context.ts`, `game/registration.ts`,
> `game/round-manager.ts`, `game/pick-processor.ts`, `config.ts`, `cli/`,
> `llm/team-aliases.md`) e `tests/` (fake in-memory, pattern).
>
> Obiettivo: elencare **solo** incongruenze, problemi e modifiche necessarie
> emerse dalla verifica di spec, così l'agente che implementa parte dal
> briefing senza rileggere tutto il materiale. **Testo di lavoro non
> autorevole**: i documenti progetto (LLD/PRD) restano la fonte per le
> decisioni; dove il briefing contesta una spec, il punto va risolto su
> `plan.md`/ADR/LLD **prima o durante** l'implementazione.
>
> **Stato:** analisi completata (2026-08-14) — le decisioni proposte (§0)
> vanno confermate dal PO prima dell'implementazione; non ci sono blocchi
> alla conferma.

---

## 0. Premessa — stato al Checkpoint 3 e decisioni proposte

Tutto ciò che le Fasi 5–6 consumeranno esiste già ed è testato al
Checkpoint 3 (168 test):

- **Interfacce (TIPI, nati nel Task 3.5):** `src/channel/adapter.ts`
  (`ChannelAdapter { fetchMessages(); sendMessage(to, body) }`,
  `IncomingMessage { from, channel, body, receivedAt }`) e
  `src/llm/generator.ts` (`EmailType` 11 valori, `EmailContext`,
  `LLMGenerator.generate(ctx): Promise<string>`). Mockate nei test del
  Game Engine; **nessuna implementazione concreta**.
- **Moduli di gioco già consumatori:** `round-manager.ts` (compone
  `EmailContext` con `tt`/`tc` da `turn.ts`, `availableTeams`, `deadline`,
  motivi; `notify()` no-op se `channel`/`generator` assenti), `registration.ts`
  (`openRegistration` invia `registration_open_invite`; `autoRegisterFromPick`
  riceve `ParsedPickContent | null`), `pick-processor.ts` (cascata con motivi
  `unknown_team` = check esatto post-parse, CL5).
- **Config completa** (`src/config.ts` + `.env.example`): `LLM_API_KEY`,
  `LLM_API_BASE_URL` (default `https://api.openai.com/v1`), `LLM_MODEL`
  (default `gpt-4o-mini`), `IMAP_*` (host/port/user/pass/poll), `SMTP_*`
  (host/port/user/pass). **Nessuna nuova env var per Fasi 5–6.**
- **`team-aliases.md` pronta** (20 nomi canonici API `name` + tabella alias,
  con test di coincidenza su `getTeams()`).
- **CLI:** pattern consolidato "il comando costruisce il contesto" (`getConfig()
  → createConnection → migrate → { db, dataProvider, config, now }` — vedi
  `cli/commands/tournament.ts`). **Nessun comando inietta ancora `channel`/
  `generator`** (verificato: il contesto CLI non li imposta).
- **Test:** fake `FakeChannel`/`FakeGenerator` in-memory già usati
  (`tests/integration/round-flow.test.ts`); provider reale su SQLite in-memory;
  `--json` e `.fail` puliti come contratto CLI.

**Decisioni proposte per la conferma del PO (2026-08-14):**

- **D1 — Subject dell'email.** `sendMessage(to, body)` non ha soggetto, ma SMTP
  e RF-25 (oggetto = forma compatta `TT2TC7`) lo richiedono. Proposta:
  estendere `ChannelAdapter.sendMessage(to, body, subject?)` e
  `EmailContext.subject?` (opzionali → nessuna rottura dei fake esistenti);
  il soggetto è composto **deterministicamente dal chiamante** con un helper
  `subjectFor(ctx)` nel modulo LLM (mai dall'LLM, mai numeri inventati).
- **D2 — Parser e lista canonica.** L'interfaccia LLD `extractPick(emailBody)`
  non trasporta la lista canonica né gli alias. Proposta: `extractPick(
  emailBody, { teams, aliases })` (iniettati per chiamata, data-driven);
  `PickExtraction` definita UNA volta in `src/llm/parser.ts` e riusata da
  `registration.ts` (rimozione del duplicato `ParsedPickContent`).
- **D3 — Errore di rete ≠ contenuto ambiguo.** LLD §6.2 "non lancia
  eccezioni" vale SOLO per il contenuto. Proposta: classe `LLMError`
  (trasporto/HTTP/timeout/formato inatteso); `null` SOLO per email ambigua o
  non riconducibile. Il wiring tratta `LLMError` come "non processato, resta
  non letto, retry al prossimo tick" (log warn).
- **D4 — TT/TC nei testi.** Proposta: template con segnaposto
  `{{TT_TC}}`/`{{TTTC}}` (mai numeri letterali nel prompt); dopo la
  generazione l'impl sostituisce deterministicamente `turnExtended(tt,tc)`
  (corpo) e `turnCompact` (soggetto) dai dati di `EmailContext`. L'LLM non
  genera mai numeri (ADR-004/RF-25); test che il testo contenga esattamente
  la coppia iniettata.
- **D5 — Un unico messaggio per l'auto-iscrizione (RF-27/CL2).** I tipi
  esistenti non coprono "iscrizione + esito pick" in un solo testo. Proposta:
  nuovo `EmailType 'auto_registered'` (benvenuto + esito del pick in un unico
  messaggio); in alternativa due email (`welcome` + `pick_confirmed`), che
  però viola "un unico messaggio" di RF-27/CL2. **Da confermare.**
- **D6 — Classificazione del Message Router.** Nessuna spec sul criterio.
  Proposta: mittente **noto** → pick; mittente **ignoto** → tenta il pick
  (Parser); se `null` e il corpo contiene intento di iscrizione (keyword
  esplicite, es. "iscriv", "partecipo", "vorrei giocare") → iscrizione;
  altrimenti → chiarimento (TT1) o rifiuto (TT2). Normalizzazione identità:
  `{channel:'email', identifier: <indirizzo minuscolo, senza nome visualizzato>}`.
- **D7 — Flag \Seen.** `channel:email:fetch` (sola lettura) non marca nulla;
  il processing segna `\Seen` SOLO a messaggio processato con successo; su
  errore resta non letto (retry al tick successivo). Duplicato da crash tra
  process e flag: accettato in POC (la logica di gioco resta idempotente:
  secondo process → `pick_already_exists` → risposta "già registrato").
- **D8 — "Round corrente" del wiring.** Proposta: il primo `round_state` con
  `status='open'` nella finestra `[start_round..N]` (stessa semantica di
  `tournament:status`); se nessuno → rifiuto `round_not_open` (CL3).
- **D9 — Formato date nei testi email.** Proposta: formato italiano
  (locale `it-IT`) con fuso fisso `Europe/Rome` (i `match_date` sono UTC;
  fuso fissato = determinismo, RNF1). Decisione minore, da documentare in LLD.

---

## 1. Problemi trasversali (vale per entrambe le fasi)

**A — Nuove dipendenze in `package.json`.**
Oggi le sole dipendenze sono `better-sqlite3`, `pino`, `yargs`, `zod`. La
Fase 6 richiede: `imapflow` (IMAP), `nodemailer` (SMTP), `mailparser`
(decodifica MIME del corpo: imapflow consegna il sorgente grezzo, non il
testo; `simpleParser` è il pattern standard) + `@types/nodemailer` (dev).
Tutte librerie pure JS: nessun `allowScripts` aggiuntivo, nessun impatto
build. **Da installare nel Task 6.1.**

**B — `sendMessage(to, body)` non trasporta il soggetto (D1).**
LLD §7.9 prevede `channel:email:send --subject` e RF-25 impone la forma
compatta `TT2TC7` nell'oggetto, ma l'interfaccia nata in Fase 3 ha solo
`(to, body)` e `LLMGenerator.generate(ctx): Promise<string>` restituisce
solo testo. **Modifica necessaria:** soggetto opzionale
(`sendMessage(to, body, subject?)` + `EmailContext.subject?`); chi compone
i contesti (Round Manager, Registration, wiring) calcola il soggetto con
l'helper deterministico `subjectFor(ctx)` (`src/llm/generator.ts`).
Compatibilità: i fake esistenti (metodo con 2 parametri) restano
assegnabili all'interfaccia estesa. Aggiornare i 2 punti che chiamano
`sendMessage` (`round-manager.ts` `notify`, `registration.ts`) e LLD §6.3/6.4.

**C — Chi valida l'output dell'LLM e dove sta il check post-parse.**
LLD §1.2 dice "Il formato di output è validato dal **Game Engine** con zod
prima di essere usato"; §6.2 dice "Output vincolato … ambiguo → `null`"
(senza soggetto). Il check deterministico esatto è già nel Pick Processor
(`unknown_team`, step 2 della cascata). **Proposta (D2):** la validazione
zod e il filtro "squadra fuori lista → null" vivono nel Parser (confine I/O,
ADR-004: nessun nome spuro esce dall'I/O); il check del Game Engine resta
come seconda barriera (difesa in profondità, documentata). Il test del piano
"risposta con squadra fuori lista → rifiutata dal check" si verifica a
entrambi i livelli (parser → null; wiring → rifiuto `unknown_team`).

**D — Contratto d'errore del Parser non definito (D3).**
"null su ambiguo/irriconoscibile, mai eccezioni" (plan) si scontra con la
rete: API giù, 429, timeout, body non-JSON non sono "ambiguità". Senza
contratto, il wiring non sa se ritentare o rispondere al giocatore.
**Proposta:** `LLMError` (nome, status, messaggio) per trasporto/HTTP/
timeout; `null` solo per contenuto; HLD §7.3 (fallback rimandato a
produzione) resta valido: in POC nessun retry automatico nel Parser (lo fa
il wiring a tick successivo, D7).

**E — Parser: la lista canonica e gli alias non sono nell'interfaccia (D2).**
LLD §6.2: "il prompt include … la lista canonica da
`SeasonDataProvider.getTeams()` + il contenuto di `team-aliases.md`", ma la
firma è `extractPick(emailBody)`. **Modifica necessaria:** portare
`{ teams, aliases }` nel contratto (per chiamata: l'import stagionale può
cambiare le squadre a metà torneo; la risorsa alias può essere editata a
mano senza ricompilare). Il file `team-aliases.md` si legge via
`new URL('./team-aliases.md', import.meta.url)` (indipendente dal cwd);
nota: il build `tsc` non copia asset `.md` → in POC si gira via `tsx`
(dalla root), documentarlo in LLD §5.

**F — Generatore: iniezione deterministica della coppia TT/TC (D4).**
LLD §1.2/§6.3 sono chiari sul *cosa* (mai numeri dall'LLM) ma non sul
*come*: se la coppia finisce nel prompt, l'LLM può alterarla (rischio
"TT3TC8" al posto di "TT2TC7"). **Proposta:** segnaposto nel template di
sistema (`{{TT_TC}}`), sostituzione post-generazione lato impl con
`turnExtended/turnCompact` (funzioni pure già in `src/game/turn.ts`).
Test (plan 5.2): il testo email contiene esattamente la coppia iniettata.
Nota: `EmailContext` implementato in Fase 3 non ha `round` (LLD §6.3 ne
elenca uno ridondante con `tc`): allineare il documento, non il codice.

**G — Messaggio unico auto-iscrizione (D5).**
RF-27/CL2: "un unico messaggio che unisce iscrizione ed esito del pick".
Gli 11 `EmailType` non lo coprono. **Proposta:** nuovo tipo
`auto_registered` con contesto esteso (team/outcome/valido+motivo). Da
aggiungere a `EmailType`, template, LLD §6.3 e ai test di
`registration.ts` (che oggi non notifica l'esito dell'auto-iscrizione:
verificare — l'invio dell'email combinata è del wiring 6.2).

**H — Classificazione del Message Router non specificata (D6).**
LLD §1.3 elenca i ruoli ma nessun criterio distingue "iscrizione" da
"pick" da "sconosciuto". **Proposta:** regola deterministica in
`message-router.ts` (mittente noto → pick; ignoto → pick-tentativo, poi
fallback keyword iscrizione, poi chiarimento/rifiuto). Il router NON
decide nulla di gioco (auto-iscrizione/rifiuti = Game Engine): produce
`{ kind, identity, body }` e il wiring 6.2 decide.

**I — "Round corrente" per il wiring (D8).**
`autoRegisterFromPick(ctx, identity, parsed, round, receivedAt)` e la
validazione pick richiedono un `round`: un'email in arrivo non lo
dichiara. **Proposta:** primo `round_state open` della finestra
(stessa query di `tournament:status`, `src/game/tournament.ts`); nessun
round aperto → rifiuto `round_not_open` (CL3) con notifica best-effort.

**J — Idempotenza del processing email (D7).**
Fetch → process → flag `\Seen` non è atomico. **Proposta:** flag solo a
successo; crash nel mezzo → messaggio riprocessato al tick successivo →
la logica di gioco è idempotente (motivo `pick_already_exists`/profilo
già esistente) e la risposta al giocatore è coerente ("già registrato").
Nessuna tabella di dedup (fuori scope POC, da dichiarare).

**K — Normalizzazione dell'identità email (D6).**
L'indirizzo va normalizzato prima di diventare `ExternalIdentity`
(identificatore univoco di `player.email`, RNF2): trim, minuscolo,
rimozione del nome visualizzato ("Mario Rossi <mario@x.it>" → "mario@x.it").
Gmail non distingue maiuscole; la spec non lo dice. **Proposta:** nel
router; `tournament:register` (CLI) applica la stessa normalizzazione
(reuse di una piccola funzione `normalizeEmail`).

**L — Fuso orario e formattazione date nei testi (D9).**
`matchDate`/`deadline` sono UTC; il testo italiano deve mostrare l'ora
locale (Serie A = Italia). **Proposta:** `Intl.DateTimeFormat('it-IT', {
timeZone: 'Europe/Rome', …})` — deterministico (RNF1), parametri di
formato documentati in LLD §6.3.

**M — La CLI deve iniettare le implementazioni reali.**
Oggi nessun comando imposta `ctx.channel`/`ctx.generator` (le email di
`round:open`/`round:close`/`round:score` sono no-op via CLI). In Fase 6 i
comandi che devono notificare (`round:*`, `tournament:register:*`) e i
nuovi `channel:email:*` costruiscono `EmailAdapter`+`LLMGenerator`+`Parser`
reali e li iniettano nel contesto (pattern esistente "la CLI inietta",
briefing Fase 3 §1-I). Proposta: helper condiviso
(`src/cli/email-wiring.ts` o estensione del `makeGameContext` esistente)
per evitare duplicazione tra comandi. Niente `getConfig()` nei moduli.

**N — Documentazione del codice (AGENTS.md rule 5).**
Header di file + commenti su funzioni/parametri per ogni file nuovo:
`src/llm/parser.ts`, `src/llm/templates.ts`, `src/llm/openai-client.ts` (o
equivalente), `src/channel/email-adapter/{index,imap-client,message-router,
smtp-client}.ts`, `src/cli/commands/llm.ts`, `src/cli/commands/channel.ts`,
`src/cli/email-wiring.ts`, test. Stesso standard delle Fasi 2–3.

**O — Registrazione CLI incrementale.**
`src/cli/index.ts` registra `llm:parse`, `llm:generate` (Fase 5) e
`channel:email:fetch`, `channel:email:process`, `channel:email:send`
(Fase 6) — file `cli/commands/llm.ts` e `cli/commands/channel.ts` secondo
il pattern yargs esistente (`.strict()`, `--json`, `.fail` pulito).

---

## 2. Task 5.1 — LLM Parser

Contenuto (plan + LLD §6.2): client API OpenAI-compatibile; prompt con
testo email + lista canonica `getTeams()` + contenuto di `team-aliases.md`;
output vincolato; `null` su ambiguo; check deterministico post-parse; comando
`llm:parse`.

**Decisioni/modifiche da fissare:**
1. **Interfaccia (D2/E):** `PickExtraction { team, outcome }` definita in
   `src/llm/parser.ts`; `LLMParser.extractPick(emailBody, { teams,
   aliases }): Promise<PickExtraction | null>` (aggiornare LLD §6.2).
   `registration.ts` sostituisce `ParsedPickContent` con `PickExtraction`
   (re-export per non rompere i test esistenti).
2. **Client HTTP:** fetch nativo (come `football-data-client.ts`, nessuna
   dipendenza): `POST {LLM_API_BASE_URL}/chat/completions`, header
   `Authorization: Bearer {LLM_API_KEY}`, `model: LLM_MODEL`,
   `temperature: 0` (determinismo), `response_format: {type:'json_object'}`
   (supportato dalla stragrande maggioranza degli endpoint OpenAI-
   compatibili; NIENTE `json_schema`: non ovunque supportato, la
   validazione zod basta), timeout massimo configurabile? (no: costante
   interna, es. 30s, documentata — nessuna env nuova).
3. **Prompt di sistema:** struttura fissa con: ruolo (estrai squadra+esito
   da email in italiano, rispondi SOLO con JSON), la lista canonica
   iniettata, il contenuto di `team-aliases.md` iniettato, istruzione
   "team DEVE essere esattamente uno dei nomi della lista; se ambiguo o
   assente → `{"team": null}`", istruzione "mai inventare nomi".
4. **Output e validazione (C/D):** `safeParse` zod di
   `{ team: string | null, outcome: 'win'|'draw'|'lose' | null }`; poi
   filtro deterministico: team non in lista → null (D2); outcome nullo o
   invalido → null. **Mai eccezioni per il contenuto**; `LLMError` per
   trasporto/HTTP/timeout/body malformato (D3).
5. **`llm:parse --input <text>`:** legge `getTeams()` dal DB (provider
   reale), legge `team-aliases.md` dal filesystem, chiama il parser,
   output JSON `{team, outcome}` o `{team: null}`. DB vuoto → lista vuota
   → esito null con messaggio chiaro.
6. **Verifica (plan):** contract test con fetch mockato: estrazione valida
   con nome canonico; squadra fuori lista → null (filtro deterministico);
   risposta ambigua (JSON `{"team": null}`) → null; output non-JSON/mal
   formato → null senza crash (CS7); 401/429/timeout → `LLMError` (nuovo
   caso, D3); prompt contiene lista e alias (assert sul body della richiesta).

---

## 3. Task 5.2 — LLM Generator + templates

Contenuto (plan + LLD §6.3): generator per gli 11 `EmailType`, testi in
italiano (RNF6), template di sistema statici (`src/llm/templates.ts`),
coppia TT/TC iniettata; comando `llm:generate`.

**Decisioni/modifiche da fissare:**
1. **Templates:** `templates.ts` = mappa `EmailType → string` (prompt di
   sistema + istruzioni sul tono e sull'uso dei campi contesto), in
   italiano, con **segnaposto `{{TT_TC}}`** per la coppia (D4). Niente
   numeri letterali, niente date letterali (D9).
2. **`LLMGenerator` concreta:** stessa chiamata API del Parser (client
   condiviso, D2 §2.2 — estrarre il client HTTP in un modulo comune
   `src/llm/openai-client.ts` usato da Parser e Generator); `generate(ctx)`
   → compone il prompt dal template + contesto serializzato, chiama l'API,
   **sostituisce `{{TT_TC}}`** nel testo ritornato con
   `turnExtended(ctx.tt, ctx.tc)` e compone il soggetto con
   `subjectFor(ctx)` (forma compatta, D1). Errore rete → `LLMError`
   (mai silenzioso: il chiamante decide se notificare).
3. **`subjectFor(ctx)`** in `generator.ts`: `"Survivor League — {etichetta
   tipo} {TT2TC7}"` (etichette per tipo, deterministiche; niente LLM).
4. **Contratto puro:** nessun accesso a DB/stato/`getConfig()` (il client
   è costruito dal chiamante/CLI); il modulo è testabile con HTTP mockato.
5. **`llm:generate --type <t> [--player-name] [--round/--tc/--tt]
   [--team] [--outcome] [--reason] [--deadline]`:** costruisce `EmailContext`
   da CLI (default: tt/tc assenti → `{{TT_TC}}` sostituito con "" o "—"?),
   stampa soggetto + corpo (LLD §7.8 da aggiornare: output soggetto+testo).
6. **Verifica (plan):** contract test per OGNI tipo (11): HTTP mockato,
   output in italiano, soggetto con forma compatta; test RF-25: la coppia
   nel testo deriva dai dati (iniezione deterministica, segnaposto
   sostituito); test che l'impl non legga DB (nessuna dipendenza).

---

## 4. Task 6.1 — EmailAdapter

Contenuto (plan + LLD §1.3, §6.4, §5): `src/channel/email-adapter/` con
`index.ts` (EmailAdapter), `imap-client.ts`, `message-router.ts`,
`smtp-client.ts`; `receivedAt` = internaldate; router con normalizzazione
identità; comandi `channel:email:fetch`/`send`.

**Decisioni/modifiche da fissare:**
1. **Dipendenze (A):** `npm i imapflow nodemailer mailparser` +
   `npm i -D @types/nodemailer`. `mailparser.simpleParser` per estrarre
   il testo (text/plain) dal sorgente grezzo di imapflow.
2. **Seam per i test (niente rete):** i client esportano funzioni che
   ricevono la connessione/il trasporto come parametro
   (es. `fetchUnseen(conn: ImapFlow)`, `sendMail(transport, opts)`); i
   test passano oggetti fake che imitano il sottoinsieme usato
   (type-level: `Pick<ImapFlow, ...>`). Il `Transport` nodemailer si
   costruisce dal chiamante (CLI), mai dentro il modulo.
3. **IMAP client:** connessione con `{host, port 993, secure: true,
   auth {user, pass}}` da config; `fetchUnseen` = messaggi senza flag
   `\Seen` (IMAP `seen:false`); `receivedAt` = `message.internalDate`
   (MAI l'header Date, ADR-001); corpo = `simpleParser(message.source).text`
   (fallback: soggetto se body vuoto); **non marca nulla** (D7). Errore di
   connessione → errore chiaro (es. `EmailAdapterError`) senza crash CLI.
4. **SMTP client:** `createTransport({host, port 587, secure: false,
   auth})` (STARTTLS default nodemailer su 587); `sendMail({from:
   SMTP_USER, to, subject, text})`; soggetto dal chiamante (D1).
5. **Message Router (D6/H):** funzione pura
   `classify(message: IncomingMessage, knownEmails: Set<string>)` →
   `{ kind: 'pick' | 'registration' | 'unknown', identity:
   ExternalIdentity, body }` con:
   - identità normalizzata `{channel:'email', identifier:
     normalizeEmail(from)}` (K);
   - mittente noto → `pick`;
   - mittente ignoto → `registration` se il corpo contiene keyword di
     iscrizione (lista costante documentata: "iscriv", "mi iscrivo",
     "partecipo", "vorrei giocare", "registr"), altrimenti `pick`
     (il wiring decide auto-iscrizione/chiarimento/rifiuto — mai il router).
   Nessuna logica di gioco nel router (LLD §1.3).
6. **`channel:email:fetch`:** connette, legge non lette, output JSON
   (from/channel/body/receivedAt), NON marca lette, idempotente.
7. **`channel:email:send --to --subject --body`:** helper test/debug
   (LLD §7.9), inietta SMTP dal config.
8. **Verifica (plan):** unit test del router (mittente noto/ignoto,
   keyword iscrizione, normalizzazione indirizzi con display name);
   integration test dei client con fake conn/transport (fetch restituisce
   internaldate, non Date header; send passa soggetto; errore connessione
   → errore chiaro). Gmail reale SOLO in UAT/CS1 (PRD §9).

---

## 5. Task 6.2 — `channel:email:process` (wiring end-to-end)

Contenuto (plan + PRD §4.1/4.3/HLD §6.1–6.2): fetch → router → iscrizione
/ pick con parse LLM, check esatto, auto-iscrizione RF-27, guard RF-31,
registrazione, conferma/rifiuto; CL2/CL5/RF-24; CS1 manuale prima del collaudo.

**Decisioni/modifiche da fissare:**
1. **Costruzione componenti (M):** `channel:email:process` e i comandi di
   gioco che notificano (`round:*`, `tournament:register:*`) usano
   l'helper condiviso per costruire `{ channel: EmailAdapter,
   generator: LLMGenerator, parser: LLMParser }` e iniettano nel
   `GameContext`. `teams = await dataProvider.getTeams()` e aliases
   letti UNA volta per batch di messaggi (non per messaggio).
2. **Flusso per messaggio (ricevuto → internaldate, D8):**
   - router classifica; `round = <primo round_state open della finestra>`;
     nessun round aperto → notifica `pick_rejected`/`registration_closed`
     (motivo `round_not_open`, CL3), messaggio NON segnato? → **decidere:**
     messaggi non processabili (round chiuso) vanno marcati letti per non
     ripetere il rifiuto a ogni tick (proposta: sì, D7 esteso).
   - **Iscrizione (mittente ignoto + keyword):** finestra `registration_open=1`
     → `checkEligibility` (loggata) → `registerPlayer` (riuso: accetta
     finestra aperta senza reason) → email `welcome` (formato pick e
     regole, coppia TT/TC). Finestra chiusa → email di rifiuto
     "torneo iniziato al TT 1 / TC n" (CL2/US8, RF-03).
   - **Pick da mittente noto:** `parser.extractPick(body, {teams, aliases})`
     → `null` → email `pick_rejected` (motivo "formato non riconosciuto,
     riprova" — CL5/CS7); altrimenti `registerPick` (cascata completa,
     guard RF-31) → ok: `pick_confirmed` (coppia TT/TC, squadra);
     rifiuto: `pick_rejected` con motivo esplicito (RF-09: si può
     riprovare).
   - **Pick da mittente ignoto (D5/D6):** se TT1 (round === start_round e
     finestra aperta): `null` → chiarimento senza profilo (CL5, email
     `pick_rejected` con istruzioni); `PickExtraction` →
     `autoRegisterFromPick(ctx, identity, parsed, round, receivedAt)` →
     ok → **`auto_registered`** (un unico messaggio, RF-27); ko → email
     con motivo (`pick_rejected`, nessun profilo). Dal TT2 (o finestra
     chiusa): rifiuto senza registrazione, messaggio "torneo iniziato al
     TT 1 / TC n" (RF-24, CL2).
   - **Mark seen (D7):** flag `\Seen` dopo il successo dell'intero
     processing del messaggio (tutte le email di risposta inviate).
3. **Errori non recuperabili per messaggio:** `LLMError`/errore rete → log
   warn, messaggio NON segnato letto, stop batch (retry al tick
   successivo). Nessun crash del comando (best-effort, RNF9).
4. **Verifica (plan):** integration e2e con adapter fake (scripted inbox:
   iscrizione, pick ok, pick rifiutato, sconosciuto TT1 interpretabile/non,
   sconosciuto TT2) e LLM mock (parser fisso); CS1 simulato (profilo
   completo via email); test CL2/CL5/RF-27/RF-24; guard RF-31 con
   `receivedAt` forzato; **verifica manuale CS1 con Gmail reale** prima
   del collaudo (PRD §13.2: serve l'account dedicato — domanda aperta).

---

## 6. Coerenze verificate (non-problemi)

- **Config completa** per Fasi 5–6: `LLM_API_*`, `IMAP_*`, `SMTP_*` già in
  `config.ts` e `.env.example` (obbligatorie dove serve) — nessun task di
  config.
- **Nessuna nuova tabella/migrazione:** il processing email non aggiunge
  stato (i flag IMAP non sono dati di gioco; l'idempotenza si appoggia ai
  vincoli esistenti, D7).
- **Interfacce già esistenti** (`ChannelAdapter`, `LLMGenerator`,
  `EmailContext`, `IncomingMessage`, `ExternalIdentity`): le Fasi 5–6 le
  IMPLEMENTANO; le estensioni D1/D2/D5 sono additive (parametri opzionali)
  o aggiunte di tipi nuovi, con aggiornamento dei 2 call-site esistenti.
- **Separazione di responsabilità** (AGENTS.md §1.3/ADR-004): il wiring
  chiama i moduli di gioco esistenti (pick-processor, registration,
  eligibility) senza duplicarne la logica; canale e LLM restano ai
  confini, mockati nei test del Game Engine.
- **Determinismo**: temperature 0, lista canonica iniettata, segnaposto
  TT/TC, fuso fisso — coerente con RNF1/RNF7.
- **Test pattern esistenti riusabili:** fake `FakeChannel`/`FakeGenerator`
  (round-flow), fixture stagione, provider reale in-memory; i contract
  test LLM seguono il pattern del fetch mockato di `football-data-client`.

---

## 7. Correzioni ai documenti da applicare in itinere

| File | Modifica |
|------|----------|
| `docs/POC/POC_LLD.md` §6.2 | Interfaccia Parser con `{ teams, aliases }` per chiamata; `PickExtraction` in `src/llm/parser.ts`; errore rete (`LLMError`) ≠ null; filtro esatto nel Parser + check Game Engine (doppia barriera); §1.2 "validato dal Game Engine" → "validato dal Parser (zod) e dal Game Engine (exact match)" |
| `docs/POC/POC_LLD.md` §6.3 | `EmailContext.subject?`; rimuovere `round` (ridondante con `tc`); segnaposto `{{TT_TC}}` con sostituzione deterministica; fuso `Europe/Rome` e formato it-IT (D9); nuovo `EmailType 'auto_registered'` (D5) |
| `docs/POC/POC_LLD.md` §6.4 | `sendMessage(to, body, subject?)`; semantica flag `\Seen` (fetch non marca; process marca a successo — D7) |
| `docs/POC/POC_LLD.md` §1.3 | Criteri di classificazione del Message Router (D6); normalizzazione identità (K); "round corrente" del wiring (D8) |
| `docs/POC/POC_LLD.md` §7.8 | `llm:generate` output = soggetto + corpo; `llm:parse` con lista da DB e alias file |
| `docs/POC/POC_LLD.md` §5 | Aggiornare l'albero: `parser.ts`, `templates.ts`, `openai-client.ts`, `email-adapter/*`, `cli/commands/llm.ts`, `cli/commands/channel.ts`, `cli/email-wiring.ts`; nota asset `.md` non copiato dal build (POC via tsx) |
| `docs/POC/POC_LLD.md` §2 | Aggiungere `imapflow`, `nodemailer`, `mailparser` allo stack |
| `tasks/plan.md` Task 5.1/5.2/6.1/6.2 | Decisioni D1–D9: subject, interfaccia parser, LLMError, segnaposto TT/TC, `auto_registered`, classificazione router, flag Seen, round corrente, fuso orario |
| `docs/POC/POC_PRD.md` §4.1/§8 CL2 | "Un unico messaggio" RF-27: riferimento al nuovo tipo email `auto_registered` (D5) |
| `AGENTS.md` §1.7 | Aggiornare lo "Stato attuale" al completamento di Fase 5 + Fase 6 (Checkpoint 4: 5.1/5.2/6.1/6.2) |

---

## 8. Ordine di esecuzione e dipendenze

```
D1/D2/D3/D4 (decisioni su interfacce, PRIMA)
  → 5.1 parser (D2/D3/E)
  → 5.2 generator+templates (D1/D4/D9)      ∥ 6.1 email-adapter (A/B/D6/K) — indipendenti
  → 6.2 channel:email:process (D5/D7/D8/M) — dipende da 5.1, 5.2, 6.1, 4.2
  → check: typecheck/lint/test verdi + aggiornamento CLI round/tournament
    (iniezione reale) + verifica manuale CS1 (Gmail reale, PRD §13.2 — da
    pianificare col commissioner)
```

Parallelismo reale solo tra 5.1, 5.2 e 6.1 (dopo aver fissato D1–D4).
Il Checkpoint 4 (Fase 5+6) non è nel piano come checkpoint numerato: l'uscita
dalla fase = `npm run typecheck`/`lint`/`test` verdi + contract test LLM
(CS7) + e2e simulato CS1 con fake + CS1 manuale pianificato come UAT
(account Gmail dedicato — domanda aperta PRD §13.2).

---

## 9. Prompt pronti per l'agente implementatore

Prompt di base (da precorrere con qualunque task delle Fasi 5–6):
> Implementa il task <n> delle Fasi 5–6 del piano (`tasks/plan.md`) seguendo
> **prioritariamente** il briefing `tasks/briefing-fasi/briefing-fase-5-6.md` (decisioni
> D1–D9 e sezioni 2–5) e le sezioni LLD/PRD ivi citate come autorità. Prima
> di scrivere codice: (1) applica le correzioni di spec della tabella §7 ai
> documenti (LLD/plan/PRD) nello stesso lavoro, (2) applica AGENTS.md rule 5
> (header file e commenti funzioni/parametri), (3) scrivi prima i test (TDD)
> su SQLite in-memory con `DbSeasonDataProvider` reale + fixture, mockando
> SOLO i confini esterni (HTTP LLM con fetch mockato, conn/transport
> IMAP/SMTP fake, parser/generator fake nei test del wiring), (4) verifica
> con `npm run typecheck`, `npm run lint`, `npm test`.
> Vincoli: niente `getConfig()` nei moduli (la CLI inietta); il Parser e il
> Generator non accedono mai a DB/stato di gioco (ADR-004); i numeri TT/TC
> entrano nei testi SOLO per iniezione deterministica (segnaposto, RF-25);
> `receivedAt` = internaldate IMAP, mai header Date (ADR-001); il router
> classifica ma non decide nulla di gioco; nessuna nuova env var.

Per task specifico:
- **5.1**: §2 del briefing (interfaccia con teams/aliases, LLMError, filtro
  esatto, `llm:parse`, contract test con fetch mockato).
- **5.2**: §3 (templates statici, `subjectFor`, segnaposto TT/TC, 11 contract
  test, `llm:generate`).
- **6.1**: §4 (dipendenze nuove, seam conn/transport, router con
  normalizzazione, `channel:email:fetch`/`send`).
- **6.2**: §5 (wiring completo, iniezione nei comandi `round:*`/
  `tournament:*`, CL2/CL5/RF-24/RF-27, CS1 simulato; verifica manuale CS1
  con Gmail reale pianificata come UAT).
