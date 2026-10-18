#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Point the RI postgres profile at the private cluster that
# `test-sandbox --pg N` starts, then exec the command. `npm run test:postgres`
# uses it; nothing outside a sandbox should call it.
#
# The cluster lives in the sandbox's own network namespace, so binding
# 127.0.0.1:55447 there satisfies the dedicated-URL contract
# (test/helpers/dedicated-postgres-test-url.ts) without touching any listener
# on the host. Every database below dies with the run, including databases a
# killed test child created.
set -euo pipefail

if [[ -z "${TEST_SANDBOX_ACTIVE:-}" || -z "${PGPORT:-}" ]]; then
  echo "test-postgres-private.sh: run it through test-sandbox --pg (npm run test:postgres)" >&2
  exit 2
fi

psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres "$@"; }

# Use the client tools of the server's major version: the backup tests run
# pg_dump against this server.
major=$(psql_admin -Atc "SELECT current_setting('server_version_num')::int / 10000")
if [[ -d "/usr/lib/postgresql/$major/bin" ]]; then
  export PATH="/usr/lib/postgresql/$major/bin:$PATH"
fi

# The semantic tests need pgvector. Use the server's own copy when it has one;
# otherwise PDPP_TEST_PGVECTOR_ROOT may name an unpacked package tree, e.g.
#   apt-get download postgresql-18-pgvector && dpkg-deb -x postgresql-18-pgvector_*.deb <root>
# PostgreSQL 18 loads extensions from extra directories without a reinstall.
if ! psql_admin -Atc "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" | grep -q 1; then
  vector_root=${PDPP_TEST_PGVECTOR_ROOT:-}
  if [[ "$vector_root" != /* || ! -d "$vector_root/usr/share/postgresql/$major/extension" || "$major" -lt 18 ]]; then
    echo "test-postgres-private.sh: pgvector is not available to PostgreSQL $major." >&2
    echo "Install it for this server, or on PostgreSQL 18 set PDPP_TEST_PGVECTOR_ROOT to the absolute root of an unpacked package (see this script)." >&2
    exit 2
  fi
  psql_admin \
    -c "ALTER SYSTEM SET extension_control_path = '\$system:$vector_root/usr/share/postgresql/$major'" \
    -c "ALTER SYSTEM SET dynamic_library_path = '\$libdir:$vector_root/usr/lib/postgresql/$major/lib'" \
    -c "SELECT pg_reload_conf()" >/dev/null
fi

# Base and restore databases named inside the dedicated grammar. The runner
# allocates a fresh per-file database from the base for every test file.
base=pdpp_test
restore=pdpp_test_restore_00000000_0
psql_admin -c "CREATE DATABASE $base" -c "CREATE DATABASE $restore"
export PDPP_TEST_POSTGRES_URL="postgresql://postgres@127.0.0.1:$PGPORT/$base"
export PDPP_TEST_POSTGRES_RESTORE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$restore"
node --experimental-strip-types scripts/provision-test-database.ts "$PDPP_TEST_POSTGRES_URL" >/dev/null
node --experimental-strip-types scripts/provision-test-database.ts "$PDPP_TEST_POSTGRES_RESTORE_URL" >/dev/null

export PDPP_TEST_PROFILE=postgres
exec "$@"
