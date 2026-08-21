# Piano: aggancio asincrono del torneo a un TC arbitrario (POC)

> **Stato esecuzione (2026-08-14): ESECUTO.** Task 1-5 e 8 completati — ADR-008 registrata; PRD v0.5.2 / HLD v0.4.2 / LLD v0.4.0 allineati (RF-20…31, CL11–18); migrazione additiva `tournament_state.start_round` implementata in `src/db/schema.ts` e testata su DB legacy (18 test verdi, typecheck/lint puliti); AGENTS.md §1.7 aggiornato. Task 6 (requisiti nei moduli) fuso in `tasks/plan.md` (Task 3.2/3.5/4.1/4.2/5.2/6.1/6.2/7.1/7.2 + checkpoint) — i moduli torneo/registrazione verranno implementati quando il piano principale ci arriverà; Task 7 (test dei moduli) da completare insieme al codice.

> **Origine:** analisi del requisito "avvio torneo asincrono rispetto al campionato" (conversazione 2026-08-14).
> **Nota percorso:** richiesto salvataggio in `tasks/` del progetto; i permessi di plan mode consentono solo la directory globale dei piani — l'agente esecutore può copiare questo file in `tasks/` all'inizio dell'esecuzione.
> **Relazione col piano esistente:** `tasks/plan.md` resta la roadmap di implementazione (prossimo task: 2.1 FootballDataClient). Questo piano (a) allinea prima i documenti, (b) inserisce i requisiti nei moduli torneo/registrazione **non ancora implementati**, quindi senza rework. I task documentali possono partire subito, in parallelo alla Fase 2 del piano principale.

## Decisioni bloccate (fonte di verità per l'esecuzione)

1. **Override US10:** iscrizione manuale + pick manuale fuori deadline ammessi solo con motivazione auditata (`--reason` obbligatorio, log strutturato); pick manuale solo su round corrente non contabilizzato; round già `scored` → flusso correzione CL9; nessuna retroattività multi-round; nuovo iscritto via override parte dal round corrente con pool intatto (nota fairness dichiarata nel PRD).
2. **Dati full-season:** import sempre stagione completa; le derivazioni data-driven (LLD §3.2: `MAX(round)`, confine girone `ceil(N/2)`, squadre, deadline) operano sull'intera stagione; la finestra torneo `[start_round..N]` è un filtro logico, non un dominio dati.
3. **CL12 — torneo di un solo turno (aggancio all'ultimo TC): ammesso.** Warning informativo a `tournament:start`, nessun blocco; i tre casi di vittoria (PRD §4.6) collassano naturalmente.
4. **Mappatura derivata:** `tournament_state.start_round INTEGER NULL` (NULL = TC1 legacy); `TT = TC − start_round + 1`; nessuna colonna `tt` su `pick`/`round_state`.
5. **Token display `TTnTCm`** (es. `TT2TC7`): oggetto email e CLI compatti; corpo email in forma estesa; log pino con campi strutturati `{tt, tc}`; coppia **iniettata deterministicamente nei template, mai generata dall'LLM** (ADR-004); nessun identificativo composito in POC (identità torneo first-class rimandata a Fase 1).
6. **Chiusura iscrizione automatica alla deadline del TT1** (derivazione da RF-04 + RF-13); `registration_open` resta come gate che si chiude da solo. **Ma** il commissioner dispone di chiusura forzata auditata per entrambe le finestre (decisione rivista 2026-08-14): chiusura anticipata arbitraria **o** in assenza di deadline registrata:
   - `tournament:register:close --reason <testo>` — chiude subito la finestra di iscrizione (prima della deadline TT1, o se la deadline TT1 non è registrata/non ha mai innescato l'auto-chiusura). Le finestre sono indipendenti: i pick restano accettati fino alla deadline del TT1.
   - `round:close --round <n> --force --reason <testo>` — chiude subito la finestra pick, prima della deadline o con deadline NULL. Semantica **identica** alla chiusura a deadline (PRD §4.4): consolida eliminando i profili senza pick valido (RF-13) e inviando le notifiche; non esiste "chiudi senza eliminare".
   - Regola comune: `--reason` obbligatorio e auditato per ogni chiusura forzata (stesso standard dell'override US10, decisione 1); la chiusura a scheduler (a deadline) non richiede motivazione.
   - **Invariante anti-frode (decisione 2026-08-14):** nessun pick è accettato se `receivedAt` > fischio d'inizio effettivo della prima partita del TC, **indipendentemente dalla deadline registrata**. L'istante di accettazione effettivo è `min(deadline registrata, kickoff effettivo da dati correnti)`; con la deadline nominale è ridondante (deadline = kickoff − anticipo), morde quando la deadline è NULL o errata. Si applica a pick normali e all'auto-iscrizione al TT1; rifiuto con motivo esplicito. Prevale su RF-14 se il calendario anticipa una partita dopo l'apertura del round senza intervento del commissioner (la stabilità della deadline nominale non può consentire pick a partita iniziata); rimedio = override US10 con `--reason`.
   - **Chiusura di sicurezza — consolidamento (decisione 2026-08-14):** se la deadline di un round non è registrata (`round_state.deadline` NULL) o non ha mai innescato l'auto-chiusura, lo scheduler chiude il round alla **chiusura del TC** (fine prevista UPP + scarto, PRD §5.4), ricalcolata dai dati correnti al momento del tick. Semantica identica alla chiusura a deadline (consolidamento: eliminazioni pick mancanti + notifiche); l'evento è loggato come `safety_close` con causa esplicita (`deadline_missing`). Stessa regola per la finestra di iscrizione (agganciata alla deadline del TT1). Il consolidamento tardivo non crea rischio di pick spuri perché l'accettazione è già bloccata dall'invariante anti-frode. Se nemmeno la chiusura TC è calcolabile dai dati → nessuna auto-chiusura, log warn + anomalia in `tournament:status`, uscita = chiusura forzata del commissioner. La chiusura di sicurezza non richiede `--reason` (non è un override: è il comportamento nominale di fallback).
   - US9 già ammette l'invocazione fuori calendario (PRD riga 442): il requisito la formalizza con audit obbligatorio.
7. **Auto-iscrizione al primo pick (RF-27):** durante la finestra TT1, un pick da indirizzo sconosciuto interpretabile (squadra+esito estratti) → creazione atomica profilo + validazione pick, risposta unica (iscrizione + esito pick). Messaggio non interpretabile (CL5) → richiesta chiarimento **senza** registrazione (opzione b). Dopo deadline TT1: pick da sconosciuto respinto senza registrazione (RF-24). Flusso iscrizione dedicato (§4.1) resta e condivide lo stesso gate.
8. **Seam eligibilità:** `checkEligibility(identity: ExternalIdentity) → { eligible: boolean; reason?: string }` nel Game Engine, gate pre-registrazione; `ExternalIdentity { channel, identifier }` normalizzata dal ChannelAdapter (POC: `{channel:'email', identifier:<email>}`); implementazione POC sempre `true` + log; Fase 1: controllo quota (`ENTRY_FEE_EUR` già placeholder in `src/config.ts:49`); override US10 passa per la stessa funzione con esito forzabile + motivo. Riformulare "l'email è l'identificativo del giocatore" (PRD §2, RF-02, §4.1) in "l'identità è fornita dal canale; nella POC il canale è l'email".

## Requisiti nuovi/modificati (da scrivere nei documenti)

- **Nuovi RF:** RF-20 aggancio (`tournament:start --start-round <n>`, default 1), RF-21 validazione aggancio (TC esistente, con partite, deadline futura; rifiuto atomico senza stato parziale), RF-22 finestra iscrizione = [apertura torneo, deadline TT1], RF-23 primo TT si apre all'apertura del torneo, RF-24 non iscritto alla deadline TT1 = non partecipante (mai profilo; nessun `eliminated_reason` nuovo), RF-25 mappatura TT↔TC in ogni comunicazione/log/CLI, RF-26 fine torneo su finestra `[n..N]`, RF-27 auto-iscrizione al primo pick, RF-28 chiusura forzata finestra iscrizione (`tournament:register:close --reason`, anticipata o senza deadline), RF-29 chiusura forzata finestra pick (`round:close --force --reason`, stessa semantica della chiusura a deadline), RF-30 chiusura di sicurezza (consolidamento): senza deadline registrata lo scheduler chiude alla chiusura del TC (fine prevista UPP + scarto), semantica identica, log `safety_close` con causa; se non calcolabile → warn + anomalia in status (uscita: RF-28/RF-29), RF-31 invariante anti-frode: nessun pick accettato dopo il fischio d'inizio effettivo della prima partita del TC (accettazione = `min(deadline registrata, kickoff)`; prevale su RF-14 in caso di anticipo non gestito; rifiuto motivato; rimedio US10 con `--reason`).
- **CL modificati/nuovi:** CL2 riscritto (auto-iscrizione invece di rifiuto+istruzioni, solo TT1); CL11 aggancio a TC passato/in corso → rifiuto; CL12 torneo un turno ammesso (warning); CL13 aggancio su confine girone (TC20): pool azzerato, regole invariate; CL14 aggancio oltre metà stagione: solo girone ritorno, disponibilità squadre garantita; CL15 freeze invariato; CL16 iscritto senza pick al TT1 → eliminato `missing_pick`; CL17 deadline mancante/non registrata → guard anti-frode blocca pick dopo il fischio d'inizio (RF-31), consolidamento via chiusura di sicurezza alla chiusura del TC (RF-30); se non calcolabile → warn + `tournament:status` + chiusura forzata commissioner (RF-28/RF-29); CL18 calendario anticipa una partita dopo l'apertura del round → la deadline nominale resta fissa (RF-14) ma il guard anti-frode rifiuta i pick dopo il kickoff effettivo (RF-31); il commissioner decide (US10).
- **Risolte:** PRD §13 domanda aperta 1 (istante apertura primo TT = apertura torneo).

## Task (ordinati per dipendenza)

### Task 1 — ADR-008
- **Contenuto:** mappatura TT↔TC derivata da `start_round` (vs colonna persistita); chiusura iscrizione = deadline TT1 con chiusure forzate auditate e **chiusura di sicurezza + invariante anti-frode al kickoff effettivo** (decisione 6 rivista, RF-28/29/30/31); seam eligibilità su `ExternalIdentity` con impl POC vuota; override US10 auditato con `--reason`. Formato: append-only, come ADR-001…007.
- **File:** `docs/decisions/architecture-decisions.md`
- **Verifica:** coerenza formato con ADR esistenti; status/context/decision/alternatives/consequences presenti.

### Task 2 — Allineamento PRD
- **Contenuto:** §2 glossario (aggancio/ancora TC, ExternalIdentity, token `TTnTCm`; riformula "email = identificativo"); §4.1 (finestra iscrizione fusa nella finestra pick TT1; auto-iscrizione; messaggi di rifiuto post-deadline "torneo iniziato a TT1/TCn"); §4.2 (apertura primo TT all'apertura torneo); §4.3 (sostituire comportamento pick-da-non-iscritto); US1 (criteri: auto-iscrizione, CL5 senza registrazione); US6 (parametro aggancio, validazioni RF-21, CL12 warning); US7 (apertura = apertura torneo); US8 (chiusura automatica a deadline TT1 **più** comando di chiusura forzata auditata `tournament:register:close --reason` — non più "superseded"); US9 (esplicitare chiusura pick forzata `round:close --force --reason` con semantica di consolidamento identica alla deadline, **più chiusura di sicurezza alla chiusura del TC se la deadline manca** e guard anti-frode al kickoff effettivo, §4.3/§4.4/§5.3/§5.4); US10 (override con `--reason`, confini temporali, no retroattività, nota fairness — anche rimedio per pick rifiutati dal guard anti-frode); CL2 riscritto + CL11–18; tabella RF-20…31; §12 decisioni PO; §13 (Q1 risolta).
- **File:** `docs/POC/POC_PRD.md` (+ changelog versione)
- **Verifica:** nessun riferimento residuo a "chiusura manuale fase iscrizione" come operazione autonoma; tracciabilità RF↔US↔CL coerente (§11).

### Task 3 — Allineamento HLD
- **Contenuto:** sequence diagram invio pick: ramo "profilo non iscritto" al TT1 → creazione profilo + validazione (non più solo rifiuto); diagrammi flusso iscrizione/apertura con finestra agganciata; nota coppia (tt, tc) in tutte le comunicazioni; nota scheduler Fase 1 su finestra `[start_round..N]`.
- **File:** `docs/POC/POC_HLD.md`
- **Verifica:** diagrammi mermaid validi; coerenza con PRD §4.

### Task 4 — Allineamento LLD
- **Contenuto:** §3 schema (`tournament_state.start_round INTEGER NULL`; **strategia migrazione additiva**: `migrate()` oggi usa solo `CREATE TABLE IF NOT EXISTS` — aggiungere `ALTER TABLE … ADD COLUMN` idempotente o migrazione versionata minima, da decidere in sede LLD); §3.1 (vincoli validazione aggancio; **nuovo vincolo applicativo: accettazione pick = `min(deadline registrata, fischio d'inizio effettivo prima partita del TC)`**); §3.2 (nota: derivazioni su stagione completa, finestra = filtro); §6 (nuova sottosezione interfaccia eligibilità: contratto, impl POC, nota Fase 1); §1.1 (innesto eligibilità e guard anti-frode nel Pick Processor; iniezione deterministica coppia tt/tc nei template); §7.10 (sintassi `tournament:start --start-round <n>`, `tournament:register --reason`, `pick:register --reason`, `tournament:register:close --reason`; output con coppia TT/TC); §7.3 (`round:close --force --reason`); §1.4 (comportamento scheduler: chiusura a deadline, **chiusura di sicurezza alla chiusura TC se deadline NULL — ricalcolo dai dati correnti —**, warn + anomalia se non calcolabile, log `safety_close`); §8 (casi test, elenco sotto).
- **File:** `docs/POC/POC_LLD.md`
- **Verifica:** coerenza con ADR-008 e PRD; nessun valore hardcodato in contraddizione con §3.2.

### Task 5 — Schema: colonna `start_round`
- **Contenuto:** implementare la migrazione additiva decisa al Task 4; aggiornare commenti header (AGENTS.md §5).
- **File:** `src/db/schema.ts`, test migrazione (idempotenza su DB esistente senza colonna)
- **Verifica:** `npm run test`, `npm run typecheck`, `npm run lint`; `db:migrate` su DB pre-esistente aggiunge la colonna senza perdere dati.

### Task 6 — Requisiti nei moduli torneo/registrazione (da fondere nel piano principale)
- **Contenuto:** aggiornare i task di `tasks/plan.md` che implementano `tournament:*`, registrazione, round manager, pick processor, template email e simulate per includere: parametro aggancio + validazioni; chiusura automatica iscrizione a deadline TT1 + comandi di chiusura forzata auditata (`tournament:register:close --reason`, `round:close --force --reason`); auto-iscrizione RF-27; seam eligibilità (interfaccia + impl POC); guard anti-frode accettazione pick (RF-31, LLD §3.1); chiusura di sicurezza dello scheduler (RF-30, LLD §1.4); coppia TT/TC in email/CLI/log (iniettata, non LLM); `simulate` con offset di partenza.
- **File:** `tasks/plan.md` (riferimenti), poi codice quando il piano principale arriva ai moduli
- **Verifica:** checkpoint del piano principale aggiornati con i nuovi criteri.

### Task 7 — Test (quando il codice esiste)
- **Casi:** aggancio a metà girone; aggancio a TC20 (confine girone); aggancio a TC38 con i tre esiti di vittoria; aggancio a TC passato/in corso → rifiuto atomico; chiusura iscrizione automatica alla deadline TT1; chiusura forzata iscrizione anticipata (pick ancora accettati fino a deadline, iscrizioni respinte); chiusura forzata finestra pick anticipata (consolidamento immediato + notifiche); auto-iscrizione + pick valido in un messaggio; auto-iscrizione + pick invalido + retry entro deadline; messaggio non interpretabile → chiarimento senza profilo creato; pick da sconosciuto dopo deadline TT1 → respinto senza registrazione; unicità profilo su invii concorrenti (RNF2); **guard anti-frode:** pick dopo fischio d'inizio effettivo con deadline NULL → respinto; pick dopo kickoff effettivo con deadline nominale più tardi (anticipo calendario, CL18) → respinto, rimedio override US10; auto-iscrizione dopo kickoff → respinta; **chiusura di sicurezza:** deadline NULL → consolidamento alla chiusura del TC con log `safety_close`, nessun pick accettato nel frattempo; chiusura TC non calcolabile → warn + anomalia in status, nessuna auto-chiusura; coppia (tt, tc) presente in email/log/CLI; eligibilità invocata e loggata; override con `--reason` auditato; regressione simulazione full-season da TC1 (CS3).
- **Verifica:** `npm run test` verde; copertura LLD §8 aggiornata.

### Task 8 — Stato progetto
- **Contenuto:** aggiornare AGENTS.md §1.7 (requisito assorbito, ADR-008, stato avanzamento) e §1.6 se cambia la mappa documenti.
- **File:** `AGENTS.md`
- **Verifica:** coerenza con la documentation map.

## Rischi e mitigazioni

- **Migrazione additiva** (Task 5): la strategia `CREATE TABLE IF NOT EXISTS` non aggiunge colonne a DB esistenti → decidere in Task 4 tra `ALTER TABLE` idempotente o versioning minimo; testare su DB pre-esistente.
- **Deriva CL2:** il comportamento auto-iscrizione vale **solo** nel TT1; dal TT2 un pick da sconosciuto è respinto (fase chiusa). Scriverlo esplicitamente in CL2 e nei test per evitare estensioni accidentali.
- **Coppia tt/tc via LLM:** vincolo assoluto di iniezione deterministica (ADR-004); aggiungere test che il numero nel testo email provenga dai dati.
- **Fairness override:** dichiarata nel PRD (pool intatto per ingressi tardivi manuali), mitigazione = audit obbligatorio, non vincolo tecnico.
- **Interazione RF-14/RF-31:** deadline nominale fissa all'apertura vs guard anti-frode al kickoff effettivo — in caso di anticipo di calendario non gestito prevale il guard (CL18): documentare la precedenza in PRD §5.3 e LLD §3.1, testare il rifiuto e il rimedio via override.
- **Eliminazioni anticipate da chiusura forzata:** `round:close --force` elimina subito i profili senza pick — decisione del commissioner irreversibile di fatto; mitigazione = `--reason` obbligatorio + audit + notifiche ai giocatori.

## Fuori scope (esplicito)

- Identità torneo composita/multi-torneo (Fase 1, PRD §10).
- Implementazione reale del controllo quota (Fase 1): in POC solo seam vuota.
- Tabella `player_identity` multi-canale (Fase 1).

## Domande aperte

Nessuna: le 8 decisioni sono bloccate. Unico punto esecutivo rimandato al Task 4: scelta tecnica della migrazione additiva (`ALTER TABLE` idempotente vs versioning).
