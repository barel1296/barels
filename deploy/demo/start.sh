#!/usr/bin/env bash
# Starts the dashboard DEMO in the background: the real platform build on a separate demo database,
# with Telegram, Instagram, the LLM and ComfyUI SIMULATED (see README.md). Safe to run again.
#   DEMO_PG_ADMIN_URL=postgres://<superuser>:<pw>@127.0.0.1:5432/postgres deploy/demo/start.sh
# The dev container sets DEMO_PG_ADMIN_URL itself. Stop with deploy/demo/stop.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${DEMO_OUT:-$root/.demo}"
port="${DEMO_PORT:-8090}"
mkdir -p "$out"
chmod 700 "$out"
if [ -f "$out/demo.pid" ] && kill -0 "$(cat "$out/demo.pid")" 2>/dev/null; then
  echo "The demo is already running (pid $(cat "$out/demo.pid")). Stop it with deploy/demo/stop.sh"
  exit 0
fi
: "${DEMO_PG_ADMIN_URL:?set DEMO_PG_ADMIN_URL to a superuser URL of a DEVELOPMENT PostgreSQL on this machine}"
cd "$root/apps/platform"
[ -d node_modules ] || npm ci --no-audit --no-fund
[ -f dist/src/main.js ] || npm run build

echo "Waiting for PostgreSQL..."
for _ in $(seq 1 60); do
  if node -e "const pg=require('pg');const c=new pg.Client({connectionString:process.env.DEMO_PG_ADMIN_URL});c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 1
done

echo "Starting the demo (seeding takes about a minute)..."
# Its own session and process group, so it outlives this script (and the Codespaces start-up step)
# and stop.sh can end it together with the platform process it starts.
nohup setsid node --import tsx scripts/demo.ts --out "$out" --port "$port" --reset > "$out/demo.log" 2>&1 &
echo $! > "$out/demo.pid"
for _ in $(seq 1 300); do
  grep -q 'READY' "$out/demo.log" && break
  if ! kill -0 "$(cat "$out/demo.pid")" 2>/dev/null; then
    echo "The demo stopped during start-up:"; tail -20 "$out/demo.log"; rm -f "$out/demo.pid"; exit 1
  fi
  sleep 1
done
if ! grep -q 'READY' "$out/demo.log"; then echo "The demo did not become ready; see $out/demo.log"; exit 1; fi
cat <<MSG

Dashboard demo is ready on port $port (http://127.0.0.1:$port/admin/ on this machine;
in a Codespace, open the forwarded port $port from the Ports tab: it stays private to you).
  Sign-in email + password:  $out/demo-credentials.txt
  Current 6-digit code:      (cd apps/platform && npm run demo:totp -- --out "$out")
  Stop:                      deploy/demo/stop.sh
MSG
