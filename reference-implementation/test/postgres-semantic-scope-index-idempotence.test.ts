// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;

async function indexIdentity() {
  const result = await postgresQuery<{ definition: string; oid: string; relfilenode: string }>(
    `SELECT pg_get_indexdef(c.oid) AS definition, c.oid::text AS oid, c.relfilenode::text AS relfilenode
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'idx_pg_semantic_search_scope_c'`
  );
  assert.equal(result.rowCount, 1, "the C-collated scope index must exist after bootstrap");
  return result.rows[0];
}

test("semantic C-collated scope index retains its physical identity when correct and repairs a bad definition once", {
  skip: databaseUrl ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  try {
    await initPostgresStorage({ backend: "postgres", databaseUrl: databaseUrl as string });
    const original = await indexIdentity();
    await closePostgresStorage();

    await initPostgresStorage({ backend: "postgres", databaseUrl: databaseUrl as string });
    assert.deepEqual(await indexIdentity(), original, "a correct index must not be dropped and recreated on bootstrap");

    await postgresQuery("DROP INDEX idx_pg_semantic_search_scope_c");
    await postgresQuery(
      "CREATE INDEX idx_pg_semantic_search_scope_c ON semantic_search_blob(connector_instance_id, scope_key, record_key)"
    );
    const wrong = await indexIdentity();
    await closePostgresStorage();

    await initPostgresStorage({ backend: "postgres", databaseUrl: databaseUrl as string });
    const repaired = await indexIdentity();
    assert.notDeepEqual(repaired, wrong, "a non-C-collated index must be replaced");
    await closePostgresStorage();

    await initPostgresStorage({ backend: "postgres", databaseUrl: databaseUrl as string });
    assert.deepEqual(await indexIdentity(), repaired, "the repaired index must remain stable on the next bootstrap");
  } finally {
    await closePostgresStorage();
  }
});
