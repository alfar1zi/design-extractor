#!/usr/bin/env bash
# install.sh - one-shot setup for design-extractor on macOS / Linux.
# Idempotent. Verifies Node 18+, runs npm install, downloads Chromium, runs tests.

set -e

# TTY-gated color (respect NO_COLOR).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[1;32m'; C_DIM=$'\033[0;90m'; C_ERR=$'\033[1;31m'; C_RST=$'\033[0m'
else
  C_OK=""; C_DIM=""; C_ERR=""; C_RST=""
fi
say()  { printf "%b\n" "$*"; }
ok()   { say "${C_OK}$*${C_RST}"; }
dim()  { say "${C_DIM}$*${C_RST}"; }
fail() { say "${C_ERR}$*${C_RST}" >&2; exit 1; }

# Step 1: verify Node 18+.
NODE_RAW="$(node -p "process.versions.node" 2>/dev/null || true)"
[ -n "$NODE_RAW" ] || fail "Node not found on PATH. Install Node 18+ from https://nodejs.org/"
NODE_MAJOR="$(printf "%s" "$NODE_RAW" | cut -d. -f1)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "Could not parse Node version: '$NODE_RAW'";;
esac
[ "$NODE_MAJOR" -ge 18 ] || fail "Node $NODE_RAW found. Need 18.0.0 or newer. Get it at https://nodejs.org/"
ok "Node $NODE_RAW (>= 18)"

# Resolve repo root (directory containing this script).
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
dim "Repo: $REPO_ROOT"

# Step 2: npm install.
say "==> npm install"
npm install --no-audit --no-fund

# Step 3: download Chromium for Playwright (slowest step on first run).
say "==> npm run install:browsers (first run can take 1-3 min)"
npm run install:browsers

# Step 4: smoke tests.
say "==> npm test"
npm test

# Step 5: final banner.
ok ""
ok "=========================================="
ok "design-extractor installed."
ok "Try these commands:"
ok "  npx design-extractor-find --prompt \"...\" --count 5"
ok "  npx design-extractor-save --url https://... --out ./refs/foo"
ok "  npx design-extractor-inspect --url https://... --out ./refs/foo/live --viewport 1440x900"
ok "  npx design-extractor <url>"
ok "=========================================="

# Step 6: point agent at the skill file.
ok "SKILL.md: ${REPO_ROOT}/SKILL.md -- point your agent at this file"
