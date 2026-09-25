#!/usr/bin/env bash
# DR citizen-assistant demo runner.
#
#   scripts/demo-dr/demo.sh seed                 # load the fictitious SIUBEN + INTRANT records (once)
#   scripts/demo-dr/demo.sh start [PUBLIC_ORIGIN] # run reference server + console on one origin
#   scripts/demo-dr/demo.sh reset                # delete the demo database
#
# PUBLIC_ORIGIN is the tunnel URL (e.g. https://abc.trycloudflare.com). Without
# it the demo runs on http://localhost:3000 only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="${DEMO_DR_DATA_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pdpp-demo-dr}"
export PDPP_DB_PATH="$DATA_DIR/pdpp.sqlite"
export PDPP_INSTANCE_NAME="${PDPP_INSTANCE_NAME:-Asistente Ciudadano · demo PDPP}"
WEB_PORT="${PDPP_WEB_PORT:-3000}"
PIDS=()

# Stop each background job and its descendants (npm -> sh -> node / next).
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_for() {
  local url="$1" tries=90
  until curl -fsS -o /dev/null "$url" 2>/dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "timed out waiting for $url" >&2
      exit 1
    fi
    sleep 2
  done
}

cmd_seed() {
  mkdir -p "$DATA_DIR"
  echo "Starting reference server without a password to load demo records…"
  (cd "$ROOT/reference-implementation" && env -u PDPP_OWNER_PASSWORD npm run -s server) >"$DATA_DIR/seed-server.log" 2>&1 &
  PIDS+=("$!")
  wait_for "http://localhost:7662/.well-known/oauth-authorization-server"
  (cd "$ROOT/reference-implementation" && npm run -s cli -- seed --connector siuben,intrant)
  echo "Seeded. Now run: $0 start [PUBLIC_ORIGIN]"
}

cmd_start() {
  local origin="${1:-http://localhost:$WEB_PORT}"
  if [ -z "${PDPP_OWNER_PASSWORD:-}" ]; then
    echo "Set PDPP_OWNER_PASSWORD (this is the password typed on the Cuenta Única-style page)." >&2
    exit 1
  fi
  if [ ! -f "$PDPP_DB_PATH" ]; then
    echo "No demo database at $PDPP_DB_PATH. Run: $0 seed" >&2
    exit 1
  fi
  export PDPP_REFERENCE_ORIGIN="$origin"
  local host
  host="$(printf '%s' "$origin" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  # The console proxies to the reference server over loopback and forwards the
  # public Host in x-forwarded-host; trust that hop, and keep localhost usable.
  export PDPP_TRUSTED_HOSTS="${PDPP_TRUSTED_HOSTS:-$host,localhost}"
  export PDPP_TRUSTED_PROXIES="${PDPP_TRUSTED_PROXIES:-127.0.0.1,::1}"

  (cd "$ROOT/reference-implementation" && npm run -s dev) >"$DATA_DIR/reference.log" 2>&1 &
  PIDS+=("$!")
  (cd "$ROOT/apps/console" && npm run -s dev) >"$DATA_DIR/console.log" 2>&1 &
  PIDS+=("$!")

  wait_for "http://localhost:$WEB_PORT/.well-known/oauth-protected-resource/mcp"
  cat <<EOF

Demo running.
  Origin:        $origin
  MCP endpoint:  $origin/mcp      <- add this as the connector URL in Claude / ChatGPT
  Grants (log):  $origin/grants   <- citizen's view of every grant and read; revoke here
  Logs:          $DATA_DIR/{reference,console}.log

Ctrl-C to stop.
EOF
  wait
}

cmd_reset() {
  rm -f "$PDPP_DB_PATH" "$PDPP_DB_PATH"-*
  echo "Removed $PDPP_DB_PATH. Run: $0 seed"
}

case "${1:-}" in
  seed) cmd_seed ;;
  start) shift; cmd_start "$@" ;;
  reset) cmd_reset ;;
  *)
    sed -n '2,9p' "$0"
    exit 1
    ;;
esac
