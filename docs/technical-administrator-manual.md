# Survivor League — Technical Administrator's Manual

> **Role of this document.** The operating manual of the Survivor League
> system, written for the **technical administrator** (VPS admin,
> shell-literate — no knowledge of the system's internals required). It
> covers how to install, configure, run and manage the system in its two
> operating modes (commissioner and scheduler) and in TEST MODE, plus the
> complete configuration reference and the tournament's temporal model.
>
> **Scope.** Strictly operational: commands, configuration parameters and
> administrative workflows. Internal implementation details are deliberately
> out of scope. Component names (Game Engine, Channel Adapter, Scheduler, …)
> are used only as roles, to explain system behavior.
>
> **Language convention.** The manual is written in English; concepts that are
> Italian in the domain and in the system's output are kept in Italian
> (Pick, TC/Turno di Campionato, TT/Turno del Torneo, girone di andata/ritorno,
> commissioner, …). Verbatim system messages are quoted in their original
> language: most CLI text output is Italian, log and warning messages are
> English (project constraint).
>
> **Companion documents.**
>
> - `docs/cli-reference.md` — the complete catalog of all 34 CLI commands
>   (man-page style). This manual covers the operational core and points to
>   the reference for the diagnostic commands.
> - `docs/uat/guida-test-mode.md` (Italian) — the detailed operating guide of
>   TEST MODE with copy-paste UAT timelines and the 2025 replay. This manual
>   condenses the essentials and refers to it.

---

## 1. Table of Contents

- [2. Introduction and System Overview](#2-introduction-and-system-overview)
  - [2.1 What Survivor League is](#21-what-survivor-league-is)
  - [2.2 Core gameplay and fundamental rules](#22-core-gameplay-and-fundamental-rules)
  - [2.3 System architecture at a glance: actors and their roles](#23-system-architecture-at-a-glance-actors-and-their-roles)
  - [2.4 Who receives which email: the notification matrix](#24-who-receives-which-email-the-notification-matrix)
- [3. Data Acquisition](#3-data-acquisition)
  - [3.1 The data source](#31-the-data-source)
  - [3.2 Initial import](#32-initial-import)
  - [3.3 Refresh during the season: when the system fetches data](#33-refresh-during-the-season-when-the-system-fetches-data)
  - [3.4 Where the data lives and how it is used](#34-where-the-data-lives-and-how-it-is-used)
  - [3.5 Synthetic test data](#35-synthetic-test-data)
- [4. Operational Modes](#4-operational-modes)
  - [4.1 Commissioner Mode (manual)](#41-commissioner-mode-manual)
  - [4.2 Scheduler Mode (cron)](#42-scheduler-mode-cron)
  - [4.3 Test Mode](#43-test-mode)
- [5. Command Line Interface (CLI)](#5-command-line-interface-cli)
  - [5.1 Invocation and common conventions](#51-invocation-and-common-conventions)
  - [5.2 Operational core commands](#52-operational-core-commands)
  - [5.3 Complete command reference](#53-complete-command-reference)
- [6. System Lifecycle](#6-system-lifecycle)
  - [6.1 One-time setup](#61-one-time-setup)
  - [6.2 The pre-season period](#62-the-pre-season-period)
  - [6.3 Tournament start](#63-tournament-start)
  - [6.4 The round cycle](#64-the-round-cycle)
  - [6.5 The half-season boundary](#65-the-half-season-boundary)
  - [6.6 Tournament end: automatic closure](#66-tournament-end-automatic-closure)
  - [6.7 Starting a new tournament](#67-starting-a-new-tournament)
  - [6.8 Anomalies and commissioner interventions](#68-anomalies-and-commissioner-interventions)
- [7. Configuration Management](#7-configuration-management)
  - [7.1 The env-file selector (`ENV_FILE`)](#71-the-env-file-selector-env_file)
  - [7.2 Game parameters](#72-game-parameters)
  - [7.3 Infrastructure parameters](#73-infrastructure-parameters)
  - [7.4 Season data parameters](#74-season-data-parameters)
  - [7.5 Scheduler parameters](#75-scheduler-parameters)
  - [7.6 Simulation parameter](#76-simulation-parameter)
  - [7.7 Test-mode parameters](#77-test-mode-parameters)
  - [7.8 Validation, required values and timezone semantics](#78-validation-required-values-and-timezone-semantics)
- [8. Tournament Timing](#8-tournament-timing)
  - [8.1 The temporal quantities](#81-the-temporal-quantities)
  - [8.2 The half-season boundary and the pool reset](#82-the-half-season-boundary-and-the-pool-reset)
  - [8.3 Postponed matches and Freeze](#83-postponed-matches-and-freeze)
  - [8.4 The end of the tournament](#84-the-end-of-the-tournament)
  - [8.5 Worked example with production defaults](#85-worked-example-with-production-defaults)
  - [8.6 The compressed UAT example](#86-the-compressed-uat-example)
- [9. Appendix: glossary of Italian terms](#9-appendix-glossary-of-italian-terms)

---

## 2. Introduction and System Overview

### 2.1 What Survivor League is

Survivor League is a **private elimination tournament among friends** based on
the results of **Serie A**. It is played entirely by **email**: players submit
their predictions by replying to the system's messages, and the system
communicates everything — instructions, confirmations, rejections, results,
eliminations — by email. The **commissioner** (the administrator) manages the
tournament from the command line.

The system is a **Proof of Concept**: one tournament at a time, one profile
per player, email as the only channel, and the 2025/26 season as the reference
data. It is a private game, **not a commercial betting product**.

### 2.2 Core gameplay and fundamental rules

The game follows the calendar of the Serie A season. Each championship
matchday — the **Turno di Campionato (TC)** — corresponds to one tournament
round — the **Turno del Torneo (TT)**.

- **The Pick.** Before the deadline of each round, every profile still in the
  game submits a **Pick**: one team **plus** a predicted outcome for that
  team's match — *win*, *draw* or *lose*. The message is free-form natural
  language (e.g. "Roma, vince") and is interpreted by the system.
- **`win_only` mode (default).** The default game mode, active when `WIN_ONLY=true`:
  the player picks **only the team** that will win its match (the system
  interprets the pick as `outcome = win`). A win → the pick is correct and the
  profile stays in; a **draw or a loss → the pick is wrong → elimination**. In
  `win_only`, a bare team name is enough ("Napoli"); an explicit "Napoli
  pareggia"/"Napoli perde" is not recognized (the system asks for
  clarification). All other rules (one team per girone, deadline, opt-in
  participation, winners) are unchanged. The mode is **fixed in the database at
  `tournament:start`**: set `WIN_ONLY` **before** `tournament:start` and do not
  change it mid-tournament — a change while the tournament is open aborts the
  process with a fatal error (see §6.8).
- **Auto-pick on a missing pick (`AUTOPICK_ON_MISSING`, default `false`).**
  Optional, **active only in `win_only`**. When `true` (`AUTOPICK_ON_MISSING=true`
  with `WIN_ONLY=true`), at the **close** of a round with a **real deadline**
  (`round_state.deadline !== null`), every profile still in the game that sent
  no pick is **not eliminated**: the system assigns it the **first available
  team in alphabetical order by generic name** (`shortName`, e.g. "Inter" —
  stored in the `team` table at import), excluding the teams burned in the
  current girone and the teams not playing in that round. The auto-assigned
  pick (`pick.auto_pick=1`, `outcome='win'`) is then scored normally: correct
  → the profile stays; wrong → elimination. The player receives the
  confirmation **`pick_auto_assigned`** at closing (no deadline section). A
  **safety closure (deadline NULL)** never auto-assigns: the missing players
  are eliminated `missing_pick` as usual. If no team is available (defensive
  case), the profile is eliminated `missing_pick` with a warning log. The flag
  is **fixed in the database at `tournament:start`** (same fatal guard as
  `WIN_ONLY`, see §6.8).
- **Jolly (`JOLLIES_PER_PLAYER`, default `1`).** A spendable token, **active
  only in `win_only`** (`WIN_ONLY=true`). The player declares it in the pick
  email with the keyword "jolly" (e.g. "Napoli Jolly"; case/accent-insensitive,
  before or after the team). A **draw** of the picked team → the jolly **saves
  the profile from elimination** (the pick counts as correct); a **loss** →
  the jolly does **not** save (elimination as usual); a **win** → the profile
  stays in. The jolly is **burned at declaration** (the moment the pick is
  registered, regardless of the outcome): `pick.jolly_used=1` and
  `profile.jollies_remaining` decreases by one, atomically. When the counter
  reaches `0`, a pick declaring a jolly is rejected with "non hai più jolly
  disponibili". `JOLLIES_PER_PLAYER=0` disables the feature completely (the
  system behaves exactly as today and the "jolly" keyword is ignored). The
  value is **fixed in the database at `tournament:start`** (same fatal guard
  as `WIN_ONLY`, see §6.8): set it **before** `tournament:start` and do not
  change it mid-tournament.
- **Outcome of a Pick.** When the match's result becomes available, the Pick
  is evaluated. Correct → the profile **stays in the game**. Wrong → the
  profile is **eliminated**.
- **Missing Pick.** A profile with no valid Pick at the deadline is
  **eliminated** (`missing_pick`). There is no grace mechanism.
- **One team per girone.** A team can be picked **once per half-season
  (girone)**. The half-season boundary is derived from the data
  (`floor(total rounds / 2) + 1`): with 38 matchdays, the boundary is round
  20 — the **andata** is TC 1–19, the **ritorno** is TC 20–38. At the boundary
  the **pool resets**: every team becomes available again. A team already used
  in the current girone is **bruciata** (burned) for that profile.
- **First valid Pick wins.** Only the first valid Pick of a profile in a round
  counts; later picks for the same round are rejected. A rejected Pick does
  not consume the attempt: the player can try again until the deadline.
- **The deadline is enforced on the server-side reception time**
  (`receivedAt`, the IMAP internaldate), never on the date the player wrote in
  the email. Picks are accepted only until the **acceptance instant** — the
  earlier of the registered deadline and the actual kickoff of the round's
  first match (anti-fraud guard; see §8).
- **Postponed matches.** If a match is postponed beyond the TC window, picks
  on it enter **Freeze**: they stay pending, the team remains burned, and they
  are evaluated whenever the match is eventually played (see §8.3).
- **Winning the tournament.** The tournament ends in three cases: (1) a single
  profile remains in the game — it wins; (2) all the profiles still in the
  game are eliminated in the same round — they share the victory; (3) two or
  more profiles survive after the last TC of the season — they share the
  victory.
- **Asynchronous attachment.** Normally the tournament starts from the first
  matchday. The commissioner may also start it from an arbitrary championship
  round (`tournament:start --start-round <n>`): the chosen TC becomes the
  **TT 1**, and the earlier matchdays are simply not played. The mapping is
  always `TT = TC − start_round + 1`, and the double numbering appears in
  emails, CLI output and logs.

**Registration and participation are two distinct concepts (registration ≠ join).**

1. **Platform account (registration).** A player registers to the platform by email at any
   time (before, during, after a tournament): the message intent
   (registration / unsubscription / **join** / pick) is understood automatically (LLM or
   deterministic, per `AI_EMAIL_PARSER`). The fundamental instruction players
   receive is the unique formula: `ISCRIZIONE [NOME]` (e.g. `ISCRIZIONE Mario`)
   to register, `DISISCRIZIONE` to unsubscribe, **`PARTECIPO` to join the
   tournament**, `<TEAM> <ESITO>` for a pick —
   in the subject or the body. The
   account keeps a stable internal `registerID`, a status
   (`active` / `pending_unsubscribe` / `unsubscribed`) and **two opt-in
   participation flags** (ADR-019, managed **only via CLI**):
   `tournament_auto_join` (auto-join at the next `tournament:start`) and
   `receive_tournament_start_notification` (receives the `tournament_open`
   announcement); both default to **ON**. Accounts live in a
   **separate database** from the tournament.
2. **Tournament profile (join).** Participation in the tournament is **opt-in**:
   the profile is born (a) by **auto-join at `tournament:start`** for every
   active account with `tournament_auto_join = ON` (a one-time snapshot: an
   account that becomes `active` *after* the start must declare), or (b) by an
   **explicit declaration** — email `PARTECIPO` or CLI `tournament:join` —
   within the TT-1 window (round 1 `pending` or `open`). The confirmation is
   `tournament_join_confirmed`; a second declaration on an account already in
   the game answers `tournament_already_joined`. **A pick never creates a
   profile** (the old auto-join on the first pick is removed): a subscriber
   without a profile who sends a pick in the TT 1 is guided to declare
   (`PARTECIPO`); after the TT-1 window has closed, participation is locked and
   the only late entry is the audited override `tournament:join --reason`.
   A subscriber who never declares (and has auto-join off) is **not a
   participant** — not eliminated, and receives no round emails.

**Unsubscription is a two-step process.** A first "voglio disiscrivermi"
message sets the account to `pending_unsubscribe` and asks for confirmation;
only a second message with an explicit confirmation word (`confermo`, `sì`,
`si`, `yes`) performs the soft-delete (`unsubscribed`). The email address is
kept and a re-registration reuses the same `registerID`. A pick from an
unknown or unsubscribed sender is silently logged (anti-spam): no reply, no
auto-registration.

### 2.3 System architecture at a glance: actors and their roles

The system is a set of cooperating components, each with a single
responsibility. At the operational level it is enough to know *who does what*:

| Actor | Role |
|---|---|
| **Players** | Real people. They only interact by email: they register, send Picks, receive notifications. |
| **Commissioner** | The administrator. The only user of the CLI. In manual operations they drive each phase; in automated operations they supervise and intervene only for overrides. |
| **Game Engine** | The deterministic heart of the game: rules, Pick validation, eliminations, accounting, winner determination. **All game decisions are made here and nowhere else.** It never talks to players directly and never interprets natural language. |
| **LLM Adapter** | Confined to input/output: it interprets the players' free-text emails (intent + Pick + name) and — only when `AI_EMAIL_GENERATOR=true` — writes the narrative of the outgoing Italian emails (the default is the deterministic generator). It makes **no game decision** — every decision is then checked deterministically by the Game Engine. |
| **Channel Adapter (email)** | The communication channel: receives emails via IMAP and delivers them via SMTP (a Gmail mailbox). In the POC, email is the only channel. |
| **Season Data Provider** | The single source of calendar and results: the data imported from the football-data.org API and stored in the local database. It decides nothing: it only supplies data. |
| **Platform Registry** | The archive of platform accounts (registration/unsubscription). Stored in a separate database; read by the tournament flows, never written by them. |
| **Scheduler** | The production automation (cron): it decides **when** to trigger round operations (open, close, account) according to the calendar. It contains no game logic of its own — it only invokes the round operations at the right time. |
| **CLI** | The administration interface: every component is operable and verifiable through the same commands used by automation and by the commissioner. |

Two consequences of this separation matter operationally:

- **No email is ever sent without passing through the Game Engine's decision.**
  The LLM writes text; it never decides a winner, an elimination or a
  rejection.
- **The same commands that the commissioner runs manually are the ones the
  scheduler triggers automatically.** The operator and the automation share
  one interface, so a manual intervention can always replace or correct an
  automatic action.

### 2.4 Who receives which email: the notification matrix

Every outgoing email is filtered on the account status at the moment of
sending. `unsubscribed` and `pending_unsubscribe` accounts receive **no
tournament email** — the only exception being the registration/unsubscription
confirmation flow itself.

| Event | Recipients |
|---|---|---|
| Tournament opening (`tournament_open`) | **Active subscribers with `receive_tournament_start_notification = ON`** (ADR-019). Announcement only: the round 1 will start soon, be ready — no dates (the round opening is a separate event). Teaches participation: *rispondi con "PARTECIPO"*. |
| Round opening (`pick_instructions`) | **Active participants** (profiles in the game), each with their available teams, the deadline and the response format. With jolly active (`JOLLIES_PER_PLAYER ≥ 1`), each participant also receives the jolly instructions ("🎯 Jolly: scrivi «SQUADRA Jolly»…") and the "Jolly rimasti: N" line. (No TT-1 exception for subscribers without a profile — ADR-019.) |
| Join declaration (`tournament_join_confirmed` / `tournament_already_joined` / `tournament_join_rejected`) | The active account that declared `PARTECIPO` (or the commissioner ran `tournament:join`): confirmed (with the deadline box if a round is open), already in the game, or rejected with the reason (`no_tournament` / `tournament_started` / `not_in_tournament`). |
| Pick confirmation (`pick_confirmed`) / rejection (`pick_rejected`) | The sender, with the reason of a rejection. With jolly active: `pick_confirmed` shows "PICK REGISTRATO CON JOLLY → {SQUADRA}" when a jolly was declared, plus "Jolly rimasti: N"; `pick_rejected` translates the jolly reasons in Italian ("non hai più jolly disponibili", "il jolly non è ammesso in questa modalità"). |
| Round closing — elimination for missing Pick (`pick_missing_elimination`) | Each eliminated profile, at `round:close`. |
| Round closing — auto-pick assigned (`pick_auto_assigned`) | Each profile that received an **auto-assigned pick** at `round:close` (`AUTOPICK_ON_MISSING=true` with a real deadline): confirmation *after the fact*, no deadline section. |
| Accounting results (`round_result_correct` / `round_result_wrong`) | Each evaluated profile, at `round:score`. `wrong` is the elimination notice. With jolly active and a jolly declared: saved-by-draw → "🎯 Il tuo jolly ti ha salvato: {SQUADRA} ha pareggiato."; win → "🎯 Jolly usato"; loss → "🎯 Il jolly non salva dalla sconfitta." |
| Round-closing summary (`round_closed_survived`) | **Survivors only**, sent exactly once when the round reaches the accounted state. Eliminated profiles never receive it. Includes the **players list** of the round (ADR-015) and, with jolly active, the "🎯 Jolly rimasti: N" line for the recipient plus the "🎯 Jolly" marker on players who declared a jolly. |
| Postponement notice (`pick_postponed`) | Profiles whose Pick entered Freeze. |
| Victory (`tournament_won` / `tournament_shared_win`) | The winner(s), at the automatic tournament closure. `tournament_shared_win` lists the **other co-winners** (ADR-015). |
| Tournament closing (`tournament_closed`) | **All participants** (profiles with at least one Pick, winners included), once at the automatic closure, with the per-round history (ADR-015). |
| Registration / unsubscription confirmations | The sender, always (this is the confirmation flow itself). |

Constraint: **emails never list participants' names** — only aggregate counts
(designed for 50+ players). **Exception (ADR-015):** the retrospective emails
`round_closed_survived` and `tournament_closed` do list the round participants,
with the elimination outcome; all the other emails stay on aggregate counts.

---

## 3. Data Acquisition

### 3.1 The data source

The system's championship data comes from the **football-data.org** API
(competition `SA` = Serie A, season `2025` = 2025/26), authenticated with the
`X-Auth-Token` configured as `FOOTBALL_DATA_TOKEN` (supplied by the product
owner). The client respects the API's rate limits advertised in the response
headers and retries only on transient failures (rate limit, server errors,
network), with a timeout per request.

### 3.2 Initial import

The first data fetch happens at **setup**, when the administrator runs:

```bash
npm run cli -- data:import
```

This downloads the full season — calendar and, where already published,
scores — and loads it into the tournament database. The import is an
**idempotent upsert** keyed on (round, home team, away team): running it again
never duplicates rows. Dates are stored canonically as ISO-8601 UTC.

### 3.3 Refresh during the season: when the system fetches data

During play, the data must stay current (results of concluded matches,
possible calendar changes). The system fetches from the API in exactly these
situations:

1. **Automatically, at every scheduler tick (production / cron mode).**
   Before evaluating its actions, `scheduler:tick` refreshes the season data.
   This is how match scores become available to the accounting: a refresh
   that fails is logged as `refresh_failed` and the tick continues with the
   other actions (the next tick retries).
2. **Manually, at any time**, with the same underlying operation:
   `npm run cli -- data:refresh` (identical to `data:import`, used for
   updates).
3. **In TEST MODE the fetches are blocked by default.** With
   `TEST_MODE=true` and `TEST_REFRESH_ALLOWED=false` (the default), both
   `data:import` and `data:refresh` — and the scheduler's automatic refresh —
   perform **no API call and no database write**, printing/logging
   `import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled`.
   This protects the synthetic UAT calendar from being overwritten with the
   real season. Setting `TEST_REFRESH_ALLOWED=true` re-enables the fetches
   (with a consent warning naming the database path at every operation) and
   is legitimate **only** on a database with real data — never on a synthetic
   calendar.

There are no other triggers: the Game Engine never calls the API directly; it
reads only what the database contains.

### 3.4 Where the data lives and how it is used

Imported data is stored in the tournament database (`DB_PATH`), in the
`match` table. The Game Engine reads calendar and results exclusively from
there. Scoring is **incremental**: each Pick is evaluated as soon as the
result of its match appears in the data (via refresh), without waiting for
the whole round to conclude.

### 3.5 Synthetic test data

For UAT sessions, a **synthetic season** can be generated instead of the real
one: `data:seed-synthetic` invents a coherent Serie A 2026/27 calendar with
**pre-seeded scores** and loads it into the same `match` table (options and
guards in the CLI reference; usage and timelines in
`docs/uat/guida-test-mode.md`). Because the scores are already present,
`round:score` completes immediately after a round closes, allowing compressed
timelines. The seeded calendar must live on a dedicated test database and is
protected from API refreshes by the TEST MODE guard described above.

---

## 4. Operational Modes

The same system runs in two operating modes, chosen by configuration, plus a
third (TEST MODE) that can wrap either of them.

### 4.1 Commissioner Mode (manual)

**What it is.** The commissioner drives each phase by hand with the CLI
commands: seed/import data, register accounts, start the tournament, and for
each round: open → collect picks → close → account → verify.

**Configuration.** `SCHEDULER_ENABLED=false`. As a safety net,
`scheduler:tick` run by mistake in this configuration prints
`Scheduler disabilitato (SCHEDULER_ENABLED=false): nessuna azione eseguita — usa i comandi manuali`
and exits without effects. The manual round/tournament commands work
independently of `SCHEDULER_ENABLED`.

**When to use it.**

- First UAT sessions and smoke tests.
- Demonstrating controls that the automatic flow cannot exercise (e.g. the
  `after_kickoff` anti-fraud rejection requires a round deliberately left open
  past the kickoff).
- Any session where you do not want to depend on the system cron.

**Full flow.** `db:migrate` → `platform:migrate` → data import or seed →
platform registrations (by email via `channel:email:process`, or by CLI with
`platform:register`) → `tournament:start [--start-round <n>]` → per round:
`round:open --round <n>` → `channel:email:process` (players' picks arrive by
email) → `round:close --round <n>` (at the deadline, or immediately with
`--force --reason`) → `round:score --round <n>` → verification
(`round:status`, `round:deadline`, `data:results`) → final verification
(`tournament:status`, `tournament:leaderboard`, `tournament:history`,
`tournament:export`, `platform:list`).

### 4.2 Scheduler Mode (cron)

**What it is.** The tournament runs "on autopilot": the system opens, closes
and accounts the rounds by itself according to the calendar; players interact
only by email. The commissioner supervises and intervenes only on anomalies.

**Configuration.** `SCHEDULER_ENABLED=true` and **two** cron lines (typically
every minute):

```cron
# Round orchestration (open/close/account)
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && npm run cli -- scheduler:tick >> /var/log/survivor.log 2>&1
# Inbound email processing (registrations, unsubscriptions and picks)
*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && npm run cli -- channel:email:process >> /var/log/survivor-mail.log 2>&1
```

**Two crons, not one.** `scheduler:tick` orchestrates the rounds but **never
reads the mailbox**. Players' emails are read and processed by
`channel:email:process`, which must be scheduled separately — without the
second line, the picks sent by the players would never be acquired.

**What `scheduler:tick` does** (based on state and calendar, idempotently):

- refreshes the season data (production; skipped in TEST MODE by default);
- opens the next round — the TT 1 once the tournament is started, then a
  pending round once the previous one is accounted (`scored`);
- closes an open round whose registered deadline has passed;
- applies the **safety closure** to an open round left without a deadline
  once the TC close has passed (same consolidation semantics; logged as a
  `warn` with the cause);
- accounts closed rounds (`round:score`) when `SCHEDULER_AUTO_SCORE=true`;
- re-accounts frozen picks on already-accounted rounds;
- if a round's TC close cannot be calculated, logs `warn_not_calculable` and
  the anomaly appears in `tournament:status` / `scheduler:status`.

Each action is logged as a structured event; the audit lives in the log (no
scheduler state is persisted).

**Verification.** `scheduler:status` and `tournament:status` are always
available, read-only, in any mode.

**Note on the automatic tournament closure.** When the system identifies the
winner (during `round:close`/`round:score`, automatic in cron mode too), the
tournament closes itself: winners are notified, the export is written to
`TOURNAMENT_EXPORT_DIR`, and the scheduler stops (`scheduler:status` reports
`FINITO (chiuso automaticamente)` with no further actions). The one manual
operational step remaining is to **remove the `scheduler:tick` cron line** so
that useless ticks stop; `channel:email:process` can stay active
(registrations, unsubscriptions and clarifications keep working). The closed
tournament's history remains consultable in the export archive and with
`winner:check`.

### 4.3 Test Mode

**What it is.** A state of the system dedicated to **User Acceptance Testing
(UAT)** with real players on simulated data, without any chance of confusing
a test session with production. It is activated by loading a dedicated env
file (`ENV_FILE=.env.uat`) whose `TEST_MODE=true`, and it is recognizable
because **every visible output carries the `TEST MODE` marker**: the emails
sent by the system begin with the banner
`[TEST MODE] This email was sent by a test instance of Survivor League.`, the
CLI prints `TEST MODE` as the first line of every output, every `--json`
payload includes `"testMode": true`, and every log line carries
`"testMode": true`.

**What changes while it is active.**

| Area | Behavior in production | In TEST MODE |
|---|---|---|
| Env loading | `.env` | The file selected by `ENV_FILE` (e.g. `.env.uat`); test-only parameters become effective. |
| Outbound emails | Sent as-is | The `[TEST MODE] …` banner is prepended to every sent email (added at sending time; LLM-generated texts unchanged). |
| CLI output | Normal | `TEST MODE` first line; `testMode` field in every JSON output. |
| Logs (pino) | Normal | `"testMode": true` in every line. |
| Pick interpretation | Real team roster (Serie A) | Synthetic Serie A 2026/27 roster, with the LLM told it is a synthetic championship. |
| Clock / reception timestamps | Real | Shifted back by `TEST_OFFSET_DAYS` days **only if > 0** (2025 replay); with `0` everything stays real. |
| Data refresh (import/refresh, scheduler) | Always executed | **Skipped by default** (`TEST_REFRESH_ALLOWED=false`); with `=true` executed with a consent WARN per operation. |

**What it is for.** An end-to-end UAT with real players on a **synthetic**
Serie A 2026/27 calendar compressible into 1–2 hours instead of a week; real clock and
real email timestamps, so the anti-fraud controls run on authentic evidence;
protection of the synthetic calendar from the real data flow; and, optionally,
the **replay of historical data** (season 2025) shifting clock and timestamps
by `TEST_OFFSET_DAYS`.

**The three test-only parameters.**

| Parameter | Values | Default | Purpose |
|---|---|---|---|
| `ENV_FILE` | path to an env file | `.env` | Selects the configuration file (`.env.uat`, `.env.uat-replay`, …). The single activation point of TEST MODE. |
| `TEST_MODE` | `true` / `false` | `false` | The TEST MODE switch: banner, synthetic roster, and the gating of the other test-only parameters. |
| `TEST_OFFSET_DAYS` | integer ≥ 0 (days) | `0` | Shifts **both** the system clock and the email reception timestamps by the same amount — for the 2025 replay only, never on a synthetic future calendar. |
| `TEST_REFRESH_ALLOWED` | `true` / `false` | `false` | Allows `data:import`/`data:refresh`/scheduler refresh while in TEST MODE. Only for UAT on **real** data; never on a synthetic calendar. |

The test-only parameters are always parsed but take effect **only when
`TEST_MODE=true`**; a malformed value silently falls back to the default, and
they never block startup.

**Compressed cadence.** For the UAT the game parameters are typically reduced
in the test env file: e.g. `MATCH_DURATION_MIN=5`, `TC_CLOSE_SKEW_MIN=10`,
keeping `DEADLINE_ADVANCE_MIN=30`. The spacing between synthetic rounds must
be at least `MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN`, or the seed logs an
English overlap error naming the parameters.

**Essential do's and don'ts.**

- DO use dedicated databases (`DB_PATH=./data/uat-synthetic*.db`,
  `PLATFORM_DB_PATH=./data/uat-platform*.db` — never the production files);
  check the `TEST MODE` banner before proceeding; clean the shared Gmail
  mailbox at the end of each session.
- DO NOT run `data:refresh` on a synthetic calendar (guarded automatically,
  but never force it with `TEST_REFRESH_ALLOWED=true`); DO NOT use
  `ENV_FILE`/TEST MODE in production; DO NOT use `TEST_OFFSET_DAYS` on a
  synthetic future calendar; DO NOT run `scheduler:tick` in a commissioner
  session with `SCHEDULER_ENABLED=true`.

**Activation and deactivation.** Prefix every command with
`ENV_FILE=.env.uat` (or put `ENV_FILE=.env.uat` in the cron line); to leave
test mode, simply stop using the prefix (`unset ENV_FILE` if exported). Test
mode is not a persistent state — it depends only on the env file loaded at
each execution.

**Where to find the details.** The complete operating guide — the synthetic
roster, the seed explained in plain language, the three copy-paste timelines
(2h / ~4h30 / ~6h30), the asynchronous-attachment example, the 2025 replay
scenario, the mailbox cleanup and the glossary — is
`docs/uat/guida-test-mode.md`.

---

## 5. Command Line Interface (CLI)

### 5.1 Invocation and common conventions

```bash
npm run cli -- <command> [options]
```

- `--json` (most commands): structured JSON output instead of Italian text.
- `--help` / `-h`: command help, no configuration required.
- `ENV_FILE=<path>`: loads an alternative env file (TEST MODE activation).
- Exit code `0` on success; `1` on configuration errors, rejected operations
  and command errors, with a clean message on stderr (no stack trace).
- All write operations are idempotent and safe to re-run.

### 5.2 Operational core commands

The commands an administrator actually uses to run a tournament. (The
diagnostic commands — `rules:*`, `pick:*`, `elimination:*`, `llm:*`,
`channel:email:send`, `simulate:*` — are documented in the full reference.)

**`db:migrate`** — creates the tournament database and its tables.
Idempotent. Parameters: `--json`. Validates the whole configuration at
startup.

**`platform:migrate`** — creates the platform database (accounts) and its
tables. Idempotent. Parameters: `--json`.

**`data:import`** — downloads the season from the football-data.org API
(initial population, idempotent upsert). Parameters: `--json`. Skipped in
TEST MODE without `TEST_REFRESH_ALLOWED`.

**`data:refresh`** — updates calendar/results from the API during the season
(same logic as import; also run automatically by the scheduler in
production). Parameters: `--json`. Same TEST MODE guard.

**`data:calendar`** — prints the whole calendar from the database (read-only).
Parameters: `--json`. Lines: `R<round> <ISO date> <home> <score|–> <away> [da giocare|rinviata]`.

**`data:results --round <n>`** — prints the results of one round. Parameters:
`--round` (required), `--json`.

**`data:seed-synthetic`** — TEST MODE tool: generates and loads the synthetic
Serie A 2026/27 calendar with pre-seeded scores. Parameters: `--teams` (2–20,
default 8), `--rounds` (default 7), `--spacing-min` (default 90), `--first-kickoff-offset-min`
(default 120), `--seed` (default 42), `--force`, `--clear` (requires
`--force`; refused mid-tournament), `--json`. Guards against overwriting and
mixed calendars (see CLI reference §4).

**`platform:register --email <email> [--name <nome>] [--auto-join] [--receive-notifications] [--reason <motivo>]`** —
the only account-creation command. Parameters: `--email` (required,
normalized), `--name` (saved at first creation; email used otherwise),
`--auto-join` (boolean, default `true`: auto-join at the next
`tournament:start`, ADR-019), `--receive-notifications` (boolean, default
`true`: receives `tournament_open`), `--reason` (audited), `--json`. Does
**not** create tournament profiles. The two flags are applied **only at first
creation**: re-registering/reactivating an existing account preserves its
current preferences (use `platform:preferences` to change them).

**`platform:preferences --email <email> [--auto-join on|off] [--receive-notifications on|off]`** —
reads or updates the opt-in participation flags of an account (ADR-019,
managed only via CLI; a change affects the subsequent tournaments). Parameters:
`--email` (required), `--auto-join` (`on`/`off`, omitted → unchanged),
`--receive-notifications` (`on`/`off`, omitted → unchanged), `--json`.

**`platform:unregister --email <email> [--reason <motivo>]`** — direct
soft-delete of an account (status → `unsubscribed`); tournament profile
untouched. Parameters: `--email` (required), `--reason`, `--json`.

**`platform:list`** — lists accounts (registerID, email, status, the two
participation flags, dates). Parameters: `--json`.

**`tournament:start [--start-round <n>]`** — starts the season (bulk auto-join
of the accounts with `tournament_auto_join = ON`, then the `tournament_open`
announcement to the subscribers with notifications ON; atomic refusal on
invalid attachment). Parameters: `--start-round` (default 1: the TC that
becomes the TT 1), `--json`.

**`tournament:join --email <email> [--reason <motivo>]`** — explicit
declaration of participation (ADR-019, the `join` path): creates the profile
within the TT-1 window; `--reason` is the audited late override (mandatory
after the TT-1 window; profile created with the pool intact). Sends no email.
Parameters: `--email` (required), `--reason`, `--json`.

**`tournament:status`** — aggregate read-only status (season, subscribers,
participants, current round, winner, anomalies). Parameters: `--json`.

**`tournament:history --email <email>`** — pick history of a profile with
TT/TC pairs. Parameters: `--email` (required), `--json`.

**`tournament:leaderboard`** — leaderboard of the profiles (in game /
eliminated, correct/wrong picks). Parameters: `--json`.

**`tournament:export`** — JSON dump of all the tables + metadata (the audit
archive; the same format as the automatic export at closure). Parameters:
`--json`.

**`round:open --round <n>`** — opens a round: registers the fixed deadline and
sends the pick emails to the participants (profiles) only. Parameters:
`--round` (required), `--json`. Refused if already open, terminal,
or tournament closed. **Refused if the deadline is not in the future**
(`now >= deadline`): opening a round whose pick window already expired would
make every incoming pick unacceptable, so the command fails with a clear
message naming the deadline (UAT incident 2026-08-22). The scheduler always
opens rounds with future kickoffs, so the automatic flow is unaffected.

**`round:close --round <n> [--force --reason <motivo>]`** — closes the pick
window and eliminates the profiles without a valid Pick. Parameters: `--round`
(required), `--force` (same consolidation semantics; immediate closure),
`--reason` (**mandatory with `--force`**), `--json`.

**`round:score --round <n>`** — incremental accounting: evaluates pending
picks whose match has concluded, freezes the postponed ones, evaluates frozen
picks when their match concludes; round → `scored` when no pick is pending;
survivor summary exactly once; automatic winner check afterwards. Parameters:
`--round` (required), `--json`. Idempotent.

**`round:status --round <n>`** — round status with TT/TC pair and pick
counts. Parameters: `--round` (required), `--json`.

**`round:deadline --round <n>`** — registered deadline, kickoff and
acceptance instant. Parameters: `--round` (required), `--json`.

**`winner:check`** — read-only winner verdict (`{finished, winners, case}`).
Parameters: `--json`.

**`scheduler:tick`** — the production orchestrator (refresh + due round
actions); no-op when `SCHEDULER_ENABLED=false`; never reads the mailbox.
Parameters: `--json`.

**`scheduler:status`** — computed scheduler state and next actions
(read-only, always available). Parameters: `--json`.

**`channel:email:fetch`** — reads the unread emails from the mailbox without
marking anything (read-only). Parameters: `--json`.

**`channel:email:process`** — end-to-end inbound processing: registration,
unsubscription, picks, replies, mark-as-read on success. Parameters:
`--json`. Must be scheduled separately from `scheduler:tick`.

### 5.3 Complete command reference

The complete catalog of all 42 commands (including the diagnostic tools
`rules:burned-teams` / `rules:available-teams` / `rules:check-half` /
`rules:teams`, `pick:validate` / `pick:register` / `pick:list`,
`elimination:check` / `elimination:list`, `llm:parse` / `llm:classify` /
`llm:generate`, `channel:email:send`, `simulate:full` / `simulate:round`,
plus `platform:preferences` and `tournament:join` — ADR-019) is in
`docs/cli-reference.md`, with man-page detail for every parameter.

---

## 6. System Lifecycle

The chronological walkthrough of the system: from the first setup to the end
of a tournament and beyond.

### 6.1 One-time setup

1. **Prerequisites.** Node.js ≥ 20.12 on the server; a dedicated Gmail
   mailbox with an App Password (for IMAP and SMTP); a football-data.org API
   token (from the product owner); an LLM API key (OpenAI-compatible
   provider).
2. **Install.** `npm install`.
3. **Configure.** `cp .env.example .env` and fill in the required values
   (IMAP/SMTP credentials, LLM key and models, football-data token, database
   paths). See §7 for every parameter.
4. **Create the databases.** `npm run cli -- db:migrate` (tournament) and
   `npm run cli -- platform:migrate` (platform accounts). Both idempotent.
5. **Import the season.** `npm run cli -- data:import`, then verify with
   `npm run cli -- data:calendar` (380 matches for a full Serie A season).

From this point the system is idle but fully operative: registrations already
work.

### 6.2 The pre-season period

Before the tournament, the platform is open for registrations at any time:

- players register by email with the formula `ISCRIZIONE [NOME]` (e.g.
  `ISCRIZIONE Mario`) and the system answers `platform_registered` — processed by
  `channel:email:process` (cron) or on demand;
- the commissioner can create accounts directly with `platform:register`
  (optionally setting the two participation flags: `--auto-join` /
  `--receive-notifications`) and adjust them afterwards with
  `platform:preferences` (e.g. set `--auto-join off` for a player who must
  declare explicitly, or `--receive-notifications off` for a subscriber who
  does not want the opening announcement);
- `platform:list` shows the current accounts, their status and their flags.

There is **no registration window to open or close**: subscription to the
platform is always available, and participation in the tournament is
**opt-in** (ADR-019): accounts with `tournament_auto_join = ON` are
auto-joined at `tournament:start`; the others declare with `PARTECIPO` /
`tournament:join` within the TT-1 window.

### 6.3 Tournament start

Before starting, **verify the shared mailbox**: run `channel:email:fetch` (§5.2) —
it must report `Nessuna email non letta in casella`. Any unread message (a
leftover pick, a subscription, a `PARTECIPO`) would be read by the first
`channel:email:process` of the new run and could register a **ghost pick or
profile** in the new tournament (UAT incident 2026-08-31: a residual pick email
became a ghost pick and produced misleading rejections). If there are unread
emails, the operator decides how to handle them — never delete valid
registrations. This check is mandatory **after a reset/aborted run too**: the
database reset does NOT clean the mailbox.

The commissioner runs `tournament:start [--start-round <n>]` (default
attachment to TC 1; any TC of the season can be chosen). The system:

1. **validates** the attachment: the chosen TC must exist and have matches,
   and the deadline of the TT 1 must still be in the future — otherwise the
   start is **refused atomically** (nothing half-initialized); attaching to
   the **last** TC is allowed with an informative warning (the
   end-of-tournament cases collapse to that single round);
2. **initializes** the tournament state and the round rows (status
   `pending`) for the whole window `[start_round … last round]`;
3. **auto-joins** every active account with `tournament_auto_join = ON`
   (ADR-019, one-time snapshot; the result reports `autoJoined`);
4. **sends the opening announcement** (`tournament_open`) to the active
   subscribers with `receive_tournament_start_notification = ON` — an
   announcement only, without dates, teaching the participation formula
   (`rispondi con "PARTECIPO"`).

Output: `Stagione avviata: TT1 = TC <n>, <m> round inizializzati (confine girone <b>)`
followed by the TT-1 deadline line and `Auto-join a start: <k> profili creati
(account con flag ON), notifiche apertura: <p>`.

The TT 1 is then **opened** — by the next `scheduler:tick` in cron mode, or by
`round:open --round <n>` in commissioner mode — which sends the pick
instructions and fixes the deadline (§8.1).

### 6.4 The round cycle

For each championship round in the tournament window, the cycle is:

1. **Open** (`round:open` / scheduler). The deadline is computed from the
   calendar and registered **once** (it never changes afterwards). Pick
   instruction emails go to the active participants only — each with its
   available teams (burned teams excluded), the deadline and the response
   format (ADR-019: no more TT-1 exception for subscribers without a profile).
2. **Collect** (`channel:email:process`). Players reply in natural language.
   The system interprets each message, validates the Pick (platform account
   active; team playing in the round; team not burned in the girone; valid
   outcome; within the acceptance instant; no previous valid Pick) and
   replies with a confirmation or a rejection with reason. A subscriber
   without a profile is **never joined by a pick** (ADR-019): in the TT 1 the
   system answers `tournament_join_rejected` (`not_in_tournament`, guiding to
   `PARTECIPO`), from the TT 2 onwards a plain rejection (tournament already
   started). Participants enter by auto-join at `tournament:start` or by
   declaring `PARTECIPO`/`tournament:join`. Picks from unknown/unsubscribed
   senders are silently logged.
3. **Close** (`round:close` / scheduler at the deadline). The pick window
   closes; every active profile without a valid Pick is eliminated
   (`missing_pick`) and notified — **unless `AUTOPICK_ON_MISSING=true` with a
   real deadline**: in that case each missing profile receives the first
   available team by `shortName` automatically and is notified with
   `pick_auto_assigned` (no elimination). A forced closure (`--force --reason`)
   consolidates identically at any moment; a safety closure (deadline NULL)
   always eliminates `missing_pick`.
4. **Account** (`round:score` / scheduler). Each pending Pick whose match has
   concluded is evaluated: `correct` (stay) or `wrong` (eliminated,
   notified). Picks on matches postponed beyond the TC window go to
   **Freeze** (notified; evaluated when the match concludes, possibly in a
   later round). The round reaches `scored` when no Pick is pending, and the
   closing summary goes to the survivors (exactly once).
5. **Winner check — automatic.** After `round:close` and after `round:score`
   the system checks whether the tournament has a winner and, if so, closes
   it (§6.6).

The next round opens once the previous one is accounted (`scored`): the
scheduler does it automatically, the commissioner with `round:open`.

**Verification commands during the cycle.** `round:status --round <n>`,
`round:deadline --round <n>`, `data:results --round <n>`,
`channel:email:fetch` (mailbox check), and at any time `tournament:status`,
`tournament:leaderboard`, `tournament:history --email <email>`,
`scheduler:status`.

### 6.5 The half-season boundary

When the tournament crosses the girone boundary (`floor(total rounds / 2) +
1`; round 20 of 38 in the real season), **every team becomes available
again**: the pool resets and the "burned" history of the andata no longer
counts. The system applies this automatically, data-driven — no command is
needed. Pick emails always show each player their currently available teams.

### 6.6 Tournament end: automatic closure

When a winner is identified (single survivor, all remaining eliminated in the
same round, or survivors at the end of the season), the system **closes the
tournament by itself**:

1. it notifies the winner(s) (`tournament_won` / `tournament_shared_win`, with
   the list of the other co-winners in the shared case);
2. it sends `tournament_closed` with the per-round history to **all
   participants** (profiles with at least one Pick, winners included) — ADR-015;
3. it writes the **automatic export** — the full JSON archive of the
   tournament — into `TOURNAMENT_EXPORT_DIR` (the directory is created if
   missing; the same dump format as `tournament:export`);
4. it **stops the scheduler**: no more rounds are opened and no more game
   emails are sent (`scheduler:status` shows `FINITO (chiuso
   automaticamente)`, no next actions).

**Commissioner's closing tasks.** Remove the `scheduler:tick` line from the
crontab (useless ticks otherwise); `channel:email:process` can remain
(registrations/unsubscriptions/clarifications keep working). The history of
the closed tournament remains available in the export archive and read-only
via `winner:check`, `tournament:status`, `tournament:history`,
`tournament:leaderboard`.

### 6.7 Starting a new tournament

From the same system, a new tournament can be started after the previous one
has closed:

1. **Verify the archive.** Confirm that the automatic export of the closed
   tournament exists in `TOURNAMENT_EXPORT_DIR` — it is the historical record
   that makes the restart safe.
2. **Verify the mailbox (pre-flight).** Run `channel:email:fetch` (§5.2) — it
   must report `Nessuna email non letta in casella`. The reset of the
   tournament database does **not** clean the mailbox: any unread message left
   from the previous run (pick, subscription, `PARTECIPO`) would be processed
   by the first `channel:email:process` of the new run and could register a
   **ghost pick or profile** (UAT incident 2026-08-31). If there are unread
   emails, the operator decides how to handle them — never delete valid
   registrations.
3. **Run `tournament:start [--start-round <n>]` again.** When the previous
   tournament is closed, the start is re-admitted and **atomically resets
   only the tournament database** (profiles, picks, round state): the
   **platform database is untouched** — accounts, names and their
   `registerID`s persist across tournaments, so players do not need to
   re-register.
4. Restore the `scheduler:tick` cron line if running in scheduler mode.

The calendar data (`match` table) is not touched by the reset: the same
season data serves the new tournament.

### 6.8 Anomalies and commissioner interventions

The system has defined behaviors for the operational anomalies the
commissioner may face:

- **Forced closure.** Any round can be closed immediately with
  `round:close --round <n> --force --reason "<motivo>"` — same consolidation
  semantics as the deadline closure, audited with the reason. This is also
  the way out of a round with no registered deadline.
- **Safety closure (automatic).** If an open round has no registered deadline
  (data gap), the scheduler closes it automatically when the TC close passes
  (same consolidation), logging the event with the cause. If even the TC
  close cannot be computed, the scheduler logs `warn_not_calculable` and the
  anomaly appears in `tournament:status` / `scheduler:status`; the exit is
  then the forced closure.
- **Commissioner override of the time checks.** `pick:register …
  --reason "<motivo>"` registers a Pick bypassing **only** the time checks
  (deadline/acceptance), never the other rules; the reason is audited.
- **Calendar changes after a round opening.** The registered deadline stays
  fixed; if a match is brought forward so that the kickoff precedes the
  deadline, the anti-fraud guard prevails: no Pick is accepted after the
  actual kickoff (see §8.1).
- **Postponements.** Handled by the Freeze mechanism (§8.3), no intervention
  required.
- **Mode change mid-tournament (fatal).** `WIN_ONLY`, `AUTOPICK_ON_MISSING` and
  `JOLLIES_PER_PLAYER` are fixed in the database at `tournament:start`. If
  `.env` changes any of them while a tournament is open, the next write path
  (`scheduler:tick`, `channel:email:process`,
  `round:open`/`close`/`score`, `pick:register`) **aborts the process** with a
  fatal error naming the persisted vs configured value(s), before any write or
  email is sent (the database stays unchanged). To recover: restore the changed
  variable to the persisted value, or close the tournament and start a new one
  (`tournament:start` re-writes the mode from the new `.env`).

---

## 7. Configuration Management

All parameters live in environment files (`.env` format) and are validated at
startup: a missing or malformed variable fails the command with an error that
names the variable, **before** anything else happens. The defaults documented
here match `.env.example`.

### 7.1 The env-file selector (`ENV_FILE`)

| Parameter | Values | Default | Effect |
|---|---|---|---|
| `ENV_FILE` | path to an env file | `.env` | Selects which env file is loaded: `ENV_FILE=.env.uat npm run cli -- <command>` loads `.env.uat` instead of `.env`. This is the single activation point of TEST MODE. If `ENV_FILE` points to a non-existent file, startup fails naming the path; a missing default `.env` is instead silent (variables may come from the process environment, e.g. cron). **Semantics:** variables already present in the environment are **not** overwritten by the file — an inline `VAR=x` prefix wins over the file. For reproducible scenarios use dedicated env files, not inline overrides. |

### 7.2 Game parameters

| Parameter | Unit | Default | What it controls |
|---|---|---|---|
| `DEADLINE_ADVANCE_MIN` | minutes | `30` | The advance of the pick deadline over the kickoff of the round's first match: `deadline = kickoff − DEADLINE_ADVANCE_MIN`. Registered once at `round:open` and fixed for the whole round. Raising it shortens the pick window; lowering it extends it. |
| `TC_CLOSE_SKEW_MIN` | minutes | `300` | The skew beyond the expected end of the last scheduled match (UPP) that defines the **TC close** — the boundary of the TC window used for postponement decisions (§8.1/§8.3). It is *not* the trigger of the accounting. |
| `MATCH_DURATION_MIN` | minutes | `125` | The estimated duration of a match, used to compute the expected end of each match (`match_date + MATCH_DURATION_MIN`) and therefore the TC close. |
| `MAX_PROFILES_PER_PLAYER` | number | `1` | Maximum profiles per player. POC: 1 — do not change. |
| `WIN_ONLY` | `true` / `false` | `true` | **Game mode `win_only` (default):** `true` = the player picks only the team that will win its match (the system interprets the pick as `outcome = win`; a draw or loss eliminates). `false` = classic mode (explicit win/draw/lose). The mode is **fixed in the database at `tournament:start`** and a fatal guard aborts the process if `WIN_ONLY` changes while a tournament is open: set it **before** `tournament:start` and do not change it mid-tournament. |
| `AUTOPICK_ON_MISSING` | `true` / `false` | `false` | **Auto-pick on a missing pick** (active **only** in `win_only`, i.e. with `WIN_ONLY=true`; otherwise ignored with no error). `true` = at the close of a round with a **real deadline** (`round_state.deadline !== null`), each profile in the game without a pick receives the **first available team by `shortName`** (alphabetical order, `team` table) — no elimination, `pick_auto_assigned` notification; the pick is then scored normally. A safety closure (deadline NULL) always eliminates `missing_pick`. Also **fixed in the database at `tournament:start`** and covered by the same fatal guard as `WIN_ONLY`: set it before `tournament:start`, do not change it mid-tournament. |
| `JOLLIES_PER_PLAYER` | integer ≥ 0 | `1` | **Jolly per player** (feature Jolly, active **only** in `win_only`): `0` = feature **disabled** (the system behaves exactly as today, the "jolly" keyword is ignored); `≥1` = every profile is created with that many jollies (`profile.jollies_remaining`), declared in the pick email with the keyword "jolly" (e.g. "Napoli Jolly") and **burned at declaration**. A draw saves the profile from elimination; a loss does not. Also **fixed in the database at `tournament:start`** (`tournament_state.jollies_per_player`) and covered by the same fatal guard as `WIN_ONLY`: set it before `tournament:start`, do not change it mid-tournament. |
| `ENTRY_FEE_EUR` | EUR | `5` | Entry fee — **placeholder, not used in the POC**. |
| `WINNER_SHARE_PCT` | percent (0–100) | `85` | Winner share of the prize pool — **placeholder, not used in the POC**. |

### 7.3 Infrastructure parameters

| Parameter | Values | Default | What it controls |
|---|---|---|---|
| `IMAP_HOST` / `IMAP_PORT` | host, port | `imap.gmail.com` / `993` | The IMAP server used to receive the players' emails. |
| `IMAP_USER` / `IMAP_PASS` | — | **required** | Credentials of the IMAP mailbox (Gmail: the mailbox address and its App Password). |
| `SMTP_HOST` / `SMTP_PORT` | host, port | `smtp.gmail.com` / `587` | The SMTP server used to send the system's emails. |
| `SMTP_USER` / `SMTP_PASS` | — | **required** | Credentials for sending (Gmail App Password). |
| `IMAP_POLL_MS` | milliseconds | `60000` | Interval between two reads of the mailbox (the cron cadence of `channel:email:process` should match this order of magnitude). |
| `LLM_API_KEY` | — | **required** | API key of the OpenAI-compatible LLM provider. |
| `LLM_API_BASE_URL` | URL | `https://api.openai.com/v1` | Base URL of the LLM API (OpenAI-compatible provider). The system default is `https://api.openai.com/v1`; the project's example file documents `https://openrouter.ai/api/v1` — set it to the provider you actually use. |
| `LLM_MODEL` | comma-separated list | `gpt-4o-mini` | The LLM models **in priority order**: the first is the primary; on retryable errors (rate limit, server errors, timeout, network, malformed body) the client retries up to `LLM_RETRIES` times and then **fails over to the next model**; deterministic 4xx errors fail over directly. Failover never triggers on a valid (even `null`) response. Entries are trimmed, deduplicated in order; an empty list is a startup error. |
| `LLM_TIMEOUT_MS` | milliseconds | `15000` | Timeout of a single LLM request. Lower → faster failover but legitimate slow answers are discarded; higher → more latency tolerance but a worse worst case (models × retries × timeout). |
| `LLM_RETRIES` | number | `3` | Total attempts per model (1 request + N−1 retries, ~1 s apart, only on retryable errors). `1` = no retries. |
| `AI_EMAIL_GENERATOR` | boolean | `false` | Email-v3 switch: `true` = the LLM writes the email narrative (with deterministic fallback on `LLMError`/degenerate output); `false`/absent = deterministic generator (`DeterministicGenerator`), the LLM is **never** called for email texts. Read at every CLI invocation (no daemon restart). Does **not** affect the Parser/Classifier (input side), which follow `AI_EMAIL_PARSER`. |
| `AI_EMAIL_PARSER` | boolean | `false` | Email-v3 Part B switch (ADR-014): `true` = the inbound email intent is classified by the LLM (`OpenAIIntentClassifier`) wrapped in a per-message deterministic fallback (`FallbackIntentClassifier`): on `LLMError` (transport/rate limit/timeout) the message is classified by the deterministic parser and the batch continues; on doubtful content results (`other` / `pick: null`) the deterministic parser is consulted as a second opinion on the pick — if it recognizes a valid pick (e.g. a bare abbreviated team name like "Parma"), the deterministic result wins with a `llm_false_negative` warning, so a valid abbreviated name never ends in a clarification. `false`/absent = deterministic classifier (`DeterministicIntentClassifier`) with the unique formulas `ISCRIZIONE [NOME]`, `DISISCRIZIONE`, `PARTECIPO`, `<TEAM> <ESITO>` in the subject or body; the LLM is **never** called for classification. With both AI flags `false`, `LLM_API_KEY` is not required (no-AI run). |
| `DB_PATH` | path | `./data/survivor.db` | The **tournament** SQLite database (directory created if missing). |
| `PLATFORM_DB_PATH` | path | `./data/platform.db` | The **platform** database: separate storage of the accounts. **Never equal to `DB_PATH`** — two distinct connections, no cross-database transactions. It persists across tournament resets (accounts are not deleted when a new tournament starts). |
| `TOURNAMENT_EXPORT_DIR` | path | `./data/exports/` | Destination directory of the **automatic exports** at tournament closure (the JSON archive that makes a database reset safe). Created if missing; must be writable by the process. |
| `TIMEZONE` | IANA string | `Europe/Rome` | The timezone used **only for outward communication**: dates in the emails and timestamps in the logs. The game system always processes absolute UTC instants: changing this parameter **never alters any game decision** — it only moves the dates displayed (e.g. `America/New_York`). An invalid string fails the startup naming the variable. |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` | Log verbosity (pino JSON lines on stdout; the cron collects them). The audit of scheduler and game events lives in these logs. |

### 7.4 Season data parameters

| Parameter | Values | Default | What it controls |
|---|---|---|---|
| `FOOTBALL_DATA_TOKEN` | — | **required** | The football-data.org API token (header `X-Auth-Token`), supplied by the product owner. |
| `FOOTBALL_DATA_BASE_URL` | URL | `https://api.football-data.org` | Base URL of the football-data API. |
| `FOOTBALL_DATA_COMPETITION` | competition code | `SA` | Competition code: `SA` = Serie A. |
| `FOOTBALL_DATA_SEASON` | year | `2025` | Season start year: `2025` = season 2025/26. |

### 7.5 Scheduler parameters

| Parameter | Values | Default | What it controls |
|---|---|---|---|
| `SCHEDULER_ENABLED` | `true` / `false` | `false` | `true` = scheduler active (production, via cron); `false` = manual CLI operations only (development/test). With `false`, `scheduler:tick` exits without effects; the manual commands work regardless. |
| `SCHEDULER_TICK_MIN` | minutes | `1` | Documented interval between two `scheduler:tick` executions by the cron (informational: set it equal to the cron cadence). |
| `SCHEDULER_AUTO_SCORE` | `true` / `false` | `true` | `true` = the scheduler accounts closed rounds automatically (`round:score` at each tick); `false` = the commissioner accounts manually. |

### 7.6 Simulation parameter

| Parameter | Unit | Default | What it controls |
|---|---|---|---|
| `SIM_PLAYERS` | number | `10` | Number of synthetic profiles registered by `simulate:full` / `simulate:round` (deterministic dry-run; no emails). |

### 7.7 Test-mode parameters

| Parameter | Values | Default | What it controls |
|---|---|---|---|
| `TEST_MODE` | `true` / `false` | `false` | Activates TEST MODE (banner everywhere, synthetic roster, gating of the test-only parameters). Set it in a dedicated env file (`.env.uat`), **never** in the production files. |
| `TEST_OFFSET_DAYS` | integer ≥ 0 (days) | `0` | Shifts the system clock **and** the email reception timestamps by the same amount, only when `TEST_MODE=true` and the value is > 0. Exists **only** for the replay of historical data (e.g. the 2025 season) on a dedicated database: re-aligns the real now to the historical dates. `0` = everything real. With `TEST_MODE=false` it is ignored; a malformed value falls back to `0` silently. Never use it on a synthetic future calendar. |
| `TEST_REFRESH_ALLOWED` | `true` / `false` | `false` | When `TEST_MODE=true`: `false` (default) blocks `data:import`/`data:refresh` and the scheduler's refresh (protecting the synthetic calendar); `true` allows them with a consent WARN per operation (including the database path). Use `true` **only** on databases with real data, never on a synthetic calendar; remove it when the test ends. With `TEST_MODE=false` it is ignored. |

### 7.8 Validation, required values and timezone semantics

- **Required (no default):** `IMAP_USER`, `IMAP_PASS`, `SMTP_USER`,
  `SMTP_PASS`, `LLM_API_KEY`, `FOOTBALL_DATA_TOKEN`. A command needing them
  fails at startup, naming each missing/invalid variable.
- **UTC processing.** The game logic works exclusively on absolute UTC
  instants (stored as ISO-8601 UTC). `TIMEZONE` is injected only when
  presenting dates to the outside (emails, log timestamps).
- **Secrets.** `.env` files contain credentials and are excluded from git —
  never commit them.
- **Example cron line** (documented in `.env.example`):
  `*/1 * * * * cd /home/fulvio/dev/SurvivorLeague && npm run cli -- scheduler:tick >> /var/log/survivor.log 2>&1`
  (JSON logs on stdout, collected by cron; execution state and audit live in
  the log, nothing is persisted for the scheduler).

---

## 8. Tournament Timing

This section defines every temporal quantity of the game: when each window
opens, when it closes, and what triggers it.

### 8.1 The temporal quantities

For a championship round (TC), three anchors are derived from the calendar:

| Quantity | Definition | Trigger / when |
|---|---|---|
| **Kickoff (fischio d'inizio)** | The scheduled start of the **first** match of the TC (from the calendar data). | Given by the data; the reference for the anti-fraud guard. |
| **Deadline** | `kickoff − DEADLINE_ADVANCE_MIN` (default: 30 minutes before the kickoff). | **Computed once at `round:open`** from the scheduled calendar and registered; it stays **fixed** for the entire round even if the calendar changes afterwards. |
| **TC close (chiusura del TC)** | Expected end of the **last scheduled match** (UPP) plus `TC_CLOSE_SKEW_MIN`; the expected end of a match is `match_date + MATCH_DURATION_MIN`. | Derived from the calendar; defines the **TC window** `[kickoff, tcClose]` used for postponement decisions — **not** the trigger of the accounting. |

Derived quantities:

- **Pick window (finestra di Pick).** From the **opening of the TT** to the
  **deadline**. The TT 1 opens at the tournament opening; each subsequent TT
  opens when the previous TC has ended (operationally: the system opens the
  next round once the previous one is accounted — `scored`; the scheduler
  does it automatically, the commissioner with `round:open`).
- **Acceptance instant (accettazione).** The moment a Pick must not exceed to
  be accepted: `min(registered deadline, actual kickoff of the round's first
  match)`. With the nominal deadline it is redundant (deadline = kickoff −
  advance); it bites when the deadline is NULL/erroneous or when a match is
  brought forward after the round opening — in that case the guard prevails
  over the fixed deadline. The timestamp that counts is the **server-side
  reception time** (`receivedAt`, IMAP internaldate), never the `Date` header
  written by the player's mail client.
- **TT close.** When all the Picks of the TT have reached a terminal state:
  accounted (`correct`/`wrong`) or **frozen**. Frozen picks do not delay the
  TT close.
- **TC window.** `[kickoff, tcClose]` — the interval in which a postponed
  match can be recovered without consequences for the Picks (§8.3).

Operationally, a late pick in the standard scheduler flow receives the
`round_not_open` rejection (the scheduler has already closed the round at the
deadline, which precedes the kickoff). The specific `after_kickoff` rejection
is observable only when a round is deliberately kept open beyond the kickoff
(commissioner mode) or in the NULL-deadline case — see
`docs/uat/guida-test-mode.md` §6.3.

### 8.2 The half-season boundary and the pool reset

- The season is divided into two gironi: **andata** and **ritorno**. The
  boundary is **derived from the data**: `floor(total rounds / 2) + 1` — with
  38 matchdays the boundary is round **20** (andata = TC 1–19, ritorno =
  TC 20–38).
- A team picked in a girone is **bruciata** for the rest of that girone.
- **At the start of the boundary round the pool resets**: every team becomes
  available again, and each profile can reuse a team already picked in the
  previous girone. With 20 teams and 19 matchdays per girone, every profile
  always has at least one available team.
- The reset is automatic and data-driven; no command or trigger is involved.
- With an asynchronous attachment, the same rule applies unchanged over the
  whole season: attaching to TC 20 resets the pool at the very start of the
  tournament; attaching beyond mid-season plays only the ritorno.

### 8.3 Postponed matches and Freeze

When a match is postponed (a suspended match is treated the same way), the
Picks on it follow the recovery date:

- **Recovery within the TC window** (`[kickoff, tcClose]`) → the Pick stays
  valid and is accounted with the recovery result when available.
- **Recovery beyond the TC window** → the Pick enters **Freeze**: it is
  neither correct nor wrong, the profile is **not** eliminated for it, and
  the team **remains burned** in the current girone. The Pick is accounted
  whenever the match is eventually played and concluded — possibly rounds
  later — and a wrong outcome eliminates the profile at that point. The
  Freeze transition is notified (`pick_postponed`).
- **The UPP itself is postponed** → the TC closes anyway at the computed
  instant and the relative Picks freeze.

A frozen Pick never blocks the TT closure, the pool boundary, or the
tournament's progression; if the match is never played within the season, the
Pick is simply never accounted.

### 8.4 The end of the tournament

The tournament ends in three cases, checked automatically after every round
closure and accounting:

1. **One profile remains in the game** → that profile wins.
2. **All the profiles still in the game are eliminated in the same TT** →
   they share the victory.
3. **Two or more profiles survive after the last TC of the season** → they
   share the victory.

On identification, the closure is automatic and complete: winner notification,
`tournament_closed` with the per-round history to all participants, automatic
export to `TOURNAMENT_EXPORT_DIR`, scheduler stopped (§6.6).

### 8.5 Worked example with production defaults

With the production defaults (`DEADLINE_ADVANCE_MIN=30`,
`MATCH_DURATION_MIN=125`, `TC_CLOSE_SKEW_MIN=300`), for a round whose first
match kicks off on Saturday at 15:00 and whose last scheduled match starts on
Sunday at 20:45:

- **deadline** = Saturday 14:30 (15:00 − 30 min);
- **expected end of the last match** = Sunday 22:50 (20:45 + 125 min);
- **TC close** = Monday 03:50 (22:50 + 300 min);
- **pick window** = from the TT opening (end of the previous TC / previous
  round accounted) to Saturday 14:30;
- **acceptance instant** = Saturday 14:30 (min(14:30, 15:00) — the guard
  becomes relevant only if a match is brought forward or the deadline is
  missing);
- a postponed match recovered before Monday 03:50 keeps its Picks valid; one
  recovered later sends its Picks to Freeze.

### 8.6 The compressed UAT example

The same quantities in the compressed synthetic configuration used by the
timeline example (`docs/uat/timeline-example.excalidraw`) — 4 teams, 6
rounds, `--spacing-min 5`, `--first-kickoff-offset-min 3`,
`DEADLINE_ADVANCE_MIN=2`, `MATCH_DURATION_MIN=1`, `TC_CLOSE_SKEW_MIN=4`
(real clock, t=0 at seed time):

| Quantity | Value |
|---|---|
| offset (first kickoff after the seed) | 3 min (`--first-kickoff-offset-min`) |
| advance (deadline before kickoff) | 2 min (`DEADLINE_ADVANCE_MIN`) |
| spacing between rounds | 5 min (`--spacing-min`) |
| estimated match duration | 1 min (`MATCH_DURATION_MIN`) |
| TC skew | 4 min (`TC_CLOSE_SKEW_MIN`) |
| **TC window** | **5 min** (1 + 4) |
| pick window — round 1 | **1 min** (offset − advance) |
| pick window — rounds 2–6 | **5 min** (= spacing) |
| girone boundary | `floor(6/2)+1` = **4** → pool resets at the start of round 4 (andata R1–R3, ritorno R4–R6) |
| total | 28 min (to the last kickoff) |

The non-overlap rule is visible here: spacing (5 min) must be ≥
`MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN` (1 + 4 = 5 min) — equality is the
minimum; the practical UAT timelines use `--spacing-min 45`.

---

## 9. Appendix: glossary of Italian terms

The domain terms used throughout the system's output, kept in Italian:

| Term | Meaning |
|---|---|
| **Pick** | A player's prediction: one team + one outcome (win/draw/lose). |
| **`win_only` (modalità)** | The default game mode (`WIN_ONLY=true`) where a Pick is just the team that will win: the system stores `outcome = win`, so a win keeps the profile in and a draw/loss eliminates it. |
| **TC — Turno di Campionato** | The championship matchday (the real round number of the season). |
| **TT — Turno del Torneo** | The tournament round; `TT = TC − start_round + 1`. |
| **TTnTCm** | The compact double numbering of a turn (e.g. `TT2TC7`), used in the CLI and logs. In emails the body carries the extended form "Round del torneo N · Turno di Campionato M"; the subject carries no turn at all, only the type label (in TEST MODE the brand is prefixed with `🚧⚠️TEST MODE⚠️🚧 - `). |
| **Girone / andata / ritorno** | Half-season (first leg / second leg); the team pool resets at the boundary `floor(N/2)+1`. |
| **Bruciata (team)** | A team already used by a profile in the current girone — no longer pickable. |
| **Finestra di Pick** | The pick window: from the round opening to the deadline. |
| **Deadline** | The last instant a Pick is accepted, fixed at round opening (`kickoff − DEADLINE_ADVANCE_MIN`). |
| **Fischio d'inizio (kickoff)** | The scheduled start of the round's first match. |
| **Chiusura del TC** | The TC close: expected end of the last scheduled match plus the configured skew. |
| **Freeze** | The state of a Pick whose match was postponed beyond the TC window: pending, team burned, accounted when the match is played. |
| **UPP — Ultima partita programmata** | The last scheduled match of the TC (defines the TC close). |
| **Rinviata (match)** | Postponed match. |
| **Commissioner** | The tournament administrator, the only user of the CLI. |
| **Auto-join** | Automatic tournament entry at `tournament:start` for the accounts with `tournament_auto_join = ON` (ADR-019). Distinct from the declaration (`PARTECIPO` / `tournament:join`). |
| **PARTECIPO (join)** | The unique email formula declaring tournament participation (ADR-019). It is NOT a platform registration: the account must already exist. |
| **Soft-delete / disiscrizione a due passi** | Two-step unsubscription: pending confirmation first, actual unsubscription only after the explicit confirmation. |
| **Iscritto vs partecipante** | A platform subscriber (account) vs a tournament participant (a subscriber with a profile). Participation is opt-in: auto-join at start or declaration. |
| **Stagione avviata** | "Season started" — the state entered by `tournament:start`. |
