# Alias delle squadre SINTETICHE — risorsa del prompt del Parser (Task 0.4, test mode)

> **Ruolo.** Risorsa del prompt dell'LLM Parser usata SOLO in test mode (D7 del
> piano UAT): aiuta l'LLM a riconoscere nei testi delle email i nomi dei club
> di Serie B usati dal calendario sintetico e a restituirli come **esatto nome
> canonico**. La risoluzione vera la fa l'LLM; il controllo deterministico
> post-parse (exact match sulla lista da `getTeams()`) resta nel Game Engine:
> nessun nome inventato entra nello stato di gioco.
>
> **Come si usa.** Il contenuto di questo file viene iniettato nel prompt del
> Parser (al posto di `team-aliases.md`) quando `config.testMode=true`: è il
> Parser a scegliere la risorsa tramite `loadTeamAliasesFor(testMode)` (D7).
> È un file editabile a mano (Markdown editoriale, nessun codice).
>
> **NON legata all'API.** A differenza di `team-aliases.md` (Serie A 2025/26),
> questa lista NON coincide con i nomi `name` dell'API football-data.org: i nomi
> canonici qui sono quelli della costante `SYNTHETIC_TEAMS` del generatore di
> stagione sintetica (Task 1). Il vincolo di correttezza con l'API vale SOLO per
> la risorsa di produzione, non qui. La lista è **Serie B (campionato
> sintetico)**, NON Serie A.

## Lista canonica (club di Serie B 2025/26 — nomi della costante SYNTHETIC_TEAMS)

1. US Cremonese
2. Brescia Calcio
3. SSC Bari
4. US Catanzaro
5. SSC Palermo
6. Spezia Calcio
7. UC Sampdoria
8. Pisa Sporting Club

## Alias → nome canonico

| Alias (come può scrivere il giocatore) | Nome canonico |
|----------------------------------------|---------------|
| cremonese, grigiorossi | US Cremonese |
| brescia, rondinelle, biancazzurri | Brescia Calcio |
| bari, galletti, biancorossi | SSC Bari |
| catanzaro, giallorossi calabresi, aquile | US Catanzaro |
| palermo, rosanero, aquile siciliane | SSC Palermo |
| spezia, aquiligialle | Spezia Calcio |
| sampdoria, blucerchiati, samp, doria | UC Sampdoria |
| pisa, nerazzurri toscani | Pisa Sporting Club |

## Note operative

- Il Parser deve restituire **esattamente** un nome della lista canonica; se
  l'alias non è riconducibile in modo univoco, risponde `null` (mai inventare
  nomi, mai accorciare/espandere).
- **Attenzione lega (D7):** questi sono club di **Serie B** (campionato
  sintetico), NON di Serie A. L'LLM non deve confonderli con le squadre della
  Serie A reale: il contesto lega è chiarito anche nel prompt di sistema in
  test mode.
- Nuove squadre sintetiche (rosa diversa) non richiedono modifiche al codice:
  si aggiorna la costante `SYNTHETIC_TEAMS` (Task 1) e, coerentemente, questa
  tabella (la coincidenza è verificata da un test dedicato al Checkpoint B).
