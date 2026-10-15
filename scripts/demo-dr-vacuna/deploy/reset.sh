#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Full reset of the walkthrough: every grant, review, audit row and reminder
# record is wiped and the fixed dataset is seeded again. It asks the next boot
# to reset (marker file /data/reset-requested, read by portal/server.ts) and
# restarts the app.
#
#   scripts/demo-dr-vacuna/deploy/reset.sh fly       [APP=vacuna-al-dia-demo]
#   scripts/demo-dr-vacuna/deploy/reset.sh compose   (local docker compose)
set -eu
MODE=${1:-fly}
HERE=$(cd "$(dirname "$0")" && pwd)

wait_ready() {
  url=$1
  tries=60
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 200 ]; do
    tries=$((tries - 1))
    [ "$tries" -le 0 ] && { echo "timed out waiting for $url" >&2; exit 1; }
    sleep 3
  done
}

case "$MODE" in
  fly)
    APP=${APP:-vacuna-al-dia-demo}
    fly ssh console --app "$APP" -C "touch /data/reset-requested"
    fly apps restart "$APP"
    wait_ready "https://$APP.fly.dev/healthz"
    ;;
  compose)
    COMPOSE="docker compose -f $HERE/docker-compose.yml"
    $COMPOSE exec app touch /data/reset-requested
    $COMPOSE restart app
    wait_ready "http://localhost:${HOST_PORT:-8080}/healthz"
    ;;
  *)
    echo "usage: $0 fly|compose" >&2
    exit 2
    ;;
esac
echo "Reset done."
