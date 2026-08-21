# Brainstorming — come testare il sistema nella sua interezza (UAT pre-produzione)

> Ruolo: documento di lavoro (non normativo) che raccoglie il brainstorming
> del 2026-08-14 (sessione Ask, commissioner) su come collaudare la POC
> end-to-end — engine + canale email + LLM + scheduler — PRIMA del campionato
> reale 2026/27. Non è un documento di specifica: le decisioni finali vanno
> confermate col PO/commissioner e, se adottate, registrate nei documenti
> normativi (PRD/HLD/LLD/ADR) e in agent-context/current-status.md.
> Stato: bozza di lavoro.

## 1. Contesto e obiettivo

- La POC è completa (Checkpoint 5, 261 test verdi, typecheck/lint puliti):
  engine, data, LLM, canale email, simulazione (CS3: 38/38 TC scored; RNF1:
  determinismo), scheduler.
- L'engine è già coperto dai test automatici e dalla simulazione full-season.
  Quello che l'UAT end-to-end deve aggiungere è: canale email reale
  (IMAP/SMTP), LLM reale, router, e orchestrazione con l'orologio reale.
- Obiettivo: il sistema deve essere pronto e GIÀ TESTATO NELLA SUA INTEREZZA
  quando comincerà il prossimo campionato (2026/27).

## 2. Il problema di fondo: due orologi

Con dati storici 2025/26 e orologio reale (oggi = 14-08-2026) il sistema
confronta sempre due orologi: il calendario (2025) e il tempo reale (2026).
Il calendario è sempre "ieri", quindi ogni evento reale arriva "in ritardo":

| Regola | In produzione | Con dati 2025 |
|--------|---------------|---------------|
| RF-21 (avvio) | rifiuta se la deadline del TT1 non è futura | tutte le deadline sono passate → il torneo NON parte |
| RF-31 (guard anti-frode pick) | accetta il pick se `receivedAt` (internaldate IMAP, reale) <= min(deadline, kickoff) | ogni email arriva dopo la deadline 2025 → pick rifiutato (after_acceptance/after_kickoff) |
| Scheduler | agisce quando scadono le deadline | vede tutto scaduto → chiuderebbe/valuterebbe tutta la stagione in pochi tick |

Queste regole non sono bug: sono il cuore del gioco (un pick dopo il fischio
d'inizio è un imbroglio). Con dati storici vengono violate in continuazione
dalle email vere. La simulazione funziona perché NON usa l'orologio reale:
si inventa un "adesso" interno derivato dai dati (R2). Un'email vera non può
"arrivare nel 2025".

## 3. Strade emerse

### 3.1 Test-mode con orologio finto (proposta commissioner)
Facciamo credere al sistema che oggi sia il 2025 (es. clock offset globale,
TEST_NOW).
- Fattibilità: il clock è già iniettabile (`ctx.now`), quindi l'offset è facile.
- Problema: il canale email rompe l'illusione — `receivedAt` viene dal server
  IMAP (internaldate, ADR-001) ed è sempre il 2026 vero. Per accettare i pick
  bisognerebbe falsificare `receivedAt` nel processore email → si falsifica
  l'evidenza anti-frode RF-31 nell'e2e (resta coperta solo dai test automatici,
  dove receivedAt è controllato: CS4).
- Rischi: modalità dimenticata accesa in produzione. Richiederebbe guardrail
  (solo DB dedicato, banner nei log, rifiuto con config di produzione).
- Verdetto: riservarla solo al caso "replay del 2025 con giocatori veri",
  con guardrail stringenti; NON come modalità principale.

### 3.2 Calendario inventato / stagione sintetica futura (proposta commissioner)
Costruiamo un calendario fittizio e lo diamo al sistema; l'orologio è reale.
- Allineata all'architettura: interfaccia `SeasonDataProvider` (ADR-007),
  regola "la CLI inietta".
- Variante migliore: NON serve un nuovo provider — un comando seed che carica
  una stagione sintetica con DATE FUTURE nella tabella `match`. Si riusa
  `DbSeasonDataProvider` e tutto l'engine, invariati.
- Con date future: RF-21 passa, le email arrivano prima delle deadline, i pick
  sono accettati, lo scheduler funziona davvero, i risultati possono essere
  iniettati per round (o già presenti, stile replay).
- È l'unica strada che testa il sistema ESATTAMENTE come in produzione:
  l'unica cosa finta è il calendario.
- Verdetto: CONSIGLIATA come prova generale ripetibile e banco di regressione.

### 3.3 Dati reali 2026/27 (check immediato)
Oggi è il 14-08-2026; la Serie A 2026/27 parte tra poche settimane e il
calendario reale dovrebbe essere già pubblicato.
- Se football-data.org ha già le fixtures 2026/27
  (FOOTBALL_DATA_SEASON=2026 su un DB di prova), l'UAT può essere fatto ORA
  su dati veri e deadline future: zero finzioni, massima fedeltà.
- È esattamente il "UAT manuale CS1 da pianificare col commissioner"
  previsto in agent-context/current-status.md.
- Primo passo verificabile: `FOOTBALL_DATA_SEASON=2026 DB_PATH=./data/prova-2026.db npm run cli -- data:import`.
- Verdetto: DA VERIFICARE SUBITO — se disponibile, è l'UAT intero definitivo.

### 3.4 Date-shift del 2025 (replay)
Spostare in avanti le `match_date` del 2025 su un DB di test
(UPDATE SQL con delta costante, kickoff TT1 = oggi + 2/3 giorni), tenendo i
risultati reali 2025.
- Pro: dati e risultati veri, sforzo minimo.
- Contro: manipolazione dati (date non più reali), e NIENTE `data:refresh`
  dopo lo shift (l'upsert dall'API riporterebbe le date vere e romperebbe il
  test a metà); `scheduler:tick` inietta il refresh → modalità manuale.
- Verdetto: ottimo come prova generale rapida, non come banco di regressione.

### 3.5 UAT graduato a fasi (approccio a rischio decrescente)
1. Smoke: canale email reale su 1-2 round di stagione sintetica corta (4-8 TC);
2. Prova generale: stagione sintetica completa con scheduler via cron su staging;
3. Pilot reale: primo campionato vero con il gruppo ristretto di amici.
Ogni fase aggiunge un pezzo; se una si rompe, non si debuggia tutto insieme.

### 3.6 Casella Gmail di test dedicata + cron in staging
- Seconda casella (es. survivorleaguetest@gmail.com) per provare il canale
  senza toccare la casella di produzione.
- Scheduler girato da cron su un ambiente di staging per collaudare il
  percorso RNF3 (cron) prima della produzione.

## 4. Tabella comparativa

| Criterio | 3.1 Test-mode clock finto | 3.2 Stagione sintetica futura | 3.3 Dati reali 2026/27 | 3.4 Shift 2025 |
|---|---|---|---|---|
| Fedeltà canale email | media (receivedAt falsato) | alta | altissima | alta |
| Fedeltà motore | alta | alta | altissima | alta |
| RF-31 testabile e2e | NO (solo test automatici) | SI | SI | SI |
| Scheduler/cron provabili | parziale | SI | SI | SI |
| Sforzo | basso ma rischioso | medio (comando seed) | minimo (se fixtures pronte) | minimo (UPDATE) |
| Ripetibilità/regressione | media | alta | bassa (una volta sola) | media |
| Rischio "resta acceso in prod" | ALTO | basso | nullo | basso |

## 5. Raccomandazioni

1. Verificare subito la 3.3 (fixtures 2026/27): se disponibili, è l'UAT intero
   definitivo — dati veri, tempo reale, giocatori veri, scheduler reale.
2. In parallelo, costruire la stagione sintetica futura (3.2): prova generale
   ripetibile e banco di regressione indipendente dal calendario reale.
3. Test-mode con clock finto (3.1): solo per il replay 2025 con giocatori
   veri, con guardrail stringenti (DB dedicato, banner, niente refresh).
4. RF-31/CL17/CL18 e i casi limite restano responsabilità dei test automatici
   (già coperti, es. CS4) — l'e2e valida l'integrazione, non ogni regola.

## 6. Allegato: stato del collaudo in corso (2026-08-14)

- Walkthrough CLI passo-passo in corso col commissioner (sessione Ask):
  - data:import completato su data/survivor.db (380 partite 2025/26);
  - run 1 archiviata in data/survivor-run1-seed42.db (simulate:full --seed 42:
    38/38 TC scored, vincitore sim-07, caso 2);
  - reset eseguito, DB re-importato vergine;
  - decisione: NIENTE simulate:full → proseguire con simulate:round
    --round 1 --seed 7, poi ispezioni (round:status, pick:list,
    tournament:status).
- Vincoli emersi dal codice:
  - simulate:round = UN round per DB vergine (guardia R3: rifiuta se
    season_started=1 o esistono round non-pending) → per il TC 2 servono il
    flusso manuale commissioner (round:open / pick:register / round:close /
    round:score) o copie di DB;
  - l'override US10 (--reason) bypassa SOLO i check temporali (after_acceptance
    / after_kickoff) ed è per-pick manuale: non applicabile al flusso email
    automatico;
  - il canale email usa l'internaldate IMAP come receivedAt (ADR-001).

## Prossimi passi

- [ ] Verifica fixtures 2026/27 su football-data.org (3.3).
- [ ] Se disponibili: pianificare l'UAT CS1 su dati reali col commissioner.
- [ ] Valutare l'implementazione del comando seed per la stagione sintetica (3.2).
- [ ] Completare il walkthrough passo-passo (simulate:round TC 1 con seed 7).
- [ ] Aggiornare agent-context/current-status.md con le decisioni adottate.
