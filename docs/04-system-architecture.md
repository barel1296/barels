# Part 4 — System Architecture

Production-grade, multi-tenant, API-first. Designed so that approval-mode v1 and autonomous Level-4 run on the **same** architecture — autonomy is a policy flag evaluated by the same execution pipeline.

## 4.1 Bird's-eye view

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                                     │
│  Next.js Web App (Command Center, War Room, Approvals, Health Centers)       │
│  Slack App (digests, approval buttons)  ·  Public REST API  ·  Webhooks      │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ HTTPS (REST + SSE/WebSocket)
┌──────────────────────────────▼──────────────────────────────────────────────┐
│  API GATEWAY — NestJS (Node 22, TypeScript)                                  │
│  AuthN (JWT+refresh, SSO) · Tenant resolution · RBAC guards · Rate limits    │
│  Zod-validated DTOs · Idempotency keys · OpenAPI · Audit interceptor         │
├──────────────────────────────────────────────────────────────────────────────┤
│  CORE SERVICES (NestJS modules, modular monolith → extractable)              │
│  Identity & Tenancy │ Integrations │ Metrics API │ Recommendations │         │
│  War Room │ Approvals │ Actions │ Audit │ Notifications │ Billing/Costs      │
└───────┬───────────────────────────────┬─────────────────────────────────────┘
        │ SQL (RLS)                     │ jobs (BullMQ/Redis)  · events (outbox)
┌───────▼────────┐              ┌───────▼──────────────────────────────────────┐
│  PostgreSQL 16 │              │  WORKER PLANE — Python 3.12 (FastAPI ctl)    │
│  OLTP: tenants │              │  ┌──────────────┐  ┌───────────────────────┐ │
│  users, RBAC,  │              │  │ INGESTION    │  │ AGENT RUNTIME         │ │
│  integrations, │              │  │ connectors,  │  │ orchestrator (state   │ │
│  campaigns*,   │              │  │ normalizers, │  │ machine), 5 super-    │ │
│  recs, actions,│              │  │ reconcilers  │  │ agents, tool registry,│ │
│  approvals,    │              │  └──────┬───────┘  │ LLM gateway, memory   │ │
│  audit, agent  │              │  ┌──────▼───────┐  └───────────┬───────────┘ │
│  runs/messages │              │  │ DETECTION    │              │             │
└───────┬────────┘              │  │ anomalies,   │  ┌───────────▼───────────┐ │
        │                       │  │ baselines,   │  │ EXECUTION ADAPTERS    │ │
┌───────▼────────┐              │  │ fatigue, DQ  │  │ Meta/Google/TikTok/   │ │
│  ClickHouse    │◄─────────────┤  └──────────────┘  │ MMP/CRM (dry-run +    │ │
│  raw + normal- │   inserts    │                    │ execute, idempotent)  │ │
│  ized events,  │              │                    └───────────────────────┘ │
│  metrics marts │              └──────────────────────────────────────────────┘
└────────────────┘
   Redis: queues, cache, rate-limit, locks │ S3-compatible: raw payloads, creatives, evidence snapshots
   Observability: OpenTelemetry → Grafana/Tempo/Loki/Prometheus · Sentry · LLM trace store
```

\* Campaign/creative *entity registry* lives in Postgres; their *metrics* live in ClickHouse.

## 4.2 Frontend — Next.js

- **Stack:** Next.js (App Router), TypeScript, Tailwind + shadcn/ui base restyled to a dense Linear-like design system, TanStack Query for server state, Zustand for ephemeral UI state, Recharts (only for evidence charts — see P1).
- **Realtime:** SSE channel per tenant (`/v1/stream`) for War Room session progress, approval queue changes, anomaly arrivals. WebSocket reserved for the live debate view if SSE proves limiting.
- **Key surfaces:** Command Center, War Room (list + session view), Approvals Queue, Recommendations, Tracking Health Center, Creative Intelligence Center, UA & Budget Intelligence, ASO Insights, Product-Growth Insights, Integrations, Settings (RBAC, guardrails/autonomy policies), Audit Log.
- **Performance budget:** TTI < 2s on Command Center; all server data cached at the metrics-API layer; optimistic UI on approvals.
- **Auth:** httpOnly cookie session against NestJS; tenant switcher for multi-tenant users (agencies later).

## 4.3 Backend core — NestJS modular monolith

Deliberately a **modular monolith** with hard module boundaries (separate Nest modules, no cross-module imports except via interfaces) — extractable to services when scale demands, not before. Two genuinely separate deployables from day one: the **NestJS API** and the **Python worker plane**, because their scaling profiles and dependency stacks differ fundamentally.

Cross-cutting concerns implemented as Nest interceptors/guards:
- `TenantContextInterceptor` — resolves tenant from JWT, sets `app.tenant_id` for Postgres RLS on every connection (see 4.5).
- `AuditInterceptor` — writes audit records for every mutating endpoint automatically (action, actor, before/after refs).
- `RbacGuard` — declarative permission decorators: `@RequirePermission('actions:approve')`.
- `IdempotencyInterceptor` — honors `Idempotency-Key` on all POSTs that create side effects.
- `CostGuard` — per-tenant LLM/job budget enforcement (see 4.10).

**Service-to-worker contract:** NestJS never calls LLMs or ad networks directly. It enqueues typed jobs (BullMQ on Redis) and exposes/consumes a transactional **outbox** table for events that must not be lost (e.g., `action.approved` → execution job). Python workers consume the same Redis queues via a thin compatibility layer (bullmq-python) — one queueing system, not two.

## 4.4 Data ingestion layer (Python worker plane)

**Connector framework** — every connector implements one interface:

```
Connector:
  spec() -> ConnectorSpec            # auth type, entities, granularities, rate limits
  check(credentials) -> HealthReport # validates creds + scopes, used at setup & hourly
  backfill(window) -> Iterator[RawBatch]
  sync_incremental(cursor) -> (Iterator[RawBatch], new_cursor)
```

- **Phase-1 connectors:** AppsFlyer (aggregate pull API + raw-data via Data Locker/S3), Meta Marketing API (insights + entity metadata), Google Ads API, RevenueCat (webhooks + API), Firebase/GA4 (BigQuery export pull or direct event ingestion endpoint), first-party events (SDK-less HTTPS ingest + ClickHouse-native batch).
- **Sync ladder:** entity metadata hourly; spend/performance metrics hourly with 3-day lookback re-pull (networks restate!); attribution daily with 7-day restatement window; SKAN postbacks as they land.
- **Raw zone:** every payload lands untouched in S3 (`raw/{tenant}/{source}/{date}/...`) and ClickHouse `raw_events`. Normalization is **replayable from raw** — a normalizer bug never requires re-pulling APIs.
- **Normalization:** source-specific mappers → canonical schemas (canonical campaign hierarchy, canonical event taxonomy, canonical money type with currency + FX table). Entity resolution maps `{source, external_id}` → internal IDs in Postgres registry tables.
- **Reconciliation jobs:** nightly cross-source checks (network spend vs. MMP cost, MMP revenue vs. RevenueCat, MMP installs vs. store/Firebase) producing `data_quality_checks` rows — the Tracking Agent's raw material.
- **Sync bookkeeping:** every run writes `sync_runs` (status, cursor, rows, lag, errors). Freshness SLOs per source feed both observability and the in-product Tracking Health Center.

## 4.5 Storage layer

**PostgreSQL 16 — OLTP and system-of-record** for tenancy, RBAC, integrations (credentials encrypted with per-tenant data keys via KMS envelope encryption), entity registries (campaigns/ad sets/ads/creatives/audiences), agent sessions & messages, evidence metadata, recommendations, actions, approvals, audit logs, playbooks, cost ledger.

- **Tenant isolation: Row-Level Security on every tenant-scoped table**, with `app.tenant_id` set per request/job. Application code *also* filters by tenant (defense in depth), and CI includes an isolation test suite that attempts cross-tenant reads with each role (Part 12).
- Migrations via a single tool (Prisma Migrate or node-pg-migrate) owned by the API repo; Python reads through the same schema.

**ClickHouse — analytics.** Databases per concern, **every table keyed by `tenant_id` first**:
- `raw_events` (source payload envelope), `events` (normalized canonical events), `attribution` (installs/conversions by source), `skan_postbacks`, `spend_metrics_daily/hourly` (campaign/adset/ad/creative × geo × platform), `revenue_events` (IAP/subscription lifecycle), `cohort_metrics` (cohort_day × dN retention/ROAS/LTV), `creative_metrics_daily`, `aso_metrics_daily`, `experiment_assignments`.
- Materialized views maintain the marts agents query; agents **never** query raw tables directly — they query versioned **metric definitions** (semantic layer, see 4.6).

**Redis:** BullMQ queues, short-TTL metric cache, distributed locks (per-tenant sync mutex), rate-limiter state. **S3:** raw payloads, creative assets, evidence snapshots (frozen query results as Parquet/JSON), LLM transcripts.

## 4.6 Semantic metrics layer (the SSOT contract)

A versioned registry (`metric_definitions` in Postgres) of every business metric: name, owner, formula (templated ClickHouse SQL), dimensions, grain, source lineage, and caveats (e.g., "iOS D7 ROAS is modeled below 25 conversions/day"). The **Metrics API** (`/v1/metrics/query`) is the *only* read path for both the UI and the agents. Consequences:
- UI numbers and agent numbers can never disagree.
- Every evidence artifact records `metric_version`, making old investigations replayable and auditable even after definitions evolve.
- Definition changes are migrations with review, not silent edits.

## 4.7 Agent orchestration layer

Detailed in Part 5; architectural skeleton here:

- **Orchestrator = deterministic state machine, not an LLM.** War Room sessions advance through coded phases (`triage → data_health_gate → parallel_investigation → debate → synthesis → action_prep → review`). LLMs act *within* phases; code decides transitions, time/token budgets, and termination. This is the single most important reliability decision in the system.
- **Agent runtime (Python):** each super-agent is a class wiring a system prompt pack, a tool allowlist, internal specialist sub-prompts, and structured output schemas (Pydantic). All LLM calls go through the **LLM Gateway**: multi-provider (Claude primary, OpenAI fallback), model tiering by task class, retries with provider failover, prompt/response logging, token accounting to the cost ledger, PII scrubbing on egress.
- **Blackboard:** agents communicate via persisted structured messages (`agent_messages` in Postgres) — typed as `finding | hypothesis | challenge | concession | proposal | vote` — each carrying `evidence_ids`. The protocol layer rejects messages whose claims lack evidence references (P2 enforced in code).
- **Tools:** `query_metrics` (semantic layer only), `get_entity`, `get_data_health`, `get_experiments`, `search_competitor_creatives`, `propose_action` (writes draft action), `request_agent_input`, plus per-agent specials. Tools are the *only* way agents touch data; every tool call is logged with inputs/outputs.
- **Durability:** session state is in Postgres; any worker can resume a session after crash (state machine + persisted messages = natural checkpointing). Temporal is deliberately deferred — BullMQ + persisted state machine covers Phases 0–5; re-evaluate at Phase 6 if execution workflows demand stronger guarantees.

## 4.8 Approval system

- Every prepared action enters `actions` with status `awaiting_approval`, linked to its recommendation, War Room session, evidence set, **diff preview** (exact before → after), guardrail evaluation result, predicted impact, and rollback plan.
- **Approval policies** per tenant: who can approve what (role + action type + magnitude thresholds, e.g., budget changes >$5K/day require CMO), optional two-person rule, expiry (stale actions auto-expire when underlying data shifts beyond tolerance — an approval on Tuesday's evidence must not fire on Friday's reality).
- Approvals available in-app and via Slack (signed deep-link back into the app for anything above a threshold — Slack one-click only for low-magnitude actions).
- Approval, rejection (with mandatory reason), modification (creates new action version, old one superseded), and expiry all write audit records.

## 4.9 Execution layer (detailed in Part 10)

- **ExecutionAdapter** interface per platform: `validate(action) → dry_run(action) → execute(action) → verify(action) → rollback(action)`. V1 implements `validate` + `dry_run` fully (that's what makes prepared actions trustworthy) and `execute/verify/rollback` behind the approval gate.
- Idempotency keys on every external mutation; outbox pattern from approval → execution job; post-execution verification reads the platform back and compares to intended state; divergence triggers alert + optional auto-rollback.
- **Guardrail engine** evaluates every action pre-approval AND pre-execution: budget caps (absolute + % change/day), blast radius (max % of tenant spend affected per day), frequency limits, blocked entities, data-health gate (no execution if upstream tracking is red).

## 4.10 Permissions, audit, cost control

- **RBAC:** roles (Owner, Admin, Approver, Analyst, Viewer + custom) → permission strings (`metrics:read`, `warroom:participate`, `actions:approve:budget`, `integrations:manage`, `policies:manage`...). Enforced at API guard + RLS. Integration credentials get the minimum platform scopes for the current autonomy level (read-only scopes until execution is enabled — a structural safety: in v1 we *cannot* mutate platforms even if every software control failed).
- **Audit:** append-only `audit_logs` (Postgres, partitioned, no UPDATE/DELETE grants) covering auth events, config changes, integration changes, every agent session, every recommendation/action state transition, every execution with request/response digests. Exportable (CSV/JSON, SIEM webhook later).
- **LLM cost control:** cost ledger per tenant/agent/session/model; per-tenant monthly budgets with soft (alert) and hard (degrade-to-cheaper-model, then pause non-critical sessions) limits; model tiering (cheap models for extraction/formatting, frontier for debate/synthesis); aggressive context discipline (evidence summarized to structured digests, full data never pasted into prompts); prompt caching for stable system packs.

## 4.11 Observability & reliability

- OpenTelemetry traces across API → queue → worker → LLM gateway → ClickHouse (one trace per War Room session is a hard requirement — debugging agent behavior demands it).
- Metrics: sync freshness/lag per source, queue depths, agent session duration/token/cost distributions, recommendation precision (approved-without-edit rate), guardrail trigger counts, API SLOs.
- Logs: structured JSON, tenant-tagged, Loki. Errors: Sentry both planes. Alerting: PagerDuty-compatible.
- **LLM trace store:** every prompt/response persisted (S3) and linked from agent messages — non-negotiable for agent QA (Part 12) and incident forensics.
- Degradation order under stress: pause competitive/ASO enrichment → reduce investigation depth → defer non-critical sessions → never degrade data ingestion or approval/audit paths.

## 4.12 Security baseline

Secrets in KMS-envelope encryption (per-tenant DEKs); TLS everywhere; OAuth tokens never logged; webhook signature verification; SSRF-safe fetchers for any URL the system retrieves; dependency and container scanning in CI; least-privilege IAM; SOC 2 controls mapped from Phase 0 (access reviews, change management via PR + CI, audit trail) so certification at Phase 7 is paperwork, not re-architecture. Prompt-injection defense for any external text entering agent context (ad copy, reviews, competitor data are *data*, never instructions — enforced via strict content/instruction separation in the gateway).
