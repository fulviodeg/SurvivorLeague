# Alias delle squadre — risorsa del prompt del Parser (Task 2.4)

> **Ruolo.** Risorsa del prompt dell'LLM Parser (LLD §6.2, decisione 5 del piano,
> ADR-004): aiuta l'LLM a riconoscere nei testi delle email i nomi delle squadre
> della Serie A 2025/26 e a restituirli come **esatto nome canonico**. La
> risoluzione vera la fa l'LLM; il controllo deterministico post-parse (exact
> match sulla lista da `getTeams()`) resta nel Game Engine: nessun nome
> inventato entra nello stato di gioco.
>
> **Come si usa.** Il contenuto di questo file viene iniettato nel prompt del
> Parser insieme alla lista canonica dinamica `SeasonDataProvider.getTeams()`.
> È un file editabile a mano (Markdown editoriale, nessun codice); gli alias si
> aggiungono/correggono senza toccare il sorgente.
>
> **Vincolo di correttezza.** I nomi canonici sotto devono coincidere
> esattamente con i valori `name` dell'API football-data.org, che `data:import`
> (Task 2.3) stora in `home_team`/`away_team` e che `getTeams()` restituisce:
> se la lista qui diverge, a UAT dei pick validi verrebbero rifiutati dal check
> esatto post-parse (briefing Fase 2 §1-C/§5-A). Alla prima importazione reale
> (token fornito dal PO) va verificato che i 20 nomi qui coincidano con la
> risposta dell'API. NON usare `shortName`/`tla`: il nome canonico è `name`.

## Lista canonica (nomi `name` dell'API football-data.org, stagione 2025/26)

1. Atalanta BC
2. Bologna FC 1909
3. Cagliari Calcio
4. Como 1907
5. Empoli FC
6. ACF Fiorentina
7. Genoa CFC
8. Hellas Verona FC
9. FC Internazionale Milano
10. Juventus FC
11. SS Lazio
12. US Lecce
13. AC Milan
14. AC Monza
15. SSC Napoli
16. Parma Calcio 1913
17. AS Roma
18. Torino FC
19. Udinese Calcio
20. Venezia FC

## Alias → nome canonico

| Alias (come può scrivere il giocatore) | Nome canonico |
|----------------------------------------|---------------|
| atalanta, la dea, orobici | Atalanta BC |
| bologna, rossoblu, bfc | Bologna FC 1909 |
| cagliari, isolani | Cagliari Calcio |
| como, lariani | Como 1907 |
| empoli, azzurri di empoli | Empoli FC |
| fiorentina, viola, gigliati | ACF Fiorentina |
| genoa, grifone, rossoblu di genova | Genoa CFC |
| hellas, verona, gialloblu, hellas verona | Hellas Verona FC |
| inter, l'inter, nerazzurri, milano | FC Internazionale Milano |
| juve, juventus, vecchia signora, bianconeri | Juventus FC |
| lazio, biancocelesti | SS Lazio |
| lecce, salentini, giallorossi di lecce | US Lecce |
| milan, rossoneri, diavolo | AC Milan |
| monza, biancorossi | AC Monza |
| napoli, partenopei, azzurri | SSC Napoli |
| parma, crociati, ducali | Parma Calcio 1913 |
| roma, giallorossi, capitolini | AS Roma |
| torino, granata, il toro | Torino FC |
| udinese, friulani, zebrette | Udinese Calcio |
| venezia, arancioneverdi, lagunari | Venezia FC |

## Note operative

- Il Parser deve restituire **esattamente** un nome della lista canonica; se
  l'alias non è riconducibile in modo univoco, risponde `null` (mai inventare
  nomi, mai accorciare/espandere: "Inter" → `FC Internazionale Milano`, non
  `Inter`).
- L'elisione ("l'Inter"), l'articolo ("la Roma") e le varianti minuscole/maiuscole
  non devono trarre in inganno: l'LLM le risolve verso il nome canonico; il check
  deterministico post-parse si applica sul risultato finale.
- Nuove squadre (promozioni/retrocessioni nelle stagioni successive) non richiedono
  modifiche al codice: si aggiorna la lista canonica da `getTeams()` (data-driven)
  e, se utile, si estende questa tabella.
