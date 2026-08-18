# Briefing — Fase 2 "Dati stagione" (Task 2.1–2.5)

> Documento di lavoro preparatorio per l'implementatore. Prodotto in modalità
> di sola lettura a partire da: `tasks/plan.md` (Task 2.1–2.5, decisioni 1–12),
> `docs/POC/POC_LLD.md` (§3, §4.3, §6.1, §7.2), `docs/POC/POC_PRD.md`
> (§3, §4.3–4.5, §5.3–5.4, §8 CL1/CL7/CL8/CL11–18, RF-14/20/26/31),
> `docs/decisions/architecture-decisions.md` (ADR-005/007/008), stato attuale
> di `src/` (config.ts, db/schema.ts, cli/commands/db.ts), documentazione
> ufficiale football-data.org v4 (overview, lookup tables).
>
> Obiettivo: elencare **solo** incongruenze, problemi e modifiche necessarie
> emerse dalla verifica di spec, così l'agente che implementa parte dal
> briefing senza rileggere tutto il materiale. Il briefing è **testo di
> lavoro non autorevole**: i documenti progetto (LLD/PRD) restano la fonte
> per le decisioni; dove il briefing contesta una spec, il punto va
> risolto su `plan.md`/ADR/LLD **prima o durante** l'implementazione.
>
> Data: 2026-08-14 · Stato: pronto per l'implementazione (da correggere in
> itinere le incongruenze di spec segnalate al §4).

---

## 0. Premessa ADR-008 — nessun impatto sulla Fase 2

L'aggancio asincrono (ADR-008) tocca `tournament_state.start_round`,
eligibilità, finestre di iscrizione e chiusure forzate — cioè Fasi 3–6.
Per i dati stagione è **neutro**:

- Import e derivazioni operano sull'intera stagione; la finestra torneo
  `[start_round..N]` è un filtro logico (LLD §3.2, nota ADR-008), quindi
  **nessun cambiamento** di query o confini dati.
- La colonna `start_round` è già migrata e testata (Task 1.3, db/schema.ts);
  la config `FOOTBALL_DATA_*` è già presente (Task 1.2) e coerente con
  `.env.example` e LLD §4.3.

Il requisito RF-31 (kickoff effettivo del guard anti-frode) **consuma** però
`getFirstMatchDateTime(round)` (Task 2.2): vedi il punto dedicato al Task 2.2
(§3-B), dove va fissata una semantica oggi non specificata.

---

## 1. Problemi trasversali (vale per tutti i task della Fase 2)

**A — Tipo `Match` condiviso ancora inesistente.**
L'interfaccia `Match` (LLD §6.1: `round`, `matchDate`, `homeTeam`,
`awayTeam`, `homeScore?`, `awayScore?`, `postponed`) esiste solo nel
documento: `src/data/` è vuota. Serve definire il tipo **prima** del Task
2.2, condiviso tra client (2.1 → produce), provider (2.2 → produce) e import
(2.3 → consuma/scrive). **Modifica necessaria:** definire `Match` una sola
volta (proposta: `src/data/types.ts`, oppure anticipare `src/data/provider.ts`
con `Match` + interfaccia `SeasonDataProvider`). Decidere la collocazione ora,
altrimenti alto rischio di tipo duplicato tra `football-data-client.ts` e
`db-provider.ts` (violazione della separazione di responsabilità, parte 1.3
AGENTS.md).

**B — Formato canonicale di `match_date` non specificato.**
La colonna è `TEXT NOT NULL` e il definirla in modo coerente è prerequisito
per: `MIN(match_date)` (deadline RF-14 e kickoff RF-31, LLD §3.2), l'ordinamento
lessicografico di SQLite (con offset di timezone i confronti diventano
inconsistenti) e il parsing in `Date` lato provider. **Modifica necessaria:**
adottare un unico formato canonico ISO-8601 UTC (es. `new Date(x).toISOString()`,
sempre suffisso `Z`). Scrivere in formato canonico in `data:import` (2.3) e
parsare in `DbSeasonDataProvider` (2.2). L'API restituisce `utcDate` già in
UTC → conversione minima e deterministica.

**C — Scelta del campo nome squadra non fissata (impatto su 2.2, 2.3, 2.4).**
L'API espone per ogni team `name`, `shortName`, `tla`. Il valore **storato
come `home_team`/`away_team`** diventa il nome canonico che `getTeams()`
restituisce al Parser e su cui `team-aliases.md` deve mappare con **exact
match** post-parse (LLD §6.2, decisione 5 del piano). **Modifica necessaria:**
fissare esplicitamente il campo da usare (proposta: `name`, denominazione
ufficiale es. "FC Internazionale Milano") e mantenerlo identico tra import,
canonical list e aliases. Verificare contro una risposta reale dell'API
(token del PO): se il nome reale differisce dall'atteso, `team-aliases.md`
e i fixture 2.5 vanno allineati.

**D — Correzioni di spec nei documenti (da applicare con l'implementazione).**
Le correzioni non vivono solo nel codice: `plan.md`, ADR-007 e `AGENTS.md`
vanno aggiornati perché sono documentazione viva, altrimenti il prossimo
agente/lettore re-inciampa (vedi §2 per i dettagli):
- header di throttling `X-Requests-Available` → **`X-RequestsAvailable`**;
- `X-RequestCounter-Reset` è in **secondi** (convertire in ms);
- mappatura status API completa (`matchday`, `AWARDED`, `EXTRA_TIME`,
  `PENALTY_SHOOTOUT`, `SCHEDULED/TIMED/IN_PLAY/PAUSED`).

**E — Documentazione del codice (AGENTS.md rule 5).**
Ogni file nuovo o modificato richiede header comment di file e commenti su
funzioni e parametri (scopo, input/output, logica). Vale per
`football-data-client.ts`, `db-provider.ts`, `provider.ts`, `cli/commands/data.ts`,
il loader dei fixture e `team-aliases.md` (risorsa).

**F — Retry ed errore nel client (contratto non definito).**
"max 3 retry" di plan.md è vago, e il contratto d'errore ("eccezione chiara")
è privo di classe. Da specificare nel Task 2.1 (§2) perché tutto il resto ne
dipende.

---

## 2. Task 2.1 — FootballDataClient (clic → §2 dell'analisi precedente)

**Riepilogo delle incongruenze/problemi/modifiche necessarie** (dettaglio e
fonti in basso):

2.1-1. **Nome header errato nel piano/ADR.** `plan.md:92` e ADR-007 citano
`X-Requests-Available`; la doc ufficiale definisce **`X-RequestsAvailable`**
(no hyphen interno). Leggere il nome sbagliato → `undefined` in produzione,
test verdi ma throttling morto. **Modifica:** usare `X-RequestsAvailable` e
correggere `plan.md` + ADR-007.

2.1-2. **Unità di misura `X-RequestCounter-Reset` = secondi.** L'header
riporta i secondi mancanti al reset. Passare il valore grezzo a `setTimeout`
→ attende millisecondi → **busy-loop** di retry. **Modifica:** ×1000 (ms).

2.1-3. **Enum status parzialmente coperto.** La doc definisce 11 stati:
`SCHEDULED | TIMED | IN_PLAY | PAUSED | EXTRA_TIME | PENALTY_SHOOTOUT |
FINISHED | SUSPENDED | POSTPONED | CANCELLED | AWARDED`. Il piano copre solo
`POSTPONED/SUSPENDED/CANCELLED → postponed=true` e `FINISHED → punteggi`.
Scoperti: **`AWARDED`** (forfait, punteggio fisso tipicamente 3-0: va deciso
se presentarlo come punteggio — non è `FINISHED` — altrimenti resta `pending`
per sempre); **`EXTRA_TIME`/`PENALTY_SHOOTOUT`** (in corso con punteggio:
definire il comportamento); **`SCHEDULED/TIMED/IN_PLAY/PAUSED`** (da mappare a
`postponed=false`, senza punteggio, mai crash).

2.1-4. **Il campo API non è `round` ma `matchday`.** La doc v4 è esplicita
("the typical `round` of other sports APIs … doesn't exist"). **Modifica:**
fissare la mappatura `matchday → round` nella spec e nel codice.

2.1-5. **"SA"/"2025" hardcodati nel testo del task** vs principio
config-driven (RF-19, LLD §4.3). **Modifica:** URL costruito da
`FOOTBALL_DATA_COMPETITION` e `FOOTBALL_DATA_SEASON` (config), e season resa
stringa nel query param.

2.1-6. **Semantica retry da definire.** Su quali status ritentare (429 e
transient 5xx/network), **mai** su 401/403/400 (token invalido → spreco di
rate limit), limite totale dei tentativi, timeout massimo (per non bloccare
`data:refresh` dello scheduler).

2.1-7. **Contratto d'errore.** Definire classe (es. `FootballDataError`) e
gestione di: risposta non-200 non-429, body malformato, mancanza della chiave
`matches`. Senza contratto, 2.3 incoerente con 2.1.

2.1-8. **Testabilità/iniezione.** Costruttore con parametri espliciti
`{ baseUrl, token, competition, season }` + `fetch` iniettabile; **no**
`getConfig()`/`process.env` interni (il comando 2.3 inietta la config). Il
pattern attuale (`db.ts`) usa `getConfig()` nel handler: va bene nel comando,
non nel client.

2.1-9. **Nessuna nuova dipendenza** necessaria: `fetch` nativo (Node ≥20)
copre "fetch mockato" dei test — nessuna modifica a `package.json`.

---

## 3. Task 2.2 — DbSeasonDataProvider

Interfaccia da implementare (LLD §6.1): `getCalendar`, `getResults(round)`,
`getMatchesForRound(round)`, `getFirstMatchDateTime(round)`, `getTeams`,
`getTotalRounds`. Unica implementazione in POC; legge solo dalla tabella
`match`; il Game Engine non accede mai all'API.

**A — Prerequisito tipo `Match` condiviso** (§1-A): definirlo qui (o in un
modulo condiviso) e farlo usare anche dal client 2.1.

**B — `getFirstMatchDateTime(round)` e RF-31 (kickoff effettivo) — GAP DI
SPEC.** Il valore sulla prima partita del TC serve per deadline (RF-14) e per
il guard anti-frode `min(deadline registrata, kickoff effettivo)` (RF-31,
PRD §5.3, LLD §3.1 "letto dai dati correnti al momento della valutazione").
Ma il modello dati **non ha** `rescheduled_date` e una partita rinviata può
essere la prima del TC: in quel caso il fischio "effettivo" non è noto al
sistema. **Modifica necessaria:** definire la semantica di
`getFirstMatchDateTime` per i match `postponed` (proposta: `MIN(match_date)`
**tra i match non rinviati** del round; se la sola prima partita è rinviata,
documentare come si comporta il guard RF-31, es. o si usa la prima non
rinviata o il guard si rimanda alla chiusura di sicurezza RF-30 — CL17).
Aggiornare la nota al Task 3.2 di conseguenza. (Nella realtà il fischio
effettivo non è mai noto *a priori*: il dato disponibile è quello programmato;
la regola operativa POC va esplicitata.)

**C — `getResults(round)` vs `getMatchesForRound(round)` ridondanti.** La
nota CRITICAL-02 (LLD §6.1) fa usare al Round Manager
`getMatchesForRound(round)` (o `getResults(round)`). Entrambe filtrano per
round ed espongono punteggi/postponed. **Modifica necessaria:**
non implementare metodi morti — definire chi usa cosa (proposta: mantenere
`getMatchesForRound` come primario; documentare `getResults` o rimuoverlo
dall'interfaccia se non consumato da nulla).

**D — `getTeams()` con `DISTINCT home_team` può perdere squadre.**
LLD §3.2 usa `SELECT DISTINCT home_team FROM match`. Sull'intera stagione ogni
squadra gioca in casa, ma per robustezza (e per finestre/import parziali)
conviene la UNION di `home_team` e `away_team`. **Modifica consigliata:**
`SELECT DISTINCT team FROM (SELECT home_team AS team FROM match UNION SELECT
away_team FROM match)`. I nomi devono coincidere con quelli storati da 2.3
(fissati al §1-C).

**E — Parsing date.** `matchDate: Date` dal `TEXT` del DB: dipende dal formato
canonico (§1-B). `getTotalRounds = MAX(round)` e `getCalendar` = intera
stagione: nessun filtro per la finestra torneo (era esplicitato al §0).

**F — Ordinamento task.** La verifica di 2.2 cita "fixture sintetiche
(Task 2.5)", ma 2.2 precede 2.5 nel piano: dipendenza esplicita. **Modifica
necessaria:** o si anticipa un minimo di fixture nel 2.2, o si riordina, o si
esplicita nel piano che i test 2.2 usano mini-fixture inline e 2.5 estende.
(Consiglio: skeleton `tests/fixtures` + loader nel 2.2; varianti rinvii nel
2.5.)

---

## 4. Task 2.3 — Comandi `data:*`

`data:import` (fetch API → upsert `match`, idempotente), `data:refresh`
(stessa logica, aggiorna risultati), `data:calendar`, `data:results
--round <n>` (stampe dal DB).

**A — Upsert idempotente su `PRIMARY KEY (round, home_team, away_team)`.**
La tabella non ha un id API: la chiave è la tripletta. **Accorgimenti:**
- il nome squadra deve essere **stabile tra chiamate** (stesso campo `name`,
  §1-C): altrimenti il secondo import crea duplicati;
- l'upsert deve sovrascrivere `match_date` (un rinvio recuperato cambia la
  data in `utcDate`), `postponed`, `home_score`, `away_score` — coerente con
  la regola operativa rinvii (LLD §3.1: "il recupero giocato emerge dai
  dati", nessun `rescheduled_date`);
- nessuna `DELETE` di righe assenti dall'API (fuori scope POC, ma da
  dichiarare).

**B — Mapping JSON → riga (già anticipato in 2.1-4/2.1-5/§1-B).** Da fissare:
`matchday → round`, `utcDate → match_date` (ISO-UTC), `homeTeam.name/awayTeam.name`
→ `home_team/away_team` (e non `shortName`/`tla`), `score.fullTime.home/away`
→ punteggi (definire il comportamento per `AWARDED` e `EXTRA_TIME`, §2 2.1-3),
`status → postponed` secondo la tabella §2 2.1-3.

**C — Atomicità senza stato parziale.** Su errore di rete/token rispondere
con errore chiaro **senza** aver scritto metà import: usare una transazione
(tutto o niente) o comunque rendere il fallimento esplicito e riproducibile.
Rilevante perché `data:refresh` è invocato dallo scheduler a ogni tick
(decisione 4 del piano).

**D — Config→client.** Il comando legge `getConfig()` (pattern attuale, come
`db.ts`) e **inietta** `{ baseUrl, token, competition, season }` al client
(§2 2.1-8). Niente costruzione del client dalla config dentro il client.

**E — Test.** Verifica del piano: "import popola N righe; secondo import senza
duplicati né modifiche; refresh che aggiunge un punteggio aggiorna la riga".
Coerente con A/B. Testare anche: stesso round con rinvio recuperato che cambia
`match_date` (refresh aggiorna, non inserisce).

---

## 5. Task 2.4 — `src/llm/team-aliases.md`

**A — Canonical base = nomi API esatti.** Il file è una *risorsa del prompt*
(LLD §6.2, decisione 5): la risoluzione la fa l'LLM, ma il check post-parse è
**exact match** contro `getTeams()` (= nomi storati da 2.3, §1-C). Quindi gli
alias devono mappare su **esattamente** quei nomi canonici (es. "inter" →
"FC Internazionale Milano", se `name` = quello). **Modifica necessaria:**
- elencare la canonical list dei 20 club 2025/26 così come l'API li rende
  (a titolo di attesa, i 20: Atalanta, Bologna, Cagliari, Como, Empoli,
  Fiorentina, Genoa, Hellas Verona, Inter, Juventus, Lazio, Lecce, Milan,
  Monza, Napoli, Parma, Roma, Torino, Udinese, Venezia — **da verificare** su
  una risposta reale, §1-C);
- coprire tutti i 20 nella canonical list e negli alias;
- aggiungere un test (fixture 2.5 con nomi "real-like") che verifichi che ogni
  squadra della lista aliases coincide con `getTeams()` del DB importato —
  altrimenti a UAT pick validi verrebbero rifiutati.

**B — Niente logica nel file.** Solo Markdown editoriale (header comment di
risorsa, §1-E), nessun codice.

---

## 6. Task 2.5 — Fixture sintetiche

**A — Struttura.** Mini-stagione 4 squadre → 3 round di andata + 3 di ritorno
(6 round, confine girone `ceil(6/2)=3`) per esercitare l'azzeramento del pool
(Fase 3). Ogni round = 2 partite. Caricabili nel DB in-memory con lo **stesso
formato riga** di `match` (loader condiviso, riusabile anche dai test 2.2, §3-F).

**B — CL7 vs "partita normale": identici nei dati statici.** La distinzione
CL1/CL7 è **temporale** (recupero entro/fuori la finestra del TC), ma il
modello dati non ha `rescheduled_date`: a parità di stato statico un match con
punteggio è sempre "contabilizzabile" (sia esso CL7 o normale). **Modifica
necessaria:** i casi CL7/CL1/CL8 e "frozen→valutato" richiedono **sequenze**,
non un singolo snapshot. Proposta:
- loader a **stadi** / helper di mutazione (`impostaPunteggio(round, home,
  away, ...)`, `impostaPostponed(...)`) così i test possono simulare
  import→refresh;
- scenari:
  - CL7: match `postponed` senza punteggio, poi refresh con punteggio entro
    la finestra → contabilizzato;
  - CL1: match `postponed` senza punteggio alla valutazione → `frozen`;
  - CL8: l'ultima partita programmata del round (UPP, per fine prevista)
    `postponed` senza punteggio → il TC si chiude comunque, il pick va in
    `frozen`;
  - frozen→valutato: partita giocata dopo la chiusura del TT → punteggio
    disponibile in un refresh successivo → valutazione a posteriori.

**C — Variante per RF-31.** Includere anche il caso **prima partita del TC
rinviata** (es. per fissare la semantica di `getFirstMatchDateTime`, §3-B) e
il caso "calendario anticipa una partita dopo l'apertura" (CL18) se si vuole
coprire il guard già coi fixture.

**D — Verifica del piano.** "Le fixture si caricano nel DB in-memory dei
test": ok con loader condiviso; da allineare con il §3-F sull'ordine dei task.

---

## 7. Coerenze verificate (non-problemi)

- Config già completa e allineata (Task 1.2): `FOOTBALL_DATA_TOKEN`,
  `FOOTBALL_DATA_BASE_URL`, `FOOTBALL_DATA_COMPETITION`, `FOOTBALL_DATA_SEASON`
  presenti in `config.ts` e `.env.example` → nessun task di config.
- Nessuna nuova dipendenza (fetch nativo).
- Separazione camlCase (`Match`) / snake_case (tabella `match`) corretta: la
  conversione avviene nel comando 2.3, non nel client né nel provider.
- ADR-008 neutro per la Fase 2 (§0); l'unico impatto è la semantica di
  `getFirstMatchDateTime` per RF-31 (§3-B), da fissare ora.
- `data:refresh` idempotente e invocabile dallo scheduler a ogni tick:
  compatibile col free tier (1 richiesta/tick) mitigato da throttling/retry.

---

## 8. Correzioni ai documenti da applicare in itinere

| File | Modifica |
|------|----------|
| `tasks/plan.md:92` (Task 2.1) | `X-Requests-Available` → `X-RequestsAvailable`; unità `X-RequestCounter-Reset` in secondi; aggiungere mapping status completo e `matchday → round` |
| `tasks/plan.md:96` (Task 2.2) | Semantica `getFirstMatchDateTime` per match rinviate (RF-31); dipendenza fixture/ordine |
| `docs/decisions/architecture-decisions.md` (ADR-007) | Correggere `X-Requests-Available` |
| `docs/POC/POC_LLD.md` §6.1 (o §7.2) | Nota su `matchday` e su formato `match_date`; decidere `getResults` vs `getMatchesForRound` |
| `docs/POC/POC_LLD.md` §6.2 o `AGENTS.md` se citano alias | Canonical list allineata ai nomi API |
| `AGENTS.md` §1.7 | Aggiornare lo "Stato attuale" al completamento della Fase 2 (a fine Checkpoint 2) |

---

## 9. Prompt pronti per l'agente implementatore

Prompt di base (da precorrere con qualunque task della Fase 2):
> Implementa il task <n> della Fase 2 del piano (`tasks/plan.md`) seguendo
> **prioritariamente** il briefing `tasks/briefing-fase-2.md` per le
> incongruenze/problemi/modifiche necessarie, e le sezioni LLD/PRD ivi
> citate come autorità. Prima di scrivere codice: (1) se una spec nel
> briefing è contestata, applica la correzione a `plan.md`/ADR/LLD nello
> stesso commit, (2) applica AGENTS.md rule 5 (header file e commenti
> funzioni/parametri), (3) scrivi prima i test (TDD) secondo il "Mock e
> livelli di test" di plan.md, (4) verifica con `npm run typecheck`,
> `npm run lint`, `npm test`. Non hardcodare SA/2025 e non usare
> `getConfig()` dentro il client (iniettare config dal comando).

Per task specifico:
- **2.1**: §2 del briefing (punti 2.1-1…2.1-9) + framework test con fetch
  mockato (200; 429 con header throttling; errore → eccezione chiara).
- **2.2**: §3-A…F + definisci il tipo `Match` condiviso; test su SQLite
  in-memory; documenta semantica rinvii per RF-31.
- **2.3**: §4-A…E; transazione per atomicità; verifica idempotenza e refresh
  con cambio punteggio.
- **2.4**: §5-A…B; canonical list dai nomi API + test di coincidenza con
  `getTeams()`.
- **2.5**: §6-A…D; loader a stadi + helper di mutazione; scenari CL7/CL1/CL8
  e frozen→valutato come sequenze.
