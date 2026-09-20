#!/usr/bin/env bash
# Generate the non-sensitive release marker (VERSION).
#
# The plain-Node.js fixture has no compile step, so this script only writes
# the marker consumed by /api/meta and the UI footer.
#
# Resolution order for the marker:
#   1. $BUILD_MARKER (explicit), e.g. BUILD_MARKER=v1.2.3
#   2. latest git short SHA at the checkout
#   3. current UTC date as a fallback
#
# The marker is intentionally not secret; database paths and environment
# values stay out of the repository (see .env.example).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/VERSION"

if [ -n "${BUILD_MARKER:-}" ]; then
  MARKER="$BUILD_MARKER"
elif sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"; then
  MARKER="$sha"
else
  MARKER="build-$(date -u +%Y%m%d-%H%M%S)"
fi

printf '%s\n' "$MARKER" > "$OUT"
printf 'VERSION = %s\n' "$MARKER"