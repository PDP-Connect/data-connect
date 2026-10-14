#!/bin/sh
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Start the PDPP reference server against the local load-test Postgres.
# Only env vars the server already reads are set; no .env file is loaded.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
RI="$HERE/../../../reference-implementation"
STATE_DIR=${VACUNA_STATE_DIR:-"$HERE/.state"}
mkdir -p "$STATE_DIR"
cd "$RI"
exec env -u PDPP_OWNER_PASSWORD -u PDPP_OWNER_TOKEN -u PDPP_OWNER_SUBJECT_ID \
  PDPP_STORAGE_BACKEND=postgres \
  PDPP_DATABASE_URL="${VACUNA_DATABASE_URL:-postgres://pdpp:pdpp@localhost:55432/pdpp}" \
  AS_PORT="${AS_PORT:-7662}" RS_PORT="${RS_PORT:-7663}" \
  PDPP_DB_PATH="$STATE_DIR/pdpp.sqlite" \
  PDPP_SEMANTIC_EMBEDDING_BACKEND=disabled \
  PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
  PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1 \
  PDPP_RECONCILE_POLYFILL_MANIFESTS=0 \
  PDPP_RUNTIME_QUIET=1 \
  node ${VACUNA_NODE_FLAGS:-} "$HERE/serve.ts"
