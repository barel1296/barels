#!/usr/bin/env bash
# One-command demo stack: infra → schemas → seed → api + web + worker.
# Used by `make demo` (local machines and GitHub Codespaces alike).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

echo "── starting infrastructure (postgres, clickhouse, redis) ──"
docker compose -f infra/docker-compose.dev.yml up -d
for i in $(seq 1 60); do
  bash scripts/check-infra.sh >/dev/null 2>&1 && break
  sleep 2
  [ "$i" = 60 ] && { echo "infra did not become healthy"; exit 1; }
done
echo "infra healthy ✓"

echo "── applying schemas ──"
pnpm db:migrate
(cd workers/py && uv run python -m gros_workers.chmigrate)

echo "── seeding demo data ──"
pnpm db:seed || true
(cd workers/py && uv run python -m gros_workers.seed.generate) || true

echo "── starting services ──"
mkdir -p var/log
(cd apps/api && nohup node -r ts-node/register/transpile-only src/main.ts \
  > ../../var/log/api.log 2>&1 &)
(cd workers/py && nohup uv run python -m gros_workers.main \
  > ../../var/log/worker.log 2>&1 &)
(cd apps/web && nohup pnpm dev > ../../var/log/web.log 2>&1 &)

for i in $(seq 1 30); do
  curl -fsS localhost:3001/healthz >/dev/null 2>&1 && break
  sleep 2
done

cat <<'MSG'

──────────────────────────────────────────────────────────────
GROS demo stack is running:

  web     http://localhost:3000   (Codespaces: open the PORTS
                                   tab and click the port-3000
                                   globe icon for the URL)
  api     http://localhost:3001/healthz
  login   demo@gros.dev / demo-password-123
  logs    var/log/{api,web,worker}.log

Look at: Command Center → War Room ("ROAS drop — Germany /
Google") → open evidence chips → Approvals → approve an action.
──────────────────────────────────────────────────────────────
MSG
