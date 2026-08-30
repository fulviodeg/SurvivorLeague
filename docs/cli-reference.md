
# Survivor League — CLI Reference

> **Role of this document.** Complete reference of every command exposed by the
> Survivor League administration CLI, organized by area and written in the style
> of Unix/Linux "man" pages: for each command, the purpose, the available
> parameters, and a detailed explanation of each parameter.
>
> **Relationship with the administrator's manual.** The *Technical
> Administrator's Manual* (`docs/technical-administrator-manual.md`) describes
> the operational workflows that use these commands; this document is the
> complete command catalog. Every command quoted here exists with exactly this
> name, these options, and these semantics.
>
> **Language convention.** The reference is written in English; concepts that
> are Italian in the system's domain (Pick, TC/Turno di Campionato, TT/Turno
> del Torneo, girone di andata/ritorno, commissioner, …) are kept in Italian.
> Verbatim system output is quoted in its original language: most CLI text
> output is Italian, log messages and warnings are English (project
> constraint); where a quoted message carries a trailing internal document
> reference (e.g. `(LLD §7.12)`), that suffix is omitted. Nothing here is
> invented: every message quoted is printed by the system in the form shown.

---

## Table of contents

- [1. Invocation and common conventions](#1-invocation-and-common-conventions)
- [2. Setup commands](#2-setup-commands)
  - [`db:migrate`](#dbmigrate) · [`platform:migrate`](#platformmigrate)
- [3. Platform commands](#3-platform-commands)
  - [`platform:register`](#platformregister) · [`platform:unregister`](#platformunregister) · [`platform:list`](#platformlist)
- [4. Season data commands](#4-season-data-commands)
  - [`data:import`](#dataimport) · [`data:refresh`](#datarefresh) · [`data:calendar`](#datacalendar) · [`data:results`](#dataresults) · [`data:seed-synthetic`](#dataseed-synthetic)
- [5. Game engine — rules](#5-game-engine--rules)
  - [`rules:burned-teams`](#rulesburned-teams) · [`rules:available-teams`](#rulesavailable-teams) · [`rules:check-half`](#rulescheck-half) · [`rules:teams`](#rulesteams)
- [6. Game engine — picks](#6-game-engine--picks)
  - [`pick:validate`](#pickvalidate) · [`pick:register`](#pickregister) · [`pick:list`](#picklist)
- [7. Game engine — eliminations](#7-game-engine--eliminations)
  - [`elimination:check`](#eliminationcheck) · [`elimination:list`](#eliminationlist)
- [8. Game engine — winner](#8-game-engine--winner)
  - [`winner:check`](#winnercheck)
- [9. Round lifecycle](#9-round-lifecycle)
  - [`round:open`](#roundopen) · [`round:close`](#roundclose) · [`round:score`](#roundscore) · [`round:status`](#roundstatus) · [`round:deadline`](#rounddeadline)
- [10. Tournament commands](#10-tournament-commands)
  - [`tournament:start`](#tournamentstart) · [`tournament:status`](#tournamentstatus) · [`tournament:history`](#tournamenthistory) · [`tournament:leaderboard`](#tournamentleaderboard) · [`tournament:export`](#tournamentexport)
- [11. Email channel](#11-email-channel)
  - [`channel:email:fetch`](#channelemailfetch) · [`channel:email:process`](#channelemailprocess) · [`channel:email:send`](#channelemailsend)
- [12. Scheduler](#12-scheduler)
  - [`scheduler:tick`](#schedulertick) · [`scheduler:status`](#schedulerstatus)
- [13. Simulation (dry-run)](#13-simulation-dry-run)
  - [`simulate:full`](#simulatefull) · [`simulate:round`](#simulateround)
- [14. LLM diagnostics](#14-llm-diagnostics)
  - [`llm:parse`](#llmparse) · [`llm:classify`](#llmclassify) · [`llm:generate`](#llmgenerate)

---

## 1. Invocation and common conventions

All commands are invoked through npm:

```bash
npm run cli -- <command> [options]
```

Example: `npm run cli -- tournament:start --start-round 1`

**Environment file selector.** Prefixing a command with `ENV_FILE=<path>` loads
that env file instead of the default `.env`:

```bash
ENV_FILE=.env.uat npm run cli -- <command>
```

This is the single activation point of TEST MODE (see the administrator's
manual, §Operational Modes). If `ENV_FILE` points to a file that does not
exist, startup fails with an error that names the path.

**Common options.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | Structured JSON output instead of human-readable text. In TEST MODE the JSON payload always includes the field `"testMode": true`. |
| `--help` / `-h` | — | Prints the command help. Works without a valid environment (no config required). |

**Common behaviors.**

- **TEST MODE banner.** When `TEST_MODE=true` (env file loaded), every command
  prints the line `TEST MODE` as the first line of its text output, before any
  other content.
- **Exit codes.** A command that completes successfully exits with code `0`.
  Configuration errors, rejected operations and command errors exit with code
  `1` and print a clean error message on stderr (no stack trace). In
  particular, `pick:register` exits with code `1` when the pick is rejected,
  with the rejection reason in the message.
- **Output language.** Human-readable CLI text is Italian (e.g.
  `Stagione avviata: TT1 = TC 1, 38 round inizializzati (confine girone 20)`);
  structured log lines (pino, on stdout) and warning/error log messages are
  English.
- **Idempotency.** All write operations are idempotent and re-runnable: a
  command repeated when its work is already done completes without side
  effects or reports the current state.

---

## 2. Setup commands

### `db:migrate`

```
db:migrate [--json]
```

**Purpose.** Creates the tournament database file at `DB_PATH` (the directory
is created if missing) and applies the data-model tables. Idempotent: safe to
re-run at any time. Validates the whole configuration at startup: if a
required variable is missing or malformed, the command fails with an explicit
message that names the variable, before touching the database.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "dbPath": "<path>", "migrated": true}` instead of the text `Database migrato: <path>`. |

**Notes.** This command operates only on the tournament database
(`DB_PATH`). The platform database has its own migration command
(`platform:migrate`).

---

### `platform:migrate`

```
platform:migrate [--json]
```

**Purpose.** Creates/migrates the tables of the **platform database** at
`PLATFORM_DB_PATH` — the separate storage of platform accounts (email,
internal `registerID`, status). Idempotent. The two databases (tournament and
platform) are always distinct files and never share transactions.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "migrated": true, "dbPath": "<path>"}` instead of the text `DB piattaforma migrato: <path>`. |

---

## 3. Platform commands

### `platform:register`

```
platform:register --email <email> [--name <nome>] [--reason <motivo>] [--json]
```

**Purpose.** The **only** command that creates a platform account. Creates (or
reactivates) the account for the given email with a stable internal
`registerID` (re-used on every re-registration). It does **not** create a
tournament profile: participation in the tournament is born exclusively from
the first valid pick in the TT 1 (auto-join). If the account already exists
and is `active`, it is returned as-is.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--email` | string, **required** | Email of the account. Unique; normalized exactly like the incoming-email router (trimmed, lowercased, display name removed), so the same identity always maps to the same account. |
| `--name` | string | Player name, saved at first creation. If absent, the system uses the email address in place of the name. |
| `--reason` | string | Audited reason of the operation (traceability). Recommended for any manual account change. |
| `--json` | boolean (default `false`) | JSON output with the account object (`registerId`, `email`, `status`, dates) instead of the text `Account <email> (registerID <id>) — status <status>`. |

---

### `platform:unregister`

```
platform:unregister --email <email> [--reason <motivo>] [--json]
```

**Purpose.** Direct soft-delete of a platform account: status becomes
`unsubscribed`. The tournament profile (if any) remains intact — historical
data is never touched. Re-registration with the same email reuses the same
`registerID`. If no account exists for the email, prints
`Nessun account per <email> (mai iscritto)`.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--email` | string, **required** | Email of the account to unsubscribe (normalized as in `platform:register`). |
| `--reason` | string | Audited reason of the unsubscription (recommended). |
| `--json` | boolean (default `false`) | JSON output with the updated account object. |

---

### `platform:list`

```
platform:list [--json]
```

**Purpose.** Lists all platform accounts ordered by `registerID`: internal
`registerID`, email, status (`active` / `pending_unsubscribe` /
`unsubscribed`) and the relevant dates. Read-only.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "accounts": […]}` instead of the text list (or `Nessun account piattaforma registrato` when empty). |

---

## 4. Season data commands

### `data:import`

```
data:import [--json]
```

**Purpose.** Downloads the season (calendar and scores) from the
football-data.org API and loads it into the `match` table of the tournament
database with an idempotent upsert (key: round, home team, away team).
Repeated executions never duplicate rows. Used for the **initial** population
of the database.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "mode":"import", "matches": <n>}` instead of the text `Importate <n> partite nella tabella match`. |

**Notes.**

- **TEST MODE guard.** With `TEST_MODE=true` and `TEST_REFRESH_ALLOWED=false`
  (the default), the command performs **no API call and no write** and prints
  (and logs): `import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled`.
  With `TEST_REFRESH_ALLOWED=true` it operates normally, emitting a consent
  WARN that includes the database path at every operation.
- Requires a valid `FOOTBALL_DATA_TOKEN` and connectivity to the API.

---

### `data:refresh`

```
data:refresh [--json]
```

**Purpose.** Same logic as `data:import` (idempotent upsert), used to **update
calendar changes and match results during the season**. The scheduler invokes
this refresh automatically at every tick in production (scheduler mode), so
that scores of concluded matches become available to the accounting
(`round:score`) as soon as the source publishes them.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "mode":"refresh", "matches": <n>}` instead of the text `Aggiornate <n> partite nella tabella match`. |

**Notes.** The TEST MODE guard described for `data:import` applies identically.
On a synthetic (UAT) calendar, refresh must **never** be allowed: it would
overwrite the invented dates with the real season.

---

### `data:calendar`

```
data:calendar [--json]
```

**Purpose.** Prints the complete season calendar from the `match` table.
Read-only; useful to verify the data after import or seeding. Each line is
formatted as `R<round> <ISO-8601 UTC date> <home team> <score|–> <away team>`
with an optional `[da giocare]` (no score yet) or `[rinviata]` (postponed)
note.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON array of matches (`round`, `matchDate`, `homeTeam`, `awayTeam`, `homeScore`, `awayScore`, `postponed`). |

---

### `data:results`

```
data:results --round <n> [--json]
```

**Purpose.** Prints the matches (with scores when available) of a single
championship round from the `match` table. Read-only.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) whose results to show. |
| `--json` | boolean (default `false`) | JSON array of matches as in `data:calendar`. Text mode prints `Nessuna partita per il round <n>` when the round has no matches. |

---

### `data:seed-synthetic`

```
data:seed-synthetic [--teams <n>] [--rounds <n>] [--spacing-min <n>]
                    [--first-kickoff-offset-min <n>] [--seed <n>]
                    [--force] [--clear] [--json]
```

**Purpose.** TEST MODE tool (UAT): generates an invented but coherent
synthetic championship calendar (Serie A 2026/27 teams) with **pre-seeded scores** and
loads it into the `match` table of the tournament database. The seeded scores
make the compressed UAT cadence possible: `round:score` can complete
immediately after a round closes, so the next round can open without waiting.

**Parameters.**

| Option | Type | Default | Description |
|---|---|---|---|
| `--teams` | number | `8` | Number of teams, from 2 to 20, taken from the synthetic Serie A 2026/27 roster. |
| `--rounds` | number | `7` | Number of rounds (matchdays). With 8 teams the complete round-robin is 7; larger values repeat the pairings (wrap). Also the domain of attachable TCs: `--start-round` of `tournament:start` must be within `1..rounds`. |
| `--spacing-min` | number | `90` | Minutes between two consecutive rounds (spaces rounds only; all matches of the same round share the same kickoff time). |
| `--first-kickoff-offset-min` | number | `120` | Minutes from *now* (real clock) to the kickoff of the first round. |
| `--seed` | number | `42` | Deterministic seed of the score generator: same seed → same scores on all matches. |
| `--force` | boolean | `false` | Allows seeding a non-empty `match` table. Without `--clear`, the upsert never deletes existing rows → possible **mixed calendar** (real season + synthetic Serie A 2026/27); a WARN (English) warns about the inconsistency. |
| `--clear` | boolean | `false` | Empties the `match` table (and only that table) before seeding. Requires `--force` (double confirmation). Refused while a tournament is in progress (`season_started=1` or rows in `pick`/`round_state`). |
| `--json` | boolean | `false` | JSON summary (`teams`, `rounds`, `matches`, `firstKickoff`, `lastKickoff`, `warnings`). |

**Guards and warnings (exact behavior).**

1. **Non-empty table without `--force`** → refusal, no write: message invites
   to use `--force` or `--force --clear`.
2. **`--force` without `--clear` on a non-empty table** → proceeds with the
   upsert, keeps existing rows, and emits the mixed-calendar WARN (in English)
   both in the log and in the output.
3. **`--clear` without `--force`** → refusal (destructive operation needs the
   double confirmation).
4. **`--force --clear` with game state present** (season started or existing
   picks/round state) → refusal: the calendar cannot be emptied mid-tournament.
   In practice: re-seed with `--clear` **before** `tournament:start`.
5. **Overlap detection.** If `--spacing-min` is smaller than
   `MATCH_DURATION_MIN + TC_CLOSE_SKEW_MIN` (from the configuration), the
   windows of consecutive rounds would overlap: the command logs an English
   `error` naming the parameters involved (it does **not** block).
6. **Outside TEST MODE.** With `TEST_MODE=false` the command proceeds but
   emits the warning (also in the output):
   `WARNING: data:seed-synthetic is a test-only command: seeding with TEST_MODE=false may pollute a production database with synthetic data`.

**Notes.** This command is one of the UAT tools; the operational workflows and
the copy-paste timelines are in `docs/uat/guida-test-mode.md` (in Italian).

---

## 5. Game engine — rules

### `rules:burned-teams`

```
rules:burned-teams --profileId <id> [--half <1|2>] [--json]
```

**Purpose.** Shows the teams already used ("burned") by a profile in a given
girone — by default the **current** girone, derived from the most advanced
round present in the system (andata if no round is open yet). Read-only,
diagnostic.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--profileId` | number, **required** | ID of the profile. |
| `--half` | number | Girone to inspect: `1` = andata, `2` = ritorno. Omitted → the current girone. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "profileId":…, "half":…, "teams": […]}`. Text output: `Profilo <id> — girone andata|ritorno: <teams>` (or `nessuna squadra bruciata`). |

---

### `rules:available-teams`

```
rules:available-teams --profileId <id> --round <n> [--json]
```

**Purpose.** Shows the teams a profile can pick in a given round: teams
playing in that round (per calendar) that the profile has not yet burned in
the current girone. Read-only, diagnostic.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--profileId` | number, **required** | ID of the profile. |
| `--round` | number, **required** | Championship round (TC) to evaluate. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "profileId":…, "round":…, "teams": […]}`. Text output: `Profilo <id> — round <n>: <teams>` (or `nessuna squadra disponibile`). |

---

### `rules:check-half`

```
rules:check-half --round <n> [--json]
```

**Purpose.** Tells which girone a championship round belongs to: `1` = andata,
`2` = ritorno. The boundary is derived from the total number of rounds in the
data (`floor(total/2) + 1`), never hardcoded. Read-only, diagnostic.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to evaluate. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "round":…, "half":…, "totalRounds":…, "label":"andata"|"ritorno"}`. Text output: `Round <n> — girone andata|ritorno (confine derivato da <N> round)`. |

---

### `rules:teams`

```
rules:teams [--json]
```

**Purpose.** Lists the teams from the `team` table **ordered by `short_name`**
(generic name, e.g. "Inter"), as pairs *generic + canonical*. Feature AUTOPICK
(ADR-017): this is the alphabetical order the auto-pick uses when a profile
misses the deadline, and the verification tool for the first real
`data:import` (the imported `shortName`s must match expectations). Read-only,
**no live API call**: reads only the current tournament database.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `[{ "name": …, "shortName": … }, …]` (the `testMode` wrapper when in TEST MODE). Text output: one line `<shortName> (<name>)` per team, e.g. `Inter (FC Internazionale Milano)`. |

**Guards and warnings.**

1. **Empty `team` table** → text output `Tabella team vuota: esegui data:import o data:seed-synthetic per popolarla.` (JSON: empty array). The table is populated only by `data:import` / `data:refresh` / `data:seed-synthetic`; a legacy database keeps it empty until then.

---

## 6. Game engine — picks

### `pick:validate`

```
pick:validate --round <n> --profileId <id> --team <name> [--outcome <win|draw|lose>] [--json]
```

**Purpose.** Validates a pick **without registering it**, applying the same
rule cascade as automatic (email) picks: team playing in the round, team not
burned in the girone, valid outcome, acceptance window (registered deadline
and actual kickoff), no existing valid pick for the same round. The JSON
output is `{valid, reason}` where `reason` is the specific rejection reason.
Diagnostic/audit tool.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) of the pick. |
| `--profileId` | number, **required** | ID of the profile. |
| `--team` | string, **required** | Canonical team name (exact match with the data). |
| `--outcome` | string, **optional** | Predicted outcome: `win` \| `draw` \| `lose`. **Optional, no CLI default**: if omitted the pick is rejected with `invalid_outcome` by the cascade (the CLI does not decide the mode — in `win_only` the pick is a bare team, but the commissioner must still pass `--outcome win` explicitly). |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "valid":…, "reason":…}`. Text output: `Pick valido` or `Pick non valido: <reason>`. |

---

### `pick:register`

```
pick:register --round <n> --profileId <id> --team <name> [--outcome <win|draw|lose>]
              [--reason <motivo>] [--json]
```

**Purpose.** Validates a pick (same rules as automatic picks, always) and
registers it atomically — one valid pick per profile per round (enforced by
database uniqueness). This is the commissioner's override tool: `--reason`
bypasses **only** the time checks (acceptance window), never the other rules.
The profile's platform account must be `active`: otherwise the command exits
with code `1` and a message naming the blocked account.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) of the pick. |
| `--profileId` | number, **required** | ID of the profile. |
| `--team` | string, **required** | Canonical team name (exact match). |
| `--outcome` | string, **optional** | Predicted outcome: `win` \| `draw` \| `lose`. **Optional, no CLI default**: if omitted the pick is rejected with `invalid_outcome` (the CLI does not decide the mode). |
| `--reason` | string | Audited reason of the commissioner's override. Required in practice when registering outside the acceptance window. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "id":…, "status":…}`. Text output: `Pick registrato: id <id> (<status>)`. |

**Notes.** A rejected pick exits with code `1` and prints `Pick rifiutato: <reason>`
(the clean-message contract of the CLI, no stack trace).

---

### `pick:list`

```
pick:list (--round <n> | --profileId <id>) [--json]
```

**Purpose.** Lists registered picks (read-only), filtered by round and/or
profile. At least one filter is mandatory.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number | Filter by championship round (TC). |
| `--profileId` | number | Filter by profile. |
| `--json` | boolean (default `false`) | JSON array of picks. Text output, one line per pick: `#<id> profilo <profileId> (<email>) R<round> <team> <outcome> [<status>]` (or `Nessun pick trovato`). |

---

## 7. Game engine — eliminations

### `elimination:check`

```
elimination:check --profileId <id> [--json]
```

**Purpose.** Tells whether a profile is eliminated and why. Read-only,
idempotent (eliminations themselves are written only by `round:close` /
`round:score`).

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--profileId` | number, **required** | ID of the profile. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "profileId":…, "eliminated":…, "reason":…, "eliminatedAt":…}`. Text output: `Profilo <id> eliminato (<reason>) il <timestamp>` or `Profilo <id> in gara`. |

---

### `elimination:list`

```
elimination:list [--json]
```

**Purpose.** Lists all eliminated profiles with email, elimination reason
(`missing_pick` / `wrong_pick`) and the exact elimination instant.
Read-only.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON array of eliminated profiles. Text output: one line per profile `Profilo <id> (<email>) — <reason> il <timestamp>`, or `Nessun profilo eliminato`. |

---

## 8. Game engine — winner

### `winner:check`

```
winner:check [--json]
```

**Purpose.** Tells whether the tournament is finished and, if so, who won —
in read-only mode, at any time (audit view). The JSON output is
`{finished, winners, case}` where `case` identifies which end-of-tournament
case occurred (single survivor; all remaining eliminated in the same round;
survivors sharing victory at the end of the season). Note that the winner
check also runs **automatically** inside `round:close` and `round:score`; this
command is the read-only inspection of the same verdict.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "finished":…, "winners":[…], "case":…}`. Text output: `Torneo in corso` or `Torneo finito (caso <case>): vincitore/i — <email> (profilo <id>), …`. |

---

## 9. Round lifecycle

These five commands implement the operating cycle of a single round
(`pending → open → closed → scored`).

### `round:open`

```
round:open --round <n> [--json]
```

**Purpose.** Opens a round: creates its state row, computes and registers the
**fixed deadline** (kickoff of the first match of the round minus the
configured advance, computed once from the calendar and never changed
afterwards), and sends the pick instruction emails. Recipients: the active
participants (with their **available teams**, the deadline and the response
format); at the opening of the **TT 1**, also the active platform subscribers
who have no profile yet (they will become participants with their first valid
pick). Refused if the round is already open or is in a terminal state
(closed/scored); refused if the tournament is closed. **Refused if the
deadline is not in the future** (`now >= deadline` at open time): opening a
round whose pick window has already expired would make every incoming pick
unacceptable (anti-fraud guard RF-31), so the command fails with a clear
message naming the deadline instead of creating a silent trap (UAT incident
2026-08-22). The scheduler opens rounds as soon as the previous TC is scored,
always with future kickoffs, so the automatic flow is not affected.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to open. |
| `--json` | boolean (default `false`) | JSON output with `tc`, `tt`, `deadline`, `notified`, `registeredNotified`. Text output: `Round <tc> (TT <tt>) aperto — deadline <ISO>, profili notificati: <n>, registrati senza profilo notificati: <m>`. |

---

### `round:close`

```
round:close --round <n> [--force] [--reason <motivo>] [--json]
```

**Purpose.** Closes the pick window of a round and consolidates: every active
profile **without a valid pick** is eliminated (`missing_pick`) and notified.
Valid picks simply stay registered awaiting accounting. A forced closure
(`--force`) has **exactly the same semantics** as the natural closure at the
deadline — there is no "close without eliminating". Forced closure is the
commissioner's tool to close immediately, or to close a round whose deadline
is NULL/not registered. Each forced closure is audited with its reason.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to close. |
| `--force` | boolean (default `false`) | Forced closure (same consolidation semantics as the deadline closure). |
| `--reason` | string | Audited reason of the forced closure. **Mandatory with `--force`.** |
| `--json` | boolean (default `false`) | JSON output with the round result and the eliminated profiles. Text output: `Round <tc> (TT <tt>) chiuso[( forzata)] — eliminati per pick mancante: <list|nessuno>`. |

---

### `round:score`

```
round:score --round <n> [--json]
```

**Purpose.** Accounts the round **incrementally**: each pending pick whose
match has concluded (score available in the data) is evaluated against the
prediction → `correct` (stay in game) or `wrong` (elimination, notified);
pending picks whose match was postponed beyond the TC window become `frozen`
(notified), and frozen picks are evaluated as soon as their match concludes —
even on rounds already `scored`. The round moves to `scored` when no `pending`
pick remains. Idempotent: processes only pending picks, safe to re-run. At the
transition `closed → scored` (and only there, exactly once) the system sends
the round-closing summary to the **survivors only**; eliminated profiles
receive only their punctual notifications. After scoring, the system
automatically checks whether a winner exists and, if so, closes the
tournament (see the administrator's manual, §System Lifecycle).

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to account. |
| `--json` | boolean (default `false`) | JSON output with `tc`, `tt`, `status`, `evaluated`, `newlyFrozen`, `newlyEliminated`. Text output: `Round <tc> (TT <tt>) → <status> — valutati: <n>, frozen: <n>, eliminati: <n>`. |

---

### `round:status`

```
round:status --round <n> [--json]
```

**Purpose.** Shows the state of a round with the TT/TC pair and the pick
counts by status. Read-only.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to inspect. |
| `--json` | boolean (default `false`) | JSON output with `tc`, `tt`, `status` (`pending`/`open`/`closed`/`scored`), opened/closed/scored timestamps and pick counts (`pending`, `frozen`, `correct`, `wrong`). Text output: `Round <tc> (TT <tt>) — <status> — pick: pending: <n>, frozen: <n>, correct: <n>, wrong: <n>`. |

---

### `round:deadline`

```
round:deadline --round <n> [--json]
```

**Purpose.** Shows the temporal anchors of a round: the registered deadline
(the pick-window close), the kickoff of the first match, and the **acceptance
instant** actually enforced for pick validation (the earlier of the registered
deadline and the actual kickoff). Read-only; useful to verify the anti-fraud
window.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to inspect. |
| `--json` | boolean (default `false`) | JSON output with `tc`, `tt`, `deadline`, `kickoff`, `acceptance`. Text output: `Round <tc> (TT <tt>) — deadline: <ISO|non registrata>, kickoff: <ISO>, accettazione: <ISO>`. |

---

## 10. Tournament commands

### `tournament:start`

```
tournament:start [--start-round <n>] [--json]
```

**Purpose.** Starts the season. Validates the calendar and the attachment
point; if valid, initializes the tournament state and the round rows (status
`pending`) for the whole window `[start_round … last round]`, and sends the
**tournament-opening announcement** (`tournament_open`) to all active platform
subscribers — an announcement only: it says the first round will start soon
and to be ready, without dates (the round-1 opening is a separate event). On
any validation failure the start is **refused atomically**: nothing is left
half-initialized. If a tournament is currently running, the start is refused;
if the previous tournament was closed, the start is re-admitted and atomically
resets only the tournament database (the platform database stays intact — see
the manual, §System Lifecycle).

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--start-round` | number (default `1`) | Championship round (TC) to which the tournament attaches: that TC becomes the **TT 1** (`TT = TC − start_round + 1`). Championship rounds before it are simply not played ("fuori finestra torneo"). Must be within `1..total rounds` and its TT-1 deadline must be in the future, otherwise the start is refused with a message naming the deadline. Attaching to the **last** TC is allowed with an informative warning (the end-of-tournament cases collapse to the single round). |
| `--json` | boolean (default `false`) | JSON output with `startRound`, `initializedRounds`, `halfBoundary`, `tt1Deadline`, `tt1Kickoff`, `lastRoundWarning`. Text output: `Stagione avviata: TT1 = TC <n>, <m> round inizializzati (confine girone <b>)` followed by `Deadline TT1: <ISO> (kickoff <ISO>)`. |

---

### `tournament:status`

```
tournament:status [--json]
```

**Purpose.** Aggregate read-only view of the tournament: season state, start TC,
total TC and girone boundary, number of active platform subscribers,
participants in game / eliminated, current round (TC/TT and status), winner
(with case) when finished, and any detected anomalies (e.g. an open round
with no registered deadline, for which the automatic safety closure is not
applicable).

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output with all the fields above (`seasonStarted`, `startRound`, `totalRounds`, `halfBoundary`, `platformSubscribers`, `activeProfiles`, `eliminatedProfiles`, `currentRound`, `winner`, `anomalies`). Text output, three lines + anomalies: `Stagione: avviata|non avviata (start TC <n>, <N> TC, confine <b>)`, `Iscritti piattaforma (attivi): … — partecipanti in gara: …, eliminati: …`, `Round corrente: TC <n> (TT <m>) [<status>]`, then `Vincitore/i (caso <c>): …` or `Torneo in corso`, then one `Anomalia TC <n>: <type> (chiusura di sicurezza non applicabile)` line per anomaly. |

---

### `tournament:history`

```
tournament:history --email <email> [--json]
```

**Purpose.** Shows the pick history of a profile with the double numbering
TT/TC for each pick (e.g. `TT2TC7` = second tournament round, attached to
championship round 7), plus elimination state. Read-only; audit view.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--email` | string, **required** | Email of the player (identity of the profile). |
| `--json` | boolean (default `false`) | JSON output with the profile and its picks. Text output: header `email (name) — eliminato (<reason>) il <ts>|in gara`, then one line per pick `TT<n>TC<m>: <team> (<outcome>) [<status>]`; `Nessun profilo trovato per <email>` if unknown. |

---

### `tournament:leaderboard`

```
tournament:leaderboard [--json]
```

**Purpose.** Shows the leaderboard of the profiles with their accounting:
in game or eliminated, correct picks, wrong picks, elimination reason. The
header reports the current TC/TT pair. Read-only.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output with `currentTurn` and `entries`. Text output: `Classifica (TC <n> / TT <m>)` then one line per profile: `IN GARA|eliminato <email> — corretti: <n>, sbagliati: <n> [(reason)]`. |

---

### `tournament:export`

```
tournament:export [--json]
```

**Purpose.** Dumps **all the tournament tables** as a JSON document with
metadata: export timestamp, derived parameters (start TC, boundary, TT/TC
mapping) and the full contents. Deterministic: two exports of the same state
differ only in the export timestamp. This is the audit/archive format — the
same dump the system writes automatically to `TOURNAMENT_EXPORT_DIR` when the
tournament closes.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | Wraps the dump in the standard `{"testMode":…, …}` envelope. Text mode prints the raw pretty-printed JSON dump. |

---

## 11. Email channel

### `channel:email:fetch`

```
channel:email:fetch [--json]
```

**Purpose.** Reads the **unread** emails from the IMAP mailbox and prints them
(`receivedAt` = IMAP internaldate, i.e. the server-side reception timestamp
that the anti-fraud checks rely on). **Read-only: it sets no flags** — the
messages remain unread. Idempotent; the standard tool to inspect the mailbox
before/after a session.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON array of messages (`from`, `receivedAt`, `body`). Text output: `Nessuna email non letta in casella` when empty, otherwise one `Da: <from> — ricevuta: <ISO>` header plus the first line of the body per message. |

**Notes.** In TEST MODE replay (offset > 0) the fetch shows the **real**
timestamps, while `channel:email:process` internally applies the shift — the
difference is expected and correct (see `docs/uat/guida-test-mode.md`, §7).

---

### `channel:email:process`

```
channel:email:process [--json]
```

**Purpose.** The end-to-end processing of the inbox — the heart of the email
channel. Reads the unread emails, classifies each one's intent (registration /
unsubscription / pick / other) via the LLM, executes the corresponding
operation through the game engine (auto-join on the first valid pick in
TT 1 included), sends the appropriate reply, and marks the message as read
(`\Seen`) **only on success**. Per-message diagnostics are printed at the end.
This is the command the cron must run alongside `scheduler:tick` (the
scheduler never reads the mailbox).

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output with `processed`, `seen`, `stopped` and the per-message action list. Text output: one line per message `[letto]|[non letto] <from>: <action> (<detail>)`, then the summary `Processati <n> messaggi, <m> marcati letti` — with the note `— batch FERMATO su errore LLM (retry al prossimo tick)` when an LLM transport error stopped the batch (remaining messages are retried at the next tick). |

**Notes.** Unsubscribed or never-registered senders produce no reply (silent
log) — anti-spam behavior. The platform registration flow ("voglio iscrivermi")
and the two-step unsubscription are driven entirely by this command in email
mode (details in the manual, §Introduction).

---

### `channel:email:send`

```
channel:email:send --to <email> [--subject <s>] --body <b> [--json]
```

**Purpose.** Test/debug helper: sends a single email via SMTP with an
explicit subject and body (no generation involved). Useful to verify the SMTP
configuration and the mailbox.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--to` | string, **required** | Recipient email address. |
| `--subject` | string | Subject of the email. |
| `--body` | string, **required** | Body of the email. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "sent": true, "to": "<email>"}` instead of `Email inviata a <email>`. |

---

## 12. Scheduler

### `scheduler:tick`

```
scheduler:tick [--json]
```

**Purpose.** The production orchestrator, run by cron (typically every
minute): a "thin" driver that refreshes the season data and then executes
exactly the actions due according to the calendar and the tournament state —
open the next round, close a round whose registered deadline has passed,
apply the **safety closure** to a round left open without a deadline once the
TC close has passed, account closed rounds (`round:score`, when
`SCHEDULER_AUTO_SCORE=true`), and re-account frozen picks. It contains no game
logic of its own: it only decides *when* to trigger the round operations.
Every event is logged (pino): `warn` level for safety closures, failed
refresh and non-calculable TC, `info` otherwise. When the tournament is
closed the scheduler produces no further actions.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "events":[…]}`. Text output: `Tick completato — nessuna azione da eseguire` or `Tick completato — eventi:` followed by one line per event. |

**Notes.**

- With `SCHEDULER_ENABLED=false` the command prints
  `Scheduler disabilitato (SCHEDULER_ENABLED=false): nessuna azione eseguita — usa i comandi manuali`
  and exits without effects (this is the guard that makes it harmless to run
  by mistake during commissioner-mode sessions).
- It does **not** read the mailbox: inbound emails are processed by
  `channel:email:process`, which must be scheduled separately.
- In TEST MODE with `TEST_REFRESH_ALLOWED=false` the data refresh is skipped
  at every tick (log line
  `import/refresh skipped: TEST MODE is active and TEST_REFRESH_ALLOWED is not enabled`),
  protecting the synthetic calendar.

---

### `scheduler:status`

```
scheduler:status [--json]
```

**Purpose.** Computed, read-only state of the scheduler — always available,
also when the scheduler is disabled: enabled flag, season state (including
"FINITO (chiuso automaticamente)" after the automatic tournament closure),
start TC and total TC, active platform subscribers, the status and deadline
of every round, detected anomalies, and the **next actions** the scheduler
would execute at the next tick. Nothing is persisted: this is a live
projection of the current state.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--json` | boolean (default `false`) | JSON output with all fields (`enabled`, `seasonStarted`, `tournamentFinished`, `finishedAt`, `startRound`, `totalRounds`, `platformSubscribers`, `rounds`, `anomalies`, `nextActions`). Text output: summary line, one line per round `TC <n> (TT <m>): <status> (deadline <ISO>)`, anomaly lines, and `Prossime azioni: <list>|nessuna`. |

---

## 13. Simulation (dry-run)

The simulation commands reproduce a full tournament **without real players,
without emails and without waiting**: deterministic synthetic profiles and
picks, with the clock derived from the data. They serve to dry-run a
configuration (e.g. verifying the asynchronous attachment or the season
completeness) in seconds. **Important:** they refuse to run if
`PLATFORM_DB_PATH` coincides with the production value — the simulation must
use a dedicated platform database (e.g. `./data/sim-platform.db`).

### `simulate:full`

```
simulate:full [--start-round <n>] [--seed <n>] [--json]
```

**Purpose.** Simulates the whole season (or the window
`[start_round … last round]`): registers `SIM_PLAYERS` synthetic platform
accounts, then for every round performs open → seeded picks (auto-join at
TT 1) → close → score, and prints a per-round report and the winner.
Deterministic: the same seed produces identical exports. Refused if the
season is already started or a round is not in the initial state. Useful as a
dry-run of `tournament:start --start-round` without the RF-21 deadline
constraint.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--start-round` | number (default `1`) | TC of attachment of the simulated window (TT 1 = start_round). |
| `--seed` | number (default `42`) | Seed of the deterministic random generator (picks and scores). |
| `--json` | boolean (default `false`) | JSON output with the full report (rounds + winner). Text output: summary line, one line per round `TC <n> (TT <m>): <picks> pick, <evaluated> valutati, <frozen> frozen, <eliminated> eliminati — <status>`, then the winner line. |

---

### `simulate:round`

```
simulate:round --round <n> [--seed <n>] [--json]
```

**Purpose.** Simulates a **single** round (open → seeded picks → close →
score) on the given TC, without starting the tournament. Diagnostic/dry-run
tool.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--round` | number, **required** | Championship round (TC) to simulate. |
| `--seed` | number (default `42`) | Seed of the deterministic random generator. |
| `--json` | boolean (default `false`) | JSON output with the report. Text output like `simulate:full`, limited to the round. |

---

## 14. LLM diagnostics

These commands exercise the LLM adapter in isolation — parsing, intent
classification and email generation. They are diagnostic tools (each component
of the system is independently invocable), not part of the tournament flow.

### `llm:parse`

```
llm:parse --input <text> [--mode <llm|deterministic>] [--json]
```

**Purpose.** Extracts `{team, outcome}` from free text (as a player's email
would be): the LLM (or, with `--mode deterministic`, the deterministic
parser with unique formulas) receives the canonical team list from the
database plus the alias resource (synthetic Serie A 2026/27 roster in TEST MODE) and
returns the canonical name and the predicted outcome, or `null` when the pick
is not recognizable or ambiguous.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--input` | string, **required** | Player's email text to analyze. |
| `--mode` | string | Extraction mode: `llm` (LLM) or `deterministic` (unique formulas `<TEAM> <ESITO>`); default follows `AI_EMAIL_PARSER`. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "team":…, "outcome":…}` (or `{"team": null}`). Text output: `{team: "<team>", outcome: "<outcome>"}` or `{team: null} — pick non riconosciuto o ambiguo` (or the empty-canonical-list message when the DB has no teams). |

**Note (`win_only`, ADR-016).** When `WIN_ONLY=true`, the extraction is
mode-aware: a bare team name yields `{team, "win"}` (no explicit formula
required), an explicit "pareggia"/"perde" is **not** recognized (→
`{team: null}`).

---

### `llm:classify`

```
llm:classify --input <text|json> [--mode <llm|deterministic>] [--json]
```

**Purpose.** Classifies a message's **intent** and pick:
`{intent: subscribe|unsubscribe|pick|other, pick: {team, outcome}|null}` —
the classification used by the email channel to route incoming messages.
With `--mode llm` it is a single LLM call; with `--mode deterministic` (or
`AI_EMAIL_PARSER=false`) the unique formulas `ISCRIZIONE [NOME]`,
`DISISCRIZIONE`, `<TEAM> <ESITO>` are recognized in the subject or body
(anything else → `other`). Also extracts the player's **name** from a
registration message.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--input` | string, **required** | The message body as plain text, or as JSON `{"body": "<text>"}` (the JSON form is convenient when the body contains quotes/newlines). |
| `--mode` | string | Classification mode: `llm` (LLM) or `deterministic` (unique formulas); default follows `AI_EMAIL_PARSER`. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "intent":…, "pick":…}`. Text output: `{intent: "pick", pick: {team: "<t>", outcome: "<o>"}}` or `{intent: "<intent>", pick: …}`. |

**Note (`win_only`, ADR-016).** When `WIN_ONLY=true`, the classification is
mode-aware: a bare team name is a valid pick `{team, "win"}`, an explicit
"pareggia"/"perde" zeroes the pick (`pick: null`, intent stays `pick`).

---

### `llm:generate`

```
llm:generate --type <type> [--player-name <n>] [--tt <n>] [--tc <n>] [--team <t>]
             [--outcome <win|draw|lose>] [--reason <r>] [--deadline <ISO>]
             [--available-teams <a,b,…>] [--mode <llm|deterministic>] [--json]
```

**Purpose.** Generates an email from a structured context: the deterministic
subject (`⚽🏆SURVIVOR LEAGUE🏆⚽ - Turno {TC} di Campionato - {etichetta}`; the
subject carries only the championship round, the "Round del torneo N · Turno di
Campionato M" pair stays in the body) plus the rendered body (fixed header,
plain-text sections with emoji + UPPERCASE titles, key message and
call-to-action around the narrative). By default the narrative is
deterministic (`AI_EMAIL_GENERATOR=false`); with `--mode llm` the LLM writes
the narrative (fallback to deterministic on `LLMError`/degenerate output).
Numbers, deadlines, available teams and outcomes are injected
deterministically. Diagnostic tool to preview any of the email types.

**Parameters.**

| Option | Type | Description |
|---|---|---|
| `--type` | string, **required** | Email type. Allowed values: `platform_registered`, `platform_unsubscribe_confirm`, `platform_unsubscribed`, `platform_already_registered`, `tournament_open`, `pick_instructions`, `pick_confirmed`, `pick_rejected`, `pick_missing_elimination`, `round_result_correct`, `round_result_wrong`, `pick_postponed`, `round_closed_survived`, `tournament_won`, `tournament_shared_win`, `clarification`, `tournament_closed`. |
| `--player-name` | string | Player name to address the email to. |
| `--tt` | number | Tournament round (TT) shown in the body header. |
| `--tc` | number | Championship round (TC) shown in the subject and body header. |
| `--team` | string | Canonical team name of the pick. |
| `--outcome` | string | Pick outcome: `win` \| `draw` \| `lose` (in `win_only` mode it is always `win`). |
| `--reason` | string | Rejection/elimination reason to communicate. |
| `--deadline` | string | Deadline in ISO-8601 format; displayed in Italian, in the system `TIMEZONE`. |
| `--available-teams` | string | Comma-separated list of available teams (for `pick_instructions`). |
| `--mode` | string | Generation mode: `llm` (LLM narrative) or `deterministic` (fixed texts); default follows `AI_EMAIL_GENERATOR`. |
| `--json` | boolean (default `false`) | JSON output `{"testMode":…, "subject":…, "body":…}`. Text output: `Oggetto: <subject>` followed by the rendered body. |

**Note (`win_only`, ADR-016).** When `WIN_ONLY=true`, the generator is
mode-aware: the pick texts ask only for the team that will win, the
`pick_confirmed` key is `PICK REGISTRATO → {TEAM}` (no outcome), and the
player rows in `round_closed_survived`/`tournament_closed` omit the outcome
(always `win`).
