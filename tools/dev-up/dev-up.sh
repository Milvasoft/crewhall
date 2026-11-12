#!/usr/bin/env bash
# Local development in one command (bash, Git Bash on Windows, macOS, Linux):
#   tools/dev-up/dev-up.sh [--no-seed] [--no-web] [--down]
# 1. starts Postgres, SeaweedFS and Mailpit (docker/compose.dev.yml, ports from docker/.env)
# 2. creates apps/backend/.env and apps/web/.env.local from the examples when missing
# 3. installs dependencies when node_modules is missing
# 4. seeds the sample org (migrations included; skipped when an org exists)
# 5. runs the api (with the job worker in-process), collab and the web dev server until Ctrl+C
# Ports, database and URLs come from those .env files: edit them, not this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SEED=1
WEB=1
for arg in "$@"; do
  case "$arg" in
    --no-seed) SEED=0 ;;
    --no-web) WEB=0 ;;
    --down)
      docker compose -f docker/compose.dev.yml $( [ -f docker/.env ] && echo --env-file docker/.env ) down
      exit 0
      ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1;33m› %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
if ! command -v pnpm >/dev/null; then
  # Windows: corepack installs pnpm under %APPDATA%\npm, outside Git Bash's PATH.
  [ -d "${APPDATA:-}/npm" ] && export PATH="$PATH:$(cygpath -u "$APPDATA" 2>/dev/null || echo "$APPDATA")/npm"
fi
command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable)" >&2; exit 1; }

ENV_FILE=()
[ -f docker/.env ] && ENV_FILE=(--env-file docker/.env)

say "Infrastructure (docker/compose.dev.yml)"
docker compose -f docker/compose.dev.yml "${ENV_FILE[@]}" up -d --wait

[ -f apps/backend/.env ] || { say "apps/backend/.env from the example"; cp apps/backend/.env.example apps/backend/.env; }
if [ ! -f apps/web/.env.local ]; then
  say "apps/web/.env.local from the example"
  # Without the proxy lines: the targets below follow the api's port.
  grep -vE '^VITE_(API|COLLAB)_PROXY=' apps/web/.env.example > apps/web/.env.local
fi

if [ ! -d node_modules ]; then
  say "Dependencies"
  pnpm install --frozen-lockfile
fi

if [ "$SEED" = 1 ]; then
  say "Seed (migrations + sample org; skipped when an org exists)"
  pnpm --filter @crewhall/backend seed
fi

# Value of KEY in an env file (last one wins), empty when missing.
env_value() { grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r"' || true; }

# Collab (pages, card descriptions, drawings) listens next to the api unless .env says otherwise:
# api 3000 → collab 3001, api 4100 → collab 4101. The api reads the same COLLAB_PORT for its
# internal calls, and the web dev server proxies /collab to it.
API_PORT="$(env_value apps/backend/.env PORT)"
API_PORT="${API_PORT:-3000}"
COLLAB_PORT="$(env_value apps/backend/.env COLLAB_PORT)"
export COLLAB_PORT="${COLLAB_PORT:-$((API_PORT + 1))}"
# The web dev server listens where the backend's HUB_URL points (its origin for CORS, cookies
# and e-mail links): http://localhost:4411 → 4411. Default 5173.
HUB_URL_VALUE="$(env_value apps/backend/.env HUB_URL)"
WEB_PORT="$(printf '%s' "$HUB_URL_VALUE" | sed -nE 's#^https?://[^/:]+:([0-9]+).*#\1#p')"
WEB_PORT="${WEB_PORT:-5173}"
WEB_API_PROXY="$(env_value apps/web/.env.local VITE_API_PROXY)"
export VITE_API_PROXY="${WEB_API_PROXY:-http://localhost:$API_PORT}"
WEB_COLLAB_PROXY="$(env_value apps/web/.env.local VITE_COLLAB_PROXY)"
export VITE_COLLAB_PROXY="${WEB_COLLAB_PROXY:-http://localhost:$COLLAB_PORT}"

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  say "Stopping api, collab and web (infrastructure keeps running; --down stops it)"
  for pid in "${PIDS[@]}"; do
    # Whole trees: pnpm starts tsx/vite, which start node again.
    if [ -r "/proc/$pid/winpid" ] && command -v taskkill >/dev/null; then
      taskkill //PID "$(cat "/proc/$pid/winpid")" //T //F >/dev/null 2>&1 || true
    fi
    kill "$pid" 2>/dev/null || true
  done
  # macOS / Linux: everything started here shares this script's process group.
  [ -r /proc/self/winpid ] || kill -- -$$ 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

say "api on :$API_PORT (apps/backend/.env)"
pnpm --filter @crewhall/backend dev &
PIDS+=($!)

say "collab on :$COLLAB_PORT"
pnpm --filter @crewhall/backend dev:collab &
PIDS+=($!)

if [ "$WEB" = 1 ]; then
  say "web on :$WEB_PORT (/api → $VITE_API_PROXY, /collab → $VITE_COLLAB_PROXY)"
  # PORT for vite only: the api reads its own PORT from apps/backend/.env.
  PORT="$WEB_PORT" pnpm --filter @crewhall/web dev &
  PIDS+=($!)
fi

say "Running. Ctrl+C stops api, collab and web."
wait
