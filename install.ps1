#!/usr/bin/env pwsh
# install.ps1 - one-shot setup for design-extractor on Windows / pwsh.
# Idempotent. Verifies Node 18+, runs npm install, downloads Chromium, runs tests.

$ErrorActionPreference = 'Stop'

# TTY-gated color (respect NO_COLOR).
$useColor = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
if ($useColor) {
    $C_OK = "`e[1;32m"; $C_DIM = "`e[0;90m"; $C_ERR = "`e[1;31m"; $C_RST = "`e[0m"
} else {
    $C_OK = ""; $C_DIM = ""; $C_ERR = ""; $C_RST = ""
}
function Say($msg)  { Write-Host "$msg" }
function Ok($msg)   { Say "${C_OK}${msg}${C_RST}" }
function Dim($msg)  { Say "${C_DIM}${msg}${C_RST}" }
function Fail($msg) { Say "${C_ERR}${msg}${C_RST}" ; exit 1 }

# Step 1: verify Node 18+.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node not found on PATH. Install Node 18+ from https://nodejs.org/"
}
$nodeRaw = node -p "process.versions.node"
if ($LASTEXITCODE -ne 0) { Fail "Could not read Node version." }
$nodeMajor = [int]($nodeRaw.Split('.')[0])
if ($nodeMajor -lt 18) { Fail "Node $nodeRaw found. Need 18.0.0 or newer. Get it at https://nodejs.org/" }
Ok "Node $nodeRaw (>= 18)"

# Resolve repo root (directory containing this script).
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
Dim "Repo: $repoRoot"

# Verify npm exists.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm not found on PATH. Install Node 18+ from https://nodejs.org/ (npm ships with Node)."
}

# Step 2: npm install.
Say "==> npm install"
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }

# Step 3: download Chromium for Playwright (slowest step on first run).
Say "==> npm run install:browsers (first run can take 1-3 min)"
& npm run install:browsers
if ($LASTEXITCODE -ne 0) { Fail "install:browsers failed." }

# Step 4: smoke tests.
Say "==> npm test"
& npm test
if ($LASTEXITCODE -ne 0) { Fail "Tests failed. Open the output above, fix the failure, and re-run install.ps1." }

# Step 5: final banner.
Ok ""
Ok "=========================================="
Ok "design-extractor installed."
Ok "Try these commands:"
Ok "  npx design-extractor-find --prompt ""..."" --count 5"
Ok "  npx design-extractor-save --url https://... --out ./refs/foo"
Ok "  npx design-extractor-inspect --url https://... --out ./refs/foo/live --viewport 1440x900"
Ok "  npx design-extractor <url>"
Ok "=========================================="

# Step 6: point agent at the skill file.
$skillPath = Join-Path $repoRoot "SKILL.md"
Ok "SKILL.md: $skillPath: point your agent at this file"
