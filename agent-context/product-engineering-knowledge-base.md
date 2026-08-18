# Unified Knowledge Base: Product Engineering & Software Development

> **Document type:** Reference knowledge base for an AI agent operating in software product development.
> **Scope:** Concepts, principles, lifecycle phases, deliverables, and operating rules that take an idea from concept to production system and evolve it afterward.
> **Status:** Compendium merged from standards and claims verified online on 2026-08-13.
> **Language:** English. **Research basis:** Synthesizes current software/systems engineering standards and established engineering practice; deliberately technology-agnostic and methodology-neutral.

**How to use this document.** Read Part I (foundational model) first, then Part II (lifecycle phases), Part III (deliverables and templates), Part IV (context adaptation), Part V (AI-assisted engineering), and Part VI (operating rules for the agent). The document is self-contained; cross-references are inline. It is a knowledge base, not a tutorial: use sections as needed and scale rigor to the situation.

**Core operating rule.** Documents and processes exist to reduce miscommunication and de-risk decisions, not to satisfy process for its own sake. For any deliverable, ask: *who reads this, what decision does it help them make, and what is the cost of getting it wrong?* Right-size the artifact — a one-paragraph PRD for a small feature and a ten-page PRD for a new product line are both correct.

---

# Part I — The Foundational Model

## 1. What software product development is

Software product development is the continuous process of turning an identified problem or opportunity into a software system that creates useful outcomes for its users, can be operated reliably, and can evolve economically over time.

Three disciplines overlap constantly but ask different core questions:

| Discipline | Core question | Primary output |
|---|---|---|
| **Product management** | *What should we build, and why?* | Vision, strategy, requirements, prioritized backlog |
| **Software engineering** | *How do we build it well, reliably, and maintainably?* | Working software, architecture, code, tests |
| **Product engineering** | *How do we build the right thing, fast, with quality?* (the hybrid) | Shipped increments validated against user/business outcomes |

A useful mental model of the whole:

```
Problem → Understanding → Product definition → Requirements → Design → Architecture →
Detailed design → Implementation → Verification → Delivery → Production → Feedback → Evolution
```

This is a **conceptual lifecycle, not a mandatory sequence**. Real projects are iterative: requirements change after implementation begins, architectural decisions are revisited, production evidence invalidates discovery assumptions, and incidents cause product or architecture changes. The central engineering objective is not merely to produce code; it is to produce a system whose behavior, quality, cost, security, operability, and evolution characteristics are appropriate for its context.

The canonical process framework is ISO/IEC/IEEE 12207:2026 (software life cycle processes, Edition 2, April 2026; supersedes 2017). It defines processes for acquisition, supply, development, operation, maintenance, and disposal, and explicitly states they may be applied **concurrently, iteratively, recursively, and incrementally**. It does not prescribe any specific life cycle model, methodology, or technology — making it a reference model, not a rigid process.

## 2. Core principles

These hold regardless of methodology, product stage, or technology:

1. **Optimize for outcomes, not artifacts.** A document is valuable only when it reduces ambiguity, preserves important reasoning, exposes risks, communicates decisions, or enables later work. More documentation is not automatically better; over-documentation slows teams, goes stale, and erodes trust in documentation generally.
2. **Separate uncertainty reduction from implementation.** Early work answers: *Is the problem real? Who experiences it? What outcome matters? What scope is justified? What constraints exist? What technical approaches are viable?* Later work turns validated intent into a dependable system. Mixing these modes creates waste: over-engineering an unvalidated idea, or discovering product uncertainty after expensive implementation.
3. **Requirements and design are related but different.** Requirements describe *what* the system must achieve (externally observable behavior, outcomes, constraints, quality properties); architecture and detailed design describe *how*. Mixing them locks in implementation details too early or produces "requirements docs" that are disguised architecture docs nobody validated with users. Distinguish: requirements → architecture (major structural decisions) → detailed design (implementable internals) → implementation (code, config, infrastructure).
4. **Quality is multi-dimensional.** Quality is not "few bugs." It spans nine characteristics (Section 3), and non-functional requirements (NFRs) are requirements — performance, security, scalability, accessibility, compliance must be captured, owned, and tested like functional ones.
5. **Build feedback loops into the lifecycle.** The fastest way to discover incorrect assumptions is to create evidence: user research, prototypes, executable spikes, automated tests, integration environments, telemetry, controlled releases, incident and customer feedback. The lifecycle behaves like a set of interacting feedback loops, not a one-way pipeline.
6. **Scale rigor to risk.** A prototype, a consumer SaaS, and a safety-critical system should not use identical processes. Rigor increases with: complexity; user/financial impact; safety consequences; security sensitivity; regulatory exposure; data criticality; availability requirements; team size and dependencies; expected lifetime; cost of failure; difficulty of changing the system later.
7. **Keep decisions traceable.** Preserve the chain *Problem → Requirement → Design decision → Implementation → Test → Operational evidence*. Perfect traceability is unnecessary for small products, but critical requirements and high-impact decisions must remain explainable.
8. **Iterate in small batches.** Small increments reduce risk, speed learning, and make failures cheap and diagnosable (DORA: small batches and frequent releases correlate with higher throughput and stability).
9. **Shift verification left.** Errors found early cost less. Verification (testing, review, security analysis) applies from the first phase, not as an end-phase gate.
10. **Treat automation as part of the product.** Build, test, deploy, and infrastructure are managed as code; the delivery pipeline is itself a product to be operated and improved.
11. **Manage complexity actively.** Without deliberate effort, complexity grows with every change (Lehman's laws of software evolution). Simplification, modularity, and refactoring are ongoing engineering work, not cleanup.
12. **Everything is reversible until it's expensive not to be.** Favor decisions and architectures that are cheap to change early (prototypes, feature flags, spikes); defer costly, hard-to-reverse commitments until the cost of being wrong is well understood.
13. **Production is not the finish line.** A system is "done" only in the sense that it now generates operational data, incidents, and user feedback that feed the next loop. Budget for monitoring, on-call, and iteration as part of the deliverable.
14. **Blameless by default.** Postmortems, retrospectives, and reviews work only if people are honest. Focus on systemic causes, not individual blame; leadership modeling this openly does more than any policy statement.

## 3. What "quality" means — a shared vocabulary (ISO/IEC 25010:2023)

The SQuaRE product quality model organizes quality into **nine characteristics**. Use it as a vocabulary to make quality *negotiable and specifiable*: functional behavior is only one characteristic among nine, and a good requirement set, design, or test plan explicitly addresses the ones that matter for the product's context.

| Characteristic | Concern |
|---|---|
| Functional suitability | Functions meet stated and implied needs: completeness, correctness, appropriateness |
| Performance efficiency | Time behavior, resource utilization, capacity |
| Compatibility | Co-existence, interoperability |
| Interaction capability | Usability: recognizability, learnability, operability, user error protection, engagement, inclusivity, assistance, self-descriptiveness |
| Reliability | Faultlessness, availability, fault tolerance, recoverability |
| Security | Confidentiality, integrity, non-repudiation, accountability, authenticity, resistance to attack |
| Maintainability | Modularity, reusability, analyzability, modifiability, testability |
| Flexibility | Adaptability, installability, replaceability, scalability |
| Safety | Operating within safe limits, hazard warning, fail-safe behavior |

## 4. Risk as the organizing principle

Before committing to build, a team should address four risk classes (Cagan/SVPG):

1. **Value risk** — will customers choose to use or buy this?
2. **Usability risk** — can users figure out how to use it?
3. **Feasibility risk** — can we build it with available technology, skills, and time?
4. **Viability risk** — does it work for the business (marketable, sellable, serviceable, fundable)?

Software engineering adds a fifth operational family: **reliability/security risk** — will it keep working, and is it safe against adversaries? SRE formalizes this as *managed risk*: reliability beyond what users need wastes resources and slows innovation; the SLO/error-budget mechanism (Section 14) makes the acceptable level of unreliability explicit and measurable. Most late-stage failures trace back to skipping or rushing discovery — the cheapest phase and the most consequential.

## 5. The lifecycle as a feedback loop, not a linear sequence

```
 VISION/STRATEGY → DISCOVERY → DEFINITION → DESIGN → PLANNING
      ↑                                                    ↓
 LEARN & ITERATE ← OPERATE/OBSERVE ← RELEASE ← TEST ← BUILD
```

Two properties matter. **It is a cycle, not a checklist:** evidence generated after release (usage data, incidents, support tickets, feedback) is the primary input to the next iteration of discovery. **Stages overlap in practice:** design uncovers new requirements, testing uncovers design flaws, operations uncovers scale requirements nobody planned for.

Two complementary framings:
- **Continuous discovery + continuous delivery (dual-track).** A discovery track (identifying, validating, describing what to build — mostly with prototypes and user testing) runs in parallel with a delivery track (building, testing, deploying validated backlog items). Production data feeds back into discovery.
- **The lifecycle as a control loop.** Every phase follows: define objective → act → measure → learn → adjust — the same shape as SRE's reliability control loop and Lean Startup's Build-Measure-Learn.

## 6. Methodology landscape

The phase model in Part II is methodology-agnostic. This section lets the agent recognize vocabulary, translate between methodologies, and recommend one.

- **Waterfall / Stage-Gate.** Linear, sequential, signed-off phases. Strongest where requirements are stable and well understood up front, compliance documentation is heavy, or late changes are physically costly (embedded systems, aerospace, large capital projects). Weakest where requirements will evolve — the cost of change grows sharply the later a defect is found.
- **Agile family.** Iterative delivery, working software, responding to change. **Scrum**: fixed sprints, defined roles (Product Owner, Scrum Master, Developers), ceremonies; stable teams of ~5–9. **Kanban**: continuous flow, WIP limits, pull-based; suited to variable/interrupt-driven work. **XP**: engineering practices (pairing, TDD, CI, simple design). **SAFe/LeSS/Scrum@Scale**: coordination frameworks for many teams; useful in large orgs, heavy in small ones.
- **Lean & Lean Startup.** Lean (Toyota) eliminates waste: partially done work, handoffs, unnecessary features, waiting. Lean Startup (Ries) applies it to validation: Build → Measure → Learn loops, cheap experiments, and the **MVP** — the smallest thing that lets a team test a specific hypothesis about product-market fit, *not* a "smaller, buggier version of the final product." Tools: Lean Canvas, Business Model Canvas.
- **Shape Up** (Basecamp). Six-week cycles of uninterrupted work on a small number of "shaped" bets, separated by two-week cooldowns; no traditional backlog; scope — not deadline — is the variable that flexes.
- **DevOps & Continuous Delivery.** Not a project methodology but an engineering/organizational practice: developers and operations share reliability ownership; deployment is automated and frequent; feedback from production is short. Overlays cleanly on any methodology above.

**Choosing an approach:**

| Situation | Better fit |
|---|---|
| Requirements stable, compliance-heavy, or physically costly to change late | Waterfall / Stage-Gate |
| Requirements will evolve; regular course-correction wanted | Scrum |
| Highly variable/interrupt-driven work (support, ops, platform) | Kanban |
| Unvalidated assumptions about users or market | Lean Startup (MVP-driven) |
| Small senior team wanting long, focused, autonomous cycles | Shape Up |
| Large org, many interdependent teams needing shared cadence | SAFe / LeSS |
| Any of the above, for the deploy/operate side | DevOps + CI/CD |

Most real organizations run a **hybrid**: Lean Startup thinking in discovery, Scrum/Kanban in delivery, DevOps for release and operations, Waterfall-like gates only where compliance demands them.

**Lifecycle vs. methodology vs. artifacts vs. tools.** These four are distinct: *lifecycle concepts* describe what engineering concerns exist; *methodologies* describe how a team organizes and sequences work; *artifacts* describe what information is recorded; *tools* execute or automate work. A PRD can exist in Scrum, Kanban, or a formal lifecycle — the existence of an artifact does not imply a specific methodology.

---

# Part II — The Lifecycle: Phases, Activities, and Concerns

The phases below are the backbone model. Each lists its **objective**, **key activities**, **primary outputs** (detailed in Part III), and **exit criteria**. They are presented in canonical order but overlap and repeat; treat exit criteria as judgment aids, not rigid gates — light-touch on small work, more rigorous on large or risky work. Security, quality, reliability, and operational concerns are **cross-cutting** (Phase 10, Section 14): they are not tasks that begin immediately before release.

## Phase 1 — Vision & Strategy

**Objective.** Establish why the product/team exists and what "winning" looks like, before any specific idea is evaluated.

**Activities.** Define product vision and mission; identify target market/users at a high level; set a **North Star Metric** (the single metric that best captures core customer value and correlates with business results); cascade strategy into **OKRs** (qualitative, inspiring objectives; measurable, outcome-based key results — not "ship feature X"); maintain a rolling **roadmap** at theme/outcome level (not a feature-and-date list, which goes stale and signals false certainty).

**Outputs.** Product vision statement, OKRs, North Star Metric definition, strategic roadmap.

**Exit criteria.** Leadership and team can articulate, in one sentence each: who the product is for, what value it delivers, how success is measured.

## Phase 2 — Discovery: Problem and Solution

**Objective.** Find problems worth solving — and then a solution concept worth building — before committing engineering resources. This is the least resource-intensive phase and the most consequential; "lack of market need" is the dominant startup failure cause. Ideas are cheap; validated problems are not.

**Problem space (separated from solution space to prevent premature commitment).** Key questions: What problem exists? Who experiences it, in what context? Why does it matter? What evidence supports it? What outcome would constitute success? What constraints are known? What assumptions remain unvalidated? Activities: stakeholder and user research (interviews, observation, workflow analysis), examination of existing systems/processes, competitive or alternative-solution analysis, hypothesis identification, risk/uncertainty identification. Apply **Jobs-to-be-Done (JTBD)** to understand the underlying need, not just the requested feature; rank hypotheses by how much they matter and how uncertain they are.

**Solution space.** Ideate candidate concepts against the validated problem; prototype low-fidelity → high-fidelity (paper, clickable mockups, concierge/mechanical-turk, partial implementations); test with representative users — observe behavior, not stated opinion; run technical feasibility spikes (small throwaway experiments); validate business viability with stakeholders; use the **PR/FAQ (Working Backwards)** technique: write the press release and FAQ as if launched today, before writing code, to force clarity on customer value. Make the four risk classes (value, usability, feasibility, viability — Section 4) explicit before scaling investment. **Continuous discovery** treats this loop as a normal working mode, generating a validated backlog rather than a one-off phase.

**Outputs.** Problem statement/opportunity assessment, hypothesis list, MRD, PR/FAQ, Lean Canvas, research synthesis (interview notes, JTBD statements), validated solution concept, prototypes, feasibility findings.

**Failure modes to avoid:** jumping from idea directly to architecture; defining features before understanding user outcomes; assuming stakeholder requests equal validated requirements; treating untested assumptions as facts; spending large engineering effort before resolving the highest-risk uncertainties.

**Exit criteria.** The team can state the problem, who has it, why it matters now, and has early evidence (not just opinion) that it is worth solving — plus a validated solution direction and explicit de-risking of the four risk classes.

## Phase 3 — Product Definition

**Objective.** Convert the validated solution concept into a clear statement of what the product is, who it is for, what it must deliver, and what success looks like — the contract between "why we're doing this" and "what exactly gets built."

**Activities.** Define product vision and target market; define problem and value proposition in user terms ("problems to solve, not features to build"); define goals, outcomes, and measurable success indicators; define scope boundaries — what is in and explicitly out; prioritize (must-have, high-want, nice-to-have, rank-ordered); define high-level release criteria (performance, scalability, reliability, usability, supportability, localization). Products should be decomposed into increments that provide meaningful value and generate useful feedback — the smallest useful increment is the smallest coherent product slice that can be evaluated, not the smallest coding task.

**Outputs.** PRD (full or one-pager) — the primary artifact; explicit out-of-scope list; success metrics.

**Exit criteria.** Product, design, and engineering agree on scope, success metrics, and exclusions; enough clarity for design and architecture to begin.

## Phase 4 — Requirements Engineering

**Objective.** Turn product intent into precise, testable, traceable statements of what the system must do and how well — the contract between problem understanding and engineering. ISO/IEC/IEEE 29148:2018 (requirements engineering; confirmed current, revision underway) defines verifiable quality criteria and the requirements document family.

**Requirement categories.**
- **Functional requirements** — what the system must do (create an account, calculate a price, expose an API operation…).
- **Non-functional / quality requirements** — properties governing *how well*: latency, availability, throughput, security, privacy, recoverability, accessibility, maintainability, interoperability (map onto ISO 25010, Section 3).
- **Constraints** — conditions restricting the solution space: mandated protocol, legacy integration, regulatory requirement, supported platform, data residency, deployment environment.
- **Business/domain rules** — valid domain behavior independent of implementation.

**Characteristics of good requirements:** clear, necessary, consistent, feasible, testable/verifiable, sufficiently precise for their purpose, traceable to a need/goal/constraint/risk, appropriately prioritized. Avoid false precision — specific enough to support engineering and verification without prescribing implementation when that is not yet justified.

**Decomposition chain:** *Product goal → capability → feature/use case → requirement → acceptance criteria → test evidence*. Not every product needs every level as a separate artifact.

**Acceptance criteria** define when a feature/requirement is satisfactorily implemented from the stakeholder perspective. They can be expressed as examples, scenarios, rules, or test conditions; they are not the same as automated tests, though they should drive test design.

**Traceability** connects requirements to design elements, source components, tests, defects, and operational signals — simple links for small products, formal matrices for high-assurance systems. (Template: SRS + RTM, Part III.)

**Outputs.** Requirements specification(s) / SRS (for regulated, safety-critical, or contractual projects), backlog with acceptance criteria (in agile practice, the operational requirements artifact), traceability links, change log.

**Exit criteria.** Requirement set is verifiable, prioritized, and change-controlled; no open contradictions; security requirements derived explicitly (Phase 10).

## Phase 5 — UX & Interaction Design

**Objective.** Make the product usable, learnable, and efficient to operate, in a way that is testable and implementable. Interaction capability is a first-class quality characteristic (ISO 25010) — users abandon products they cannot figure out.

**Activities.** User research (personas, journeys, context-of-use); information architecture (navigation, content structure, labeling); interaction and interface design (flows, wireframes, prototypes, design specs); design systems / reusable UI components for consistency; accessibility review; usability testing with real or representative users, with iterative refinement before and during implementation.

**Outputs.** Personas/journeys, user flows, wireframes, interactive prototypes, UI specifications/design system references, usability test results.

**Exit criteria.** Key flows validated with users (including error, empty, and edge states — static mockups routinely miss the unhappy path); accessibility requirements entered the requirement set.

## Phase 6 — System Design & Software Architecture

**Objective.** Define the fundamental structure: components, responsibilities, interactions, data flows, technology choices, and governing principles — sufficient to satisfy functional and NFRs and to guide all detailed design and implementation. Architecture is where NFRs are won or lost (they cannot be retrofitted), and where the hardest-to-reverse decisions are made.

**Key activities.** Stakeholder and concern analysis (ISO/IEC/IEEE 42010:2022 frames architecture descriptions around stakeholders, concerns, viewpoints, views); decomposition into components/modules/services; data and integration architecture; technology selection with explicit trade-offs; quality-attribute engineering (performance, scalability, availability, security, operability, maintainability, testability); architecture evaluation (design reviews, threat modeling, capacity planning, POCs for uncertain choices); governance (patterns and standards, conformance verification as the system evolves).

**Architecture should answer:** What are the major components and bounded areas? What responsibilities belong where? How do components communicate? Where does data live? What are the trust boundaries? How are failures isolated or propagated? How is it deployed and scaled? What are the critical dependencies? Which quality attributes drive structural decisions?

**HLD (High-Level Design).** Content: system context; major components with responsibilities; interfaces and communication patterns; major data flows; data ownership and storage choices; deployment topology; security/trust boundaries; key quality attributes; scaling/availability considerations; major external dependencies; architectural risks; decisions and trade-offs. The HLD does *not* describe every class, method, or column.

**Viewpoints.** Create the views required to reason about important concerns (context, logical/component structure, runtime interactions, data, deployment, security/trust boundaries, integration) — not views because a template says they exist.

**Architectural styles.** Monolith, modular monolith, layered, hexagonal (ports-and-adapters), service-oriented, microservices, event-driven, serverless, batch/data pipeline, client-server, hybrid. Architecture follows requirements, constraints, risks, organizational realities, and expected evolution — never fashion.

**Trade-offs to make explicit:** simplicity vs. independent scalability; consistency vs. availability/latency; coupling vs. distribution; local autonomy vs. global coordination; initial delivery speed vs. long-term change cost; managed services vs. operational control; flexibility vs. complexity; performance vs. cost; reliability vs. implementation complexity.

**Decision records.** Capture significant, hard-to-reverse decisions as **ADRs** (context, decision, consequences — template in Part III) and use **RFCs / design docs** to propose and debate larger or cross-team changes before implementation. Documentation frameworks: **C4 model** (how to draw: Context → Container → Component → Code) and **arc42** (what sections an architecture doc should have: 12 sections including context, constraints, solution strategy, building blocks, runtime/deployment views, cross-cutting concepts, decisions, quality requirements, risks, glossary) — complementary, not competing.

**Best practices.** Document assumptions explicitly; design the unhappy path (errors, retries, partial failures) as rigorously as the happy path; design for testability (dependency injection, clear boundaries); review the design with the engineers who will implement it; keep a lightweight consistent template; update the architecture description as decisions change — it is a living record, not a frozen diagram.

**Exit criteria.** Implementing engineers can start without making major undocumented architectural decisions on the fly; key trade-offs recorded, not just discussed.

## Phase 7 — Detailed (Low-Level) Design

**Objective.** Specify at implementation level how each architectural component will be built: modules/classes/functions, data structures, algorithms, contracts, error handling, configuration, interfaces between units. Without it, implementation is improvisation producing inconsistent, untestable structure.

**Activities.** Module/class/component design with explicit responsibilities and interfaces; data design (entities, relationships, ownership, invariants, schema, indexing, consistency needs, retention, migrations, privacy, backup/recovery implications); API design with versioning strategy; design for testability (seams, dependency injection, test doubles); error-handling and failure-mode design at unit level; design reviews before code exists.

**LLD** covers: module/class responsibilities; internal interfaces; API contracts; database and message/event schemas; algorithms; state machines; validation rules; error handling; concurrency; caching; retry/idempotency rules; configuration structure; important sequence flows. **The LLD refines the HLD; it does not repeat it.**

**API / interface contracts** (OpenAPI, AsyncAPI, Protobuf, GraphQL, typed interfaces): operation semantics; request/response schemas; error behavior; authN/authZ expectations; compatibility rules; versioning strategy; idempotency; timeout and retry expectations.

**Outputs.** LLD(s) or lightweight design notes, API specs, data model/schema, per-feature design docs.

## Phase 8 — Implementation (Development)

**Objective.** Turn designs into working, verifiable, maintainable code, integrated continuously with the work of others. Implementation is where all upstream ambiguity becomes concrete; the core risks are drift from design, untestable code, slow integration, and invisible quality.

**Activities.** Coding per design and team conventions; version-control discipline (small, reviewable changes; frequent integration with the shared mainline; meaningful commit messages); developer testing (unit tests, TDD where adopted); **code review** of every change — focused on correctness, maintainability, security, knowledge sharing, and consistency, not style that automation could check; **continuous integration** (every merge triggers automated build + test + analysis; broken builds are fixed immediately — nobody integrates on top of a broken baseline); documentation as part of implementation (API docs, READMEs, changelog entries); self-verification against requirements/acceptance criteria.

**Coding is constrained by design — but design is a hypothesis, not a contract.** Implementation exposes design flaws; engineers feed discoveries back into requirements and design rather than treating earlier artifacts as immutable. Keep architecture docs and ADRs updated as reality diverges from the original design. Treat technical debt as visible, tracked backlog items (Phase 16).

**Exit criteria.** Feature/increment meets acceptance criteria and Definition of Done; code reviewed and merged; CI passing.

## Phase 9 — Testing & Quality Assurance

**Objective.** Provide evidence that the product meets its functional and NFRs, works when its parts are combined, and does not regress — and find defects before users do. Testing is organized along three orthogonal axes (ISTQB):

- **Test levels** (by granularity): component/unit (smallest testable units in isolation); component integration (interactions between components); system (the whole system against its requirements); system integration (across system boundaries and external services); acceptance (fit for purpose from the user/business perspective — user acceptance, alpha/beta, contract acceptance; the release gate). Contract tests verify interface assumptions between independently evolving components.
- **Test types** (by purpose, applicable at any level): functional (black-box vs. white-box); non-functional (performance/load/stress, security, usability, accessibility, reliability); change-related (regression, smoke).
- **Test design techniques**: black-box (equivalence partitioning, boundary value analysis, state transition, decision tables); white-box (coverage criteria); experience-based (exploratory testing).

**Strategy and allocation.**
- **The test pyramid is a heuristic, not a law:** many fast, cheap, isolated unit tests; fewer integration tests; a small number of slow, expensive end-to-end tests. Unusual architectures, hardware dependencies, distributed behavior, or safety constraints shift the balance.
- **Test strategy is designed from requirements and risks**, not added mechanically after coding: for every important requirement, identify how its satisfaction can be demonstrated — automated tests, human evaluation, analysis, inspection, simulation, operational measurement, or combinations.
- **Coverage tools show what was executed, not what was verified** — coverage is a hygiene indicator, not a goal.
- **Shift left:** test design starts with requirements; non-functional testing (especially security and performance) is planned early.
- Replicate production-like conditions in test environments to avoid "passed QA, failed in prod."

**Defect lifecycle:** detect → reproduce/characterize → assess severity/impact → fix or intentionally accept/defer → verify after resolution → analyze systemic causes. Repeated defect patterns feed back into requirements, design, coding practices, test strategy, or architecture.

**Exit criteria.** Defined coverage executed; no open blocking/critical defects; NFRs validated; UAT sign-off where applicable; traceability requirements → tests → results maintained.

## Phase 10 — Security (cross-cutting)

**Objective.** Secure by design and secure across the lifecycle: reduce vulnerabilities introduced, mitigate exploitation impact, respond to discovered vulnerabilities. Security cannot be added after the fact; few SDLC models address it explicitly, so it must be a continuous practice (NIST SP 800-218, SSDF). Vulnerabilities arise from design flaws, insecure implementation, insecure configuration, and dependency/supply-chain weaknesses.

**Activities (NIST SSDF's four groups):**
- **Prepare the organization (PO):** security roles, toolchains, security requirements definition, criteria for security checks, secure development environments.
- **Protect the software (PS):** protect components from tampering, integrity checks, provenance/**SBOM**, archive releases.
- **Produce well-secured software (PW):** security requirements and risk tracking, threat modeling, secure coding standards, code review and SAST, dependency scanning, security testing (DAST, fuzzing, pen tests), secure build/verification.
- **Respond to vulnerabilities (RV):** monitor disclosures, triage, patch, post-incident root-cause analysis.

**Threat modeling** (OWASP): structured answers to *What are we building? What can go wrong? What are we going to do about it? Did we do a good enough job?* — using techniques such as STRIDE, attack trees, kill chains, LINDDUN (privacy). Inputs: architecture/context diagram, assets and sensitive data, trust boundaries, identities/privileges, external dependencies, attack surfaces. Most useful early enough to influence architecture and design, then revisited on every significant change. Iterative, not one-off.

**Core techniques:** secure defaults and least privilege; defense in depth; input validation; output encoding; authN/authZ; session management; cryptography done right; secrets management; secure error handling; security-event logging. **OWASP resources:** Top 10 (most common web risks), ASVS 5.0.0 (verification standard with levels), SAMM (program maturity model).

**Outputs.** Threat model (living document), security requirements, security test cases, SBOM/dependency inventory, vulnerability response plan, review evidence.

## Phase 11 — Integration & System Validation

**Objective.** Demonstrate that independently developed parts work together as intended, and that the integrated product behaves as required in the environment and usage context that matters. Integration is where interface compatibility, configuration consistency, dependency behavior, data contracts, auth flows, failure propagation, environment differences, integrated-load performance, and deployment correctness are proven. System validation can reveal emergent behavior invisible in isolated testing.

**Exit criteria.** Integrated system passes end-to-end and acceptance verification in production-like conditions; open integration defects triaged and closed.

## Phase 12 — Release & Deployment

**Objective.** Deliver verified changes to production reliably, repeatably, and with minimal risk. **Deployment** (placing a version into an environment) and **release** (making a capability available to users) are distinct and can be separated — a deployment may occur without exposing a feature, via feature flags or dark launches.

**CI/CD pipeline:** *Source → Build → Test → Security checks → Package → Deploy to non-production → Validate → Deploy/Promote → Observe*. Principles: build each artifact once and promote it (never rebuild for production); deploy the same way to every environment; smoke-test deployments; keep environments as similar as possible; version code, configuration, and infrastructure together; approvals gate higher-risk transitions.

**Release techniques:** big-bang; incremental rollout; rolling (sequential instance replacement — simple, slower rollback); blue-green (two identical environments, instant switch — costs double infrastructure); canary (small real-traffic percentage first, then expand on healthy signals — needs traffic splitting and monitoring); feature flags/dark launching (decouple deploy from release; instant kill-switch); phased release; automatic rollback on health-check failure.

**Rollback and recovery:** application rollback; forward fix; configuration rollback; feature disablement; database migration rollback or compatibility strategy; traffic shifting; failover. **Database changes deserve special attention** — schema changes are often harder to reverse than application deployments; prefer migration strategies preserving compatibility across transition states.

**Release engineering:** reproducible hermetic builds; semantic versioning for interfaces; branch/release strategy; audit trail; signed, immutable artifacts; infrastructure as code; database migrations deployed with the release; release notes/changelog and stakeholder communication; go/no-go checklist; rehearsed rollback path.

**Outputs.** CI/CD pipeline as code, immutable versioned artifacts, environment definitions (IaC), deployment runbooks/smoke checks, release plan and notes, feature-flag configuration.

## Phase 13 — Production Readiness

**Objective.** Ensure the product can be operated safely and predictably at the required level of risk *before* it carries real users — the operational counterpart of acceptance testing. "Works in dev" ≠ "works in production": scale, real data, real concurrency, failure modes, operational tooling, and support processes differ.

**Activities.** Environment parity (production-like staging, sanitized data, config parity); non-functional verification under realistic conditions (load/performance, capacity estimation, failover/chaos testing, backup/restore drills); operational tooling (monitoring, alerting, logging, dashboards, runbooks, incident response process); security checks (vulnerability scan, pen test where risk warrants, compliance checks); support readiness (documentation, support process, operator training); launch plan (rollout strategy, rollback plan, go/no-go criteria, launch checklist).

**Outputs.** PRR checklist (Part III), runbooks/playbooks, SLO definitions and dashboards, backup/disaster-recovery plan, launch plan. The exact set is proportional to product maturity and risk.

## Phase 14 — Operations & Observability

**Objective.** Keep the product working, know what it is doing, and recover quickly when it fails. A production system is never "done"; in distributed systems failures are unavoidable and often non-deterministic — the question is how fast you *know* and how fast you *recover*, not whether failure happens.

**Observability** (CNCF/OpenTelemetry): the property that lets you ask arbitrary questions about internal state from external outputs, via **telemetry** in three primary signals — *metrics* (numeric aggregations for alerting and trends; RED: Rate/Errors/Duration, USE: Utilization/Saturation/Errors), *logs* (timestamped structured records), *traces* (the path of a request across components — essential in distributed systems) — plus *profiles* and correlated *events*. Correlate the signals (logs carry trace IDs), standardize with semantic conventions, and use sampling (tail sampling keeps all errors and slow requests) to control cost.

**SLIs, SLOs, SLAs, error budgets** (Google SRE):
- **SLI** — a carefully defined quantitative measure of service level (successful request rate, latency percentiles, freshness).
- **SLO** — the target for an SLI over a defined period (e.g., 99.9% over 30 days). SLOs make incident severity objective instead of a debate, and should represent user-relevant outcomes.
- **SLA** — a contractual commitment, a business decision; SLOs are the engineering instrument. Related but not interchangeable.
- **Error budget** = 1 − SLO: the allowed unreliability in a period. While the budget remains, changes can ship; when exhausted, releases stop and reliability work takes priority — converting "reliability vs. velocity" from a political argument into a measured control loop.

**Alerting.** Alerts must be actionable and tied to meaningful service impact; noisy alerts create toil and erode the ability to detect real incidents. **Toil reduction:** repetitive operational work with no enduring value should be automated so operational load does not scale linearly with growth.

**Incident management:** detection → triage → mitigation → communication → recovery → verification → follow-up analysis. Incidents that consume significant error budget require **blameless postmortems** that identify contributing factors and concrete preventive actions; track action items to closure (a low completion rate means the process has become theater).

**Runbooks** should be structured around: trigger (which alert activates it), symptoms, diagnosis steps, mitigation steps (stop the bleeding), permanent fix (tracked separately), escalation (who to page if mitigation fails).

**Outputs.** Instrumentation, dashboards, alert rules, SLO/error-budget definitions, runbooks, incident records and postmortems, on-call schedules. Observability is a design property: instrumentation is implemented during development, not retrofitted.

## Phase 15 — Feedback, Learning & Evolution

**Objective.** Close the loop — turn production evidence, feedback, and retrospection into the next cycle of discovery. Production is a source of evidence, not the end of the lifecycle.

**Relevant feedback:** user behavior and feature usage; user feedback; support issues; incidents; performance and reliability data; security findings; cost data; developer experience; architectural friction. The loop — *Release → Observe → Learn → Re-prioritize → Modify requirements/design → Implement → Verify → Release* — operates at multiple timescales: per commit, per release, per incident, per product cycle.

**Activities.** Review usage analytics against the success metrics defined in Phase 3; run team **retrospectives** on process (not just incident postmortems on outages); synthesize user feedback and support trends; feed validated learning back into Vision/Strategy and Discovery. Retrospectives must produce a small number of concrete, owned action items — not a list of grievances. Distinguish incident postmortems (technical, incident-specific) from team retrospectives (process- and collaboration-focused, cadence-based); both matter.

**Exit criteria.** Insights captured durably (not just discussed) and visibly influencing the next roadmap or backlog.

## Phase 16 — Maintenance, Technical Debt & Refactoring

**Objective.** Sustain and develop the product over its lifetime: fix what breaks, adapt to change, and keep internal quality such that change remains cheap and safe. Long-lived software must change or it progressively becomes unsatisfactory (Lehman's law of continuing change); environments (OS, libraries, regulations, platforms) change under it.

**Maintenance categories** (ISO/IEC/IEEE 14764:2022): *corrective* (fix defects); *adaptive* (accommodate environment changes); *perfective* (enhance functionality — the largest share of post-release work); *preventive* (improve maintainability/future reliability: refactoring, modernization, documentation). Plus: bug triage by impact/severity; dependency and security-patch maintenance; change management — every change flows through the same delivery pipeline as feature work.

**Technical debt** is a present shortcut or compromise that increases future cost or risk (brittle code, inadequate tests, obsolete dependencies, poor boundaries, duplicated logic, migration shortcuts, unclear ownership, missing observability). Two dimensions (Fowler): *reckless vs. prudent* (was it a considered trade-off?) and *deliberate vs. inadvertent* (did the team know?). Prudent-deliberate debt ("we must ship now") is legitimate if planned; reckless-inadvertent debt is the dangerous kind. **Interest triggers on change, not on time:** stable-but-crufty areas can be left alone; high-activity areas need zero tolerance. Pay the principal gradually, preferably in the areas you touch most, or as dedicated debt-reduction work; compare interest vs. principal to decide. Debt extends beyond code: design, documentation, test, dependency, infrastructure, process debt. Track it visibly (backlog items with effort estimates; estimated interest in retrospectives; qualitative debt ceilings). Not every shortcut is irrational — the engineering problem is *unmanaged* debt that silently accumulates interest.

**Refactoring** changes internal structure without intentionally changing external behavior — the primary tool for paying down debt, safe only with adequate verification to detect regressions (Section 9).

## Phase 17 — Retirement & Deprecation

**Objective.** Remove features, versions, or products that are no longer justified, without breaking users or leaving unresolved security/compliance exposure. Deprecated software still consumes resources (compute, support, patching, cognitive load) and unmaintained software is an attack surface.

**Activities.** Define and communicate a **deprecation policy** (announce → deprecate → sunset) with realistic windows (contextual, not universal — e.g., 90 days internal, 6–12 months for public APIs); publish migration guides and changelogs; use machine-readable signals — the `Deprecation` header (RFC 9745, 2025), the `Sunset` header (RFC 8594, 2019), `deprecated` markers in OpenAPI specs; **monitor usage** and drive the sunset decision with data (traffic, revenue, support load), not sentiment; coordinate consumer migration, then remove with proper status codes (410 Gone); archive/preserve what regulations require (ISO 12207 includes a *disposal* process: data preservation, secure erasure, audit records). **Versioning is the enabling practice**: versioned APIs with documented compatibility policies and contract testing make deprecation safe.

**Outputs.** Deprecation/sunset policy, notices and migration guides, usage dashboards, retirement records/archives.

---

# Part III — Deliverables: Purpose, Relationships, and Condensed Templates

## 3.1 What each artifact answers

Every artifact exists to answer a question; the *concept* matters more than the name or template, and in lightweight contexts artifacts shrink to notes, cards, or conversations.

| Artifact | Primary question it answers | Typical position |
|---|---|---|
| Problem Statement | What is the problem, who has it, why does it matter? | Discovery |
| Product Vision / Intent | What outcome are we aiming at, for whom? | Discovery / Definition |
| MRD / BRD | Why build this at all (market / business justification)? | Discovery / Definition |
| PRD | What are we building and why — scope, goals, success criteria? | Product Definition |
| User Flows / UX Spec | How do users interact with the product? | UX Design |
| Requirements Spec (SRS) | What must the system do, and what constraints/qualities must it satisfy? | Requirements |
| Acceptance Criteria | When is a feature considered satisfactorily implemented? | Requirements / Testing |
| HLD / Architecture Description | What major structure will satisfy those requirements? | Architecture |
| ADR | Why was this significant architectural choice made? | Architecture / Evolution |
| LLD / Design Docs | How will the architectural components work internally? | Detailed Design |
| API / Interface Contract | What is the contract between components/systems? | Design / Integration |
| Data Model / Schema | What persistent data structures and rules exist? | Detailed Design |
| Threat Model | What can go wrong adversarially, and what will we do about it? | Design / Security |
| Test Strategy / Plan | How will we verify, at what levels, with what evidence? | Verification Planning |
| Tests / Test Evidence | What evidence demonstrates correct behavior? | Implementation / Verification |
| Deployment / Release Definition | How is software promoted and exposed to users? | Delivery |
| Production Readiness Info | Is the system safely operable at the required risk level? | Pre-production |
| Runbook / Operational Docs | How do we safely run, observe, diagnose, and recover? | Production |
| Observability / SLO Definition | How is production health measured and promised? | Architecture / Operations |
| Postmortem / Retrospective | What happened, why, and what will change as a result? | Operations / Evolution |

## 3.2 How the artifacts relate

```
Problem Statement ─┐
                   ├─→ PRD ─→ Requirements/backlog ─→ HLD/Architecture ─→ LLD/Design Docs
Discovery evidence ┘         │                         │                  │
                             │                         ├─→ Threat model    │
                             │                         └─→ Test strategy   │
                             └─→ Acceptance criteria ─→ Acceptance testing ├─→ Implementation
                                                                           ├─→ CI/CD pipeline ─→ Production
                                                                           └─→ API contracts
Production ─→ SLOs/dashboards/runbooks/postmortems ─→ learning → discovery / requirements / debt / deprecation
```

The chain is intentionally **recursive**: a change discovered in production may result in a new requirement, a revised PRD section, an ADR, a refactoring task, or a new test. An agent should detect contradictions between these artifacts instead of blindly following whichever document it read last.

## 3.3 Condensed templates

Use only what's needed; cut or combine sections freely. Bracketed text is a placeholder; headers are suggestions, not law. The best deliverable is the shortest one that removes ambiguity for its reader.

**MRD — Market Requirements Document** (answers "why build this at all?"): Market opportunity (problem, size, trend) · Target customer · Competitive landscape (how they solve it today) · Product/market fit hypothesis · Strategic fit · Recommendation (pursue / do not pursue / needs more validation).

**BRD — Business Requirements Document** (business "why" and constraints): Business objective · Problem/justification · Stakeholders & sponsors · Scope in/out · Success criteria (business metrics) · Assumptions & constraints · Risks & mitigations · Timeline & budget (high level).

**PRD — Product Requirements Document** (the working contract; use a one-pager for small features — problem, success metric, a handful of stories, launch notes): Executive summary · Problem statement & goals · Success metrics (measurable) · Target users/personas · User stories/use cases · Functional requirements (numbered, testable) · Non-functional requirements · Out of scope (as important as in-scope) · Design & UX references · Technical considerations & dependencies (link to HLD, don't embed it) · Milestones & timeline · Open questions · Change log. Failure modes: unreadable detail, no measurable metrics, missing stakeholders, stale document drifting from reality.

**User Stories & Acceptance Criteria:** story format `As a [user], I want [goal], so that [benefit]`; INVEST checklist (Independent, Negotiable, Valuable, Estimable, Small, Testable); acceptance criteria in Given/When/Then (Gherkin). Acceptance Criteria apply to one specific story; **Definition of Done** applies uniformly to all work — a story isn't complete until both are met.

**SRS — Software Requirements Specification + RTM** (regulated/safety-critical/contractual projects; loosely per ISO/IEC/IEEE 29148): Introduction (purpose, scope, definitions, references) · Overall description (perspective, user classes, constraints, assumptions) · Functional requirements (uniquely IDed, verifiable: "The system shall…") · Non-functional requirements (testable, measurable statements, not aspirations) · External interface requirements · Verification (how each requirement is validated) · **RTM** table: `Req ID | Description | Source | Design ref | Test case | Status` — proving nothing was missed and nothing was built that wasn't requested.

**HLD — High-Level Design:** System overview & goals · Architecture diagram (C4 Context + Container) · Technology stack · Data flow · External integrations & dependencies · Non-functional strategy · Capacity/scale assumptions · Key risks & open questions · Related ADRs.

**LLD — Low-Level Design** (one per major HLD component): Purpose & scope (which HLD part it implements) · Detailed component design (class/module structure, sequence diagrams) · Data structures & database schema · API/interface contracts (shapes, error codes) · Algorithms & business logic · Error handling & edge cases (explicitly, not just the happy path) · Testability notes · Dependencies on other components.

**ADR — Architecture Decision Record** (one significant, hard-to-reverse decision; short — if it's long, it's multiple decisions): Status (Proposed / Accepted / Deprecated / Superseded by ADR-n) · Context (motivating issue, forces, constraints) · Decision (plainly stated) · Consequences (what becomes easier, harder, new risks). Store ADRs together, numbered, as an append-only log — a changed decision gets a new ADR that supersedes the old one. Reserve ADRs for decisions affecting structure, NFRs, dependencies, interfaces, or construction techniques; otherwise the log becomes noise.

**RFC / Technical Design Doc** (propose and debate a change before implementation; broader and more exploratory than an ADR — an RFC's conclusion often becomes an ADR): Status (Draft / In Review / Approved / Implemented / Abandoned) · Summary · Motivation/problem · Proposed solution · Alternatives considered · Impact & risks (blast radius, migration, rollback) · Open questions · Reviewers/approvers. Formality guidance: lightweight for team-scoped changes, heavier for org-wide ones — forcing everything through heavyweight process discourages writing anything at all.

**Test Plan / Test Strategy:** Objectives · Scope in/out (features, requirement IDs) · Strategy (types, levels, manual vs. automated split) · Environment & data (production parity) · Entry/exit criteria · Schedule & resources · Risks & contingencies · Deliverables. Small projects: a "strategy" paragraph inside the plan; large/regulated projects: Strategy (approach) and Plan (one release's execution) as separate documents.

**Roadmap** (theme/outcome-based, not feature-and-date): `Theme/Outcome | Why it matters (tie to OKR) | Target timeframe (quarter, not date) | Status`.

**OKRs & North Star Metric:** Objective (qualitative, inspiring, time-bound) · Key Results (measurable, outcome-based, not outputs) — plus NSM definition: the single metric, why it captures customer value, why it correlates with business outcomes, supporting/input metrics.

**RACI Matrix:** `Activity/Decision | Responsible | Accountable | Consulted | Informed` — Responsible does the work; Accountable owns the outcome (one per row); Consulted gives input before the decision; Informed is told after.

**Definition of Ready / Definition of Done:** DoR (story-level, lean, 3–5 items): story and acceptance criteria clear to the whole team, dependencies identified, sized/estimated, design assets available. DoD (uniform quality bar): code reviewed and merged, automated tests written and passing, NFRs checked where relevant, deployed to staging, documentation updated, no open blocking defects. Keep both lean initially; expand only on real gaps. Note: Scrum's official guide does not mandate a formal DoR — many teams adopt one as a practical aid; it should never become gatekeeping.

**Planning (execution-level).** Turn the definition + design into an executable, resourced plan: break epics/features into stories or tasks sized for the team's cadence; estimate effort/complexity; sequence work against dependencies and the roadmap; define DoR/DoD; clarify decision rights via RACI. Keep DoR lean rather than turning backlog refinement into its own bottleneck. Exit: the team knows what it's building next, roughly how big it is, who owns what decision, and what "done" means.

**Release Plan / Release Notes:** Scope · Deployment strategy (rolling/blue-green/canary/flags) · Rollback plan · Communication plan · Go/no-go checklist. Release Notes: new features · improvements · bug fixes · known issues · upgrade/migration notes.

**PRR — Production Readiness Review checklist:** monitoring/alerting tied to SLIs/SLOs · runbooks for known failure modes · rollback path tested · capacity/load-tested · security review completed · on-call ownership assigned · dependency failure modes understood · backup/recovery plan · documentation current and discoverable.

**Runbook:** Trigger (which alert activates it) · Symptoms (what it looks like on dashboards) · Diagnosis steps · Mitigation steps (immediate) · Permanent fix (tracked separately, not blocking mitigation) · Escalation (who to page).

**Incident Postmortem** (blameless): Summary (2–3 sentences) · Impact (duration, users/systems, business impact) · Timeline (chronological, timestamped) · Root cause(s) — contributing factors, not just the trigger · What went well / poorly · Action items `Action | Owner | Type (mitigative/preventative) | Due` · Lessons learned. Publish widely; track actions to closure.

**Retrospective:** What went well · What didn't go well · What we'll try next · Action items (owned, small in number).

**PR/FAQ — Amazon Working Backwards** (during discovery): Press release (max ~1 page, plain language, as if launched today): headline, sub-headline, problem paragraph in customers' words, solution paragraph, company quote, hypothetical customer quote, call to action · FAQ: external (customer/press questions) and internal (cost, risk, competition, why now, why us, what could go wrong). If the press release isn't compelling, that's a signal to rework the idea — not the writing.

## 3.4 What "done" means at different levels

"Done" is contextual:
- **Feature-level done:** intended behavior implemented and verified at the required level, integrated correctly, documented sufficiently for ongoing use.
- **Release-level done:** can be safely deployed or exposed per the release strategy, with required verification complete.
- **Production-level done:** operationally usable, observable, supportable, secure enough for its risk profile, recoverable per its reliability needs.
- **Product-level done:** a product is rarely simply "done" — it reaches states of maturity, launches, evolves, and is eventually retired.

## 3.5 Decision quick-reference: which deliverable do I need?

| Situation | Produce this |
|---|---|
| Deciding whether an idea is worth pursuing at all | MRD, PR/FAQ, Lean Canvas |
| Justifying investment to business stakeholders | BRD |
| Defining what a feature/product should do, for the team | PRD (one-pager or full) |
| Highly regulated, safety-critical, or contractual project | SRS + RTM |
| Breaking a PRD into buildable, testable units | User Stories + Acceptance Criteria |
| Describing overall system architecture | HLD (+ C4 Context/Container diagrams) |
| Describing how one component will be implemented | LLD |
| Recording a significant, hard-to-reverse technical decision | ADR |
| Proposing and debating a significant technical change before building | RFC / Design Doc |
| Planning how testing will be approached and executed | Test Plan / Test Strategy |
| Communicating direction without over-committing to dates | Roadmap (theme-based) |
| Aligning team goals to strategy for a period | OKRs |
| Clarifying who decides / does / is consulted / is informed | RACI Matrix |
| Setting the bar for "ready to start" and "actually done" | DoR / DoD |
| Preparing to ship a new version safely | Release Plan + PRR checklist |
| Helping on-call respond to a known failure mode | Runbook |
| Learning from an outage | Incident Postmortem |
| Learning from a sprint/cycle as a team | Retrospective |

## 3.6 Documentation principles

- **Documentation as code / living docs:** store docs, ADRs, and diagrams as text (Markdown, AsciiDoc) in version control; reviewable via the same PR process, versioned with the system, far less likely to rot. Diagrams-as-code (PlantUML, Mermaid, Structurizr/C4) extend this to visuals.
- **Prefer semantic structure:** meaningful headings, stable terminology, explicit relationships, concise definitions.
- **Separate facts from decisions:** a requirement ≠ an architectural decision; an assumption ≠ a validated fact; a proposed design ≠ an accepted design.
- **Record rationale for important decisions:** a diagram shows what exists; an ADR preserves why.
- **Avoid contradictory sources of truth:** one recognizable authoritative source; duplicates either reference it or are intentionally summarized.
- **Prefer current state plus historical decisions;** do not document implementation with no durable value (trivial, unstable, or obvious from source).
- **Document for communication, not compliance:** a living, accurate, accessible artifact beats a comprehensive obsolete one. Write to think — a document that changes no one's mind, including the author's, wasn't worth full formality.

---

# Part IV — Adapting the Lifecycle to Context

**The master rule — tailoring.** Do not ask "what is the correct process for software development?" Ask: *"what engineering activities and evidence are justified by this product's uncertainty, complexity, risk, maturity, and expected change?"* The principles remain consistent; the depth and formality change. A small internal tool may need a concise product description, a simple architecture sketch, automated tests, and a deployment procedure; a large externally exposed platform may need formal requirements, architecture views, ADRs, threat models, interface contracts, extensive automated testing, production readiness analysis, SLOs, incident processes, migration strategies, and detailed operational controls.

## 4.1 Product stages and what changes

| Stage | Purpose | Typical rigor |
|---|---|---|
| **Proof of Concept** | Test technical feasibility of a specific uncertain approach | Minimal; disposable code; single experiment; results (not code) are the deliverable; explicitly identify what it does *not* prove |
| **Prototype** | Test usability/value of a solution concept with users | Design artifacts, throwaway code; production constraints deliberately deferred; prototype ≠ product |
| **MVP** | Test market/business hypotheses with the smallest real product that produces validated learning | Real but minimal: remove anything not contributing to the learning sought; must still be safe and adequate for its users; may be pivoted or abandoned. Avoid both extremes: shipping a prototype as production-ready, or building enterprise architecture before assumptions are validated |
| **Early-stage product** | Find product-market fit; iterate rapidly | Lightweight process; CI/CD early; user feedback and usage data dominate; selective documentation; architecture likely reworked — keep it simple, defer decisions |
| **Production product** | Serve real users reliably while growing | Standard engineering discipline: full pipeline, testing depth, SLOs, on-call, security program scaled to risk; operations first-class |
| **Scale-up** | Grow usage, team, and feature surface without collapse | Structured architecture governance, team/platform topology, capacity and performance engineering, reliability depth; simplification and modularity critical (the correct response to scaling is *not automatically* microservices — modularity, caching, database design, async processing, deployment practices often suffice) |
| **Enterprise system** | Multiple stakeholders, long life, many integrations, compliance | Formalized requirements and change management, contracts, security/compliance programs, strong observability; traceability and documentation load-bearing |
| **Mission-critical / regulated** | Failures are catastrophic (safety, financial, legal) | Highest formality: formal verification, safety cases, audit trails, rigorous change control, defense-in-depth, disaster recovery; domain standards become mandatory |

**Stage ↔ phase depth.** Discovery phases matter most when uncertainty is high (new market, new problem) and can be near-formal when requirements are externally given (regulated, contractual, enterprise-internal). Architecture/design scale from a diagram plus decision log to formal descriptions with reviews and governance. Verification scales from "tests covering critical paths" to layered pyramids with formal acceptance and auditability. Operations scales from "you can run it and see logs" to SLOs, error budgets, on-call, and chaos/DR programs. Process formality is a function of *risk and team size*: more people need more explicit contracts; higher stakes need more evidence.

## 4.2 What remains fundamental at nearly every scale

These survive even at minimal scale because they are the difference between "writing code" and "engineering a product":

1. A written statement of the problem and target (even a paragraph).
2. Explicit success criteria (what would make this worth building).
3. A prioritized, visible backlog with acceptance criteria.
4. Version control and a review step for every change.
5. Some automated verification (at minimum tests of critical paths) on every change.
6. A reproducible way to run and deploy the product.
7. Basic telemetry (logs + key metrics) from day one.
8. A feedback loop from users/production back into the backlog.
9. Explicit, visible technical debt decisions.

## 4.3 Engineering decision spectrums

The lifecycle is technology-agnostic; choosing among approaches is a normal part of architecture. Reason from constraints and outcomes before selecting technologies — never confuse a technology pattern with an engineering principle.

| Decision | Spectrum (not binary prescriptions) |
|---|---|
| System structure | Monolith → modular monolith → service-oriented → microservices. Smaller products and early stages favor monoliths; decomposition into independently deployable services is a scaling and organizational tool with real costs (distributed-systems complexity, observability burden). Questions: Do independent scaling/deployment needs exist? Can the team operate distributed systems? Does separation reduce a real coupling problem? Is the operational complexity justified? |
| Data storage | Relational vs. document vs. key-value vs. graph vs. columnar vs. specialized (search, time-series); single store vs. polyglot. Follows the data model and access patterns, not fashion. Questions: What consistency/transaction properties are required? How are queries shaped? What evolution is expected? What operational skills exist? |
| Communication | Synchronous (request/response) vs. asynchronous (queues, events, streams); direct calls vs. brokers vs. event buses. Asynchrony improves decoupling and resilience at the cost of consistency reasoning and observability. Questions: Is an immediate response required? What delivery guarantees are needed? How are retries and duplicate events handled? |
| Execution model | Always-on servers vs. containers (orchestrated or not) vs. serverless/FaaS; batch vs. event-driven. Affects scaling, cost, operational model. |
| Infrastructure | Managed services vs. self-hosted; cloud vs. on-premises; infrastructure-as-code vs. manual. Managed trades control and cost for operational burden removed. Questions: Is operational control materially valuable? What is the total cost of ownership? What compliance/data-location constraints exist? |
| Intelligence | Deterministic software vs. components with AI/ML (models, LLMs): affects data engineering, evaluation, monitoring (drift), explainability, risk management. |
| Delivery model | SaaS vs. installable/on-prem vs. embedded: affects release cadence, upgrade strategy, telemetry. |

Each choice has trade-offs evaluated against requirements and context (cost, skills, risk tolerance, compliance). There is no universal right answer — only the decision, its rationale, and its revisability.

---

# Part V — AI-Assisted / AI-Native Software Engineering

AI agents and AI-assisted tooling are now a normal participant in the engineering lifecycle. This part describes how an agent can participate within the model above and what responsibilities follow. It is deliberately not a guide to any specific product or model.

## 5.1 Where AI participates in the lifecycle

- **Discovery:** organize research, compare hypotheses, expose ambiguity, identify unanswered questions, summarize evidence — but never treat generated synthesis as evidence by itself.
- **Product definition & requirements:** draft requirements, identify missing cases and contradictions, decompose, propose acceptance criteria, maintain terminology consistency — distinguish source requirements from the agent's own interpretation.
- **Architecture:** reason over constraints, propose alternatives, compare trade-offs, generate diagrams and architecture descriptions, identify failure modes, draft ADRs, detect inconsistencies across documents and code — decisions remain evidence-based and explicitly validated.
- **Implementation:** code generation, transformation, refactoring, test generation, documentation, repository exploration, debugging. Generated code is an **implementation proposal until verified**; the fact that code compiles is weak evidence of correctness.
- **Testing/verification:** produce tests, analyze failures, identify untested branches, review requirements against code, find defects — not an infallible verifier; independent execution, automated checks, deterministic evidence, and human review remain valuable, especially for high-risk behavior.
- **Operations:** log analysis, incident triage, anomaly investigation, runbook execution, postmortem drafting, change-impact analysis — production actions constrained by authorization, safety controls, auditability, and rollback capability.
- **Knowledge/context management:** retrieve relevant files, verify claims against the actual codebase, track relationships (requirement ↔ implementation ↔ test), and know when to ask for clarification or defer.

Effectiveness depends directly on the quality, accessibility, and freshness of the artifacts in Part III — **documentation is the agent's context.**

## 5.2 Key risks of AI-generated output

Research (MIT CSAIL, "Challenges and Paths Towards AI for Software Engineering," 2025; empirical AI-code studies) documents systematic risks:

- **Hallucination:** confident, plausible output that is wrong — invented APIs, non-existent identifiers, logic that compiles but fails, dead code, incorrect library usage, claims inconsistent with the actual codebase. Affects natural-language artifacts too (design summaries, commit messages, review comments).
- **Context blindness:** models struggle with large, idiosyncratic codebases; they retrieve by surface similarity rather than intent, and produce code that violates internal conventions or calls internal functions that do not exist.
- **Security risk:** generated code reproduces vulnerability patterns from training data (injection, hard-coded secrets, weak crypto, poor input validation), and studies show developers review AI-generated code less critically than their own — the combination *increases* vulnerability count and *decreases* detection. AI-generated code must flow through the same (or stricter) security gates as human code: review, SAST, dependency scanning, security tests.
- **False confidence:** syntactically valid, semantically wrong code reads as correct; acceptance without verification erodes the controls that keep systems safe.
- **Licensing/provenance:** generated code may reproduce training-data code with uncertain licenses; SBOM/provenance discipline applies to it like any dependency.

## 5.3 Validation and verification obligations

Because the agent produces artifacts, the verification machinery of Part II is the guarantee of their quality:

- Generated code must pass the same gates as human code: build, tests, static analysis, review, security checks.
- Generated tests must be evaluated for what they actually assert — a test that always passes verifies nothing.
- Generated documentation must be checked against the code it claims to describe.
- The agent should expose its confidence and flag uncertainty rather than presenting everything as certain.
- Verification is *never* "the model says it's correct": correctness is established by the system's tests, reviews, and telemetry.

## 5.4 Productive integration principles

- **Documentation is the agent's context:** investing in requirements, design docs, and API contracts pays off twice — for humans and for AI-assisted development.
- **Small, verifiable steps:** agent-driven changes are safest in small increments with fast feedback.
- **Human-in-the-loop for high-stakes decisions:** requirements interpretation, architectural choices, security-sensitive changes, and public interface changes warrant human judgment; the agent drafts, proposes, and implements under review.
- **Treat the agent as a force multiplier for the loop, not a replacement for it:** it accelerates discovery support, implementation, testing, and analysis, but the feedback loop (measure → learn → adjust) and operational obligations (SLOs, incidents, security response) remain owned by the team.

## 5.5 AI-enabled systems: lifecycle concerns

Systems *incorporating* AI introduce concerns ordinary software does not fully cover: model selection and version management; prompt/instruction management; evaluation datasets; output quality and nondeterminism; hallucination; data provenance; model/prompt drift; retrieval quality; tool-use safety; indirect prompt injection; model-provider dependency; cost/latency management; privacy of prompts and context; human oversight. These feed back into ordinary requirements, architecture, testing, security, operations, and product decisions rather than forming a separate lifecycle.

- **NIST AI RMF 1.0** organizes AI risk management around **Govern, Map, Measure, Manage**, with governance cross-cutting and risk management throughout the AI system lifecycle.
- **OWASP AISVS 1.0** (2026) provides testable security requirements for AI-enabled systems (12 categories, verification levels 1–3); **OWASP LLMSVS 2.0** (2026) covers LLM-backed applications. Both are specialized references, not substitutes for general application security (ASVS 5.0.0).

---

# Part VI — Operating Rules for the Agent

## 6.1 The reference mental model

Given a new software idea or change request, reason conceptually in this order (a reasoning model, not a mandatory execution script):

1. **Understand the problem** — intended outcome, users, context, assumptions, constraints, uncertainties.
2. **Understand the product scope** — in scope, explicitly out of scope, how success will be recognized.
3. **Identify requirements** — functional vs. quality vs. constraints vs. domain rules.
4. **Identify uncertainty and risk** — what must be learned before committing to substantial implementation.
5. **Design the solution** — architecture and detailed design chosen from requirements and constraints.
6. **Preserve important decisions** — record high-impact choices with rationale (ADRs).
7. **Implement incrementally** — small coherent changes with verification close to the change.
8. **Verify the result** — multiple forms of evidence appropriate to the risk.
9. **Deliver safely** — automate build/test/deploy where appropriate; make failures recoverable.
10. **Operate and observe** — measure actual production behavior; preserve the ability to diagnose and recover.
11. **Learn and evolve** — feed production and product evidence back into requirements, architecture, implementation, and prioritization.

## 6.2 Common anti-patterns

- **Code-first without sufficient problem understanding:** implementation begins immediately; requirements change repeatedly for avoidable reasons; architecture built on unvalidated assumptions.
- **Architecture astronautics:** sophisticated distributed architecture before evidence requires it; large infrastructure footprint for a small product; operational complexity exceeds product value.
- **Documentation theater:** large documents that don't influence decisions; duplicate sources of truth; unmaintained diagrams; detailed specs that rapidly become false.
- **Testing only at the end:** late integration failures, unstable releases, expensive debugging, weak confidence in change safety.
- **Security as a final checklist:** risks discovered late force architectural redesign — security must influence requirements and design early enough to change the solution.
- **Production as someone else's problem:** ignoring operation, deployability, observability, failure behavior, and recovery during design makes them expensive downstream.
- **Treating AI output as truth:** AI-generated requirements, designs, code, and test plans are candidate artifacts until supported by evidence and reviewed at a level appropriate to their risk.

## 6.3 Evidence hierarchy

When evaluating whether a system satisfies an expectation, evidence ranges from weak to strong: assumption → informal reasoning → design analysis → prototype/spike → automated test → integration/system test → production telemetry → repeated production evidence. The appropriate evidence depends on the claim — a prototype is not the best evidence of operational reliability; a production metric is not the best evidence of a security design property. **Choose evidence that actually tests the relevant claim.**

## 6.4 Delivery and operational performance (DORA)

DORA's research measures delivery performance with **five metrics** (the fifth, *deployment rework rate*, was added in 2024): throughput — *change lead time* (commit → production), *deployment frequency*, *failed deployment recovery time*; instability — *change fail rate* (deployments requiring immediate intervention), *deployment rework rate* (unplanned deployments following production incidents). These are **not local targets to game** — they are signals for understanding system-level constraints. A healthy delivery system makes changes small enough to understand, automated enough to validate reliably, frequent enough to reduce batch size, reversible or safely recoverable, and observable after deployment.

## 6.5 Final principles

1. Understand before implementing.
2. Separate problem, requirements, design, and implementation.
3. Use the lightest process that provides sufficient confidence.
4. Increase rigor as risk and complexity increase.
5. Treat architecture as a set of consequential decisions, not just diagrams.
6. Keep important rationale and constraints discoverable.
7. Design verification from requirements and risk.
8. Integrate security throughout the lifecycle.
9. Design for operation, not only successful execution.
10. Automate repetitive verification and delivery work where practical.
11. Prefer small, understandable, reversible changes.
12. Use production evidence to improve the system.
13. Treat technical debt as an engineering trade-off with future consequences.
14. Do not assume a fashionable architecture is the correct architecture.
15. Do not equate documentation volume with engineering maturity.
16. Do not treat AI-generated output as verified truth.
17. Preserve the relationship between intent, requirements, design, implementation, tests, and operational evidence.
18. Tailor lifecycle depth, artifacts, and rigor to the product's current context.

---

# Part VII — Standards and Authoritative Sources

Standards are used to validate and ground concepts, not as compliance checklists. All listed versions verified current as of 2026-08-13.

| Source | Role in this document |
|---|---|
| ISO/IEC/IEEE 12207:2026 (Software life cycle processes) | The canonical process framework: what processes exist, and that they apply concurrently/iteratively/recursively/incrementally |
| ISO/IEC/IEEE 29148:2018 (Requirements engineering) | The construct of a good requirement and requirement set; requirements document family; management processes (revision underway; 2018 remains current) |
| ISO/IEC/IEEE 42010:2022 (Architecture description) | Stakeholders, concerns, viewpoints, views; rationale and decisions as core architecture content |
| ISO/IEC 25010:2023 (Product quality model) | The shared vocabulary of nine quality characteristics (Section 3) |
| ISO/IEC/IEEE 14764:2022 (Maintenance) + Lehman's laws | Maintenance classification (corrective/adaptive/perfective/preventive); software evolution framing |
| ISO/IEC/IEEE 15288, 15289 | System life cycle processes; content of lifecycle information items |
| ISTQB (testing syllabus) | Test levels, types, techniques; pyramid and quadrants as allocation guidance |
| NIST SP 800-218 (SSDF) + SP 800-218A (SSDF for generative AI) | The four-group secure software development framework; AI-specific secure practice |
| OWASP (Top 10, ASVS 5.0.0, SAMM, AISVS 1.0, LLMSVS 2.0, threat modeling) | Security as integrated practice; verification standards; AI security |
| CNCF / OpenTelemetry | Observability: metrics, logs, traces; semantic conventions; sampling |
| Google SRE (books/workbook) | SLI/SLO/SLA and error budgets; toil; incident response and blameless postmortems; release engineering |
| DORA (Accelerate / State of DevOps) | Five delivery metrics; small-batch, continuous-delivery evidence base |
| Continuous Delivery (Humble & Farley) | The deployment pipeline pattern; low-risk release principles |
| Twelve-Factor App (Heroku) | Codification of cloud-native design principles (config, build/release/run separation, statelessness, dev/prod parity, logs as events) |
| Lean Startup / SVPG (Ries, Cagan) | MVP and validated learning; product discovery; the four risk classes; outcomes over outputs |
| Fowler / ACM CACM (Allman) | Technical debt metaphor, quadrant, and debt management as risk management |
| IETF RFC 9745 (Deprecation header, 2025) / RFC 8594 (Sunset header, 2019) | Machine-readable deprecation and sunset signaling for interfaces |
| MIT CSAIL et al. (2025), empirical AI-code studies | Evidence base for AI-assistance risks and the verification obligations of Part V |
| NIST AI RMF 1.0 | AI risk management: Govern, Map, Measure, Manage |

**Primary sources consulted:** the standards above, plus: Agile Manifesto; IEEE/ACM work on architecture decision documentation and design reviews; OWASP Threat Modeling Project and Developer Guide; OpenTelemetry observability primer; Belady & Lehman laws of software evolution; Zalando RESTful API Guidelines (deprecation); arXiv 2503.22625 and related AI-code studies.

---

# Glossary

- **ADR** — Architecture Decision Record
- **BRD** — Business Requirements Document
- **CI/CD** — Continuous Integration / Continuous Delivery (or Deployment)
- **C4** — Context, Container, Component, Code (diagramming model)
- **DoD / DoR** — Definition of Done / Definition of Ready
- **HLD / LLD** — High-Level Design / Low-Level Design
- **INVEST** — Independent, Negotiable, Valuable, Estimable, Small, Testable (story checklist)
- **JTBD** — Jobs to Be Done
- **MRD** — Market Requirements Document
- **MVP** — Minimum Viable Product
- **NFR** — Non-Functional Requirement
- **NSM** — North Star Metric
- **OKR** — Objectives and Key Results
- **PR/FAQ** — Press Release / FAQ (Amazon "Working Backwards")
- **PRD** — Product Requirements Document
- **PRR** — Production Readiness Review
- **RACI** — Responsible, Accountable, Consulted, Informed
- **RFC** — Request for Comments (technical design proposal)
- **RTM** — Requirements Traceability Matrix
- **SBOM** — Software Bill of Materials
- **SDLC** — Software Development Lifecycle
- **SLI / SLO / SLA** — Service Level Indicator / Objective / Agreement
- **SRE** — Site Reliability Engineering
- **SRS** — Software Requirements Specification
- **SSDF** — Secure Software Development Framework (NIST SP 800-218)
- **UAT** — User Acceptance Testing

---

*End of document. This knowledge base is intended to be read in full before acting; cross-references are deliberate, and section numbers refer to this document's own structure. Standards and practices change over time — the stable layer is the underlying reasoning: understand the problem → make requirements explicit → choose a design appropriate to constraints → implement incrementally → verify with evidence → operate observably → learn from reality → evolve deliberately.*



