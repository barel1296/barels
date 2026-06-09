#!/usr/bin/env bash
# Asserts local dev infrastructure is up and healthy.
set -euo pipefail

fail=0

check() {
  local name="$1" cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "✓ $name"
  else
    echo "✗ $name"
    fail=1
  fi
}

check "postgres"   "PGPASSWORD=gros psql -h localhost -U gros -d gros -c 'select 1'"
check "clickhouse" "curl -fsS 'http://localhost:8123/ping'"
check "redis"      "redis-cli -u redis://localhost:6379 ping"

exit $fail
