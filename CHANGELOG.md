# Changelog

Tutti i cambiamenti degni di nota del progetto sono documentati in questo file.
Formato ispirato a [Keep a Changelog](https://keepachangelog.com/), versioning [SemVer](https://semver.org/).

## [Non rilasciato] - 2026-08-21

### Aggiunto (branch `feat/email-templates-v2`, ADR-011)

- **Email v2 — stile unico "energetic"**: renderer deterministico di canale (`src/llm/email-renderer.ts`) che compone header con coppia umana ("Round N · Turno di campionato M"), box ASCII (esito ✅/❌, deadline+countdown calcolato dal sistema, squadre bruciate, partite/risultati, stato aggregato) e CTA attorno alla narrativa LLM; text/plain, niente HTML; soggetti in forma umana e NEUTRI per le mail di esito; mai elenchi nominativi di partecipanti; mail di apertura torneo = solo annuncio; chiusura fissa dell'eliminato.
- **Chiusura automatica e completa del torneo**: hook `settleWinnerIfNeeded` del Round Manager (dopo `round:close`/`round:score`) — guardia atomica idempotente (`winner_notified`/`finished_at`), notifica ai vincitori (`tournament_won`/`tournament_shared_win`), export automatico in `TOURNAMENT_EXPORT_DIR`, scheduler inibito a torneo chiuso, `tournament:start` riammissibile con reset atomico del DB di gioco (piattaforma intatta).
- **Nome del giocatore end-to-end**: classificatore `{intent, pick, name?}`, `platform_account.name`, `platform:register --name`, auto-join con `player.name = account.name ?? email`.
- **Timezone di sistema** `TIMEZONE` (IANA, validata al boot) per date nelle email e timestamp dei log pino.
- Nuovo tipo email `clarification` (soggetto "Non ho capito") e helper `formatRemaining` per i countdown.

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
