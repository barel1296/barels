#!/usr/bin/env bash
# One-command demo stack: infra → schemas → seed → api + web.
# Used by `make demo` (local machines and GitHub Codespaces alike).
# Self-diagnosing: every step verifies itself and prints logs on failure.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
mkdir -p var/log

fail() {
  echo ""
  echo "✗ DEMO FAILED at: $1"
  shift
  for log in "$@"; do
    if [ -f "$log" ]; then
      echo "── last 30 lines of $log ──"
      tail -30 "$log"
    fi
  done
  echo ""
  echo "Paste the output above to get this fixed."
  exit 1
}

step() { echo ""; echo "── $1 ──"; }

step "checking toolchain"
command -v docker >/dev/null || fail "docker not found (install Docker / use a Codespace)"
command -v pnpm >/dev/null || fail "pnpm not found — run: bash .devcontainer/setup.sh"
command -v uv >/dev/null || fail "uv not found — run: bash .devcontainer/setup.sh"
node -v

step "stopping any previous demo processes"
pkill -f "ts-node/register" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "gros_workers.main" 2>/dev/null || true
sleep 1

step "starting infrastructure (postgres, clickhouse, redis)"
docker compose -f infra/docker-compose.dev.yml up -d || fail "docker compose up"
healthy=""
for i in $(seq 1 60); do
  if bash scripts/check-infra.sh >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  # check-infra needs psql/redis-cli on the host; fall back to direct probes
  PG_OK=$(docker compose -f infra/docker-compose.dev.yml exec -T postgres \
            pg_isready -U gros -d gros >/dev/null 2>&1 && echo 1 || echo "")
  CH_OK=$(curl -fsS localhost:8123/ping >/dev/null 2>&1 && echo 1 || echo "")
  [ -n "$PG_OK" ] && [ -n "$CH_OK" ] && healthy=1
fi
[ -n "$healthy" ] || fail "infrastructure did not become healthy"
echo "infra healthy ✓"

step "ensuring dependencies are installed"
[ -d node_modules ] || pnpm install || fail "pnpm install"
[ -d workers/py/.venv ] || (cd workers/py && uv sync --all-extras) || fail "uv sync"

step "building the shared package (@gros/shared)"
pnpm --filter @gros/shared build > var/log/shared-build.log 2>&1 \
  || fail "shared package build" var/log/shared-build.log

step "applying Postgres migrations"
pnpm db:migrate > var/log/migrate.log 2>&1 || fail "postgres migrations" var/log/migrate.log
step "applying ClickHouse schema"
(cd workers/py && uv run python -m gros_workers.chmigrate) \
  > var/log/chmigrate.log 2>&1 || fail "clickhouse schema" var/log/chmigrate.log

step "seeding demo data"
pnpm db:seed > var/log/seed-pg.log 2>&1 || true
(cd workers/py && uv run python -m gros_workers.seed.generate) \
  > var/log/seed-ch.log 2>&1 || fail "demo data seed" var/log/seed-ch.log var/log/seed-pg.log

step "starting the API"
(cd apps/api && nohup node -r ts-node/register/transpile-only src/main.ts \
  > ../../var/log/api.log 2>&1 &)
api_ok=""
for i in $(seq 1 45); do
  curl -fsS localhost:3001/healthz >/dev/null 2>&1 && { api_ok=1; break; }
  sleep 2
done
[ -n "$api_ok" ] || fail "API did not become healthy on :3001" var/log/api.log
echo "api healthy ✓"

step "running detection once (risk signals for the Command Center)"
(cd workers/py && uv run python -c "
from gros_workers.detection.runner import run_detection_for_tenant
print('anomalies:', run_detection_for_tenant('aaaaaaaa-0000-4000-8000-000000000001'))
") >> var/log/seed-ch.log 2>&1 || true

step "starting the web app"
(cd apps/web && nohup pnpm dev > ../../var/log/web.log 2>&1 &)
web_ok=""
for i in $(seq 1 45); do
  curl -fsS localhost:3000/login >/dev/null 2>&1 && { web_ok=1; break; }
  sleep 2
done
[ -n "$web_ok" ] || fail "web did not become reachable on :3000" var/log/web.log

cat <<'MSG'

──────────────────────────────────────────────────────────────
✓ GROS demo stack is RUNNING

  In Codespaces: open the PORTS tab → port 3000 → globe icon
  ("Open in Browser"). Locally: http://localhost:3000

  login   demo@gros.dev / demo-password-123
  logs    var/log/{api,web,migrate,seed-ch}.log

  Tour: Command Center → War Room ("ROAS drop — Germany /
  Google") → click the highlighted numbers (evidence) →
  Approvals → approve an action.

  Optional (live agent investigations): add ANTHROPIC_API_KEY
  to .env and run `make worker` in a second terminal.
──────────────────────────────────────────────────────────────
MSG
