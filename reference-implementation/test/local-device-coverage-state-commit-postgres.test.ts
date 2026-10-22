// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL proof for the newest state-commit instant the stale-proof
 * projection compares against a terminal proof (`stateCommittedAt`). The SQL
 * runs in both the singleton and the page-batched readers, and the batched one
 * is the list path, which swallows its own failures. So this test reads it
 * back directly rather than trusting a projection that would silently degrade.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  readCommittedLocalCoverageDiagnostics,
  readCommittedLocalCoverageDiagnosticsByConnectionIds,
} from "../server/records.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const CONNECTOR_ID = "claude-code";
const WITH_STATE = "cin_stale_proof_state_commit_pg";
const SCOPE_ONLY = "cin_stale_proof_scope_only_pg";
const EARLIER = "2026-10-22T10:00:00.000Z";
const LATER = "2026-10-22T10:05:00.000Z";
const SCOPE_WRITE = "2026-10-22T11:00:00.000Z";
const NOW = "2026-10-22T09:00:00.000Z";

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM connector_state WHERE connector_instance_id = ANY($1::text[])", [
    [WITH_STATE, SCOPE_ONLY],
  ]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [
    [WITH_STATE, SCOPE_ONLY],
  ]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function seed(): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID }),
    NOW,
  ]);
  for (const instance of [WITH_STATE, SCOPE_ONLY]) {
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES ($1, 'owner_local', $2, 'laptop', 'active',
         'local_device', $1, '{}'::jsonb, $3, $3)`,
      [instance, CONNECTOR_ID, NOW]
    );
  }
  // WITH_STATE: two stream commits, the newer of which decides the instant. Its
  // `$`-prefixed scope row is written last, and must not count as a state commit.
  const rows: Array<[string, string, string, string]> = [
    [WITH_STATE, "messages", LATER, '{"cursor":"later"}'],
    [WITH_STATE, "sessions", EARLIER, '{"cursor":"earlier"}'],
    [WITH_STATE, "$collection_scope", SCOPE_WRITE, '"unscoped"'],
    [SCOPE_ONLY, "$collection_scope", SCOPE_WRITE, '"unscoped"'],
  ];
  for (const [instance, stream, updatedAt, stateJson] of rows) {
    await postgresQuery(
      `INSERT INTO connector_state(
         connector_id, connector_instance_id, stream, state_json, updated_at, manifest_generation
       ) VALUES ($1, $2, $3, $4::jsonb, $5, 0)`,
      [CONNECTOR_ID, instance, stream, stateJson, updatedAt]
    );
  }
}

test("real PostgreSQL: stateCommittedAt is the newest non-scope state commit, from both coverage readers (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seed();

    const batch = await readCommittedLocalCoverageDiagnosticsByConnectionIds([WITH_STATE, SCOPE_ONLY]);
    assert.equal(
      batch.get(WITH_STATE)?.stateCommittedAt,
      LATER,
      "the newest stream commit wins, and the later scope row is not a state commit"
    );
    assert.equal(
      batch.get(SCOPE_ONLY)?.stateCommittedAt,
      null,
      "a connection with only server scope state has no state commit"
    );

    const single = await readCommittedLocalCoverageDiagnostics({
      connector_id: CONNECTOR_ID,
      connector_instance_id: WITH_STATE,
    });
    assert.equal(single.stateCommittedAt, LATER, "the singleton reader agrees with the batched one");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});
