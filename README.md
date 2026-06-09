# GROS — AI Growth Operating System

An Autonomous AI Growth Operating System for mid-size mobile game studios and
subscription app companies: five super-agents (Growth Director, Intelligence,
Operations, Creative, Tracking/Data) investigate growth problems in a visible
**War Room**, debate over inspectable evidence, and prepare executable actions
— budget shifts, campaign changes, creative rotations — behind a human
approval gate with diff-hash protection, full audit trails, and an
architecture built to graduate to supervised autonomy.

**Not a dashboard.** The unit of value is a concluded investigation with a
prepared, guard-checked, approvable action — every claim traceable to a frozen
evidence artifact.

## Repository layout

```
docs/                 Founding design specification (16 parts) + dev docs
packages/shared/      Protocol, permissions, evidence-binding contracts (TS)
apps/api/             NestJS API: auth, RBAC+RLS, audit, semantic metrics
                      layer, ingestion, War Room, approvals  (+ migrations)
apps/web/             Next.js: Command Center, War Room, Approvals, Health,
                      Creative Intelligence, Audit, Settings
workers/py/           Python plane: deterministic orchestrator, 5 super-agents,
                      LLM gateway, detection, guardrails, golden-incident evals
infra/                docker-compose (Postgres/ClickHouse/Redis), CH schema
```

## Quick start

```bash
pnpm install && (cd workers/py && uv sync --all-extras)
cp .env.example .env
make infra-up && make migrate && make seed
make dev-api    # :3001
make dev-web    # :3000  → demo@gros.dev / demo-password-123
make worker     # job consumer (sessions, detection)
```

Full guide: [docs/dev/local-setup.md](./docs/dev/local-setup.md)

## Documentation

- **Design spec:** [docs/README.md](./docs/README.md) — vision, principles,
  architecture, agents, War Room, data model, APIs, roadmap, QA, risks
- **Implementation:** [architecture notes](./docs/dev/architecture-notes.md) ·
  [testing guide](./docs/dev/testing.md) ·
  [known gaps](./docs/dev/known-gaps.md) ·
  [implementation report](./docs/dev/implementation-report.md)

## Hard guarantees in this build

1. **Evidence or it didn't happen** — agent claims without stored evidence are
   rejected at the protocol layer AND by a database trigger; the UI can only
   render numbers bound to evidence artifacts.
2. **Approval-first (autonomy level 2)** — approving an action requires
   echoing the hash of the exact diff you saw; nothing executes (no execution
   adapter exists in the codebase).
3. **Tenant isolation by Row-Level Security**, enforced for a non-superuser
   app role and verified live.
4. **LLM cost governance** — per-tenant hard budgets enforced before every
   call; sessions terminate honestly at their cap.
5. **Append-only audit** — UPDATE/DELETE on audit, evidence, messages,
   approvals are rejected at the database level.

## QA

`make qa` — eslint, tsc, jest/vitest (27 JS/TS tests), next build, ruff, mypy,
pytest (39 tests incl. the golden-incident harness with a release-blocking
zero-fabrication gate).
