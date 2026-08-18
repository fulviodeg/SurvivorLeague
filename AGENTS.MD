# AGENTS.md

This file is organized in two parts:

- **Part 1 — The project** — everything specific to Survivor League: overview, architecture, scope, stack, documentation map, and current status.
- **Part 2 — Working rules** — behavioral guidelines and skill-driven execution rules that apply to every task in this repository.

---

## Part 1 — The project

### 1.1 Overview

**Survivor League** (working title): a private elimination tournament among friends, based on **Serie A** results. Before each matchday (Round), every profile submits a prediction (Pick: team + outcome). Correct pick → the profile stays in the game; wrong or missing pick → eliminated. Each team can be used **only once per half-season** (girone di *andata/ritorno*, i.e. first and second half of the season); the pool resets at the half-season boundary. The winner is the last profile remaining in the game (or a shared victory in the cases provided for by the rules).

A private game among friends: not a commercial betting product (disclaimer in `BRIEF/BRIEF.MD`).

### 1.2 POC architecture at a glance

- **Deterministic Game Engine** — rules, pick validation, accounting, eliminations, winners. It must not be wrong: no game logic lives outside of it.
- **LLM Adapter confined to I/O only** — email parsing → `{team, outcome}`, Italian email text generation. It makes no game decisions.
- **Abstract ChannelAdapter** — email (IMAP/SMTP on Gmail) is the only implementation in the POC; a new channel = a new adapter, without touching the logic.
- **Abstract SeasonDataProvider** — `DbSeasonDataProvider` (data imported into the DB from the football-data.org API, 2025/26 season) is the only implementation in the POC (ADR-007).
- **Full CLI** — every component exposes CLI commands; orchestrable via cron (production) or by an AI agent.
- **Total configurability** — all parameters in env vars validated with `zod`; league parameters (number of teams, number of rounds, half-season boundary) are derived from data, never hardcoded.

### 1.3 Separation of responsibilities (binding architectural principle)

Distinct responsibilities are assigned to distinct entities or components within the system: no component plays the role of another, duplicates another component's logic, or depends on the internal details of other components in order to work or to be tested.

- **Options/execution time ≠ domain logic**: whatever is not part of the decision-making core decides or triggers operations but never implements domain decisions.
- Each component must be invocable and verifiable independently of the others, through the same interface used by automation and by the operator.
- Domain logic lives entirely within the component responsible for it and cannot be moved or replicated elsewhere (operational details may change without the logic changing).

### 1.4 POC scope

- **In scope:** email channel, one profile per player, historical Serie A 2025/26 data, administration via CLI, full-season simulation.
- **Out of scope:** WhatsApp and other channels, web frontend, multiple profiles, payments/payouts, jokers/auto-pick (details in `POC_PRD.md` §10 and `FUTURE_EXPLORATIONS.MD`).

### 1.5 Tech stack (POC, from LLD §2)

Node.js ≥20 + strict TypeScript · SQLite (`better-sqlite3`) · `imapflow` + `nodemailer` (Gmail) · OpenAI-compatible LLM API · `zod` · `yargs` · `pino` · `vitest` · `eslint` + `prettier`

### 1.6 Documentation map

| File | Content | When to consult it |
|------|---------|--------------------|
| `BRIEF/BRIEF.MD` | **Historical document** — requirements gathering concluded and frozen on 2026-08-11: high-level rules, glossary, open questions, launch roadmap | Do not update it; the design documents (PRD v0.3.0+) are authoritative for decisions |
| `BRIEF/FUTURE_EXPLORATIONS.MD` | Future ideas and explorations, all out of scope for the POC | To understand what NOT to implement |
| `docs/POC/POC_PRD.md` (v0.5.2) | POC product requirements: tournament flow, edge cases (CL1-18), success criteria (CS1-7), out of scope (§10) | Before implementing any feature |
| `docs/POC/POC_HLD.md` (v0.4.2) | High-level architecture: components, data flows, VPS deployment | To understand how components interact |
| `docs/POC/POC_LLD.md` (v0.4.0) | Detailed design: stack, data model (SQL), configuration (env vars), TS interfaces, CLI commands, test strategy | During implementation |
| `docs/reviews/2026-08-11/architecture-review-2026-08-11.md` | Independent review: 2 CRITICAL, 6 HIGH, 5 MED, 4 LOW; prioritized fixes in §16; PO questions in §15 | Guides the ongoing LLD revision |
| `docs/decisions/architecture-decisions.md` | **Append-only ADR log** — significant, hard-to-reverse architectural decisions (ADR-001…008): status, context, decision, alternatives, consequences | To understand the *why* of architectural choices; new decisions are recorded here |
| `tasks/plan-aggancio-torneo-asincrono.md` | Requirements plan for the **asynchronous tournament hook-up** (ADR-008, RF-20–31, CL11–18): 8 blocked decisions, documentary/executive tasks, risks | Source of the hook-up requirements; `tasks/plan.md` remains the roadmap |
| `tasks/briefing-fase-2.md` | Work briefing of **Phase 2 "Season data"** (Task 2.1–2.5): inconsistencies, problems, and required changes raised by the spec analysis (non-authoritative text; table §8 lists the spec corrections to apply) | To understand the Phase 2 choices; the spec corrections (table §8) have been applied in the documents |
| `tasks/briefing-fase-3.md` | Work briefing of **Phase 3 "Game Engine"** (Task 3.1–3.5 + 4.1 + 4.2): decisions 1/2/3/4/A (winner cases, idempotency, US10 override, injectable clock), §1-F cascade pick-processor, anti-fraud guard RF-31 §1-B/§3.3, shared modules §8 (`round-time.ts`, `turn.ts`), §1-D interfaces (ChannelAdapter/LLMGenerator) | Non-authoritative working text: in case of conflict PRD/HLD/LLD prevail; documents the choices applied in Phase 3 |
| `agent-context/product-engineering-knowledge-base.md` | Consolidated product-engineering and software-development knowledge base for the agent: principles, lifecycle phases, deliverables and templates, context adaptation, AI-assisted engineering, operating rules; grounded in standards (ISO 12207/25010/29148/42010, ISTQB, NIST SSDF, OWASP, SRE, DORA) | Consult before planning, designing, implementing, testing, or reviewing, to ground decisions and artifacts in established engineering practice scaled to risk |
| `docs/uat/guida-test-mode.md` | **Operational guide for the TEST MODE (UAT)** — the "instruction manual" for planning and running UAT sessions with the system in test mode (piano UAT Task 6): what the test mode is, what changes per component when active, the test parameters and why they exist, the complete operating manual (activate/use/deactivate/verify, do's and don'ts, standard procedures), both operating modes (commissioner manual flow and cron scheduler), the synthetic seed explained in plain language, three copy-paste timelines (2h / ~4h30 / ~6h30), the scope of what can and cannot be demonstrated (with the RF-31 `after_kickoff` note), the 2025 replay via `.env.uat-replay`, the shared Gmail mailbox cleanup, and a non-technical glossary | Reference for administrators, PO and non-developer operators (and agents) when planning/executing UAT; documents the real implementation (actual command/option/parameter names and verbatim English log/banner messages) |

Documents in `docs/POC/` are marked **POC ONLY**: they describe the Proof of Concept, not the production system.

### 1.7 Current status

The live project status (phase, work plan, checkpoints, next step) is kept in `agent-context/current-status.md`. Read it to know where the project stands before starting work; update it after every substantial change (see Part 2 §0).

---

## Part 2 — Working rules

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 0. Keep the project status up to date

- After every **substantial change** or **key step** in the project's progress (updated design, recorded ADR decision, implemented feature, completed milestone, priority change), update the **Current status** file (`agent-context/current-status.md`, referenced from §1.7): bump its `Last updated` timestamp and append an ISO-8601 UTC changelog entry summarizing the change, keeping it consistent with the documentation map above (§1.6).
- Status must never be left behind: every agent that touches the project must check whether its work requires an update to `agent-context/current-status.md` and, if so, apply it in the same session.

### 1. Think before coding

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

- No features beyond what was asked.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

### 4. Goal-driven execution

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"

For multi-step tasks, state a brief plan:
```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
```

### 5. Documentation standards (mandatory)

During development, every agent MUST add explicit explanatory comments to:

- **All configuration parameters** — each parameter must state its specific purpose, accepted values/units, and the effect of changing it.
- **All functions** — each function must explain what it does, its inputs/outputs, and the logic it implements, so any reader can immediately understand it.
- **All files** — each file (source or configuration) must open with a header comment describing its role within the project and how it interacts with other components.

Comments must be written so that **any reader can immediately understand the logic of the code, the purpose of each parameter, and the role of each configuration file**, without needing to reverse-engineer the implementation. Keep comments up to date whenever the code they describe changes.

### 6. Skill-driven execution

All skills live in `agent-skills/skills/<skill-name>/SKILL.md`. The mapping below covers every skill currently installed in the project.

#### Core rules

- If a task matches a skill, you MUST invoke it via the `skill` tool
- Never implement directly if a skill applies
- Follow the skill instructions exactly — do not partially apply them

#### Intent → skill mapping

| Intent | Skill(s) |
|--------|----------|
| New feature / significant change | `spec-driven-development`, then `incremental-implementation`, `test-driven-development` |
| Vague or underspecified request | `interview-me`, then `spec-driven-development` |
| Refine an idea / stress-test a plan | `idea-refine` |
| Need a plan from a spec | `planning-and-task-breakdown` |
| Implementing logic / fixing a bug | `test-driven-development` + `debugging-and-error-recovery` |
| Large multi-file implementation | `incremental-implementation` |
| Decisions grounded in official documentation | `source-driven-development` |
| High-stakes or unfamiliar-code decisions | `doubt-driven-development` |
| API / interface design | `api-and-interface-design` |
| UI / frontend work | `frontend-ui-engineering` |
| Browser runtime inspection / debugging | `browser-testing-with-devtools` |
| Code review | `code-review-and-quality` |
| Refactoring / simplification | `code-simplification` |
| Deprecation / migration of features or APIs | `deprecation-and-migration` |
| Security concerns | `security-and-hardening` |
| Performance concerns | `performance-optimization` |
| Git workflow | `git-workflow-and-versioning` |
| CI/CD setup | `ci-cd-and-automation` |
| Documentation / ADRs | `documentation-and-adrs` |
| Shipping / deploying | `shipping-and-launch` |
| Observability / telemetry | `observability-and-instrumentation` |
| Session/context setup, rules files | `context-engineering` |
| Diagrams (flowcharts, architectures, mind maps) | `excalidraw-diagram-generator` + `excalidraw-information-design` |
| Markdown → PDF export | `convert-md-to-pdf` |

The meta-skill `using-agent-skills` governs how all other skills are discovered and invoked; it is not tied to a specific intent.

#### Lifecycle sequence

```
DEFINE  -> spec-driven-development
PLAN    -> planning-and-task-breakdown
BUILD   -> incremental-implementation + test-driven-development
VERIFY  -> debugging-and-error-recovery
REVIEW  -> code-review-and-quality
SHIP    -> shipping-and-launch
```

#### Anti-rationalization

These thoughts are wrong and must be ignored:
- "This is too small for a skill"
- "I can just quickly implement this"
- "I'll gather context first"

Correct behavior: **always check for and use skills first.**

### 7. Git & GitHub

#### 7.1 Reference skill

For all git workflow practices (trunk-based development, atomic commits, descriptive messages, branching strategy, pre-commit hygiene, debugging via git, release/versioning), invoke the **`git-workflow-and-versioning`** skill (mapped at §6, intent "Git workflow") and follow it. This section does not restate its content — refer to the skill.

#### 7.2 Binding project rules

These are the non-negotiable project rules for git/GitHub usage (from the project instructions). They complement the skill — where they differ, they win.

**ALWAYS**
- Run local tests before committing (`npm test`)
- Check `git status` and `git diff` before committing to avoid unintended files
- Verify `.gitignore` is respected

**ASK FIRST**
- Before executing `git push` to GitHub
- Before creating or merging a Pull Request via `gh pr create`
- Before adding new dependencies to the project

**NEVER**
- Commit secrets, `.env` files, API keys, or credentials
- Force-push (`git push -f`) to any remote branch
- Commit directly to `main` or `master`
- Delete existing git branches without explicit human permission

#### 7.3 Essential workflow

```
1. Branch from main:        git checkout main && git pull && git checkout -b feat/<desc>
2. Develop atomically:      git add -p && git commit -m "type(scope): subject"
3. Rebase onto main:        git fetch origin && git rebase origin/main
4. Push + PR:               git push -u origin feat/<desc>  → open PR via gh
5. Merge via PR only,       never directly to main, never automatically
```
