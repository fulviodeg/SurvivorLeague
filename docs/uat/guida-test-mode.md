# Survivor League — Guida operativa del Test Mode (UAT)

> **Ruolo del documento.** Questo è il "libretto di istruzioni" della
> **modalità test** (TEST MODE) di Survivor League: spiega a che cosa serve,
> come si attiva, come si usa passo per passo e come si spegne, con esempi di
> comandi pronti da copiare e incollare nel terminale. È il riferimento
> durevole per **amministratori, Product Owner e operatori** (persone con una
> media confidenza con il linguaggio tecnico, **non sviluppatori**) e per gli
> agenti automatici.
>
> **Principio fondamentale.** La guida descrive l'implementazione **reale** del
> sistema: ogni comando, opzione, parametro e messaggio citato esiste davvero
> con quel nome. Niente nomi inventati, niente esempi teorici non eseguibili.
> I messaggi di log e i banner citati sono riportati **testualmente in
> inglese**, così come li stampa il sistema (vincolo di progetto); il testo
> esplicativo è in italiano.
>
> **Niente segreti.** Questa guida non contiene mai password, chiavi API o
> credenziali: si riferisce al file `.env.uat` (che contiene i segreti ed è
> escluso dal versionamento) senza mai riportarne il contenuto sensibile.
>
> **Scope.** La guida copre l'uso del test mode per **User Acceptance Test
> (UAT)** con giocatori veri su calendario sintetico, e descrive anche
> l'**aggancio asincrono del torneo** a un turno di campionato diverso dal
> primo (ADR-008, RF-20…31) come **funzionalità di sistema** collaudabile in
> test mode (vedi §5.4 e il glossario). L'esecuzione di una specifica
> campagna UAT (date, partecipanti, checklist di accettazione) è oggetto di
> pianificazione dedicata; questa guida è il manuale operativo di riferimento
> per qualunque sessione.

---

## A chi è rivolta e assunzione dei giocatori di TEST

La guida presume che a collaudare il sistema siano **giocatori di TEST**:
persone consapevoli di partecipare a una prova, collaborative, con la casella
email aperta e pronte a operare secondo le esigenze dei test. In particolare:

- sanno che si tratta di una simulazione e che le email del sistema portano
  il banner `TEST MODE`;
- sono pronte a **inviare il pronostico (pick) entro finestre brevi**
  (30–45 minuti negli esempi di questa guida);
- all'occorrenza, sono pronte a **inviare il pick in ritardo** su richiesta
  dell'operatore (per dimostrare i controlli anti-frode, vedi §6);
- usano squadre del **campionato sintetico di Serie B** elencate nel §1, non
  squadre di Serie A.

Questa assunzione è ripetuta nei singoli esempi (§5) perché tutto il tempo
stimato delle timeline è pensato per **persone umane** che leggono l'email,
decidono e rispondono: non è il tempo di calcolo del sistema.

---

## 1. Cos'è il test mode

### 1.1 In parole semplici

Il **test mode** è uno stato in cui il sistema si mette appositamente per
essere collaudato in sicurezza senza confondere una sessione di prova con la
produzione. Si attiva caricando un file di configurazione dedicato (`.env.uat`)
tramite la variabile `ENV_FILE` e si riconosce subito perché **ogni output
visibile porta la scritta `TEST MODE`**: le email inviate dal sistema, i
comandi a schermo, i log di sistema e i dati in formato `--json`.

A cosa serve:

- permettere una **UAT end-to-end con giocatori veri** su un calendario
  **sintetico** (inventato ma coerente) di Serie B, con giornate comprimibili
  in 1–2 ore invece che in una settimana reale;
- lasciare l'orologio e i timestamp delle email **reali**, così il controllo
  anti-frode (che si basa sull'orario vero di arrivo delle email) viene
  esercitato su evidenza autentica;
- **proteggere il calendario sintetico** dal flusso dati reale (nessun
  aggiornamento dall'API che lo sovrascriverebbe con la stagione 2025/26);
- opzionalmente, per il **replay di dati storici** (stagione 2025), permettere
  di spostare l'orologio e i timestamp delle email indietro di un numero di
  giorni (vedi §7).

**Una funzionalità di sistema, non del test mode: l'aggancio asincrono.** In
produzione il torneo parte normalmente dal primo turno di campionato. Il
sistema permette però di **avviare il torneo da un turno di campionato
qualunque** (`tournament:start --start-round <n>`): le giornate di campionato
**precedenti** a quella scelta semplicemente **non vengono giocate** (sono
"fuori finestra torneo"). Questa possibilità — chiamata **aggancio
asincrono** — è una **funzionalità di sistema, non del test mode**: esiste
anche in produzione, dove il default è l'aggancio al primo turno. Due concetti
chiave da ricordare:

- ogni turno di gioco ha un **doppio numero**: il **TT** (Turno di Torneo,
  progressivo da 1 in poi) e il **TC** (Turno di Campionato, il numero vero
  della giornata). Vale sempre `TT = TC − start_round + 1`: partendo da TC 3,
  la prima giornata di gioco è "TT1 = TC 3";
- a metà stagione il **pool si azzera** (le squadre tornano tutte
  disponibili) al **confine di girone** `floor(N/2)+1`: con 6 giornate cade
  al 4. Vedi l'esempio §5.4 e il glossario (§9).

**Implicazioni del suo uso:**

- è una **segnalazione visibile, non un blocco tecnico**: il sistema non
  impedisce di fare qualcosa, ma segnala ovunque che si è in test; la
  responsabilità di non usare il test mode in produzione è dell'operatore;
- i parametri specifici del test mode hanno effetto **solo quando il test mode
  è attivo**: se sono presenti per sbaglio in un ambiente non di test, restano
  ininfluenti (vedi §1.3, gating a consumo);
- il test mode **non si usa mai in produzione** (vedi §2, cosa NON fare).

### 1.2 Cosa cambia nel sistema quando è attivo

Quando `TEST_MODE=true` (e il file `.env.uat` è caricato via `ENV_FILE=.env.uat`)
i seguenti componenti cambiano comportamento rispetto alla produzione:

| Componente | Comportamento in produzione | Cosa cambia con test mode attivo |
|---|---|---|
| **Loader / configurazione** | Carica il file `.env` di default | Carica il file selezionato da `ENV_FILE` (es. `.env.uat`); espone i parametri test-only `TEST_MODE`, `TEST_OFFSET_DAYS`, `TEST_REFRESH_ALLOWED` |
| **Canale email — invio** | Email inviate tal quali | Ogni email **inviata** dal sistema riceve in testa al corpo il banner `[TEST MODE] This email was sent by a test instance of Survivor League.` (aggiunto in un solo punto, al momento dell'invio; i testi generati dall'LLM non sono modificati) |
| **CLI — output testuale** | Output normale | Ogni comando stampa una riga `TEST MODE` in cima all'output |
| **CLI — output `--json`** | JSON tal quale | Ogni output `--json` include il campo `"testMode": true` |
| **Log (pino)** | Righe JSON normali | Ogni riga di log include il campo `"testMode": true` |
| **Parser LLM** | Usa la risorsa `team-aliases.md` (Serie A 2025/26) | Usa la risorsa sintetica `team-aliases-synthetic.md` (Serie B) e riceve nel prompt il contesto "campionato sintetico di Serie B" (per non confondere l'LLM reale) |
| **Orologio (clock)** | Ora reale | Spostato indietro di `TEST_OFFSET_DAYS` giorni **solo se** il valore è > 0 (per il replay 2025); con 0 resta reale |
| **Timestamp di ricezione email** | `receivedAt` reale (internaldate IMAP) | Spostato indietro dello **stesso** `TEST_OFFSET_DAYS` **solo se** > 0 (replay); con 0 resta reale |
| **Scheduler — refresh dati** | Aggiorna i risultati dall'API a ogni tick | Con `TEST_REFRESH_ALLOWED=false` (default) **salta** il refresh e lo segnala a log; con `=true` esegue ma emette un WARN di consenso a ogni operazione |

Le **squadre del calendario sintetico** (dalla risorsa alias sintetica, Serie B
2025/26) sono otto:

1. US Cremonese — alias: `cremonese`, `grigiorossi`
2. Brescia Calcio — alias: `brescia`, `rondinelle`, `biancazzurri`
3. SSC Bari — alias: `bari`, `galletti`, `biancorossi`
4. US Catanzaro — alias: `catanzaro`, `giallorossi calabresi`, `aquile`
5. SSC Palermo — alias: `palermo`, `rosanero`, `aquile siciliane`
6. Spezia Calcio — alias: `spezia`, `aquiligialle`
7. UC Sampdoria — alias: `sampdoria`, `blucerchiati`, `samp`, `doria`
8. Pisa Sporting Club — alias: `pisa`, `nerazzurri toscani`

I giocatori possono scrivere nella email il nome canonico oppure un alias:
l'LLM lo riconduce al nome esatto della lista.

### 1.3 Parametri del test mode e perché esistono

Oltre al selettore `ENV_FILE`, il test mode introduce tre parametri detti
**test-only**. La tabella seguente ne spiega lo **scopo** ma anche la
**motivazione** (perché esistono e che rischio coprono), non solo i valori.

| Parametro (file env) | Valori | Default | Perché esiste (motivazione) |
|---|---|---|---|
| `ENV_FILE` | percorso di un file env (es. `.env.uat`, `.env.uat-replay`) | `.env` | Permette di avere **più configurazioni separate** (test, replay, produzione) senza sovrascrivere `.env`. Si passa come variabile d'ambiente prima del comando o nel cron. È il **punto unico di attivazione** del test mode. |
| `TEST_MODE` | `true` / `false` | `false` | È l'interruttore del test mode. Con `true` attiva banner, risorsa alias sintetica e il fatto che i parametri test-only abbiano effetto. Esiste per **rendere esplicita e visibile** la scelta di fare una prova, separandola dalla configurazione di gioco. |
| `TEST_OFFSET_DAYS` | intero ≥ 0 (giorni) | `0` | Sposta **lo stesso delta** sia l'orologio sia il timestamp di ricezione delle email. Esiste **solo per il replay 2025** (ri-allineare l'ora reale alle date storiche). L'offset **unificato** elimina per costrutto il rischio di avere clock e timestamp disallineati (che falsificherebbe il controllo anti-frode). Con `0` niente cambia: orologio e timestamp restano reali. |
| `TEST_REFRESH_ALLOWED` | `true` / `false` | `false` | Decide se in test mode si possono fare `data:import` / `data:refresh` e l'aggiornamento automatico dello scheduler. Esiste per **proteggere il calendario sintetico**: se il refresh partisse, sovrascriverebbe le date inventate con la stagione 2025/26 reale, rovinando la prova. Si attiva solo per UAT su **dati reali** (mai sul sintetico). |

**Gating a consumo (importante).** I parametri test-only `TEST_OFFSET_DAYS` e
`TEST_REFRESH_ALLOWED` sono **sempre** letti dalla configurazione (con default
`0` / `false`), ma il loro **effetto** si attiva solo quando `TEST_MODE=true`.
Se per sbaglio finiscono in un ambiente con `TEST_MODE=false`, non succede
nulla: il comportamento resta quello di produzione. Anche un valore
malformato non fa fallire l'avvio: viene riportato al default in silenzio.

**Parametri di gioco "cadenza compressa"** (valori UAT nel file `.env.uat`,
diversi dai default di produzione). Non sono parametri test-only, ma in UAT si
riducono per comprimere le giornate:

| Parametro | Default produzione | Valore UAT | Perché in UAT è diverso |
|---|---|---|---|
| `DEADLINE_ADVANCE_MIN` | 30 | 30 | Anticipo della deadline dei pick sul fischio. Resta 30: è la **finestra di pick** del primo round (con offset 60 min, vedi §5). |
| `MATCH_DURATION_MIN` | 125 | 5 | Durata stimata di una partita. Ridotta a 5 minuti per evitare sovrapposizioni tra giornate ravvicinate. |
| `TC_CLOSE_SKEW_MIN` | 300 | 10 | Scarto oltre la fine prevista per la chiusura del Turno Corrente. Ridotto a 10 per chiudere poco dopo il fischio. |
| `SCHEDULER_ENABLED` | false | true (cron) / false (commissioner) | Attiva l'orchestrazione automatica via cron; in modalità commissioner si tiene false. |

**Regola di non-sovrapposizione (D8).** La spaziatura tra giornate
(`--spacing-min` del seed) deve essere ≥ `MATCH_DURATION_MIN` + `TC_CLOSE_SKEW_MIN`
(= 5 + 10 = **15 minuti** negli esempi di questa guida). Se non lo è, il seed
emette un **log di errore** (in inglese) che nomina i parametri coinvolti — vedi
§4. Tutti gli esempi di §5 usano `--spacing-min 45`, ben sopra la soglia.

### 1.4 Verifica immediata che il test mode sia attivo

Comandi di controllo (sola lettura, non producono email, non avviano il cron):

```bash
ENV_FILE=.env.uat npm run cli -- data:calendar
ENV_FILE=.env.uat npm run cli -- data:calendar --json
```

Cosa devi vedere se il test mode è attivo:

- nell'output **testuale**, la **prima riga** è `TEST MODE`, seguita dal
  calendario sintetico (squadre di Serie B, date future);
- nell'output **`--json`**, il campo `"testMode": true` (es.
  `{"testMode":true,"result":[...]}`);
- nei **log** (su stdout, una riga JSON per evento) il campo `"testMode": true`
  in ogni riga.

Le **email inviate** dal sistema (es. inviti, conferme pick, rifiuti) recano in
cima al corpo il banner `[TEST MODE] This email was sent by a test instance of Survivor League.`

---

## 2. Manuale operativo del TEST_MODE

### 2.1 Come si attiva

1. **Crea il file `.env.uat`** a partire dall'esempio versionato
   `.env.uat.example` (copia e compila le credenziali vuote copiandole dal
   `.env` reale: casella Gmail del progetto e chiave LLM). Il file `.env.uat`
   è **escluso dal versionamento** (in `.gitignore`): contiene segreti.
2. **Predisponi due database dedicati** (torneo e piattaforma): `.env.uat`
   imposta `DB_PATH=./data/uat-synthetic.db` (DB del **torneo**, NON quello di
   produzione) e `PLATFORM_DB_PATH=./data/uat-platform.db` (DB degli **account
   piattaforma**, ADR-009, anch'esso NON quello di produzione
   `./data/platform.db`). La directory `data/` viene creata se manca.
3. **Attiva il test mode** anteponendo `ENV_FILE=.env.uat` al comando:

   ```bash
   ENV_FILE=.env.uat npm run cli -- <comando>
   ```

   La variabile `ENV_FILE` seleziona il file env da caricare al posto del
   default `.env`. In `.env.uat` c'è `TEST_MODE=true`, quindi il test mode
   parte. Se `ENV_FILE` punta a un file **inesistente**, l'avvio fallisce con
   un errore esplicito che nomina il percorso.

> **Nota su override inline.** Le variabili già presenti nell'ambiente vincono
> su quelle del file (es. `DB_PATH=./data/pippo.db ENV_FILE=.env.uat npm run ...`
> usa `pippo.db`). Per le prove **ripetibili e auditabili**, però, si usano
> **file env dedicati** (`.env.uat`, `.env.uat-replay`), non override inline.

### 2.2 Come si usa (le due modalità)

Ci sono due modalità operative, trattate in dettaglio nel §3:

- **modalità commissioner** — l'operatore lancia a mano i comandi, uno per
  fase (seed → iscrizioni → avvio → per ogni giornata: apri → raccogli pick →
  chiudi → contabilizza → verifica);
- **modalità cron** — l'orchestrazione è automatica (lo scheduler apre/chiude/
  contabilizza le giornate in base al calendario).

### 2.3 Come si disattiva

Semplicemente **non usare più `ENV_FILE=.env.uat`**: i comandi senza `ENV_FILE`
caricano `.env` (dove `TEST_MODE=false`). Il test mode non è uno stato
persistente: dipende solo dal file env caricato a ogni esecuzione.

Per riutilizzare il terminale senza rischio di confondere test e produzione,
togli la variabile `ENV_FILE` dalla shell (se l'avevi esportata):

```bash
unset ENV_FILE
```

### 2.4 Cosa fare e cosa NON fare

**FAI:**

- usa un **database dedicato** (`DB_PATH=./data/uat-synthetic.db` o uno di
  scarto) e un **DB piattaforma dedicato** (`PLATFORM_DB_PATH=./data/uat-platform.db`,
  mai `./data/platform.db`);
- controlla sempre il banner `TEST MODE` a inizio output prima di procedere;
- alla fine di ogni sessione, **ripulisci la casella Gmail condivisa** dalle
  email di test (vedi §8).

**NON FARE (vincoli):**

- **MAI** lanciare `data:refresh` (o `data:import`) su un DB sintetico: con
  `TEST_REFRESH_ALLOWED=false` il sistema li **salta automaticamente** a
  protezione del calendario; ma se tu impostassi `TEST_REFRESH_ALLOWED=true`
  su un DB sintetico, l'aggiornamento dall'API sovrascriverebbe le date
  inventate con la stagione 2025/26 reale, rovinando la prova.
- **MAI** usare `ENV_FILE` / `TEST_MODE` in **produzione**: sono strumenti del
  test mode.
- **MAI** usare `TEST_OFFSET_DAYS` su un calendario **sintetico** futuro: è
  pensato solo per il **replay di dati storici** (stagione 2025) su DB
  dedicato (vedi §7). Spostare l'orologio su un calendario futuro non ha senso
  e falserebbe le finestre.
- **MAI** lanciare `scheduler:tick` in modalità commissioner se
  `SCHEDULER_ENABLED=true`: eseguirebbe azioni automatiche. In commissioner
  tieni `SCHEDULER_ENABLED=false` (vedi §3).

### 2.5 Procedure standard con comandi di verifica per fase

**Avvio del test (una volta):**

```bash
# 1. Crea/migra il DB torneo dedicato (idempotente)
ENV_FILE=.env.uat npm run cli -- db:migrate
# 1b. Crea/migra il DB piattaforma dedicato (idempotente, ADR-009)
ENV_FILE=.env.uat npm run cli -- platform:migrate
# 2. Genera e carica il calendario sintetico (esempio 2h: vedi §5.1)
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 4 --rounds 2 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
# 3. Verifica il calendario e il banner TEST MODE
ENV_FILE=.env.uat npm run cli -- data:calendar
```

> **Avvio della stagione.** Per avviare la stagione si usa `tournament:start`,
> che accetta l'opzione `--start-round <n>` (default `1`) per l'**aggancio
> asincrono**: il torneo parte dal TC `n` invece che dal primo turno di
> campionato (vedi §3.1 e l'esempio §5.4).

**Operazioni per ogni giornata (round) — modalità commissioner:**

```bash
# Apre la giornata: registra la deadline e invia le email di pick ai profili attivi
ENV_FILE=.env.uat npm run cli -- round:open --round <N>
# (i giocatori inviano i pick via email entro la deadline)
# Processa le email in ingresso (iscrizioni, disiscrizioni e pick)
ENV_FILE=.env.uat npm run cli -- channel:email:process
# Chiude la giornata (auto alla deadline) OPPURE forzata subito (override RF-29):
ENV_FILE=.env.uat npm run cli -- round:close --round <N> --force --reason "chiusura forzata per test"
# Contabilizza (i punteggi sono pre-seedati: passa subito a scored)
ENV_FILE=.env.uat npm run cli -- round:score --round <N>
```

**Verifica e controllo per ogni giornata (sola lettura):**

```bash
ENV_FILE=.env.uat npm run cli -- round:status --round <N>     # stato della giornata
ENV_FILE=.env.uat npm run cli -- round:deadline --round <N>   # deadline, kickoff, istante di accettazione
ENV_FILE=.env.uat npm run cli -- data:results --round <N>     # risultati (squadre e punteggi) della giornata
```

**Conclusione e verifica finale:**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:status              # stato aggregato, vincitore, anomalie
ENV_FILE=.env.uat npm run cli -- tournament:leaderboard         # classifica profili in gara
ENV_FILE=.env.uat npm run cli -- tournament:history --email <email>   # storico pick di un profilo
ENV_FILE=.env.uat npm run cli -- tournament:export              # dump JSON di tutte le tabelle + metadati
ENV_FILE=.env.uat npm run cli -- scheduler:status               # stato computato dello scheduler + prossime azioni
```

---

## 3. Le due modalità operative

### 3.1 Modalità commissioner (comandi manuali)

L'operatore conduce a mano ogni fase. **Quando usarla**: per le prime sessioni
UAT, per dimostrare controlli specifici (es. la guard anti-frode `after_kickoff`
richiede una giornata lasciata aperta oltre il fischio, vedi §6), per test
rapidissimi (smoke) o quando non si vuole dipendere dal cron.

**Setup consigliato:** imposta `SCHEDULER_ENABLED=false` nel file `.env.uat`
(per la sessione commissioner), così `scheduler:tick` è inoffensivo anche se
lanciato per sbaglio (stampa `Scheduler disabilitato (SCHEDULER_ENABLED=false): nessuna azione eseguita — usa i comandi manuali (LLD §7.12)` e non fa nulla). I
comandi manuali (`round:open`, `round:close`, ecc.) funzionano comunque
indipendentemente da `SCHEDULER_ENABLED`.

**Flusso completo (semplificato):**

```
db:migrate → platform:migrate → data:seed-synthetic
→  iscrizioni piattaforma (via email: channel:email:process, o CLI: platform:register)
→  tournament:start [--start-round <n>]   (invia tournament_open agli iscritti attivi)
→  per ogni round N:
     round:open --round N  →  channel:email:process  →  round:close --round N [--force --reason]
     →  round:score --round N  →  (verifica: round:status, round:deadline, data:results)
→  verifica finale: tournament:status / leaderboard / history / export / platform:list
```

**Aggancio asincrono (RF-20).** `tournament:start [--start-round <n>]` avvia
il torneo dal TC `n` (default `1`): le giornate di campionato **PRIMA** del TC
di aggancio **non vengono giocate** (sono fuori dalla finestra del torneo).
Dopo l'avvio verifichi l'aggancio con:

- `tournament:status` → riga `Stagione: avviata (start TC <n>, <N> TC, confine <b>)`;
- `tournament:history --email <email>` → righe `TTnTCm` (es. `TT1TC3`) per ogni pick.

**Iscrizione alla piattaforma (ADR-009).** Non esiste più una finestra di
iscrizione da aprire/chiudere: l'iscrizione alla **piattaforma** è **sempre
disponibile** via email (intento classificato dall'LLM) o via CLI, e la
**partecipazione al torneo** nasce **da sola al primo pick valido nel TT 1**
(auto-join, RF-P5):

- **via email:** il giocatore scrive "voglio iscrivermi" → il sistema crea
  l'account (con un `registerID` stabile, riusato a ogni re-iscrizione) e
  risponde `platform_registered`; il suo **primo pick valido nel
  TT1** lo rende partecipante (risposta `pick_confirmed`, nessuna conferma di
  iscrizione separata);
- **già iscritto:** un account `active` che riscrive "voglio iscrivermi"
  riceve la risposta `platform_already_registered` (oggetto "Già iscritto
  alla piattaforma"), nessun account duplicato;
- **via CLI (unico comando di creazione account, NON crea profili):**
  `platform:register --email <email> [--name <nome>] [--reason <motivo>]`;
- **disiscrizione a due passi (RF-P2):** primo "voglio disiscrivermi" →
  account `pending_unsubscribe` + email `platform_unsubscribe_confirm`
  (nessuna cancellazione); la cancellazione effettiva (soft-delete
  `unsubscribed` + email `platform_unsubscribed`) avviene **solo** quando il
  **secondo** messaggio ha il body nella lista di conferma
  (`confermo`/`sì`/`si`/`yes`) — indipendentemente da come l'LLM classifica
  il messaggio (un "confermo" completa la disiscrizione anche se letto come
  "non ho capito"); un body NON in lista mantiene `pending_unsubscribe` e
  richiede di nuovo la conferma; da account già disiscritto o da mittente
  mai iscritto → nessuna risposta (log interno);
- **re-iscrizione (RF-P3):** un `subscribe` o un `pick` mentre l'account è
  `pending_unsubscribe` lo riporta `active`; da `unsubscribed`, una nuova
  iscrizione riattiva lo **stesso** `registerID` (lo storico torneo non è
  toccato);
- **disiscrizione dal commissioner:** `platform:unregister --email <email>
  [--reason <motivo>]` (soft-delete diretto, il profilo torneo resta intatto);
- **consultazione:** `platform:list [--json]` (registerID, email, status,
  date);
- **anti-spam (RF-P4):** un pick da un mittente non iscritto (mai iscritto o
  disiscritto) produce solo un log interno, **nessuna risposta**; anche il
  chiarimento "non ho capito" (intento `other`) parte **solo** verso account
  `active`: da account `unsubscribed` o `pending_unsubscribe` → nessuna
  risposta (log interno).

**Matrice notifiche (RF-P6).** Ogni email in uscita va **solo ad account
`active`**: apertura torneo (`tournament_open`) a **tutti gli iscritti
attivi**; apertura round (`pick_instructions`) ai **soli partecipanti attivi**
(`eliminated = 0`) e, **all'apertura del TT 1**, anche agli **iscritti attivi
senza profilo** (amendment 2026-08-21: al round 1 i profili non esistono
ancora, auto-join RF-P5); chiusura round → riepilogo `round_closed_survived`
**ai soli sopravvissuti** (inviato **una sola volta** alla contabilizzazione);
gli eliminati ricevono **solo** `pick_missing_elimination` (alla chiusura) e
`round_result_wrong` (alla contabilizzazione). Un account `unsubscribed` o
`pending_unsubscribe` **non riceve alcuna email di torneo**.

**Chiusura di una giornata.** In commissioner puoi lasciare che la giornata si
chiuda da sola al superamento della deadline (l'operatore non fa nulla) oppure
**chiudere subito** con `round:close --round N --force --reason "<motivo>"`
(chiusura forzata RF-29, il `--reason` è obbligatorio con `--force`). È
l'override che usiamo negli esempi di §5 per non aspettare la deadline reale.

### 3.2 Modalità cron (scheduler automatico)

**Quando usarla:** per una UAT "in pilota automatico", in cui il sistema apre,
chiude e contabilizza le giornate da solo secondo il calendario, e i giocatori
interagiscono solo via email.

**Setup:** in `.env.uat` lascia `SCHEDULER_ENABLED=true`. Aggiungi due righe al
crontab del sistema (ogni minuto):

```cron
# Orchestrazione delle giornate (apertura/chiusura/contabilizzazione)
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && ENV_FILE=.env.uat npm run cli -- scheduler:tick >> /var/log/survivor-uat.log 2>&1
# Lettura e processamento delle email in ingresso (iscrizioni, disiscrizioni e pick)
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && ENV_FILE=.env.uat npm run cli -- channel:email:process >> /var/log/survivor-uat-mail.log 2>&1
```

> **Importante — due cron, non uno.** `scheduler:tick` orchestra le giornate
> (apre/chiude/contabilizza) ma **non
> legge la casella email**: è un orchestratore "sottile", senza logica di
> gioco oltre al decidere *quando* agire. Le email in ingresso (iscrizioni,
> disiscrizioni e
> pick dei giocatori) sono lette e processate da `channel:email:process`, che
> va therefore schedulato a parte. Senza la seconda riga, i pick inviati dai
> giocatori non verrebbero mai acquisiti.

**Cosa fa `scheduler:tick` (in base allo stato e al calendario):**

- apre la giornata (round) quando la precedente è contabilizzata (`scored`);
  la prima si apre all'avvio del torneo;
- chiude la giornata al superamento della deadline (auto-chiusura);
- contabilizza le giornate chiuse (`round:score`, se `SCHEDULER_AUTO_SCORE=true`).
- **Nota ADR-009:** non esiste più alcuna finestra di iscrizione da
  aprire/chiudere — le azioni `register_close_auto`/`register_close_safety`
  sono rimosse: l'iscrizione piattaforma è sempre aperta e la partecipazione
  è gated dalla deadline del TT1 (auto-join).

**Vincolo fondamentale (cron):** in modalità cron su calendario sintetico,
`TEST_REFRESH_ALLOWED` deve restare `false` (il default). Così il refresh
automatico dello scheduler è **saltato** a ogni tick e il calendario sintetico
non viene sovrascritto dalla stagione reale. A log compaiono righe come:

```
{"level":30,...,"testMode":true,"msg":"import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled"}
```

**Verifica in cron (sola lettura, sempre disponibile):**

```bash
ENV_FILE=.env.uat npm run cli -- scheduler:status
ENV_FILE=.env.uat npm run cli -- tournament:status
```

> **Nota (vincolo di progetto).** Il cron usa i valori del file `.env.uat`
> **senza override inline**. Mantieni `.env.uat` coerente con il DB di test
> (`DB_PATH=./data/uat-synthetic.db`). I DB di collaudo restano file separati e
> non disturbano la produzione.

---

## 4. Il seed del calendario sintetico in linguaggio semplice

Il comando `data:seed-synthetic` **genera** un calendario inventato ma
coerente (campionato di Serie B) e **lo carica** nella tabella `match` del DB.
In questa guida i **punteggi sono già presenti** (pre-seedati) fin dall'inizio:
questo è strutturale per la cadenza compressa, perché permette alla
contabilizzazione (`round:score`) di completare subito dopo la chiusura della
giornata, così la successiva si apre senza attese.

**Cosa fa (e cosa non fa):**

- **aggiunge o aggiorna** le partite (upsert), **non cancella mai** da solo.
  Lo stesso seed ripetuto non duplica le righe (la chiave è
  `(round, home_team, away_team)`).
- I punteggi sono **deterministici** a parità di `--seed`: stesso seed → stessi
  gol su tutte le partite.

**Opzioni reali del comando** (con i default della CLI):

| Opzione | Default | Significato |
|---|---|---|
| `--teams <n>` | 8 | Numero di squadre (da 2 a 8; prese dalla rosa sintetica di Serie B). |
| `--rounds <n>` | 7 | Numero di giornate. Con 8 squadre il girone completo è 7; valori maggiori **ripetono gli accoppiamenti** (wrap, vedi §5.3). |
| `--spacing-min <n>` | 90 | Minuti tra due giornate consecutive (distanzia solo le giornate, non le partite di una stessa giornata, che hanno tutte lo stesso orario). |
| `--first-kickoff-offset-min <n>` | 120 | Minuti da adesso al fischio della **prima** giornata (orologio reale). |
| `--seed <n>` | 42 | Seed dei punteggi (deterministico). |
| `--force` | false | Permette il seed su una tabella `match` già popolata. |
| `--clear` | false | Svuota la tabella `match` prima del seed (richiede `--force`). |
| `--json` | false | Output JSON strutturato (con campo `testMode`) invece di testo. |

> **Nota — `--rounds` e dominio dell'aggancio asincrono.** `--rounds` è il
> numero di giornate generate e quindi il **dominio dei TC agganciabili**:
> `tournament:start --start-round <n>` accetta `n` in `1..rounds`. Il
> **confine di girone** si calcola su quel totale con `floor(rounds/2)+1`
> (es. 6 → 4, 8 → 5). Un calendario **MISTO** (WARN di `--force` senza
> `--clear`, vedi sotto) rende incoerente questo dominio, perché il numero
> totale di giornate visto dal sistema è `MAX(round)` della tabella.

**Le tre guardie (protezioni) — cosa succede in caso d'uso sbagliato:**

1. **Tabella già piena, senza `--force`:** il seed **rifiuta** (non scrive
   nulla) con un messaggio che invita a usare `--force` o `--force --clear`.
2. **`--force` senza `--clear` su tabella piena:** il seed procede ma **non
   cancella** le righe esistenti (l'upsert non fa DELETE) → si può formare un
   **calendario MISTO** (Serie A + Serie B sintetica). Il sistema emette un
   **WARN** (in inglese) e lo ripete nell'output:
   `--force without --clear on a non-empty match table: existing rows are kept (upsert never deletes); the calendar may become mixed (Serie A + synthetic Serie B) and getTeams()/getTotalRounds() become inconsistent with the synthetic alias resource. Use --force --clear to wipe the match table first`.
   Il WARN avverte anche che la rosa delle squadre e il numero di giornate
   diventano incoerenti con la risorsa alias sintetica. **Quando usare
   `--force --clear`:** quando vuoi ripartire da un calendario pulito su un DB
   di prova.
3. **`--clear` rifiutato se il torneo è in corso:** con `--force --clear`, il
   seed rifiuta se la stagione è già avviata (`season_started=1`) o se esistono
   già pronostici (`pick`) o stato delle giornate (`round_state`). Motivo:
   svuotare il calendario lascerebbe "orfani" i pronostici e lo stato,
   producendo un DB inconsistente. Messaggio (italiano):
   `Rifiuto --clear: stato di gioco presente (season_started=1 oppure righe in pick/round_state). La tabella match non può essere svuotata a torneo in corso`.
   In pratica: per ri-seedare con `--clear`, fallo **prima** di
   `tournament:start`.

**Avvertenza fuori test mode.** Se lanci `data:seed-synthetic` con
`TEST_MODE=false` (es. per sbaglio sul `.env` di produzione), il comando
**procede** ma emette un **WARN** (non un blocco) — è uno strumento del test
mode e non va usato su un DB di produzione:

```
WARNING: data:seed-synthetic is a test-only command: seeding with TEST_MODE=false may pollute a production database with synthetic data
```

**Rilevazione sovrapposizione finestre (D8).** Se `--spacing-min` è minore di
`MATCH_DURATION_MIN` + `TC_CLOSE_SKEW_MIN` (15 min in UAT), il seed emette un
**log di errore** (inglese) che nomina i parametri coinvolti — non blocca, ma
avvisa che le finestre di due giornate consecutive si sovrapporrebbero:

```
Synthetic seed: spacing between rounds (--spacing-min = 5 min) is less than MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN (5 + 10 = 15 min): TC windows of consecutive rounds would overlap; verify MATCH_DURATION_MIN, TC_CLOSE_SKEW_MIN and --spacing-min
```

Tutti gli esempi di §5 usano `--spacing-min 45` (≥ 15), quindi questo errore
**non** compare negli esempi corretti.

---

## 5. Tre esempi di timeline (comandi copiabili passo per passo)

> **Convenzione degli esempi.** Ogni comando è prefissato da
> `ENV_FILE=.env.uat` (il selettore del file env di test). Negli esempi si
> assume la **modalità commissioner** con `SCHEDULER_ENABLED=false` in
> `.env.uat`. Sostituisci `<N>` con il numero della giornata (1, 2, 3, …) e
> `<email>` con l'indirizzo di un giocatore. Le **durate** stimate sono il
> tempo per **giocatori umani** (leggere l'email, decidere, rispondere); non
> vanno riprodotte in una verifica a secco delle sintassi (vedi nota finale).
>
> **Assunzione giocatori di TEST (valida per tutti gli esempi):** i partecipanti
> sono persone consapevoli, collaborative, con la casella aperta, pronte a
> rispondere entro finestre brevi (30–45 min) e, su richiesta dell'operatore,
> a inviare un pick in ritardo per dimostrare i controlli anti-frode (§6).

### 5.1 Esempio smoke (~2h) — 4 squadre, 2 giornate

```bash
data:seed-synthetic --teams 4 --rounds 2 --spacing-min 45 --first-kickoff-offset-min 60
```

- **Durata ≈ 1h45** (dal seed all'ultimo fischio = 60 + 45×(2−1) = 105 min).
- **Finestre di pick:** 30' al round 1 (offset 60 − anticipo 30), 45' al
  round 2 (uguale alla spaziatura).
- **A chi serve:** smoke test minimo per verificare banner, calendario,
  iscrizione, un paio di pick e la contabilizzazione, in meno di due ore.

**Setup (una volta):**

```bash
ENV_FILE=.env.uat npm run cli -- db:migrate
ENV_FILE=.env.uat npm run cli -- platform:migrate
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 4 --rounds 2 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
ENV_FILE=.env.uat npm run cli -- data:calendar
```

**Iscrizioni piattaforma (ADR-009: nessuna finestra da aprire/chiudere):**

```bash
# (i giocatori si iscrivono via email "voglio iscrivermi"; processa le email:)
ENV_FILE=.env.uat npm run cli -- channel:email:process
# oppure iscrizione diretta via CLI (l'unico comando di creazione account):
ENV_FILE=.env.uat npm run cli -- platform:register --email alice@example.com --reason "test smoke 2h"
ENV_FILE=.env.uat npm run cli -- platform:register --email bob@example.com --reason "test smoke 2h"
# verifica degli account:
ENV_FILE=.env.uat npm run cli -- platform:list
```

**Avvio stagione:**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:start
```

**Giornata 1:**

```bash
ENV_FILE=.env.uat npm run cli -- round:open --round 1
# (i giocatori inviano il pick via email entro ~30')
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- round:close --round 1 --force --reason "test smoke 2h"
ENV_FILE=.env.uat npm run cli -- round:score --round 1
ENV_FILE=.env.uat npm run cli -- round:status --round 1
ENV_FILE=.env.uat npm run cli -- round:deadline --round 1
ENV_FILE=.env.uat npm run cli -- data:results --round 1
```

**Giornata 2 (ultima):**

```bash
ENV_FILE=.env.uat npm run cli -- round:open --round 2
# (i giocatori inviano il pick via email entro ~45')
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- round:close --round 2 --force --reason "test smoke 2h"
ENV_FILE=.env.uat npm run cli -- round:score --round 2
ENV_FILE=.env.uat npm run cli -- round:status --round 2
ENV_FILE=.env.uat npm run cli -- data:results --round 2
```

**Verifica finale:**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:status
ENV_FILE=.env.uat npm run cli -- tournament:leaderboard
ENV_FILE=.env.uat npm run cli -- tournament:history --email alice@example.com
ENV_FILE=.env.uat npm run cli -- tournament:export
```

### 5.2 Esempio standard (~4h30) — 8 squadre, 6 giornate

```bash
data:seed-synthetic --teams 8 --rounds 6 --spacing-min 45 --first-kickoff-offset-min 60
```

- **Durata ≈ 4h45** (dal seed all'ultimo fischio = 60 + 45×(6−1) = 285 min).
- **Finestre di pick:** 30' al round 1, 45' ai round 2–6.
- **A chi serve:** UAT rappresentativa: 8 squadre (girone completo di 7, qui
  6 giornate, senza wrap), più giocatori e più eliminazioni da osservare.

**Setup (una volta):**

```bash
ENV_FILE=.env.uat npm run cli -- db:migrate
ENV_FILE=.env.uat npm run cli -- platform:migrate
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 8 --rounds 6 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
ENV_FILE=.env.uat npm run cli -- data:calendar
```

**Iscrizioni piattaforma e avvio (ADR-009):**

```bash
# (i giocatori si iscrivono via email; processa le email:)
ENV_FILE=.env.uat npm run cli -- channel:email:process
# oppure via CLI:
ENV_FILE=.env.uat npm run cli -- platform:register --email alice@example.com --reason "test standard 4h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email bob@example.com --reason "test standard 4h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email carol@example.com --reason "test standard 4h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email dave@example.com --reason "test standard 4h30"
ENV_FILE=.env.uat npm run cli -- platform:list
# l'avvio invia tournament_open a tutti gli iscritti attivi:
ENV_FILE=.env.uat npm run cli -- tournament:start
```

**Ogni giornata da 1 a 6 — ripeti questo blocco per N = 1, 2, 3, 4, 5, 6:**

```bash
ENV_FILE=.env.uat npm run cli -- round:open --round <N>
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- round:close --round <N> --force --reason "test standard 4h30"
ENV_FILE=.env.uat npm run cli -- round:score --round <N>
ENV_FILE=.env.uat npm run cli -- round:status --round <N>
ENV_FILE=.env.uat npm run cli -- data:results --round <N>
```

**Verifica finale (dopo la giornata 6):**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:status
ENV_FILE=.env.uat npm run cli -- tournament:leaderboard
ENV_FILE=.env.uat npm run cli -- tournament:history --email alice@example.com
ENV_FILE=.env.uat npm run cli -- tournament:export
```

### 5.3 Esempio completa (~6h30) — 8 squadre, 8 giornate (wrap)

```bash
data:seed-synthetic --teams 8 --rounds 8 --spacing-min 45 --first-kickoff-offset-min 60
```

- **Durata ≈ 6h15** (dal seed all'ultimo fischio = 60 + 45×(8−1) = 375 min).
- **Finestre di pick:** 30' al round 1, 45' ai round 2–8.
- **A chi serve:** UAT estesa con la stagione completa e il **wrap**.

**Cosa significa "wrap" del round-robin.** Con 8 squadre il girone all'italiana
completo ha **7 giornate**: ogni squadra incontra le altre 7, una volta per
giornata, senza mai giocare contro sé stessa. Chiedendo `--rounds 8` (maggiore
di 7) il generatore **riapplica** lo stesso schema a partire dall'ottava
giornata: la **giornata 8 ha gli stessi accoppiamenti della giornata 1** (le
stesse coppie di squadre), ma è una giornata **distinta** (numero di round
diverso, punteggi diversi perché il generatore continua a estrarli). Non ci sono
auto-match né duplicati dentro la stessa giornata. In soldoni: al round 8 le
squadre si ritrovano abbinate come al round 1, e la cosa è **documentata e
prevista** dal sistema.

> **Wrap e confine di girone sono due cose diverse.** Il **wrap** (round 8 =
> accoppiamenti del round 1) riguarda la completezza del girone all'italiana
> (7 accoppiamenti unici per 8 squadre). Il **confine di girone** — quando il
> **pool si resetta** e le squadre tornano tutte disponibili — dipende invece
> dal numero **totale** di giornate N e cade al round `floor(N/2)+1`: con
> N=8 cade al **round 5** (le giornate 1–4 sono andata, dalla 5 all'8 ritorno;
> il pool si resetta all'inizio del round 5, dopo il round 4). Quindi in
> questo esempio osservi **entrambi** i fenomeni: il reset del pool al
> round 5 e una giornata "extra" (il round 8) oltre il girone completo di
> 7 accoppiamenti. Non confonderli: il reset del pool **non** avviene al
> round 7 né al round 8.

**Setup (una volta):**

```bash
ENV_FILE=.env.uat npm run cli -- db:migrate
ENV_FILE=.env.uat npm run cli -- platform:migrate
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 8 --rounds 8 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
ENV_FILE=.env.uat npm run cli -- data:calendar
```

**Iscrizioni piattaforma e avvio (ADR-009):**

```bash
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- platform:register --email alice@example.com --reason "test completa 6h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email bob@example.com --reason "test completa 6h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email carol@example.com --reason "test completa 6h30"
ENV_FILE=.env.uat npm run cli -- platform:register --email dave@example.com --reason "test completa 6h30"
ENV_FILE=.env.uat npm run cli -- platform:list
ENV_FILE=.env.uat npm run cli -- tournament:start
```

**Ogni giornata da 1 a 8 — ripeti questo blocco per N = 1, 2, 3, 4, 5, 6, 7, 8:**

```bash
ENV_FILE=.env.uat npm run cli -- round:open --round <N>
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- round:close --round <N> --force --reason "test completa 6h30"
ENV_FILE=.env.uat npm run cli -- round:score --round <N>
ENV_FILE=.env.uat npm run cli -- round:status --round <N>
ENV_FILE=.env.uat npm run cli -- data:results --round <N>
```

**Verifica finale (dopo la giornata 8):**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:status
ENV_FILE=.env.uat npm run cli -- tournament:leaderboard
ENV_FILE=.env.uat npm run cli -- tournament:history --email alice@example.com
ENV_FILE=.env.uat npm run cli -- tournament:export
```

### 5.4 Esempio aggancio asincrono — 8 squadre, 6 giornate, avvio da TC 3

```bash
data:seed-synthetic --teams 8 --rounds 6 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
```

- **Cosa dimostra:** l'**aggancio asincrono** (ADR-008/RF-20): il torneo parte
  dal TC 3 invece che dal TC 1. Le giornate **1 e 2** del calendario **non
  vengono giocate** (fuori dalla finestra del torneo).
- **6 TC totali**, confine di girone `floor(6/2)+1 = 4`. Avviando da TC 3, il
  torneo gioca **4 giornate** (TC 3, 4, 5, 6); la prima giornata di ritorno è
  TC 4 = **TT 2**: il pool si resetta a metà torneo, in miniatura (CL13/CL14).
- **Finestre di pick:** la finestra del TT1 arriva fino alla deadline di TC 3
  (~120 min dal seed, vedi sotto); le giornate successive hanno finestre di
  ~45' (la spaziatura tra giornate).

**Vincolo temporale (RF-21).** Con offset 60 e spacing 45, la deadline di
TC 3 cade **~120 minuti dopo il seed** (kickoff di TC 3 = 60 + 45×2 = 150
minuti, meno l'anticipo di 30). `tournament:start --start-round 3` e le
iscrizioni piattaforma (che dovranno poi entrare in torneo con un pick nel TT1, auto-join)
vanno quindi fatti **entro quel lasso**: altrimenti l'avvio viene
rifiutato con `Deadline del TT 1 non futura (<ISO>): avvio rifiutato (RF-21)`.

**Setup (una volta):**

```bash
ENV_FILE=.env.uat npm run cli -- db:migrate
ENV_FILE=.env.uat npm run cli -- platform:migrate
ENV_FILE=.env.uat npm run cli -- data:seed-synthetic --teams 8 --rounds 6 --spacing-min 45 --first-kickoff-offset-min 60 --seed 42
ENV_FILE=.env.uat npm run cli -- data:calendar
```

**Iscrizioni piattaforma e avvio (entro ~120 minuti dal seed):**

```bash
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- platform:register --email alice@example.com --reason "test aggancio TC3"
ENV_FILE=.env.uat npm run cli -- platform:register --email bob@example.com --reason "test aggancio TC3"
ENV_FILE=.env.uat npm run cli -- platform:register --email carol@example.com --reason "test aggancio TC3"
ENV_FILE=.env.uat npm run cli -- platform:register --email dave@example.com --reason "test aggancio TC3"
ENV_FILE=.env.uat npm run cli -- platform:list
# Avvio asincrono: il torneo parte dal TC 3 (TT1 = TC 3); invia tournament_open
ENV_FILE=.env.uat npm run cli -- tournament:start --start-round 3
```

**Ogni giornata da TC 3 a TC 6 — ripeti questo blocco per N = 3, 4, 5, 6:**

```bash
ENV_FILE=.env.uat npm run cli -- round:open --round <N>
ENV_FILE=.env.uat npm run cli -- channel:email:process
ENV_FILE=.env.uat npm run cli -- round:close --round <N> --force --reason "test aggancio asincrono"
ENV_FILE=.env.uat npm run cli -- round:score --round <N>
ENV_FILE=.env.uat npm run cli -- round:status --round <N>
ENV_FILE=.env.uat npm run cli -- data:results --round <N>
```

**Verifica finale (dopo la giornata 6):**

```bash
ENV_FILE=.env.uat npm run cli -- tournament:status        # riga "Stagione: avviata (start TC 3, 6 TC, confine 4)"
ENV_FILE=.env.uat npm run cli -- tournament:history --email alice@example.com   # righe TTnTCm (es. TT1TC3)
ENV_FILE=.env.uat npm run cli -- tournament:export
```

**Verifica rapida senza attese (dry-run).** Per controllare subito la logica
d'aggancio senza aspettare le finestre reali, usa la simulazione, che **non
vincola** la deadline del TT 1 (bypassa RF-21) ed è deterministica:

```bash
ENV_FILE=.env.uat npm run cli -- simulate:full --start-round 3
```

> **Nota sulle durate per la verifica.** Le durate (≈1h45, ≈4h45, ≈6h15) sono
> il tempo reale di una sessione con giocatori umani. In una **verifica a
> secco** della sintassi (senza attese e senza email reali) si possono
> eseguire i comandi in sequenza usando la **chiusura forzata**
> (`round:close --force --reason`) per non aspettare la deadline: il flusso
> completa comunque, perché i punteggi sono pre-seedati e `round:score` passa
> subito a `scored`. In tal caso non si esercitano le finestre di pick reali
> né l'invio email: si controlla solo che i comandi esistano e completino.

---

## 6. Scope del test mode (cosa si può dimostrare e cosa no)

### 6.1 Cosa si PUÒ dimostrare in test mode (UAT su calendario sintetico)

- **Flusso email completo:** iscrizione/disiscrizione piattaforma (due
  passi) e re-iscrizione (stesso account), risposta "già iscritto" a chi si
  re-iscrive da `active`, invio del pick (auto-join al TT1),
  conferma o rifiuto con motivazione, il tutto via Gmail reale e LLM reale.
- **Guard anti-frode su timestamp veri:** l'orologio e i timestamp di
  ricezione delle email sono reali (`TEST_OFFSET_DAYS=0`), quindi un pick
  arrivato oltre l'istante di accettazione viene rifiutato con motivo.
- **Eliminazioni:** chi non invia il pick entro la chiusura viene eliminato
  (`missing_pick`); chi sbaglia pronostico viene eliminato alla
  contabilizzazione.
- **Reset del pool** al confine di girone (andata/ritorno): le squadre tornano
  disponibili una volta superato il confine.
- **Aggancio asincrono** a un TC > 1 (RF-20): avvio del torneo da un turno di
  campionato diverso dal primo, con la mappatura **TT/TC** visibile in CLI,
  email e log (RF-25) e il **reset del pool al confine di girone** — nel
  sintetico il confine è `floor(rounds/2)+1` e l'aggancio è possibile solo
  finché la deadline del TC scelto è futura (RF-21/CL11).
- **Vincitore** (ultimo profilo rimasto, o vittoria condivisa nei casi previsti).
- **Banner e segnalazione ovunque:** `TEST MODE` in CLI, `testMode` nei JSON e
  nei log, banner nelle email inviate.

### 6.2 Cosa NON si può dimostrare nel flusso sintetico

Restano coperti dai **test automatici**, non dall'UAT su calendario sintetico
con punteggi pre-seedati:

- **pick congelati (freeze)** e **recupero di partite rinviate** (dentro/fuori
  finestra): servirebbero partite effettivamente rinviate, assenti nel
  calendario sintetico;
- **deadline NULL** (giornata mai programmata), **tranne il caso CL17** (vedi
  §6.3): nel calendario sintetico ogni giornata ha una deadline registrata;
- **anticipo di calendario** dopo l'apertura della giornata;
- **chiusura di sicurezza** (RF-30) e anomalie `warn_not_calculable`: si
  verificano quando la deadline manca o la chiusura del TC non è calcolabile;
- **flusso dati reale** (refresh dall'API): in test mode è bloccato di default
  proprio per proteggere il calendario sintetico.
- il **confine di girone reale a TC 20** della Serie A (dimostrabile solo in
  replay, vedi §7);
- l'**aggancio a un TC oltre il numero di giornate generate**: nel sintetico
  `--start-round` deve stare in `1..rounds` (un valore fuori range è rifiutato).

### 6.3 NOTA OBBLIGATORIA — guard anti-frode RF-31 (`after_kickoff`)

Il controllo anti-frode RF-31 distingue due rifiuti: `after_kickoff` (pick
arrivato **dopo il fischio d'inizio**) e `after_acceptance`/`round_not_open`
(pick arrivato **dopo la chiusura della finestra di accettazione**).

Nel **flusso cron standard** su calendario sintetico, la deadline è fissata
**30 minuti prima del fischio** (`deadline = kickoff − DEADLINE_ADVANCE_MIN`).
Appena la deadline scade, lo scheduler **chiude la giornata**. Di conseguenza,
un pick tardivo riceve **`round_not_open`** (la giornata è già chiusa prima
del fischio), **non** `after_kickoff`. Il path specifico `after_kickoff` **non
è esercitato** dal flusso cron standard: durante tutto il periodo in cui la
giornata è aperta, il pick arriva prima della deadline, che precede il fischio.

Per **dimostrare `after_kickoff`** in UAT occorre uno di questi due modi:

1. **modalità commissioner** con la giornata **lasciata aperta oltre il
   kickoff**: non chiudere alla deadline, attendere che il fischio reale passi,
   poi far inviare un pick (arriva dopo il kickoff) → rifiuto `after_kickoff`;
2. **deadline NULL (caso CL17):** la giornata resta aperta oltre il kickoff e
   la chiusura di sicurezza avviene alla chiusura del Turno Corrente
   (`kickoff + MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN`); un pick in
   `[kickoff, tcClose]` riceve `after_kickoff`.

**Non promettere copertura impossibile nel flusso cron.** In cron, il caso
"tardivo" che si vede davvero è `round_not_open`; `after_kickoff` si dimostra
solo come sopra.

---

## 7. Replay 2025 (scenario 3.1)

Per collaudare il sistema **sui dati storici della stagione 2025/26** (replay
con giocatori veri) si usa un **file env dedicato**: `.env.uat-replay`
(esempio versionato: `.env.uat-replay.example`).

**Differenze rispetto a `.env.uat`:**

- `TEST_OFFSET_DAYS=365` — sposta indietro di un anno sia l'orologio sia il
  timestamp di ricezione delle email, per ri-allineare l'ora reale alle date
  storiche. Il valore va **aggiustato** in base alla prima giornata del DB
  importato (365 va bene se la data odierna è ~un anno dopo l'inizio della
  stagione 2025/26);
- `DB_PATH=./data/uat-replay.db` — database **dedicato** e separato (NON il
  sintetico, NON quello di produzione), contenente la stagione 2025/26 reale
  importata.
- `PLATFORM_DB_PATH=./data/uat-replay-platform.db` — DB **piattaforma**
  dedicato e separato (ADR-009), distinto dal DB torneo e dal valore di
  produzione (`./data/platform.db`).

**Attivazione:**

```bash
ENV_FILE=.env.uat-replay npm run cli -- <comando>
```

**Vincoli (riepilogo):**

- `TEST_OFFSET_DAYS` > 0 si usa **solo** per il replay 2025 su DB dedicato,
  **mai** sul calendario sintetico futuro (spostare l'orologio su date future
  non ha senso e falserebbe le finestre);
- il replay usa la **stessa casella Gmail** del progetto (vedi §8);
- `TEST_REFRESH_ALLOWED=false` (default): anche in replay non si aggiorna dal
  calendario reale via API (il DB ha già la stagione storica).

**Aggancio asincrono nel replay.** Nel replay (stagione reale 2025/26 a 38 TC)
l'aggancio asincrono è il caso d'uso più naturale: `tournament:start
--start-round <n>` con `n` in `1..38`, incluso `--start-round 20` (il confine
di girone reale). Vincolo: `TEST_OFFSET_DAYS` va **tarato** perché la deadline
del TC scelto risulti **futura** rispetto all'orologio shiftato (il valore
~365 documentato sotto allinea l'inizio della stagione); `TEST_REFRESH_ALLOWED`
resta sempre `false`.

**Nota diagnostica importante (fetch vs process).** Con `TEST_OFFSET_DAYS > 0`,
lo shift del timestamp di ricezione viene applicato **solo nel
processamento** delle email (dentro `channel:email:process`), non nel fetch
grezzo. Di conseguenza:

- `channel:email:fetch` mostra i timestamp **REALI** (l'internaldate IMAP
  originale, non shiftato);
- `channel:email:process` usa internamente il timestamp **shiftato** per i
  controlli anti-frode.

Vedere timestamp diversi per la stessa email tra `fetch` e `process` è
**atteso e corretto** in replay: è il segnale che lo shift è applicato una
sola volta, nel punto giusto. L'evidenza anti-frode in replay è quindi
**derivata** (timestamp trasformato), non grezza — accettabile solo per il
replay 2025, mai per l'UAT su calendario sintetico (dove `TEST_OFFSET_DAYS=0`
e i timestamp sono reali).

---

## 8. Cleanup della casella Gmail condivisa

**Decisione (2026-08-17):** test e produzione usano la **stessa casella Gmail**
del progetto. Non c'è una casella dedicata separata. Questo significa che le
email di test finiscono nella stessa inbox di quelle di produzione e vanno
**ripulite a mano**.

**Come riconoscere le email di test.** Ogni email **inviata dal sistema** in
test mode reca in cima al corpo il banner:

```
[TEST MODE] This email was sent by a test instance of Survivor League.
```

Quindi, in casella, individua i messaggi inviati dal sistema (inviti,
conferme/rifiuti dei pick, comunicazioni di chiusura giornata) che iniziano
con `[TEST MODE]`. Le email **ricevute** dai giocatori (i loro pick) non
portano il banner (il sistema non può modificare le email in ingresso), ma si
riconoscono dal contenuto (squadre di Serie B, riferimenti alle giornate di
test) e dal fatto che sono state inviate durante la sessione di test.

**Procedura di cleanup:**

1. a **fine di ogni sessione UAT**, seleziona in casella i messaggi con
   banner `[TEST MODE]` e le relative risposte dei giocatori di test;
2. marca/elimina tali messaggi per lasciare la inbox pulita;
3. puoi verificare che non restino email non lette di test con:
   ```bash
   ENV_FILE=.env.uat npm run cli -- channel:email:fetch
   ```
   (restituisce "Nessuna email non letta in casella" quando la casella è
   pulita; è un comando di **sola lettura**, non marca nulla);
4. **comunque prima del go-live reale**, ripeti la pulizia completa della
   casella, così nessuna email di test rischia di essere confusa con
   comunicazioni di produzione.

> **Vincolo di progetto.** Il cleanup della cartella di test viene eseguito
> solo quando l'operatore lo decide esplicitamente; il sistema **non elimina
> email in automatico**.

---

## 9. Glossario (per lettori non tecnici)

| Termine | Cosa significa |
|---|---|
| **Round (giornata)** | Una singola tornata di pronostici del torneo. Ogni giocatore sceglie una squadra e un risultato prima della deadline. In questa guida "round" e "giornata" sono sinonimi. |
| **Deadline** | L'istante ultimo entro cui un pick è accettato. È posta un po' prima del fischio d'inizio della prima partita del round (`DEADLINE_ADVANCE_MIN` minuti prima). |
| **Kickoff (fischio d'inizio)** | L'orario di inizio effettivo della prima partita del round. È il riferimento per la guard anti-frode `after_kickoff`. |
| **Pick (pronostico)** | La scelta di un giocatore: una squadra + un esito (vince/pareggia/perde). Si invia via email. |
| **Seed** | L'operazione di "semina" del calendario: il comando `data:seed-synthetic` genera e carica le partite inventate (di Serie B) nel DB. |
| **Commissioner** | L'operatore che conduce a mano le fasi del torneo con i comandi CLI (modalità manuale). Da qui "modalità commissioner". |
| **Cron / Scheduler** | L'orchestrazione automatica: un job di sistema (cron) lancia `scheduler:tick` ogni minuto e il sistema apre/chiude/contabilizza le giornate da solo in base al calendario. |
| **Test mode** | Lo stato del sistema quando è attivo `TEST_MODE=true` (via `ENV_FILE=.env.uat`): segna ogni output con `TEST MODE` e abilita i parametri test-only. |
| **Banner `TEST MODE`** | La scritta `TEST MODE` che compare in CLI, nei log e (come `[TEST MODE] ...`) nelle email inviate, per distinguere subito una sessione di test. |
| **TC / TT** | "Turno Corrente" (TC) e "Turno Torneo" (TT). Il **TC** è il numero vero della giornata di campionato; il **TT** è il numero progressivo del turno nel torneo. Vale la mappatura `TT = TC − start_round + 1` (partendo da TC 3, la prima giornata di gioco è "TT1 = TC 3"). |
| **Aggancio asincrono** | L'avvio del torneo da un turno di campionato (TC) diverso dal primo, tramite `tournament:start --start-round <n>`. Le giornate prima del TC di aggancio non vengono giocate. È una **funzionalità di sistema** (in produzione il default è l'aggancio al TC 1), non del test mode. |
| **start-round / TC di aggancio** | Il turno di campionato da cui parte il torneo, che diventa il **TT1** del torneo. Con `--start-round 3`, la prima giornata di gioco è "TT1 = TC 3". |
| **TTnTCm** | Il token compatto che identifica un turno: `TT` numero del turno di torneo, `TC` numero della giornata di campionato (es. `TT2TC7` = secondo turno di gioco, agganciato alla giornata 7). Compare nell'oggetto delle email e nelle righe di `tournament:history`. |
| **Pool (rosa)** | L'insieme di squadre ancora utilizzabili da un giocatore nel girone corrente. Si resetta al confine di girone (andata/ritorno). |
| **Account piattaforma / registerID** | L'account persistente creato dall'iscrizione alla piattaforma (ADR-009): identificato da un `registerID` interno stabile (riusato a ogni re-iscrizione), con email e stato `active`/`pending_unsubscribe`/`unsubscribed`. Vive in un DB separato (`PLATFORM_DB_PATH`). |
| **Iscritto vs partecipante** | L'**iscritto** è chi ha un account piattaforma; il **partecipante** è l'iscritto che ha un `profile` nel torneo. Si diventa partecipanti **solo** inviando il primo pick valido nel TT1 (auto-join). |
| **Auto-join (RF-P5)** | L'ingresso automatico nel torneo al **primo pick valido** nel TT1: crea profilo + pick in un'unica operazione. Sostituisce la vecchia "auto-iscrizione" (RF-27, deprecata). |
| **Soft-delete / disiscrizione a due passi** | La disiscrizione non cancella l'account: lo marca `unsubscribed` (soft-delete) solo dopo una **conferma** esplicita (secondo messaggio con body `confermo`/`sì`/`si`/`yes`). Lo storico non si perde e la re-iscrizione riusa lo stesso `registerID`. |
| **UAT** | User Acceptance Test: il collaudo finale con utenti veri per accettare il sistema. |
| **Env file** | Un file di configurazione (`.env`, `.env.uat`, `.env.uat-replay`) con i parametri del sistema. Si seleziona con la variabile `ENV_FILE`. |
