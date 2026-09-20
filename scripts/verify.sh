#!/usr/bin/env bash
# Full verification for the Node.js taskboard fixture:
#
#   1. scripts/build.sh -> release marker (VERSION)
#   2. clean install -> rm -rf node_modules && npm ci (frozen lockfile)
#   3. syntax check -> npm run check (node --check on src/ and public/)
#   4. node --test tests/ (unit/integration suite)
#   5. scripts/smoke.sh -> real production process: CRUD, invalid input,
#      search/filter, restart persistence, database-unavailable readiness
#
# Usage:
#   scripts/verify.sh
#
# Exit codes: 0 = all checks passed, nonzero = a check failed. The first
# failing step aborts with its own nonzero code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
NPM="${NPM:-$(command -v npm)}"
[ -x "$NODE" ] || { echo "node executable not found" >&2; exit 1; }
[ -x "$NPM" ] || { echo "npm executable not found" >&2; exit 1; }

step() { printf '\n=== %s ===\n' "$*"; }

step "build release marker"
"$ROOT/scripts/build.sh"

step "clean install with frozen lockfile"
rm -rf "$ROOT/node_modules"
(cd "$ROOT" && "$NPM" ci --no-audit --no-fund)

step "syntax check (src + public)"
(cd "$ROOT" && "$NPM" run --silent check)

step "test suite (node --test tests)"
(cd "$ROOT" && "$NODE" --test "tests/*.test.js")

step "production smoke: real process + CRUD + negatives + persistence + readiness"
"$ROOT/scripts/smoke.sh"

step "verification complete (all steps passed)"
printf '%s\n' "node: $("$NODE" --version)"
printf '%s\n' "npm: $("$NPM" --version)"
printf '%s\n' "better-sqlite3: $(cd "$ROOT" && node -p "require('better-sqlite3/package.json').version")"
printf '%s\n' "node_modules installed: $([ -d "$ROOT/node_modules" ] && echo yes || echo no)"
printf '%s\n' "release marker: $(cat "$ROOT/VERSION")"