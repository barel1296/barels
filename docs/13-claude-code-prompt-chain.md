# Part 13 — Claude Code Build Prompt Chain

Copy-paste-ready prompts to build GROS step by step in Claude Code. Rules of engagement:

- **One prompt = one session = one reviewable PR.** Don't chain two prompts in one session.
- Run them in order; each prompt's Context references the prior state. If a prompt's preconditions fail, fix that first — never let Claude Code "work around" a broken foundation.
- Every prompt ends with the same mandatory report format. Hold it to that.
- Before Prompt 1, commit `docs/` (this spec) to the repo — every prompt tells Claude Code to read the relevant parts. The spec is the contract.

**Global preamble — paste at the top of EVERY prompt:**

```text
GLOBAL RULES (apply to this and every task in this project):
- This is a production system that will move real advertising money. No demo logic,
  no hardcoded insights, no fake data paths, no TODO-as-implementation.
- Read the relevant spec in /docs before writing code; the spec is the contract.
  If you must deviate, say so explicitly in your final report under "Deviations".
- Multi-tenant: every tenant-scoped table has tenant_id + RLS; every query is
  tenant-scoped; every endpoint is permission-guarded; every mutation is audited.
- TypeScript strict mode; Python typed (mypy --strict); no `any`/`type: ignore`
  without an inline justification comment.
- Write the tests specified under Automated QA in the same session as the code.
- Never commit secrets. Use .env.example for every new variable.
- If something cannot be completed in this session, deliver a working vertical
  slice, not a broad scaffold of stubs.
```

---

## Prompt 1 — Monorepo foundation & infrastructure skeleton

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Build from scratch. Empty repo except /docs (spec). You may add
files freely; do not modify /docs.

OBJECTIVE: Production-grade monorepo skeleton for the AI Growth OS: Next.js web
app, NestJS API, Python worker plane, shared types, local infra, CI.

CONTEXT: Read docs/04-system-architecture.md (sections 4.1–4.3) and
docs/11-roadmap.md (Phase 0). Stack: pnpm + Turborepo, Next.js (App Router, TS),
NestJS (Node 22, TS), Python 3.12 (uv, FastAPI control plane for workers),
PostgreSQL 16, ClickHouse, Redis, MinIO (S3-compatible) — all via docker-compose
for local dev.

TASKS:
1. Initialize monorepo: apps/web (Next.js), apps/api (NestJS), workers/py
   (Python package `gros_workers` with FastAPI health app), packages/shared
   (zod schemas + generated types shared web/api), infra/ (docker-compose.dev.yml
   with postgres, clickhouse, redis, minio + init scripts).
2. apps/api: NestJS skeleton with config module (env-validated via zod), health
   endpoint, global exception filter producing RFC7807 problem+json, request-id
   middleware, pino structured logging.
3. workers/py: pyproject with uv, FastAPI /healthz, shared settings module
   (pydantic-settings), structlog JSON logging, mypy --strict + ruff configured.
4. apps/web: Next.js with Tailwind + shadcn/ui installed, a /login placeholder
   page and an authenticated layout shell (sidebar nav stub: Command Center,
   War Room, Approvals, Health, Settings), dark-first design tokens.
5. Tooling: root scripts (dev, build, test, lint, typecheck), ESLint+Prettier,
   GitHub Actions CI running lint/typecheck/test for all packages + docker
   builds. Add Makefile or task runner for `make dev` bringing up infra + apps.
6. README.md at root: setup in <10 commands, architecture pointer to /docs.

FILES TO CREATE: as above. Do not create database schemas yet (next prompt).

CONSTRAINTS: No business logic. No auth yet. CI must pass on a fresh clone.
Pin all dependency major versions.

AUTOMATED QA: CI workflow green locally (act or documented equivalent);
`pnpm -r typecheck && pnpm -r lint && pnpm -r test` passes; `uv run pytest`
passes in workers/py (a trivial settings test); docker-compose up succeeds and
all four infra services pass healthchecks (write scripts/check-infra.sh that
asserts this).

MANUAL VERIFICATION (tell me to do this): clone fresh, `make dev`, open
http://localhost:3000 (web shell) and http://localhost:3001/health (api),
http://localhost:8000/healthz (worker). Confirm hot reload in web and api.

EXPECTED OUTPUT: Running skeleton, green CI, README accurate.

FINAL REPORT (mandatory): WHAT WAS DONE (file-level summary) / WHAT WAS NOT DONE
(explicitly, with why) / DEVIATIONS from spec (with justification) / RISKS &
NOTES for the next task.
```

---

## Prompt 2 — Tenancy, auth, RBAC, audit spine (Postgres + RLS)

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend existing monorepo from Prompt 1. Migrations are
forward-only from here.

OBJECTIVE: The multi-tenant security spine: tenants, users, memberships, roles,
permissions, JWT auth, RLS enforcement, audit logging, idempotency.

CONTEXT: Read docs/07-data-model.md (§7.1 Tenancy/RBAC, audit, outbox),
docs/08-api-plan.md (§8.1, 8.2, 8.9 audit), docs/04-system-architecture.md
(§4.3, 4.10). Migration tool: node-pg-migrate in apps/api/migrations.

TASKS:
1. Migrations for: tenants, users, memberships, roles, permissions,
   role_permissions, api_keys, audit_logs (partitioned monthly), outbox —
   exactly per docs/07 DDL (adapt syntax, keep semantics). Seed system roles
   (Owner, Admin, Approver, Analyst, Viewer) and the permission catalog from
   docs/08 §8.11.
2. RLS: enable on every tenant-scoped table with the tenant_isolation policy;
   create app DB role that cannot bypass RLS; connection middleware sets
   app.tenant_id per request from the authenticated context. Document the
   pattern in apps/api/docs/rls.md.
3. Auth module: register (bootstrap tenant + Owner), login (argon2id), JWT
   access (15m) + rotating refresh (httpOnly cookies for web, Bearer for API),
   logout, /v1/me returning profile + permissions.
4. RBAC: @RequirePermission decorator + guard reading membership role →
   permissions; api_keys auth strategy with scopes.
5. AuditInterceptor: every mutating endpoint writes audit_logs (actor, event,
   object, before/after refs, ip, ua) inside the same transaction.
6. IdempotencyInterceptor honoring Idempotency-Key with Redis-backed replay.
7. Tenant/member/role endpoints per docs/08 §8.2.
8. Web: real login page, auth context, route protection, member settings page
   (list/invite/change-role) wired to API.

CONSTRAINTS: RLS is the enforcement layer — application-level tenant filters
are additional, not a substitute. No permission check may live only in the
frontend. Passwords: argon2id with sane params. No email sending yet (invites
return a dev-mode link).

AUTOMATED QA:
- Isolation suite (apps/api/test/isolation.e2e.ts): create 2 tenants × 5 roles;
  programmatically iterate EVERY registered route attempting cross-tenant access
  and under-privileged access; assert 403/404 everywhere. This suite must be
  structured to auto-discover new routes (fail CI if a route lacks coverage
  metadata).
- Unit tests: guards, token rotation, idempotency replay.
- Audit test: run a mutation script, assert audit rows complete and immutable
  (UPDATE/DELETE on audit_logs fails at DB level).

MANUAL VERIFICATION: register tenant A and B in two browsers; confirm A sees
nothing of B anywhere; change a member's role and watch permissions update;
inspect audit_logs rows for the session.

EXPECTED OUTPUT: Auth + RBAC + RLS + audit working end to end, isolation suite
green and wired into CI as a required check.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Prompt 3 — Job plane, LLM gateway, observability

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. API and worker plane both change.

OBJECTIVE: The async backbone: BullMQ queues shared Node↔Python, transactional
outbox dispatch, OpenTelemetry tracing across the stack, the LLM Gateway with
multi-provider support and cost ledger.

CONTEXT: docs/04-system-architecture.md §4.3, 4.7, 4.10, 4.11;
docs/07-data-model.md (llm_cost_ledger, outbox). LLM providers: Anthropic
(primary) + OpenAI (fallback) behind one interface; read provider docs as
needed. Model tiers: 'fast' and 'frontier' resolved from config, never
hardcoded at call sites.

TASKS:
1. Queue layer: typed job contracts in packages/shared (zod), BullMQ producer
   in Nest, Python consumer (workers/py/gros_workers/queues.py) with
   at-least-once handling + idempotent job design doc; dead-letter queue +
   retry policy (exp backoff, max 5).
2. Outbox dispatcher: poller publishing outbox rows to queues exactly-once
   (row lock + published_at), with metrics.
3. OTel: trace propagation API → Redis job → Python worker → Postgres/ClickHouse
   clients; one trace id visible end to end; export OTLP (compose adds
   grafana/tempo/loki/prometheus for local).
4. LLM Gateway (workers/py/gros_workers/llm/): provider-agnostic
   complete(structured_output_schema, messages, tier, tenant_id, purpose);
   Anthropic + OpenAI adapters; retries with provider failover; full
   prompt/response persisted to MinIO with pointer; tokens+cost written to
   llm_cost_ledger; per-tenant monthly budget check (hard stop raises
   BudgetExceeded); strict separation: external/untrusted text is passed only
   inside a fenced data block, never concatenated into instructions.
5. Cost endpoints: /v1/costs/llm and /v1/costs/budget per docs/08 §8.9.
6. Sentry wiring both planes.

CONSTRAINTS: No agent logic yet. Gateway must be import-safe without API keys
(degrades to explicit NotConfigured error). All LLM calls must carry tenant_id
and purpose — reject otherwise.

AUTOMATED QA: queue round-trip integration test (Nest enqueues, Python consumes,
result lands in Postgres, single trace id asserted via in-memory OTLP exporter);
outbox exactly-once test under concurrent pollers; gateway unit tests with
mocked providers (failover, budget stop, transcript persistence); cost ledger
accounting test (token math).

MANUAL VERIFICATION: run `make dev`, execute scripts/demo-llm-call.py with a
real key, view the trace in Grafana spanning API→worker→LLM, and the ledger row
via /v1/costs/llm.

EXPECTED OUTPUT: Working async + tracing + gateway substrate the data and agent
layers will stand on.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Prompt 4 — ClickHouse schemas, connector framework, first connector (Meta)

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. Mostly workers/py + ClickHouse + new Nest module.

OBJECTIVE: The ingestion substrate: ClickHouse schemas, raw zone, connector
framework, integrations API, and the Meta Ads connector end to end
(entities + spend metrics), with sync bookkeeping.

CONTEXT: docs/04-system-architecture.md §4.4–4.5; docs/07-data-model.md §7.2
(raw_events, spend_metrics_hourly) and §7.1 (data_sources, integrations,
sync_runs, apps, campaigns, ad_groups, ads, creatives); docs/08 §8.3.
Meta Marketing API: use the insights and entity endpoints; respect rate limits.

TASKS:
1. ClickHouse migration runner (workers/py, plain SQL files, versioned) +
   schemas: raw_events, spend_metrics_hourly (per docs/07 §7.2 exactly).
2. Postgres migrations: data_sources (seed catalog rows for meta_ads,
   google_ads, appsflyer, revenuecat, firebase, firstparty), integrations
   (credentials KMS-envelope encrypted — implement envelope encryption with a
   local KMS abstraction now, cloud KMS adapter later), sync_runs, apps,
   campaigns, ad_groups, ads, creatives.
3. Connector framework (workers/py/gros_workers/connectors/base.py): the
   Connector protocol from docs/04 §4.4 (spec/check/backfill/sync_incremental),
   RawBatch envelope → S3(MinIO) + raw_events insert, cursor persistence,
   rate-limit/backoff helpers, structured connector errors.
4. Meta connector: OAuth flow endpoints (8.3), check() validating token+scopes
   (READ-ONLY scopes only), entity sync (campaigns/adsets/ads/creatives →
   registry upserts with external-id mapping), insights sync (hourly grain,
   3-day lookback re-pull) → spend_metrics_hourly via a meta→canonical
   normalizer with golden-fixture tests.
5. Sync scheduler: per-integration schedule (BullMQ repeatable), per-tenant
   mutex lock, sync_runs bookkeeping, freshness metric export.
6. Integrations API + minimal web UI: connect (OAuth), status/health, trigger
   backfill, sync-runs history.

CONSTRAINTS: READ-ONLY platform scopes — fail check() loudly if a write scope
sneaks in. Raw payloads always persisted before normalization. Normalizers
pure-functional and replayable from raw. No metrics API yet.

AUTOMATED QA: connector tests against recorded cassettes (commit sanitized
fixtures); normalizer golden tests incl. malformed payloads; restatement test
(re-pull mutated fixture → ReplacingMergeTree converges, assert via final
SELECT); scheduler mutex test; encryption round-trip test; isolation suite
still green (new routes covered).

MANUAL VERIFICATION: connect a real Meta sandbox/dev account, run backfill for
30 days, then: SELECT spend by campaign/day in ClickHouse and compare to Ads
Manager for 5 sampled cells — document the comparison in the report.

EXPECTED OUTPUT: Real Meta data flowing raw→normalized on schedule, visible
sync health.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
the 5-cell reconciliation table.
```

---

## Prompt 5 — Remaining Phase-1 connectors (AppsFlyer, Google, RevenueCat, events)

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend, following the established connector framework patterns
from Prompt 4 exactly.

OBJECTIVE: Complete the Phase-1 source set: AppsFlyer (attribution + cost),
Google Ads (entities + spend), RevenueCat (subscription lifecycle), first-party
events ingestion with canonical taxonomy. Plus the events/attribution/revenue
ClickHouse tables.

CONTEXT: docs/07-data-model.md §7.2 (events, attribution, skan_postbacks,
revenue_events) and §7.1 (taxonomy notes in docs/08 §8.3); docs/04 §4.4 sync
ladder. AppsFlyer: aggregate pull API + raw data via Data Locker if configured;
SKAN postback ingestion. RevenueCat: webhooks (signature-verified) + REST
backfill.

TASKS:
1. ClickHouse schemas: events, attribution, skan_postbacks, revenue_events
   per docs/07.
2. AppsFlyer connector: attribution (installs by source/campaign/geo, 7-day
   restatement window), cost data, SKAN postbacks; normalizers + external-id →
   internal campaign resolution (fuzzy fallback documented when networks/MMP
   ids mismatch — flag unresolved to a reconciliation table, never guess
   silently).
3. Google Ads connector: entities + spend (hourly where available, daily
   otherwise), same registry/normalizer patterns.
4. RevenueCat: webhook endpoint (signature verification, replay-safe) +
   backfill; normalize to revenue_events (trial_start/convert/renewal/cancel/
   refund/reactivation), proceeds vs revenue handled.
5. First-party events: POST /v1/ingest/events (api-key scoped, batched, zod
   schema), canonical event taxonomy registry (Postgres) + validation
   (unknown events land quarantined with a taxonomy violation record, not
   dropped), GET/PUT taxonomy endpoints.
6. FX: daily rates table + normalization of all money to USD at event date,
   original currency preserved.

CONSTRAINTS: Same rules as Prompt 4 (read-only, raw-first, replayable).
Webhook endpoints must be idempotent under replay.

AUTOMATED QA: per-connector cassette + golden normalizer tests; SKAN postback
math fixtures (null CV, coarse values); RevenueCat webhook signature +
replay-idempotency tests; taxonomy quarantine test; FX conversion property
tests; cross-source smoke: one synthetic user journey (install via Meta →
events → trial → conversion) flows into all four ClickHouse fact tables with
consistent ids.

MANUAL VERIFICATION: with real/sandbox creds for each source, backfill 30 days;
verify in ClickHouse: installs by source vs AppsFlyer dashboard (5 cells),
revenue vs RevenueCat dashboard (5 days). Document.

EXPECTED OUTPUT: Five production connectors; the SSOT fact layer is complete.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
reconciliation tables.
```

---

## Prompt 6 — Semantic metrics layer, marts, reconciliation jobs

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. This prompt creates the single read path everything
else will use — take exceptional care with correctness.

OBJECTIVE: Semantic metric definitions + /v1/metrics/query + decompose;
cohort/creative marts; cross-source reconciliation jobs feeding
data_quality_checks; health status model.

CONTEXT: docs/04 §4.5–4.6; docs/07 §7.1 (metric_definitions,
data_quality_checks, health_status) and §7.2 (cohort_metrics,
creative_metrics_daily); docs/08 §8.4–8.5; docs/09 §9.5 freshness concepts.

TASKS:
1. metric_definitions migration + seed ~25 core metrics (spend, installs, cpi,
   cpm, ctr, ipm, cvr, roas_d0/d3/d7/d30, retention_d1/d7/d30, ltv_d30_proj,
   trial_start_rate, trial_to_paid, refund_rate, arpdau, payer_rate...) as
   templated ClickHouse SQL with declared dimensions/grains/caveats.
2. Metrics service (workers/py or api — choose api with a CH client, justify):
   POST /v1/metrics/query — safe template expansion (NO string-interpolated
   user input; parameterized, dimension/filter allowlists from the definition),
   tenant_id always injected, freshness + caveats in response, Redis cache
   (short TTL keyed by params+data-version).
3. POST /v1/metrics/decompose: deterministic contribution analysis of metric
   change between two windows across allowed dimensions (additive metrics
   exact; ratio metrics via standard decomposition — document the method).
4. Mart builders (worker jobs): cohort_metrics (nightly full + intraday
   partial) and creative_metrics_daily per docs/07 definitions, rebuilt from
   facts (restatement-safe).
5. Reconciliation jobs: meta-spend vs appsflyer-cost, appsflyer-revenue vs
   revenuecat, installs MMP vs firstparty; tolerance bands config;
   data_quality_checks rows + health_status rollup (green/yellow/red per
   domain) + GET /v1/health/* endpoints per docs/08 §8.5.
6. Cross-mart invariant checks as a scheduled job (docs/12 §12.2) alerting on
   violation.

CONSTRAINTS: The metrics endpoint is the ONLY read path for UI and (later)
agents — no other ClickHouse SELECT paths in api code (enforce via lint rule
or code review note). Ratio-metric decomposition must state its method in
the response payload.

AUTOMATED QA: formula tests (synthetic facts → expected metric values, per
metric); decompose correctness tests (constructed deltas with known
contributors); SQL-injection attempts on query/decompose rejected; mart
rebuild idempotency test; reconciliation threshold tests (planted delta →
warn/fail as configured); invariant checker tests.

MANUAL VERIFICATION: query roas_d7 by geo×channel for the live test tenant via
API and cross-check 3 values by hand-written ClickHouse SQL; break a connector
on purpose (pause it) and watch health flip yellow with reasons.

EXPECTED OUTPUT: The SSOT contract is live: one governed read path, marts,
reconciliation, health.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Prompt 7 — Detection layer (statistical signals) + Command Center

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. First user-facing intelligence — but strictly
statistical; NO LLM usage in this prompt.

OBJECTIVE: The detector suite writing anomalies, and the Command Center
delivering the 10-second experience on real data.

CONTEXT: docs/09 §9.1 (detector suite, noise control, materiality);
docs/07 §7.1 (anomalies, experiments); docs/08 §8.4
(/v1/dashboard/command-center); docs/06 has UI DNA; docs/03 Dana's morning loop.

TASKS:
1. Detectors (workers/py/gros_workers/detection/): robust zscore/MAD
   (day-of-week adjusted), CUSUM change-point, STL residual, creative fatigue
   curve fit, cohort quality sequential test, opportunity scanners (scale
   headroom, geo headroom), each versioned + parameterized per tenant; hourly/
   daily scheduled runs; anomalies rows with materiality_usd; hierarchical
   suppression + known-event masking (experiments table) + cooldowns.
2. experiments table migration + minimal CRUD (manual entry + Firebase import
   stub) so masking works.
3. GET /v1/dashboard/command-center: single-request payload per docs/08 —
   status summary, what-changed list (top anomalies, business-ordered),
   waste & opportunity cards with $ estimates, health strip, approvals count
   (0 for now).
4. Web: Command Center page — above-the-fold answers to the six questions
   (docs/02 P9), dense Linear-like layout, keyboard nav, every number
   click-through to a drilldown view (UA table by channel/geo/campaign;
   creative table with fatigue badges; cohort grid). SSE channel pushing new
   anomalies live.
5. Tracking Health Center page: health strip detail, reconciliation reports,
   sync runs, taxonomy violations.
6. Slack daily digest (webhook-based, opt-in): top 3 signals + health.

CONSTRAINTS: No LLM calls anywhere. Detector outputs must be reproducible
(same inputs → same anomalies; seed anything stochastic). Noise budget:
include per-tenant config for materiality threshold; default tuned so the
demo tenant yields ≤5 material signals/day — show the tuning math in the
report.

AUTOMATED QA: detector unit tests on synthetic series (planted anomalies
detected; clean seasonal series silent; CUSUM catches slow drift zscore
misses); suppression/masking tests; fatigue-fit tests on synthetic decay;
dashboard endpoint contract test + p95 latency test (<1.5s with warm cache,
k6 script committed); Playwright: login → command center renders real numbers
→ drilldowns navigate.

MANUAL VERIFICATION: the 10-second test (docs/12 §12.4) on the live tenant:
can you answer all six questions without scrolling? Time it. Plant a synthetic
spend spike in ClickHouse and watch it surface within one detection cycle.

EXPECTED OUTPUT: The wedge product: trustworthy dashboard + statistical signals.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
10-second-test result.
```

---

## Prompt 8 — Agent substrate: orchestrator, protocol, evidence, tools

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. This is the most architecturally sensitive prompt in
the chain — the orchestrator is deterministic code; LLMs act only inside
phase steps.

OBJECTIVE: The agent runtime substrate: session state machine, message
protocol with evidence enforcement, evidence pipeline, tool registry,
playbook loader. NO real agents yet — substrate + one trivial EchoAgent for
testing.

CONTEXT: docs/05 §5.0 and §5.6 (protocol, memory, orchestration flow);
docs/07 §7.1 (playbooks, agent_sessions, agent_runs, agent_messages, evidence,
tenant_memory); docs/04 §4.7. The LLM Gateway from Prompt 3 is the only LLM
access path.

TASKS:
1. Migrations: playbooks, agent_sessions, agent_runs, agent_messages, evidence,
   tenant_memory per docs/07.
2. Orchestrator (workers/py/gros_workers/agents/orchestrator.py): explicit
   state machine (triage → health_gate → investigation → debate → synthesis →
   action_prep → review → published/monitoring/closed/parked/failed); phase
   transitions are code; per-phase wall-clock/token/tool budgets from playbook
   definition; state persisted to agent_sessions on every transition; resume
   after worker kill (idempotent phase steps); per-scope distributed lock.
3. Message protocol: pydantic models for finding/hypothesis/challenge/
   concession/proposal/vote/request/directive/resolution; the validator that
   REJECTS findings/hypotheses/challenges lacking resolvable evidence_ids;
   hypothesis messages require the falsification field; persisted append-only.
4. Evidence pipeline: tool execution wrapper that, for any metrics
   query/decompose call, freezes result snapshot to MinIO, writes evidence row
   (params, sql_hash, digest, freshness), returns evidence_id with the digest
   to the agent.
5. Tool registry: query_metrics, decompose_metric_change, get_entity,
   get_data_health, get_experiments — typed schemas, allowlists per agent,
   every call logged to agent_runs.tool_calls and traced.
6. Playbook loader: JSON definitions (phases, roster, budgets, mandatory
   primitives, output schema) versioned in-repo under playbooks/ and synced to
   DB; ship a `test_echo` playbook.
7. Session APIs: POST /v1/sessions (manual trigger), GET list/detail/messages,
   SSE events session.message/session.phase; minimal War Room list + raw
   thread view in web (debug-grade UI; the real UI comes in Prompt 10).
8. EchoAgent: trivial agent that queries one metric via tools and emits a
   finding with evidence — proves the whole substrate.

CONSTRAINTS: No agent may emit a number not present in an evidence digest —
implement the binding format ({metric:...} tokens) and renderer-side
substitution now. Budgets must actually terminate sessions gracefully
(status=budget_exceeded with honest partial state). All session steps
idempotent for resume.

AUTOMATED QA: state-machine tests (every legal/illegal transition); kill-resume
test (SIGKILL worker mid-phase, session completes on restart); protocol fuzz
tests (evidence-less claims, forged evidence ids, schema garbage → rejected);
budget-cap test; evidence immutability test; EchoAgent e2e producing a session
with evidence-bound finding; SSE integration test.

MANUAL VERIFICATION: trigger a test_echo session via API; watch phases stream
in the debug UI; open the evidence row and confirm snapshot in MinIO matches
the digest; kill the worker mid-run and watch it resume.

EXPECTED OUTPUT: A bulletproof agent substrate; adding agents is now writing
prompts + tools, not infrastructure.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Prompt 9 — Tracking Agent + Intelligence Agent + Growth Director (first real playbooks)

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. First real LLM reasoning enters the system. Build the
agent QA harness IN THIS PROMPT, alongside the agents.

OBJECTIVE: Three super-agents (Tracking/Data, Intelligence, Growth Director)
with internal specialists, the health gate, playbooks roas_drop / cpi_spike /
tracking_break / cohort_quality_shift, and the golden-incident evaluation
harness.

CONTEXT: docs/05 §5.1, 5.2, 5.5, 5.6 in full; docs/09 §9.2–9.4, 9.6 (triage,
playbooks, confidence rubric); docs/12 §12.3 (agent QA — implement the harness
as described). Use 'fast' tier for triage/extraction, 'frontier' for
investigation/debate/synthesis via the gateway tiers.

TASKS:
1. Agent base class: system prompt pack structure (identity, protocol rules,
   tool docs, tenant memory digest), specialist sub-prompt invocation,
   structured outputs (pydantic), retry-on-schema-failure (max 2, then
   protocol error).
2. Tracking/Data Agent: tools get_sync_health/run_reconciliation/
   get_taxonomy_diff/get_skan_diagnostics/declare_health_status/veto_finding;
   specialists per docs/05 §5.5; health-gate phase implementation (red blocks,
   override path API + audit); daily scheduled health review session.
3. Intelligence Agent: tools incl. decompose, correlate_events (implement:
   timeline alignment vs experiments/releases/our-actions registry),
   compare_cohorts, funnel_analysis; specialists per §5.2; falsification-field
   discipline.
4. Growth Director: arbitration directives, challenge-resolution requirement
   (orchestrator enforces all challenges resolved before finalize), Devil's
   Advocate pass, Decision object (chosen/rejected-with-reasons/confidence/
   predicted-impact-range placeholder/risk/re-eval conditions).
5. Triage step (fast tier) per docs/09 §9.2 wiring anomalies → sessions with
   dedupe/merge + concurrency caps.
6. Confidence rubric v1 (docs/09 §9.6) computed in code from session state.
7. AGENT QA HARNESS (gros_workers/evals/): golden-incident format (frozen
   ClickHouse fixture dataset + ground-truth label), runner executing a
   playbook against a fixture tenant, metrics (root-cause accuracy, false-action
   rate, fabrication rate, cost, decision-agreement across 5 reruns), 6 seeded
   incidents to start (2 fatigue, 1 CV-schema break, 1 auction CPM, 1 cohort
   shift, 1 pure-noise negative). CI job runs the suite on prompt-pack changes.

CONSTRAINTS: Fabrication rate must be 0 in the harness (validator catch =
pass; published fabrication = build failure). Session cost cap default $10;
log per-phase token spend. Prompt packs live in versioned files
(agents/prompts/), never inline strings.

AUTOMATED QA: the harness itself (≥70% root-cause accuracy on the 6 incidents,
0 fabrications, negative incident yields monitor/parked NOT a recommendation);
protocol conformance under real LLM outputs (record + replay transcripts for
deterministic CI); health-gate block + override tests; challenge-resolution
enforcement test.

MANUAL VERIFICATION: plant the synthetic ROAS-drop scenario from Prompt 7 and
run a real roas_drop session end to end with live LLM; read the thread: does
the debate make sense? Does the decision cite real evidence? Record your
verdict in the report.

EXPECTED OUTPUT: The system investigates real anomalies and produces
evidence-bound decisions; harness guards every future change.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
harness scorecard.
```

---

## Prompt 10 — War Room UI

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. Frontend-heavy; the debug thread view from Prompt 8 is
replaced by the real experience.

OBJECTIVE: The full War Room per docs/06: session list, three-pane session
view, contention cards, Evidence Inspector with re-run & drift, decision
panel, live streaming + replay, ask-the-room, abstracts, export.

CONTEXT: docs/06 in full (it is the UI spec); docs/05 §5.6 phases; existing
SSE channel and session APIs. Action panel renders from API but
approve/reject buttons are disabled-with-tooltip until Prompt 11.

TASKS:
1. Session list with filters, keyboard nav, live updates.
2. Session view: phase-grouped collapsible thread; message anatomy (agent
   chips, type tags, evidence chips inline, confidence bars); number rendering
   STRICTLY via evidence binding ({metric:...} token substitution — a message
   with an unresolvable token renders an error chip, never a raw number).
3. Contention cards: side-by-side positions + resolution, per docs/06 §6.3.
4. Evidence Inspector drawer: result/definition/query views, freshness,
   re-run & diff (POST /v1/evidence/:id/rerun — implement endpoint).
5. Decision panel: terminal states, rejected alternatives, predicted impact,
   risk statement, re-eval conditions; honest failure states (monitor /
   budget-exceeded / parked-on-red-health banners) per docs/06 §6.9.
6. Live mode: SSE streaming with phase ticker; replay as default for closed
   sessions; session abstract at top.
7. Ask-the-room: directive input → orchestrator routing (Growth Director must
   address before finalize — extend orchestrator).
8. Export session to Markdown.
9. Wire "Investigate →" entry points from Command Center anomaly cards and
   campaign/creative drilldown rows.

CONSTRAINTS: p95 interaction <200ms perceived (optimistic UI, virtualized
thread). No number on screen that doesn't come from an evidence digest. Design
density: Linear-grade; no decorative illustrations.

AUTOMATED QA: Playwright: full replay of a seeded session (thread, contention,
inspector opens with correct SQL and snapshot, decision panel complete);
evidence-binding test (message with bad token renders error chip); SSE live
test (session runs, UI updates without refresh); export snapshot test;
accessibility pass on the session view (keyboard-only operation).

MANUAL VERIFICATION: run a live session and watch it stream; perform the
"skeptical analyst hour" (docs/11 Phase 4 exit): try to find one claim you
can't trace to data in two clicks. Report the result honestly.

EXPECTED OUTPUT: The product's signature experience, live on real
investigations.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
skeptical-hour verdict.
```

---

## Prompt 11 — Operations Agent, guardrails, actions, approvals

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. Money-adjacent logic begins; bias every ambiguity
toward safety.

OBJECTIVE: Operations Agent producing dry-run-validated action drafts; the
guardrail engine; approval policies and flows (web + Slack); recommendation
records with confidence and predicted impact; outcome tracking jobs.

CONTEXT: docs/05 §5.3; docs/10 §10.1–10.4 (lifecycle, adapter contract for
validate/dry_run only, guardrails, per-kind specs); docs/07 (recommendations,
actions, approvals, approval_policies, executions); docs/08 §8.7–8.8;
docs/09 §9.7 (impact estimators) and §9.8 (validation gate), §9.9 rejection
codes.

TASKS:
1. Migrations: recommendations, actions, approvals, approval_policies,
   executions (executions unused until Prompt 12, schema now).
2. ExecutionAdapter interface + Meta and Google adapters implementing
   capabilities/validate/dry_run ONLY (execute/verify/rollback raise
   NotEnabledError). Dry-run uses platform validation APIs where available,
   else read-current-state + simulated diff with documented semantics.
3. Guardrail engine: policy set per docs/10 §10.3 as per-tenant data; evaluated
   at draft and at approval; full evaluation report stored on the action.
4. Operations Agent: action_prep phase; specialists per docs/05 §5.3; drafts
   carry diff/payload/execution_plan/rollback_plan/monitoring_plan; an action
   draft missing rollback or monitoring plans fails schema; feasibility-veto
   path back to Growth Director.
5. Impact estimators (typed, per docs/09 §9.7) for budget_change, pause_entity,
   creative_rotation, tracking fix; wired into recommendations.predicted_impact
   with basis evidence ids.
6. Validation gate (docs/09 §9.8) as the publish step: number binding, schema,
   policy, dedupe-vs-open-recommendations, freshness re-check.
7. Approvals: policies CRUD (magnitude thresholds, role requirements,
   two-person rule, expiry); approve endpoint requiring confirm_diff_hash echo;
   reject with mandatory reason codes; modify → superseding version; expiry job
   on evidence drift/TTL; Slack approval messages (low-magnitude one-click,
   high-magnitude deep-link); ALL audited.
8. Web: Approvals queue + action panel in War Room goes live (approve/modify/
   reject); recommendations list + detail; recommendation stats page v1
   (approval rates; calibration arrives with outcomes).
9. Outcome jobs: arm monitoring plans (detection-layer hooks), compute
   predicted-vs-realized at horizon into recommendations.outcome; feed playbook
   precision store.

CONSTRAINTS: There is NO execution path in this prompt — approved actions stop
at status=approved with a clear "execution not yet enabled" state. Guardrail
evaluation must be deterministic and fully explained in stored output. Slack
approve must be signature-verified + permission-checked server-side.

AUTOMATED QA: guardrail table-driven tests (every policy boundary); diff-hash
echo test (stale render cannot approve); approval permission matrix (extend
isolation suite); two-person rule test; expiry-on-drift test; rollback-inverse
property test (apply→rollback==identity on payload model); dry-run cassette
tests for both adapters; impact estimator unit tests; e2e: anomaly → session →
recommendation → action awaiting approval → approve → status=approved + audit
chain complete.

MANUAL VERIFICATION: run the full loop on the live tenant; approve a budget
action and verify the audit log reconstructs the entire causal chain
(docs/12 §12.6 trust-audit style). Attempt to approve beyond your role's
magnitude threshold — must be refused.

EXPECTED OUTPUT: Level-2 product complete: investigate → decide → prepared,
guarded, approvable actions.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Prompt 12 — Creative Agent & creative intelligence center

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend.

OBJECTIVE: Creative Agent with fatigue interpretation, hook analysis, grounded
brief generation; creative tagging pipeline; Creative Intelligence Center UI;
playbooks creative_fatigue and scale_opportunity.

CONTEXT: docs/05 §5.4; docs/09 §9.1 fatigue detector (exists since Prompt 7 —
this prompt adds the agent layer on top); creative_metrics_daily mart;
docs/06 for UI DNA.

TASKS:
1. Creative tagging pipeline: at asset ingest, fast-tier multimodal tagging
   (hook_type, theme, style, format already known) into creatives.tags;
   taxonomy config versioned; backfill job for existing assets.
2. Creative Agent: tools get_creative_assets/get_fatigue_curves/tag_creative/
   generate_brief/search_competitor_creatives (competitor tool returns
   structured digests from an ad-library ingestion job — implement a minimal
   Meta Ad Library pull for tenant-configured competitor pages; mark clearly
   as inspiration-only data); specialists per docs/05 §5.4; briefs require
   rationale_evidence_ids (schema-enforced grounding).
3. Playbooks: creative_fatigue (fatigue signal → remaining-life estimate →
   replacement readiness check → rotation recommendation + brief generation),
   scale_opportunity (saturation curve + marginal ROAS + downside sizing →
   budget action via Operations).
4. Creative Intelligence Center UI: asset table (fatigue badges, decay
   sparklines, spend share), hook/angle performance map, briefs inbox
   (review/edit/export brief → mark as sent-to-studio), competitor pattern
   digest view.
5. creative_rotation action kind through the Prompt-11 pipeline (rotation plan
   diff; new-asset upload remains out of scope until execution phase — the
   action packages asset specs + rotation steps for approval).

CONSTRAINTS: Every brief grounded (evidence-cited rationale) — ungrounded
generation must fail schema. Competitor data is inspiration only: prompts
forbid copy instructions; output briefs must differ structurally from cited
competitor examples (reviewer note in UI). Multimodal tagging budget-capped
per tenant.

AUTOMATED QA: tagging pipeline golden tests (fixture videos/images →
expected tag fields present); grounding schema tests (briefs without evidence
rejected); fatigue playbook on golden incidents (the 2 fatigue incidents from
Prompt 9 harness must now produce rotation recommendations with briefs);
saturation/downside estimator tests; Playwright on the center.

MANUAL VERIFICATION: run creative_fatigue on the live tenant's most-spent
asset; judge the 5 generated briefs yourself: are they specific to this
game/app and its winning patterns, or generic ad-speak? Verdict in report.

EXPECTED OUTPUT: The wow-moment chain (fatigue → diagnosis → briefs →
prepared rotation + budget action) works end to end.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
brief-quality verdict.
```

---

## Prompt 13 — Execution: execute/verify/rollback for Meta & Google

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. HIGHEST-RISK PROMPT IN THE CHAIN. Everything here runs
against SANDBOX/TEST ad accounts only; production credentials remain read-only
and execution remains feature-flagged off by default.

OBJECTIVE: Complete the ExecutionAdapter lifecycle (execute/verify/rollback)
for Meta and Google; the approval→outbox→execution worker; pre-execution drift
checks; auto-revert pipeline; kill switch.

CONTEXT: docs/10 in full (lifecycle, idempotency, drift check, monitoring/
auto-revert, autonomy ladder — implement L2 execution: human-approved actions
only); docs/07 executions table; docs/12 §12.5 execution safety drills.

TASKS:
1. Meta + Google execute(): budget_change, pause_entity, create_campaign
   (created paused, always); idempotency keys; rate-limit aware; full
   request/response digests to executions.
2. Pre-execution gate (code path shared across adapters): approval row exists
   and unexpired; evidence drift within tolerance (re-run load-bearing
   evidence, compare); current platform state == action.diff.before (abort on
   drift, demote to draft, notify); health domain not red; guardrails re-pass;
   per-entity in-flight lock.
3. Outbox flow: action.approved → outbox → execution worker; retries with
   backoff; terminal failure → status + alert.
4. verify(): read-back within configured delay, compare to intended state;
   mismatch → verify_failed + alert + (policy) auto-rollback.
5. rollback(): apply stored inverse; manual rollback endpoint; auto-revert
   pipeline: monitoring-plan threshold breach → auto-revert PROPOSAL action
   (one-click approve at L2).
6. Kill switch: tenant-level "pause all agent activity & executions" — one
   API + one always-visible UI button; halts schedulers, parks sessions,
   blocks execution worker; audited.
7. Scope upgrade flow: per-tenant credential re-auth requesting write scopes,
   gated behind policies:manage + explicit confirmation UI; integrations
   show current scope level prominently.
8. Credentials for sandbox accounts via env/dev settings; E2E execution tests
   against Meta sandbox + Google test account in a nightly CI job (not on
   every PR).

CONSTRAINTS: Execution feature flag default OFF per tenant; enabling writes an
audit event. No action kind beyond the three implemented. Double-execution
race must be impossible (DB-level uniqueness on action_id active execution +
lock). All platform writes carry idempotency keys; document each platform's
idempotency semantics in adapters' README.

AUTOMATED QA: execution safety drills as tests (docs/12 §12.5: no-approval,
expired, drifted-evidence, red-health, double-execution race — all fail
safely); verify-mismatch → auto-rollback test (mock platform mutates state
behind our back); kill-switch test (in-flight work parks gracefully); nightly
sandbox E2E: full chain approve→execute→verify→rollback on a real sandbox
campaign.

MANUAL VERIFICATION: on the sandbox account, approve and execute a budget
change end to end; verify in the platform's own UI; then trip the auto-revert
threshold artificially and approve the revert. Run a kill-switch fire drill.

EXPECTED OUTPUT: One-click execution with verification and rollback, gated,
flagged, and drilled.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
drill results.
```

---

## Prompt 14 — SaaS hardening: onboarding, billing, limits, security pass

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend.

OBJECTIVE: Self-serve readiness: onboarding flow, Stripe billing with usage
metering, plan limits/feature flags, notification preferences, data
retention/deletion, and a security hardening pass.

CONTEXT: docs/11 Phase 7; docs/08 §8.10; docs/04 §4.12; cost ledger from
Prompt 3 is the usage-metering source.

TASKS:
1. Onboarding wizard: tenant setup → connect integrations (OAuth flows
   hardened, clear progress) → taxonomy mapping assistant (observed events →
   canonical suggestions, user confirms) → backfill with progress → "first
   insight" landing moment.
2. Stripe: platform tiers + metered LLM/agent usage from llm_cost_ledger;
   webhooks (signature-verified, replay-safe); billing page; dunning states;
   plan limits enforced (integrations count, session concurrency, history
   depth) via a feature-flag/limits service.
3. Notification preferences (digest cadence, channels, thresholds) + customer
   outbound webhooks (HMAC-signed, retried) per docs/08 §8.10.
4. Data lifecycle: tenant data export (async job, S3 link), deletion pipeline
   (integration revoke → purge schedule across PG/CH/S3 with certificate of
   deletion), retention config.
5. Security pass: rate limiting per route class; secrets audit (canary-token
   log-scrub test from docs/12 §12.5); dependency/container scan gates
   blocking CI; CSP + security headers on web; session fixation/refresh-token
   rotation review; write SECURITY.md.
6. Status/ops: /v1/status public endpoint, SLO dashboards (sync freshness,
   API p95, queue lag, session cost), on-call runbook docs for the top 10
   failure modes (write them).

CONSTRAINTS: Billing must reconcile to the ledger exactly (penny test).
Deletion must be provable (post-purge verification queries). No plan-limit
check in frontend only.

AUTOMATED QA: Stripe webhook replay/signature tests; metering reconciliation
test (synthetic usage → expected invoice line); plan limit enforcement tests;
deletion pipeline test (seed tenant → delete → assert zero rows/objects across
all stores); rate-limit tests; full isolation + authz matrix suites still
green (regression).

MANUAL VERIFICATION: onboard a brand-new tenant start to finish yourself,
timing it (target < 1 day wall-clock to first insight with live data, < 30 min
of active work); run a test-mode Stripe subscription through upgrade/downgrade/
cancel.

EXPECTED OUTPUT: A stranger can sign up, connect, pay, and get value without
us in the room.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS /
onboarding timing.
```

---

## Prompt 15 — Autonomy ladder (L3): eligibility engine, undo window, review rituals

```text
[PASTE GLOBAL RULES]

EXECUTION MODE: Extend. Policy-layer work on top of the Prompt-13 execution
pipeline; no new platform mutations.

OBJECTIVE: Level-3 autonomy: per-kind track-record eligibility, auto-execution
of small-magnitude approved-kind actions within guardrails, undo window,
notification + weekly review surfaces, and the system-generated autonomy
eligibility report.

CONTEXT: docs/10 §10.6 (the ladder and unlock criteria — implement exactly);
docs/09 §9.6 confidence gates; approval_policies.autonomy_level is the dial.

TASKS:
1. Eligibility engine: per tenant × action kind, compute trailing-30-action
   stats (approval-without-edit rate, calibration error, guardrail incidents);
   expose GET /v1/autonomy/eligibility; generate the "eligibility report"
   document the user sees before enabling L3.
2. L3 policy enforcement: when autonomy_level=3 and action magnitude ≤ policy
   band and confidence ≥ gate and guardrails pass → execute without approval,
   create notification with 4h undo window (undo = prepared inverse executed
   on click); above band → normal approval flow.
3. Undo window UX: notification center + Slack message with Undo; countdown;
   undo executes rollback + audits.
4. Weekly review ritual surface: digest of all auto-executed actions, outcomes
   vs predictions, guardrail near-misses; requires explicit "reviewed" ack by
   an Approver — repeated missed reviews auto-downgrade to L2 (policy,
   documented, audited).
5. Auto-downgrade triggers: calibration drift beyond threshold, any guardrail
   incident, verify_failed event → kind drops to L2 + notification.
6. Enabling L3: two-step confirmation restating scope and bands, requires
   policies:manage + a second Approver acknowledgment (two-person), audited.

CONSTRAINTS: L4 is OUT OF SCOPE (design exists; do not implement). Creative
asset publication remains approval-required regardless of level. Every
auto-execution must be indistinguishable in audit/trace quality from approved
ones.

AUTOMATED QA: eligibility math tests; L3 path e2e (eligible action
auto-executes, notification + undo work, audit complete); band-boundary tests
(magnitude just above band → approval required); auto-downgrade trigger tests;
missed-review downgrade test; the full execution safety drill suite re-run
under L3.

MANUAL VERIFICATION: on the sandbox tenant, enable L3 for budget_change with a
$200/day band; let a small auto-action run; use Undo once; review the weekly
digest; trip a downgrade trigger and confirm the kind returns to L2.

EXPECTED OUTPUT: Supervised autonomy that earns and loses trust mechanically.

FINAL REPORT: WHAT WAS DONE / WHAT WAS NOT DONE + why / DEVIATIONS / RISKS.
```

---

## Using the chain well

- **Cadence:** Prompts 1–3 ≈ Phase 0; 4–6 ≈ Phase 1; 7 ≈ Phase 2; 8–9 ≈ Phase 3; 10 ≈ Phase 4; 11–12 ≈ Phase 5; 13 ≈ Phase 6; 14 ≈ Phase 7; 15 ≈ Phase 8 (L3). Expect several review/fix sessions per prompt — hold the exit criteria from docs/11, not the calendar.
- **Review discipline:** read every diff. The prompts demand honest "WHAT WAS NOT DONE" reporting — treat that section as the most important output and roll unfinished items into a follow-up session before advancing.
- **Connector add-ons** (TikTok in Phase 2, CRM in Phase 6, ASO module in Phase 7) reuse Prompt 4/5's structure: copy that prompt, swap the source specifics, keep the QA shape.
