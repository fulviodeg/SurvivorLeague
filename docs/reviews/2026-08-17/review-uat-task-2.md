# Review indipendente — UAT Task 2: comando `data:seed-synthetic`

- **Data:** 2026-08-17
- **Oggetto:** `src/cli/commands/data.ts` (comando + orchestratore `seedSyntheticSeason`), `src/data/importer.ts` (helper `clearMatches`), `src/cli/index.ts` (registrazione), `tests/integration/seed-synthetic.test.ts` — Task 2 del piano `tasks/plan-uat-calendario-sintetico.md`, incluse le guardie del Task 3 (stato di gioco) implementate nella stessa funzione.
- **Tipo:** sola lettura (nessun file di codice modificato, nessun fix eseguito)
- **Verdetto:** **PASS**

## Allineamento al piano (riassunto dell'intendimento)

Il Task 2 chiede il comando `data:seed-synthetic` che genera la stagione sintetica
(Task 1) e la carica nella tabella `match` con `upsertMatches` (ADR-007), con
opzioni `--teams/--rounds/--spacing-min/--first-kickoff-offset-min/--seed/--json`,
riepilogo e output `--json`. Comportamenti richiesti (D6/D8): guardia
anti-sovrascrittura senza `--force`; `--force` senza `--clear` → WARN di calendario
misto (inglese); `--force --clear` → svuota e ri-seeda previa **guardia stato di
gioco** (Task 3: `season_started=1` o righe in `pick`/`round_state`); `--clear`
senza `--force` → rifiuto; rilevazione sovrapposizione TC (D8) con log pino
`error` in inglese; gate test-only (WARN non bloccante con `TEST_MODE=false`). La
review verifica ogni criterion con evidenza, rilancia test/typecheck/lint, ispeziona
`data.ts` e `importer.ts` a campione, verifica l'assenza di modifiche a `src/game/*`,
`synthetic-season.ts` (Task 1) e alle risorse md, e fa smoke test CLI su DB reale.

## 1. Acceptance criteria — evidenza

### Task 2

| # | Criterion | Esito | Evidenza |
|---|---|---|---|
| 1 | Comando registrato e funzionante su `DB_PATH` configurato | PASS | Registrato in `src/cli/index.ts:9,65`; smoke CLI su DB file reale: `--help` mostra `data:seed-synthetic`, seed → 28 partite, `data:calendar` mostra i club Serie B |
| 2 | Upsert idempotente sulla PK `(round, home_team, away_team)` (re-run non duplica) | PASS | `UPSERT_MATCH` con `ON CONFLICT (round, home_team, away_team) DO UPDATE` in `importer.ts:48-56`; test `seed-synthetic.test.ts:131-148` (re-run con `--force` → 28 righe, `getCalendar()` identico) |
| 3 | Output riepilogo e supporto `--json` | PASS | `SeedSyntheticSummary` (`data.ts:141-152`) con teams/rounds/matches/firstKickoff/lastKickoff/warnings; handler `--json` → `jsonWithTestMode` (`data.ts:359-361`); smoke: `{"teams":8,"rounds":7,"matches":28,...}` |
| 4 | Nomi squadre da `SYNTHETIC_TEAMS` | PASS | `data.ts:258` usa `SYNTHETIC_TEAMS.slice(0, opts.teams)`; test `:124-129` e `:346-371` (coincidenza con i primi `n` nomi) |
| 5 | Sovrapposizione TC (spacing < `MATCH_DURATION_MIN`+`TC_CLOSE_SKEW_MIN`) → log `error` in inglese con suggerimento | PASS | `data.ts:242-253` (calcolo finestra, `logger.error` inglese con `MATCH_DURATION_MIN`, `TC_CLOSE_SKEW_MIN`, `--spacing-min`); test `:269-302`; smoke CLI mostra il log `level:50` |
| 6 | `--force` senza `--clear` su non vuota → WARN inglese di calendario misto | PASS | `WARN_FORCE_WITHOUT_CLEAR` (`data.ts:116-117`) + `logger.warn` in `data.ts:238-239`; test `:177-193` (12 Serie A restano, 28 sintetiche si aggiungono, WARN livello 40) |
| 7 | `--force --clear` su non vuota → (previa guardia) svuota e ri-seeda, zero righe residue | PASS | `clearMatches` (`importer.ts:115-117`) + upsert; test `:196-209` (da 12 Serie A → 28 solo sintetiche) |
| 8 | `--clear` senza `--force` → rifiuto (doppia conferma) | PASS | `data.ts:207-211`; test `:165-175`; smoke CLI: "`--clear richiede --force (doppia conferma)`" |
| 9 | `TEST_MODE=false` → procede con WARN inglese in output e log | PASS | `WARN_SEED_OUTSIDE_TEST_MODE` (`data.ts:109-110`) + `logger.warn` in `data.ts:201-204`; test `:304-316`; smoke CLI: log `level:40` "test-only command" |

### Task 3 (guardie, implementate in `seedSyntheticSeason`)

| # | Criterion | Esito | Evidenza |
|---|---|---|---|
| 1 | Seed su `match` non vuota → errore chiaro, nessuna modifica | PASS | `data.ts:229-236` (throw con conteggio righe e suggerimento `--force`/`--force --clear`); test `:151-163` (`getCalendar()` invariato) |
| 2 | `--force` senza `--clear` supera la guardia ma NON cancella | PASS | `data.ts:237-240` (nessuna `DELETE`); test `:177-193` |
| 3 | `--force --clear` su vuota → no-op e ri-seeda | PASS | `data.ts:228` (`if (existing > 0) clearMatches`); test `:211-221` |
| 4 | `--force --clear` con `season_started=1` o righe `pick`/`round_state` → rifiuto | PASS | `data.ts:215-226`; test `:223-266` (tre casi: season_started, pick, round_state — tutti rifiutati con match invariato a 12) |
| 5 | `--force --clear` senza stato di gioco → svuota e ri-seeda | PASS | `data.ts:228` + upsert; test `:196-209` |

## 2. Rilancio comandi di verifica

| Comando | Esito | Dettaglio |
|---|---|---|
| `npm run test` | **PASS** | 32 file, **355 test verdi** (16 in `seed-synthetic.test.ts`) |
| `npm run typecheck` | **PASS** | `tsc --noEmit`, exit 0 |
| `npm run lint` | **PASS** | `eslint .`, exit 0 |

Nota operativa: `npm` non è nel `PATH` di default; usato il binario via
`~/.nvm/versions/node/v24.19.0/bin` (Node v24.19.0, npm 11.17.0).

## 3. Ispezione a campione di `src/cli/commands/data.ts`

- **Header** presente (`:1-24`), in italiano, descrive ruolo, elenco comandi
  `data:*`, pattern "la CLI inietta" e il nuovo `data:seed-synthetic`. Conforme a
  AGENTS.md regola 5.
- **Commenti in italiano** su ogni costante/opzione/funzione (`WARN_*`,
  `SeedSyntheticOptions`, `SeedSyntheticSummary`, `countRows`,
  `seedSyntheticSeason`). Conforme.
- **describe yargs documentate**: ogni opzione (`teams`, `rounds`, `spacingMin`,
  `firstKickoffOffsetMin`, `seed`, `force`, `clear`) ha `describe` con scopo e
  default (`data.ts:298-338`). Conforme.
- **`generateSyntheticSeason` con `SYNTHETIC_TEAMS.slice(0, n)`**: `data.ts:257-263`
  (inclusa la validazione `--teams` in `:193-198`). Conforme a D7.
- **Guardie anti-sovrascrittura e `--clear`/`--force`**: doppia conferma
  `:207-211`, anti-sovrascrittura `:229-236`, calendario misto `:237-240`. Conformi
  a D6.
- **Gate TEST_MODE** (`:200-204`): WARN pino (inglese) + warning nel riepilogo,
  non bloccante. Conforme a Task 2/D4.
- **Overlap D8** (`:242-253`): confronto `spacingMin < MATCH_DURATION_MIN +
  TC_CLOSE_SKEW_MIN`, `logger.error` con messaggio **in inglese** e suggerimento
  dei parametri coinvolti; è un log, NON un blocco (il seed prosegue, test
  `:269-289`). Conforme a D8 (livello `error`, non `critical`).

## 4. Ispezione di `src/data/importer.ts`

- **`clearMatches` isolato e commentato** (`importer.ts:104-117`): è l'unico punto
  che fa `DELETE FROM match`, con commento esplicito che l'import base NON fa MAI
  `DELETE`, che agisce SOLO su `match` e che è invocato SOLO dal seed con
  `--force --clear` dopo la guardia stato di gioco. Conforme.
- **`importMatches`/`upsertMatches` restano puri**: `upsertMatches`
  (`:80-88`) e `importMatches` (`:96-102`) non fanno `DELETE`, non leggono
  `getConfig()` né `process.env` (unico import: `provider.js`). Conforme a
  Task 4/separazione responsabilità.
- L'upsert è transazionale e la conversione `Match`→riga avviene prima della
  transazione (`:80-88`), invariato rispetto a prima.

## 5. Assenza di modifiche fuori scope

- `src/game/*`: **non toccato** — mtime di tutti i file `src/game/` al
  2026-08-14, precedente alla finestra Task 2 (18:37–18:40 del 2026-08-17).
- `src/data/synthetic-season.ts` (Task 1): **non ritoccato da Task 2** — mtime
  10:57 del 2026-08-17 (Task 1); nessun riferimento al seed nel modulo.
- Risorse md: `src/llm/team-aliases.md` (produzione) mtime 2026-08-14 e
  `src/llm/team-aliases-synthetic.md` mtime 10:10 del 2026-08-17 (Task 0.4): **non
  toccate da Task 2**.
- File effettivamente modificati nella finestra Task 2: `data.ts`, `importer.ts`,
  `index.ts`, `seed-synthetic.test.ts` — coerenti con "Files likely touched" del
  piano (`:391-395`).

**Caveat:** la directory **non è un repository git** (`git rev-parse` → "not a git
repository"), quindi la verifica di "non toccato" è per **mtime**, non per diff.

## Osservazioni (non bloccanti)

1. **Lingua degli errori lanciati (throw) vs vincolo `log_messages_english`.** I
   log pino (overlap `error`, WARN gate/calendario misto) sono **in inglese** come
   richiesto. Gli errori lanciati come eccezione (anti-sovrascrittura, `--clear`
   senza `--force`, guardia stato di gioco) sono **in italiano**, coerenti con il
   testo CLI esistente del repo (`"Importate X partite"`, `"Nessuna partita per il
   round X"`, ecc.). I criterion del piano richiedono l'inglese solo per i log/WARN
   pino, non per i messaggi di errore CLI; segnalo il punto per decisione esplicita
   del commissioner, non è un blocco.
2. **`--first-kickoff-offset-min` non validato.** Un valore negativo produce un
   primo fischio nel passato (comunque una `Date` valida, accettata dal generatore).
   Non è nei criterion del Task 2; se si vuole, aggiungere un controllo
   `> 0`/`≥ 0` come per `--teams`.
3. **Ordine tra overlap e validazione del generatore.** Con `--spacing-min ≤ 0` il
   check D8 emette prima il log `error` di sovrapposizione (`data.ts:242-253`), poi
   `generateSyntheticSeason` lancia `"spacingMin must be a positive number"`
   (`synthetic-season.ts:142-144`): un input invalido produce sia un log error sia
   un throw. Ininfluente per input validi.
4. **Overlap con config di produzione.** Con i default reali
   (`MATCH_DURATION_MIN=125`, `TC_CLOSE_SKEW_MIN=300`) la soglia è 425 min, quindi
   anche `--spacing-min 90` (default) emette sempre il log `error` di
   sovrapposizione: comportamento corretto per D8, ma significa che fuori dalla
   config UAT (Task 5: `5`/`10`) il comando logga sempre l'overlap. Documentato
   nel smoke test qui sopra.

## Conclusione

Task 2 (con le guardie Task 3) **conforme al piano** su tutti i punti: comando
registrato e funzionante, upsert idempotente sulla PK, riepilogo e `--json`,
nomi da `SYNTHETIC_TEAMS`, log `error` D8 in inglese con suggerimento, WARN
calendario misto e gate test-only in inglese, guardia stato di gioco su
`--force --clear`, `--clear` senza `--force` rifiutato. `clearMatches` isolato e
commentato in `importer.ts`, `importMatches`/`upsertMatches` restano puri senza
`getConfig`. Nessuna modifica a `src/game/*`, `synthetic-season.ts` (Task 1) o
alle risorse md. Test (355), typecheck e lint tutti verdi; smoke test CLI
coerente. Le quattro osservazioni sono minori e non richiedono modifiche per il
completamento del Task 2.
