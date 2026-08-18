# Review indipendente — UAT Task 3: guardie anti-sovrascrittura e stato di gioco (chiusura Checkpoint B)

- **Data:** 2026-08-17
- **Oggetto:** `src/cli/commands/data.ts` (orchestratore `seedSyntheticSeason`), `src/data/importer.ts` (helper `clearMatches`), `tests/integration/seed-synthetic.test.ts` — Task 3 del piano `tasks/plan-uat-calendario-sintetico.md` + chiusura del Checkpoint B
- **Tipo:** verifica con evidenza + smoke test CLI su DB di prova; **nessun file di codice modificato** (gap trovati: 0 — le due guardie vivono già in `seedSyntheticSeason`, implementate nel corpo del Task 2 e qui formalizzate/verificate)
- **Verdetto:** **PASS**

## Allineamento al piano (riassunto dell'intendimento)

Il Task 3 (scope XS, dipendenza Task 2) formalizza **due guardie distinte** che il
Task 2 descrive già nel corpo del comando `data:seed-synthetic` (§0.1 D6):

1. **Anti-sovrascrittura (base):** il seed rifiuta senza effetti se la tabella
   `match` è già popolata, salvo `--force`. Il `--force` NON cancella (l'upsert
   non fa `DELETE`): senza `--clear` le righe pre-esistenti restano e il
   calendario può diventare MISTO (WARN, Task 2); per svuotare e ri-seedare serve
   `--force --clear`.
2. **Stato di gioco (per `--clear`):** prima del `DELETE FROM match` con
   `--force --clear`, rifiutare se `tournament_state.season_started=1` o se
   esistono righe in `pick`/`round_state` (il `DELETE` lascerebbe orfani i
   pronostici e lo stato dei round → DB inconsistente).

Il compito di questa verifica non è re-implementare le guardie (già presenti), ma
verificarne l'adesione ai 5 acceptance criterion con evidenza di test e smoke CLI,
e chiudere il Checkpoint B. Aggiunte di codice previste solo in presenza di un
criterion privo di test dedicato o di un comportamento mancante: **nessuna
necessaria** (gap: 0).

## 1. Acceptance criteria — evidenza

| # | Criterion (Task 3) | Esito | Evidenza |
|---|---|---|---|
| 1 | Seed su `match` non vuota → errore chiaro, nessuna modifica | PASS | `data.ts:229-236` (throw con conteggio righe + suggerimento `--force`/`--force --clear`); test `seed-synthetic.test.ts:152-163` (`getCalendar()` invariato); smoke CLI: `La tabella match non è vuota (28 righe)…`, exit 1, 28 righe invariate |
| 2 | `--force` senza `--clear` supera la guardia ma NON cancella le righe esistenti (WARN calendario misto, Task 2) | PASS | `data.ts:237-240` (`WARN_FORCE_WITHOUT_CLEAR` a `data.ts:116-117` + `logger.warn`, nessuna `DELETE`); test `:177-193` (12 righe Serie A restano, +28 sintetiche = 40, WARN pino livello 40 "mixed") |
| 3 | `--force --clear` su tabella vuota → svuota (no-op) e ri-seeda | PASS | `data.ts:228` (`if (existing > 0) clearMatches(db)` → su vuota nessuna `DELETE`); test `:211-221` (28 partite, `warnings` vuoto) |
| 4 | `--force --clear` su non vuota CON `season_started=1` o righe in `pick`/`round_state` → rifiuto esplicito con il motivo | PASS | `data.ts:215-226` (guardia stato di gioco); test `:223-235` (season_started), `:237-252` (pick), `:254-266` (round_state) — tutti rifiutati con match invariato a 12; smoke CLI `season_started=1`: `Rifiuto --clear: stato di gioco presente…`, exit 1, 28 righe invariate |
| 5 | `--force --clear` su non vuota SENZA stato di gioco → `match` svuotata e ri-seedata (zero righe residue) | PASS | `data.ts:228` + `upsertMatches`; test `:196-209` (da 12 Serie A → 28 solo sintetiche); smoke CLI: 29 righe (28 sintetiche + 1 Serie A spuria) → 28 righe, **0 Serie A residue**, solo 8 club Serie B |

## 2. Rilancio comandi di verifica

| Comando | Esito | Dettaglio |
|---|---|---|
| `npm run test` | **PASS** | 32 file, **355 test verdi** (16 in `seed-synthetic.test.ts`, 20 in `synthetic-season.test.ts` per il Checkpoint B) |
| `npm run typecheck` | **PASS** | `tsc --noEmit`, exit 0 |
| `npm run lint` | **PASS** | `eslint .`, exit 0 |

Nota operativa: `npm` non è nel `PATH` di default dell'ambiente; usato il binario
via `~/.nvm/versions/node/v24.19.0/bin` (Node v24.19.0, npm 11.17.0).

## 3. Smoke test CLI su DB di prova (scenari richiesti dalla verifica)

Eseguito su DB isolato `/tmp/kilo/uat-task3.db` (mai sui DB del repo `data/*`),
con `DB_PATH` inline e `TEST_MODE=true`. Sequenza e risultati:

| # | Scenario | Comando | Output reale / esito |
|---|---|---|---|
| 1 | Seed su DB vuoto | `data:seed-synthetic` | `Seed completato: 8 squadre, 7 giornate, 28 partite`, exit 0 |
| 2 | Seed senza `--force` su DB popolato (28 righe) | `data:seed-synthetic` | `La tabella match non è vuota (28 righe): il seed sintetico non sovrascrive…`, exit 1, match invariato (28) |
| 3 | `--clear` senza `--force` | `data:seed-synthetic --clear` | `--clear richiede --force (doppia conferma)…`, exit 1, match invariato (28) |
| 4 | `--force --clear` con `season_started=1` | `data:seed-synthetic --force --clear` | `Rifiuto --clear: stato di gioco presente (season_started=1 oppure righe in pick/round_state)…`, exit 1, match invariato (28) |
| 5 | `--force --clear` su DB popolato senza stato di gioco | `data:seed-synthetic --force --clear` | Seed completato (28); dopo: 28 righe, **0 righe Serie A residue**, solo 8 club Serie B |
| 6 | `data:calendar` su DB seedato | `data:calendar` | Banner `TEST MODE` + `R1 2026-08-17T18:55:54.742Z Brescia Calcio 3-2 UC Sampdoria`, `R1 … SSC Bari 0-2 Spezia Calcio` |

Nota sullo scenario 4: la guardia legge `SELECT season_started FROM
tournament_state WHERE id = 1`; su un DB appena migrato **non esiste ancora la
riga** `id=1` (viene creata da `tournament:start`), quindi il test ha richiesto
`INSERT INTO tournament_state (id, season_started) VALUES (1, 1)` per simulare il
torneo avviato — un `UPDATE` senza riga sarebbe un no-op (vedi Osservazioni).

## 4. Ispezione a campione di `src/cli/commands/data.ts`

- **Le guardie vivono NEL comando** (`seedSyntheticSeason`, `data.ts:185-279`),
  non nei moduli dati: il comando legge `getConfig()` e inietta tutto; nessuna
  logica di dominio spostata fuori dalla CLI. Conforme al vincolo "guardie nel
  comando, `importMatches`/`upsertMatches`/`clearMatches` restano puri".
- **Ordine delle guardie** dentro `seedSyntheticSeason`: (0) validazione
  `--teams` `:193-198`; (1) gate test-only WARN `:201-204`; (2) doppia conferma
  `--clear`→`--force` `:207-211`; (3) guardia stato di gioco nel ramo `--clear`
  `:215-226`; (4a) anti-sovrascrittura `:229-236`; (4b) WARN calendario misto
  `:237-240`; (5) overlap D8 `:242-253`; (6) generazione+upsert `:256-264`.
- **Guardia stato di gioco** (`:215-226`): legge `season_started` da
  `tournament_state WHERE id=1` (assente → `(state?.started ?? 0) === 1` falso =
  torneo non avviato) e conta `pick`/`round_state` via `countRows` (`:159-162`,
  nomi tabella letterali fissi, non input utente → nessuna SQL injection).
- **`clearMatches` invocato solo con `existing > 0`** (`:228`): su tabella vuota
  è un no-op (nessuna `DELETE` superflua), coerente col criterion 3.
- **Messaggi:** errori `throw` in italiano (coerenti col testo CLI del repo);
  WARN/error pino in inglese (`WARN_SEED_OUTSIDE_TEST_MODE`,
  `WARN_FORCE_WITHOUT_CLEAR`, overlap D8). Conforme al vincolo
  `log_messages_english` (inglese SOLO per log/WARN pino).

## 5. Ispezione di `src/data/importer.ts`

- **`clearMatches` isolato e commentato** (`importer.ts:104-117`): unico punto del
  livello dati che esegue `DELETE FROM match`, con commento esplicito che l'import
  base NON fa MAI `DELETE`, che agisce SOLO su `match` e che è invocato SOLO dal
  seed con `--force --clear` dopo la guardia stato di gioco. Conforme.
- **`importMatches`/`upsertMatches` restano puri**: nessuna `DELETE`, nessun
  `getConfig()`/`process.env` (unico import `provider.js`). Verificato con grep
  (vedi §6).

## 6. Assenza di modifiche fuori scope

- **`DELETE FROM match`**: unica occorrenza in `src/` → `src/data/importer.ts:116`.
- **`getConfig`/`process.env` in `src/data/*`**: assenti come chiamate (l'unico
  match è un commento in `football-data-client.ts:12-13` che *nega* l'uso del
  pattern, nessuna invocazione reale).
- **`clearMatches`**: definito in `importer.ts:115`, invocato solo in
  `src/cli/commands/data.ts:228`.
- **`src/game/*`**: non toccato — mtime di tutti i file al **2026-08-14**,
  precedente alla finestra Task 2/3.
- **`src/data/synthetic-season.ts`** (Task 1): non ritoccato — mtime 10:57 del
  2026-08-17 (Task 1).
- **Risorse md**: `src/llm/team-aliases.md` (produzione) mtime 2026-08-14;
  `src/llm/team-aliases-synthetic.md` mtime 10:10 del 2026-08-17 (Task 0.4) — non
  toccate.
- **File Task 2/3**: `data.ts` (18:39), `importer.ts` (18:37), `index.ts` (18:39),
  `seed-synthetic.test.ts` (18:40) — coerenti con "Files likely touched" del
  piano (`:431-433`).

**Caveat:** la directory **non è un repository git** (`git rev-parse` → "not a git
repository"), quindi la verifica di "non toccato" è per **mtime/grep**, non per diff.

## 7. Chiusura Checkpoint B

| Voce Checkpoint B | Esito | Evidenza |
|---|---|---|
| `data:seed-synthetic` + `data:calendar` da CLI su DB di prova | ✅ | Smoke §3 scenari 1 e 6 |
| Guardia anti-sovrascrittura (rifiuto senza `--force`) | ✅ | Criterion 1 + smoke §3 scenario 2 |
| `--force` senza `--clear` su DB popolato → WARN misto; `--force --clear` → svuota e ri-seeda | ✅ | Criterion 2 (test `:177-193`) e 5 (test `:196-209` + smoke §3 scenario 5) |
| `--force --clear` rifiutato se `season_started=1` o righe in `pick`/`round_state` | ✅ | Criterion 4 (test `:223-266` + smoke §3 scenario 4) |
| Generatore: tutte le partite di una giornata stesso orario; `--rounds > teams-1` wrap senza auto-match (test) | ✅ | `synthetic-season.test.ts:106-122` (stessa `getTime()` per giornata) e `:159-176` (teams=8/rounds=10, PK uniche, no auto-match) — 20/20 verdi |
| `npm run test`, typecheck e lint verdi | ✅ | §2: 355/355, exit 0, exit 0 |

## Osservazioni (non bloccanti)

1. **`tournament_state` vuoto su DB fresco ⇒ guardia "non avviato".** La guardia
   stato di gioco interpreta l'assenza della riga `id=1` come `season_started=0`
   (torneo non avviato): comportamento corretto (la riga è creata da
   `tournament:start`), ma è un dettaglio non ovvio: chi fa smoke test su un DB
   appena migrato e vuole verificare il rifiuto per `season_started=1` deve
   inserire esplicitamente la riga `(id=1, season_started=1)`, non fare un
   `UPDATE`. Non è un difetto.
2. **Ordine guardia-stato-di-gioco vs log overlap D8.** Con `--force --clear` su
   DB con stato di gioco, il rifiuto avviene (`data.ts:215-226`) PRIMA del log
   `error` di sovrapposizione (`:242-253`): il seed rifiuta senza emettere il log
   overlap. Coerente (si rifiuta prima di arrivare alla rilevazione), ma degno di
   nota per chi legge i log.
3. **Conservatività della guardia `pick`/`round_state`.** La guardia conta
   QUALSIASI riga in `pick`/`round_state` (non solo quelle legate alle partite che
   verrebbero cancellate): più restrittiva del minimo necessario, ma è la scelta
   corretta e sicura per il caso peggiore (un `--clear` su torneo in corso).
4. **Rilevanza delle osservazioni della review Task 2 per il Task 3: nessuna.**
   (1) errori `throw` in italiano = coerenti col testo CLI, il piano impone
   l'inglese solo per i log/WARN pino; (2) validazione `--first-kickoff-offset-min`
   non è criterion del Task 3; (3) ordine overlap/validazione e (4) overlap coi
   default di produzione non toccano le due guardie.

## Conclusione

Task 3 **conforme al piano** su tutti i punti: le due guardie (anti-sovrascrittura
e stato di gioco) vivono in `seedSyntheticSeason` (`src/cli/commands/data.ts`),
`clearMatches` è l'unico `DELETE` isolato e commentato in `src/data/importer.ts`,
le guardie restano nel comando (nessun `getConfig()` nei moduli dati). Tutti i 5
criterion mappano a test dedicati (`tests/integration/seed-synthetic.test.ts`) e
sono stati ri-verificati con smoke test CLI sui quattro scenari richiesti. Test
(355), typecheck e lint verdi. Checkpoint B chiuso. **Nessun file di codice
modificato** (gap: 0).
