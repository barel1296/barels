#!/usr/bin/env bash
# Stops the dashboard demo started by start.sh (the platform process and the simulators with it).
# The demo database is kept until the next start (which recreates it) or until the dev container
# or Codespace is deleted.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${DEMO_OUT:-$root/.demo}"
if [ ! -f "$out/demo.pid" ] || ! kill -0 "$(cat "$out/demo.pid")" 2>/dev/null; then
  echo "The demo is not running."
  rm -f "$out/demo.pid"
  exit 0
fi
pid="$(cat "$out/demo.pid")"
# start.sh runs the demo as a process-group leader: signal the whole group (demo, platform, simulators).
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
rm -f "$out/demo.pid"
echo "Demo stopped."
