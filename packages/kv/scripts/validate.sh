#!/usr/bin/env bash
#
# Brings up a throwaway Valkey and runs every Lua script against it.
#
# Usage:  bun run validate:kv
#         ./scripts/validate.sh --keep   leaves the server running afterwards
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    printf 'Server kept running. Stop it with: docker compose down -v\n'
  else
    printf 'Tearing down.\n'
    docker compose down -v >/dev/null 2>&1
  fi
}
trap cleanup EXIT

printf '==> Starting Valkey\n'
docker compose up -d --wait || { echo "compose up failed"; exit 1; }

REDIS_URL="${REDIS_URL:-redis://localhost:6379}" bun run scripts/validate.ts
