# Changelog

Tutti i cambiamenti degni di nota del progetto sono documentati in questo file.
Formato ispirato a [Keep a Changelog](https://keepachangelog.com/), versioning [SemVer](https://semver.org/).

## [0.1.0] - 2026-08-18

Prima release del POC.

### Aggiunto

- Game engine deterministico: regole, validazione pick, contabilità, eliminazioni, vincitori.
- LLM Adapter confinato all'I/O (parsing email → `{team, outcome}`, generazione email in italiano) con failover multi-modello.
- ChannelAdapter email (IMAP/SMTP su Gmail via `imapflow` + `nodemailer`).
- SeasonDataProvider da football-data.org (Serie A 2025/26).
- CLI completa (`tournament`, `round`, `pick`, `elimination`, `winner`, `scheduler`, `data`, `db`, `simulate`, …).
- Configurazione tramite variabili d'ambiente validate con `zod`.
- Test mode (UAT) con calendario sintetico e offset orario (`TEST_MODE`, `TEST_OFFSET_DAYS`).
- Suite di test (unit + integration) con `vitest`.
