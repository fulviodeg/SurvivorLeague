# Survivor League (POC)

Torneo a eliminazione **privato tra amici** basato sui risultati di **Serie A**. Prima di ogni giornata (round) ogni profilo invia un *pick* (squadra + esito); pick corretto → si resta in gioco, pick sbagliato o mancante → eliminazione. Ogni squadra è utilizzabile **una sola volta per girone** (andata/ritorno) e il pool si azzera a metà stagione. Vince l'ultimo profilo rimasto in gioco (o una vittoria condivisa nei casi previsti dal regolamento).

> Progetto privato tra amici: **non è un prodotto di scommesse commerciali** (vedi `BRIEF/BRIEF.MD`).

## Stato

**Proof of Concept (POC)**. Lo stato aggiornato del progetto è in `agent-context/current-status.md`; requisiti e design in `docs/POC/`.

## Architettura (sintesi)

- **Game Engine deterministico** — regole, validazione pick, contabilità, eliminazioni, vincitori. Nessuna logica di gioco vive al di fuori di esso.
- **LLM Adapter confinato all'I/O** — parsing delle email → `{team, outcome}` e generazione delle email in italiano; non prende alcuna decisione di gioco.
- **ChannelAdapter astratto** — il canale email (IMAP/SMTP su Gmail) è l'unica implementazione nel POC.
- **SeasonDataProvider astratto** — dati importati da football-data.org (Serie A 2025/26).
- **CLI completa** — ogni componente espone comandi; orchestra via cron (produzione) o da un agente.
- **Configurabilità totale** — parametri in variabili d'ambiente validate con `zod`; i parametri di lega derivano dai dati, mai hardcoded.

## Stack tecnologico

Node.js ≥ 20 · TypeScript (strict) · SQLite (`better-sqlite3`) · `imapflow` + `nodemailer` (Gmail) · API LLM OpenAI-compatible · `zod` · `yargs` · `pino` · `vitest` · `eslint` + `prettier`

## Prerequisiti

- Node.js ≥ 20.12
- Una casella Gmail dedicata con App Password (per IMAP/SMTP)
- (Facoltativo) un token football-data.org per importare i dati della stagione

## Installazione

```bash
npm install
cp .env.example .env
# compila in .env i valori obbligatori (IMAP_USER, IMAP_PASS, SMTP_USER, SMTP_PASS, LLM_API_KEY, ...)
```

## Utilizzo (CLI)

```bash
npm run cli -- <comando> [opzioni]
npm run cli -- --help
```

Esempi:

```bash
npm run db:migrate
npm run cli -- tournament:start --start-round 1
```

Per la modalità di test (UAT) caricare un file env dedicato:

```bash
ENV_FILE=.env.uat npm run cli -- <comando>
```

Vedi `docs/uat/guida-test-mode.md` per il manuale operativo completo.

## Test

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run lint      # eslint .
```

## Documentazione

| Documento | Contenuto |
|-----------|-----------|
| `docs/POC/POC_PRD.md` | Requisiti di prodotto del POC |
| `docs/POC/POC_HLD.md` | Architettura di alto livello |
| `docs/POC/POC_LLD.md` | Design dettagliato (stack, modello dati, env vars, interfacce, CLI) |
| `docs/decisions/architecture-decisions.md` | Log ADR (append-only) |
| `docs/uat/guida-test-mode.md` | Guida operativa del TEST MODE (UAT) |
| `AGENTS.MD` | Istruzioni operative per agenti e contributori |

## Licenza

Progetto privato: nessuna licenza open source applicata.
