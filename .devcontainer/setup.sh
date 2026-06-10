#!/usr/bin/env bash
# Codespace bootstrap: installs toolchains and JS/Python deps.
set -euo pipefail

echo "── installing pnpm + uv ──"
corepack enable || sudo corepack enable || npm i -g pnpm@10
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

echo "── installing dependencies ──"
pnpm install
(cd workers/py && uv sync --all-extras)

cp -n .env.example .env || true

cat <<'MSG'

──────────────────────────────────────────────────────────────
GROS codespace is ready. To start the full demo stack, run:

    make demo

then open the forwarded port 3000 (the PORTS tab → globe icon),
and log in with  demo@gros.dev / demo-password-123
──────────────────────────────────────────────────────────────
MSG
