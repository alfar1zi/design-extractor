#!/usr/bin/env bash
# install.sh - one-shot setup for design-extractor on macOS / Linux.
# Idempotent. Verifies Node 20+, installs from the lockfile, downloads Chromium, runs tests.

set -eu

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

# Step 1: verify Node 20+. This must match package.json `engines.node`; the
# resolved playwright requires it, and a Node 18 install fails later with a
# stack trace that says nothing about the real cause.
NODE_RAW="$(node -p "process.versions.node" 2>/dev/null || true)"
[ -n "$NODE_RAW" ] || fail "Node not found on PATH. Install Node 20+ from https://nodejs.org/"
NODE_MAJOR="$(printf "%s" "$NODE_RAW" | cut -d. -f1)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "Could not parse Node version: '$NODE_RAW'";;
esac
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $NODE_RAW found. Need 20.0.0 or newer. Get it at https://nodejs.org/"
ok "Node $NODE_RAW (>= 20)"

# Resolve repo root (directory containing this script).
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
dim "Repo: $REPO_ROOT"

# Step 2: install dependencies. A lockfile is what makes the install reproducible
# and it is what CI uses, so the installer uses it too; `npm install` is the
# fallback for a checkout that somehow lost it.
if [ -f package-lock.json ]; then
  say "==> npm ci"
  npm ci --no-audit --no-fund
else
  say "==> npm install (no package-lock.json)"
  npm install --no-audit --no-fund
fi

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
ok "  npx design-extractor-save --url https://... --out ./refs/foo"
ok "  npx design-extractor-inspect --url https://... --out ./refs/foo/live --viewport 1440x900"
ok "  npx design-extractor <url>"
ok "=========================================="

# Step 6: point agent at the skill file. The skill lives in the plugin layout,
# not at the repo root, and an installer that prints a path that does not exist
# costs the reader the one step it was meant to save.
ok "SKILL.md: ${REPO_ROOT}/skills/design-extractor/SKILL.md: point your agent at this file"
