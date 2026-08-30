# Alias delle squadre SINTETICHE — risorsa del prompt del Parser (Task 0.4, test mode)

> **Ruolo.** Risorsa del prompt dell'LLM Parser usata SOLO in test mode (D7 del
> piano UAT): aiuta l'LLM a riconoscere nei testi delle email i nomi dei club
> di Serie A usati dal calendario sintetico e a restituirli come **esatto nome
> canonico**. La risoluzione vera la fa l'LLM; il controllo deterministico
> post-parse (exact match sulla lista da `getTeams()`) resta nel Game Engine:
> nessun nome inventato entra nello stato di gioco.
>
> **Come si usa.** Il contenuto di questo file viene iniettato nel prompt del
> Parser (al posto di `team-aliases.md`) quando `config.testMode=true`: è il
> Parser a scegliere la risorsa tramite `loadTeamAliasesFor(testMode)` (D7).
> È un file editabile a mano (Markdown editoriale, nessun codice).
>
> **NON legata all'API.** I nomi canonici qui sono quelli della costante
> `SYNTHETIC_TEAMS` del generatore di stagione sintetica (Task 1), che per la
> stagione 2026/27 coincidono con i nomi `name` dell'API football-data.org
> delle squadre di Serie A. La lista è **Serie A (campionato sintetico)**:
> NON è la stagione reale importata, ma la stessa rosa di club usata dal
> calendario sintetico di test.

## Lista canonica (club di Serie A 2026/27 — nomi della costante SYNTHETIC_TEAMS)

1. AC Milan
2. AC Monza
3. ACF Fiorentina
4. AS Roma
5. Atalanta BC
6. Bologna FC 1909
7. Cagliari Calcio
8. Como 1907
9. FC Internazionale Milano
10. Frosinone Calcio
11. Genoa CFC
12. Juventus FC
13. Parma Calcio 1913
14. SS Lazio
15. SSC Napoli
16. Torino FC
17. US Lecce
18. US Sassuolo Calcio
19. Udinese Calcio
20. Venezia FC

## Alias → nome canonico

| Alias (come può scrivere il giocatore) | Nome canonico |
|----------------------------------------|---------------|
| milan, rossoneri, diavolo | AC Milan |
| monza, biancorossi | AC Monza |
| fiorentina, viola, gigliati | ACF Fiorentina |
| roma, giallorossi, capitolini | AS Roma |
| atalanta, la dea, orobici | Atalanta BC |
| bologna, rossoblu, bfc | Bologna FC 1909 |
| cagliari, isolani, rossoblu sardi | Cagliari Calcio |
| como, lariani | Como 1907 |
| inter, l'inter, nerazzurri, milano | FC Internazionale Milano |
| frosinone, ciociari, canarini | Frosinone Calcio |
| genoa, grifone, rossoblu di genova | Genoa CFC |
| juve, juventus, vecchia signora, bianconeri | Juventus FC |
| parma, crociati, ducali | Parma Calcio 1913 |
| lazio, biancocelesti | SS Lazio |
| napoli, partenopei, azzurri | SSC Napoli |
| torino, granata, il toro | Torino FC |
| lecce, salentini, giallorossi di lecce | US Lecce |
| sassuolo, neroverdi | US Sassuolo Calcio |
| udinese, friulani, zebrette | Udinese Calcio |
| venezia, arancioneverdi, lagunari | Venezia FC |

## Note operative

- Il Parser deve restituire **esattamente** un nome della lista canonica; se
  l'alias non è riconducibile in modo univoco, risponde `null` (mai inventare
  nomi, mai accorciare/espandere: "Inter" → `FC Internazionale Milano`, non
  `Inter`).
- **Attenzione lega (D7):** il calendario sintetico usa la rosa di **Serie A**
  (campionato sintetico). L'LLM deve risolvere verso i nomi canonici della
  lista, mai verso nomi della stagione reale importata.
- Nuove squadre sintetiche (rosa diversa) non richiedono modifiche al codice:
  si aggiorna la costante `SYNTHETIC_TEAMS` (Task 1) e, coerentemente, questa
  tabella (la coincidenza è verificata da un test dedicato al Checkpoint B).
