# Part 11 — Roadmap

Team assumption: 3–4 senior engineers (1 frontend-lean, 2 backend/data, 1 AI/agents) + founder doing product/design partners. Durations are honest, with parallelism noted. **Every phase has exit criteria — a phase is not done because its time elapsed.**

Strategic sequencing logic: data trust before intelligence, intelligence before debate, debate before actions, actions before execution. Two design partners signed before Phase 1 ends, live on the product from Phase 2 — we build against their real data from the earliest possible moment.

---

## Phase 0 — Foundation (Weeks 1–3)

Monorepo (pnpm + Turborepo: `apps/web`, `apps/api`, `workers/py`, `packages/shared-types`, `infra/`), CI/CD (lint, typecheck, tests, docker builds, migration checks, preview deploys), environments (dev/staging/prod, IaC), NestJS skeleton with auth (JWT + refresh, argon2id, sessions), tenants/users/memberships/RBAC (system roles + permission catalog + guards), Postgres with RLS enforced + isolation test harness, ClickHouse + Redis provisioned, audit interceptor writing real records, observability spine (OTel traces API→worker, Sentry, structured logs), Next.js shell with auth flow and design-system primitives, LLM Gateway v0 (multi-provider, logging, cost ledger).

**Exit criteria:** two tenants with users/roles created via API; cross-tenant isolation suite green (every role × every endpoint); a traced request spans web→API→queue→Python worker→back; audit log shows every mutation from the test run; CI blocks on all of it.

## Phase 1 — Data layer (Weeks 3–9, overlaps 0)

Connector framework + five connectors to production grade: **AppsFlyer, Meta Ads, Google Ads, RevenueCat, Firebase/first-party events** (TikTok fast-follows in Phase 2 — it shares the framework). Raw zone (S3 + ClickHouse), normalizers, entity registry resolution, canonical event taxonomy + validation, FX handling, restatement re-pull windows, sync scheduling/bookkeeping, reconciliation jobs + `data_quality_checks`, semantic metrics layer v1 (~25 core metrics: spend, CPI, CPM, CTR, IPM, ROAS d0/d3/d7/d30, retention d1/d7/d30, LTV projections, trial funnel, refunds…), `/v1/metrics/query` + `decompose`, cohort + creative + spend marts with MV pipelines.

**Exit criteria:** design partner's real 13-month history backfilled; our numbers vs. their AppsFlyer/network dashboards reconcile within documented tolerance (±2% spend, ±5% attributed revenue) **or every discrepancy explained in writing**; restatement test passes (re-pull converges); sync-failure chaos test recovers without data loss; freshness SLO dashboards live.

## Phase 2 — Command Center (Weeks 8–13, overlaps 1)

The 10-second dashboard on real data: status summary, what-changed (powered by detection layer v1 — the statistical detectors ship HERE, before agents, as "Signals"), waste & opportunity cards (scanner-driven, no LLM narrative yet), health strip, drill-down views (UA & budget, creatives, product-growth, cohorts), Tracking Health Center v1 (reconciliation reports, sync health, taxonomy violations), TikTok connector, Slack daily digest.

**Exit criteria:** design partner's Head of UA voluntarily opens it every morning for 10 consecutive workdays (measured); "what changed" precision ≥ 80% judged by partner ("was this worth showing?"); detection noise within budget (≤ 5 material signals/day at their spend); dashboard p95 < 1.5s.

**This phase is the wedge demo:** trustworthy SSOT + signals already beats their spreadsheet — before a single agent speaks.

## Phase 3 — Agent layer (Weeks 12–19, overlaps 2)

Orchestrator state machine (sessions, phases, budgets, persistence/resume), message protocol + evidence pipeline (artifacts, snapshots, protocol-level evidence enforcement), tool registry over the semantic layer, **Tracking/Data Agent first** (health gate + daily health review — it has the smallest blast radius and biggest trust payoff), then Intelligence Agent (with `decompose`, `correlate_events`, cohort/funnel primitives), then Growth Director (synthesis + Devil's Advocate). Playbooks: `tracking_break`, `roas_drop`, `cpi_spike`, `cohort_quality_shift`. Validation gate. Agent QA harness with golden datasets (Part 12) — built WITH the agents, not after.

**Exit criteria:** 20 historical incidents from design partners replayed; agents reach the (known) correct root cause in ≥ 70%, and **zero** fabricated numbers across all runs (validator catches = pass, publishes = fail); session cost p50 < $3, p95 < $10; sessions survive worker kill mid-debate and resume.

## Phase 4 — War Room (Weeks 18–24, overlaps 3)

Full session UI: list, three-pane session view, phase-grouped thread, contention cards, Evidence Inspector (with re-run & drift diff), decision panel, live SSE streaming + replay, ask-the-room directives, session export, abstracts. Creative Agent + creative intelligence center (fatigue curves, hook maps, briefs) and playbooks `creative_fatigue`, `scale_opportunity`.

**Exit criteria:** design partners run ≥ 3 real investigations/week unprompted; a skeptical-user test (their most senior analyst tries to break it for an hour) produces zero ungrounded claims; "I understood the session in ≤ 60 seconds from the abstract + decision panel" ≥ 80% in user tests.

## Phase 5 — Approval & action layer (Weeks 23–28, overlaps 4)

Operations Agent, action drafts with diffs/payloads/plans, guardrail engine, approval policies + flows (web + Slack), action versioning/modify/expiry + evidence-drift revalidation, dry-run via Meta/Google adapters (validate-only), monitoring-plan arming, predicted-vs-realized outcome jobs, recommendation stats/calibration page, `budget_rebalance_weekly` + `paywall_experiment_readout` playbooks.

**Exit criteria:** ≥ 70% of published recommendations approved (any form) by partners; ≥ 50% approved **without modification**; every approved action's diff matched platform reality at approval time (drift checks logged); zero guardrail bypasses in adversarial QA; full causal chain reconstructable from audit log for 100% of actions.

## Phase 6 — Execution integrations (Weeks 27–34)

Adapter `execute/verify/rollback` for Meta + Google (sandbox-tested, then scoped-credential upgrade per consenting tenant), outbox→execution worker, idempotency + pre-execution drift checks, auto-revert pipeline, kill switch, AppsFlyer audience sync execution, TikTok execution, CRM adapter v1 (Braze or OneSignal — pick by design-partner stack), executed-action verification dashboards. **One-click execute of approved actions replaces "copy this into Ads Manager."**

**Exit criteria:** 50 consecutive production executions with zero unintended changes (verified by read-back) across 2+ tenants; rollback fire-drill passes in production conditions; a deliberately induced verify-failure auto-reverts correctly; platform API version upgrade playbook documented and rehearsed.

## Phase 7 — SaaS readiness (Weeks 33–40, overlaps 6)

Self-serve onboarding (connector OAuth flows hardened, guided taxonomy mapping, backfill UX), billing (Stripe: platform tier + usage metering from cost ledger), plan limits/feature flags, SSO/SAML, SOC 2 Type I audit kickoff (controls exist since Phase 0 — this is evidence collection), security review + pentest, rate limiting/quotas, status page, docs + public API guides, ASO insights module v1, multi-app tenants, agency multi-tenant UX (tenant switcher, cross-tenant user management), data-deletion/retention automation (GDPR).

**Exit criteria:** a stranger tenant onboards to first-insight without human help in < 1 day (measured with 3 beta customers); pentest highs/criticals = 0 open; billing reconciles to the penny against ledger; 10 paying tenants stable.

## Phase 8 — Autonomous mode (Weeks 40–52+)

L3 rollout: per-kind eligibility engine (track-record gates from Part 10.6), undo-window UX, notification rituals, weekly human-review surface; then L4 for budget changes within guardrails at consenting tenants; cross-tenant pattern intelligence v1 (privacy-safe benchmarks/priors); playbook auto-tuning proposals; insurance/legal framework for autonomous spend; the system's own "autonomy eligibility report" as the upgrade sales motion.

**Exit criteria (L3):** 30 days of auto-executed small actions at 3+ tenants with realized-impact calibration error < 15% and zero guardrail incidents; undo used < 5% of actions. **L4 gate:** board-level decision with design partners' written consent, contractual liability framework, and a quarter of L3 evidence.

---

## Timeline summary

| Phase | Calendar | Headline deliverable |
|---|---|---|
| 0 Foundation | W1–3 | Multi-tenant spine, auth, RBAC, audit, observability |
| 1 Data layer | W3–9 | SSOT: 5 connectors, semantic layer, reconciliation |
| 2 Command Center | W8–13 | 10-second dashboard + statistical Signals (wedge) |
| 3 Agent layer | W12–19 | Tracking + Intelligence + Director agents, 4 playbooks |
| 4 War Room | W18–24 | Full debate UX + Creative Agent |
| 5 Approval/Action | W23–28 | Prepared actions, guardrails, approvals, calibration |
| 6 Execution | W27–34 | One-click execute, verify, rollback (Meta/Google first) |
| 7 SaaS readiness | W33–40 | Self-serve, billing, SOC 2 I, 10 tenants |
| 8 Autonomy | W40–52+ | L3 → L4 ladder with evidence-gated unlocks |

~7 months to revenue-grade product (end of Phase 5), ~9 months to execution, ~12 months to autonomy. Anyone promising this scope materially faster is cutting the exact corners (data correctness, agent QA, guardrails) that this product cannot survive cutting.
