#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Run one load-test configuration end to end:
#   ./experiment.sh <label> [pool_max|default] [synchronous_commit on|off] [loadgen args...]
# Restarts the server (pool override only when pool_max is a number), sets
# Postgres synchronous_commit, checkpoints, then runs the concurrency ramp.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=$1; POOL=${2:-default}; SYNC=${3:-on}
shift; [ $# -gt 0 ] && shift; [ $# -gt 0 ] && shift
STATE_DIR=${VACUNA_STATE_DIR:-"$HERE/.state"}
export VACUNA_STATE_DIR="$STATE_DIR"

# Only this checkout's server: sibling worktrees may run their own copy.
pkill -f "$HERE/serve.ts" 2>/dev/null || true
while lsof -nP -iTCP:7663 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done

"$HERE/db.sh" psql -q -c "ALTER SYSTEM SET synchronous_commit = '$SYNC'" -c "SELECT pg_reload_conf()" >/dev/null

if [ "$POOL" != "default" ]; then
  export VACUNA_PG_POOL_MAX="$POOL"
  export VACUNA_NODE_FLAGS="--import $HERE/experiment-pool-override.ts"
fi
nohup "$HERE/start-server.sh" >"$STATE_DIR/server-$LABEL.log" 2>&1 &
until curl -sf http://127.0.0.1:7663/.well-known/oauth-protected-resource >/dev/null; do sleep 1; done
sleep 5  # let post-listen startup tasks finish

"$HERE/db.sh" psql -q -c "CHECKPOINT" >/dev/null
cd "$HERE"
node loadgen.ts --label "$LABEL" "$@"
