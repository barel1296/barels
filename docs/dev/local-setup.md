# Local Setup Guide

## Prerequisites

- Node 22+, pnpm 10+
- Python 3.11+, [uv](https://docs.astral.sh/uv/)
- Docker (for Postgres 16, ClickHouse 24, Redis 7)

## First run

```bash
# 1. Dependencies
pnpm install
cd workers/py && uv sync --all-extras && cd ../..

# 2. Environment
cp .env.example .env          # dev defaults work out of the box

# 3. Infrastructure
make infra-up                 # postgres + clickhouse + redis
make check-infra              # asserts all three are healthy

# 4. Schemas
make migrate                  # Postgres migrations + ClickHouse schema

# 5. Dev data (DEV-ONLY synthetic dataset + demo War Room session)
make seed
# prints: demo@gros.dev / demo-password-123 and an ingest API key

# 6. Run (three terminals)
make dev-api                  # NestJS API on :3001
make dev-web                  # Next.js on :3000
make worker                   # Python worker (jobs: sessions, detection)
```

Open http://localhost:3000 → log in with the demo credentials → Command
Center. The seeded War Room session ("ROAS drop — Germany / Google") shows the
full debate → decision → prepared-actions flow with two actions awaiting
approval.

## Notes

- **Two Postgres roles.** The app connects as `gros_app` (non-superuser, RLS
  enforced); migrations/seeds run as the owner (`DATABASE_URL_OWNER`). The
  bootstrap `POSTGRES_USER` is a superuser and would silently bypass RLS —
  never point `DATABASE_URL` at it.
- **LLM keys are optional for the demo.** The seeded session was produced
  through the real pipeline with the eval-mode scripted provider. Live agent
  sessions (`War Room → Investigate`) require `ANTHROPIC_API_KEY` (and/or
  `OPENAI_API_KEY` as failover) in `.env` — without a provider, agents fail
  loudly by design; there is no fake fallback.
- **First-party event ingestion:**
  ```bash
  curl -X POST localhost:3001/v1/ingest/events \
    -H "X-Api-Key: <printed by seed>" -H "content-type: application/json" \
    -d '{"events":[{"eventName":"session_start","eventTime":"2026-06-09T12:00:00Z",
         "userId":"u1","appId":"aaaaaaaa-0000-4000-8000-000000000003"}]}'
  ```
  Unknown event names are quarantined (visible in Tracking Health), never
  silently dropped.

## QA commands

```bash
make qa            # everything below
pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd workers/py && uv run ruff check . && uv run mypy gros_workers && uv run pytest -q
```
