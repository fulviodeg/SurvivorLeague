# Review indipendente — UAT Task 1: generatore stagione sintetica

- **Data:** 2026-08-17
- **Oggetto:** `src/data/synthetic-season.ts` + `tests/unit/data/synthetic-season.test.ts` (Task 1 del piano `tasks/plan-uat-calendario-sintetico.md`)
- **Tipo:** sola lettura (nessun file di codice modificato, nessun fix eseguito)
- **Verdetto:** **PASS**

## Allineamento al piano (riassunto dell'intendimento)

Il Task 1 chiede un **modulo puro** che generi un `Match[]` per il test mode:
round-robin (circle method) con una partita a giornata per squadra, mai contro sé
stessa né duplicati intra-giornata; stessa ora per tutte le partite di una
giornata con `--spacing-min` che distanzia solo le giornate (D8); date canoniche
ISO-8601 UTC; punteggi presenti e deterministici a parità di seed (D5); wrap con
`--rounds > teams-1`; costante `SYNTHETIC_TEAMS` (8 club Serie B, D7) coerente
con la risorsa alias sintetica. La review verifica ogni acceptance criterion con
evidenza, rilancia test/typecheck/lint, ispeziona il modulo a campione, controlla
la coincidenza con la risorsa alias e l'assenza di modifiche a `src/game/*` e
alle risorse md, e la purezza del modulo.

## 1. Acceptance criteria — evidenza

| # | Criterion (Task 1) | Esito | Evidenza |
|---|---|---|---|
| 1 | Round-robin corretto: ogni squadra 1 partita/giornata, no auto-match, no duplicati intra-giornata | PASS | `tests/unit/data/synthetic-season.test.ts:76-103` (`expectValidRound` + 28 match per 7 giornate + girone completo C(8,2)=28) |
| 2 | Tutte le partite di una giornata stesso orario; giornate distanziate di `spacingMin` | PASS | `synthetic-season.test.ts:106-122` (stessa `getTime()` per giornata; delta `spacingMin*60_000`) e `synthetic-season.ts:100-102` (una sola `Date` per giornata) |
| 3 | Date future, formato canonico ISO-8601 UTC (suffisso Z) | PASS | `synthetic-season.test.ts:124-134` (regex `...T..:..:..\...Z`, `toISOString()`); serializzazione `Z` confermata in `src/data/importer.ts:63-66` (`toMatchRow` → `matchDate.toISOString()`) |
| 4 | Punteggi presenti su tutte le partite, deterministici a parità di seed | PASS | `synthetic-season.test.ts:136-149` (gol 0..3, `postponed=false`, `season() === season()`, accoppiamenti indipendenti dal seed) |
| 5 | `rounds`/`teams` configurabili; parametri validati; wrap senza auto-match | PASS | `synthetic-season.test.ts:159-176` (teams=8/rounds=10 → 40 match, PK uniche, ripetizione ciclica) + `:213-238` (validazione input invalidi) |
| 6 | `SYNTHETIC_TEAMS` ≥ 8 nomi canonici validi (Serie B), senza duplicati | PASS | `synthetic-season.ts:51-60` (8 nomi) + `synthetic-season.test.ts:60-72` |

## 2. Rilancio comandi di verifica

| Comando | Esito | Dettaglio |
|---|---|---|
| `npm run test` | **PASS** | 31 file, **339 test verdi** (di cui 20 in `synthetic-season.test.ts`, 6 in `team-aliases-synthetic.test.ts` con la coincidenza) |
| `npm run typecheck` | **PASS** | `tsc --noEmit`, exit 0 |
| `npm run lint` | **PASS** | `eslint .`, exit 0 |

Nota operativa: `npm` non è nel `PATH` di default dell'ambiente; usato il binario
via `~/.nvm/versions/node/v24.19.0/bin` (Node v24.19.0, npm 11.17.0).

## 3. Ispezione a campione di `src/data/synthetic-season.ts`

- **Header** presente (`:1-41`), in italiano, con ruolo, dipendenze, semantica
  spacing/wrap/date/punteggi e riferimenti alle decisioni D5/D7/D8. Conforme a
  AGENTS.md regola 5.
- **Commenti in italiano** su ogni funzione/parametro (`SyntheticSeasonParams`,
  `generateSyntheticSeason`, `validate`, `roundRobinPairings`, `mulberry32`,
  `rollGoals`). Conforme.
- **Conformità a `Match`** (`src/data/provider.ts:23-43`): produce `round`,
  `matchDate` (`Date`), `homeTeam`, `awayTeam`, `homeScore`, `awayScore`,
  `postponed` — tutti i campi obbligatori presenti, tipo corretto. Conforme.
- **Date ISO-8601 UTC con Z**: il modulo restituisce `Date` valide (derivate da
  `firstKickoff`); la forma canonica `Z` è ottenuta con `toISOString()` al
  momento della scrittura (`importer.ts:63-66`), identico percorso di
  `FootballDataClient`. Conforme.
- **Punteggi deterministici per seed**: PRNG `mulberry32` privato (`:202-210`),
  seed normalizzato `>>> 0`; il seed influisce solo sui gol (`rollGoals`, 0..3),
  mai sugli accoppiamenti (test `:151-156`). Conforme.
- **Matchday stesso orario**: una sola `Date` `kickoff` per giornata, condivisa da
  tutte le partite (`:100-115`). Conforme a D8.
- **Spaziatura solo tra giornate**: `kickoff = firstKickoff + (round-1)*spacingMin*60_000`
  (`:100-102`); nessun offset intra-giornata. Conforme a D8.
- **Wrap teams=8/rounds=10**: `pairings[(round-1) % pairings.length]` (`:104`), 7
  giornate base → round 8/9/10 ripetono ciclicamente round 1/2/3 senza auto-match
  né duplicati intra-giornata (verificato `:159-176`). Conforme.

## 4. Coincidenza `SYNTHETIC_TEAMS` ↔ risorsa alias sintetica

- La costante `SYNTHETIC_TEAMS` (`synthetic-season.ts:51-60`) coincide **esattamente,
  anche nell'ordine**, con la lista canonica di
  `src/llm/team-aliases-synthetic.md:24-31` (US Cremonese, Brescia Calcio, SSC Bari,
  US Catanzaro, SSC Palermo, Spezia Calcio, UC Sampdoria, Pisa Sporting Club).
- Il **test di coincidenza esiste** in
  `tests/integration/team-aliases-synthetic.test.ts:86-90` (describe
  "coincidenza con SYNTHETIC_TEAMS (Checkpoint B, Task 1)") e **passa** (6/6).
  Il test usa `.sort()` (coincidenza come insieme, ordine irrilevante): le due
  liste sono comunque identiche anche in ordine, quindi la copertura è più forte
  di quanto richiesto.

## 5. Assenza di modifiche fuori scope + purezza

- `src/game/*`: **non toccato** — grep su `synthetic|SYNTHETIC_TEAMS|Serie B|Cremonese|Catanzaro`
  non restituisce alcun match in `src/game/`.
- Risorsa md di produzione `src/llm/team-aliases.md`: **non toccata** — nessun
  riferimento a sintetico/Serie B/nomi dei club cadetti.
- Purezza del modulo: unico import è `import type { Match } from './provider.js'`
  (`synthetic-season.ts:42`); **nessun `getConfig`**, nessun `process.env`, nessun
  I/O. L'unico `new Date(` (`:100`) è un calcolo di calendario da `firstKickoff`,
  non un clock. Confermato puro.

## Osservazioni (non bloccanti)

1. **Aliasing della `Date` condivisa (basso).** Tutte le partite di una giornata
   condividono la **stessa istanza** `Date` (`synthetic-season.ts:100-115`). I
   consumer attuali (`toMatchRow` → `toISOString()`) trattano `matchDate` in sola
   lettura, quindi non è un bug oggi; un futuro consumer che muti la data ne
   propagherebbe l'effetto a tutte le partite della giornata. Se si vuole
   robustezza a costo zero, clonare (`new Date(kickoff)`) per ciascun match.
2. **"Date future" è responsabilità del chiamante.** Il modulo accetta un
   `firstKickoff` arbitrario e non impone che sia nel futuro: coerente col piano
   (il "futuro" è garantito da `--first-kickoff-offset-min` nel Task 2), ma
   segnalo che il criterion 3 è soddisfatto solo in composizione con Task 2, non
   dal modulo isolato.
3. **Test di coincidenza per-insieme, non per-ordine.** Come sopra, irrilevante
   perché le liste coincidono anche in ordine.

## Conclusione

Task 1 **conforme al piano** su tutti i punti: modulo puro, semantica spacing e
wrap corrette, punteggi deterministici, `SYNTHETIC_TEAMS` allineata alla risorsa
alias (con test di coincidenza verde), nessuna modifica a `src/game/*` o alle
risorse md. Test (339), typecheck e lint tutti verdi. Le tre osservazioni sono
minori e non richiedono modifiche per il completamento del Task 1.
