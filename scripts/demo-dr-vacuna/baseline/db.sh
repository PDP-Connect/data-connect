#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Local Postgres for the load test: ./db.sh up | start | stop | down | psql [args]
set -eu
NAME=${VACUNA_PG_CONTAINER:-pdpp-vacuna-pg}
PORT=${VACUNA_PG_PORT:-55432}
case "${1:-up}" in
  up)
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" \
      -e POSTGRES_USER=pdpp -e POSTGRES_PASSWORD=pdpp -e POSTGRES_DB=pdpp \
      --shm-size=1g pgvector/pgvector:pg16 \
      -c max_connections=200 -c shared_buffers=1GB -c track_io_timing=on
    until docker exec "$NAME" pg_isready -U pdpp -q; do sleep 1; done
    ;;
  start)  # reuse a stopped, already-seeded container
    docker start "$NAME" >/dev/null
    until docker exec "$NAME" pg_isready -U pdpp -q; do sleep 1; done
    ;;
  stop) docker stop "$NAME" ;;
  down) docker rm -f "$NAME" ;;
  psql) shift; docker exec -i "$NAME" psql -U pdpp -d pdpp "$@" ;;
  *) echo "usage: $0 up|start|stop|down|psql" >&2; exit 2 ;;
esac
