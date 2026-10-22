// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL proof for the collection-revision fence the local coverage
 * projection reads (`revisionFence`). State commits, terminal runs and
 * observed attempts each take the next per-connection revision at commit, and
 * the server's own `$` scope rows take none. The fence SQL runs in both the
 * singleton and the page-batched readers, and the batched one is the list
 * path, which swallows its own failures. So this test reads it back directly
 * rather than trusting a projection that would silently degrade.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  readCommittedLocalCoverageDiagnostics,
  readCommittedLocalCoverageDiagnosticsByConnectionIds,
} from "../server/records.ts";
import {
  issueCollectionRunSequence,
  recordCollectionRevisionEvent,
} from "../server/stores/collection-revision-store.ts";
import { createPostgresConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const CONNECTOR_ID = "claude-code";
const WITH_STATE = "cin_revision_fence_pg";
const SCOPE_ONLY = "cin_revision_fence_scope_only_pg";
const PROOF_RUN = "run_revision_fence_pg";
const NOW = "2026-10-22T09:00:00.000Z";

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

async function cleanup(): Promise<void> {
  const ids = [WITH_STATE, SCOPE_ONLY];
  await postgresQuery("DELETE FROM run_history WHERE connector_instance_id = ANY($1::text[])", [ids]);
  await postgresQuery("DELETE FROM spine_events WHERE run_id = $1", [PROOF_RUN]);
  await postgresQuery("DELETE FROM connector_state WHERE connector_instance_id = ANY($1::text[])", [ids]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [ids]);
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
}

async function stateRowRevisions(connectorInstanceId: string): Promise<Record<string, string | null>> {
  const result = await postgresQuery<{
    collection_revision: string | null;
    stream: string;
  }>(
    "SELECT stream, collection_revision::text AS collection_revision FROM connector_state WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.stream, row.collection_revision]));
}

async function fences() {
  const batch = await readCommittedLocalCoverageDiagnosticsByConnectionIds([WITH_STATE, SCOPE_ONLY]);
  const single = await readCommittedLocalCoverageDiagnostics({
    connector_id: CONNECTOR_ID,
    connector_instance_id: WITH_STATE,
  });
  assert.deepEqual(single.revisionFence, batch.get(WITH_STATE)?.revisionFence, "the singleton reader agrees");
  return {
    scopeOnly: batch.get(SCOPE_ONLY)?.revisionFence,
    withState: batch.get(WITH_STATE)?.revisionFence,
  };
}

test("real PostgreSQL: the collection revision orders commits and observed events, and both coverage readers return the same fence (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seed();
    const store = createPostgresConnectorStateStore();
    const scope = {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WITH_STATE,
    };

    // A state commit takes revision 1 and stamps every row it writes.
    await store.putState(scope, {
      messages: { cursor: "m-1" },
      sessions: { cursor: "s-1" },
    });
    // The server's own scope row is not a collection event.
    await store.putState(scope, { $collection_scope: "unscoped" });
    assert.deepEqual(await stateRowRevisions(WITH_STATE), {
      $collection_scope: null,
      messages: "1",
      sessions: "1",
    });

    // A terminal run takes revision 2; its own state rows and its run record carry it. The run
    // registered its start, so it is also the run-order marker.
    await issueCollectionRunSequence({
      connectorInstanceId: WITH_STATE,
      deviceId: "dev_revision_fence_pg",
      runId: PROOF_RUN,
      sourceInstanceId: "src_revision_fence_pg",
    });
    await commitTerminalRun({
      collectionBoundary: "unscoped",
      commitId: `commit_${PROOF_RUN}`,
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WITH_STATE,
      deviceId: "dev_revision_fence_pg",
      envelopeHash: `envelope_${PROOF_RUN}`,
      normalizedFacts: [],
      runId: PROOF_RUN,
      sourceInstanceId: "src_revision_fence_pg",
      stateDelta: { messages: { cursor: "m-2" } },
      version: 2,
    });
    assert.deepEqual(await stateRowRevisions(WITH_STATE), {
      $collection_scope: null,
      messages: "2",
      sessions: "1",
    });
    const afterRun = await fences();
    assert.deepEqual(
      afterRun.withState?.highWater && {
        ...afterRun.withState.highWater,
        at: null,
      },
      {
        at: null,
        event: "terminal_run",
        revision: 2,
        runId: PROOF_RUN,
      }
    );
    assert.equal(afterRun.withState?.proofRun?.runId, PROOF_RUN, "the fence reads the run the run-order marker names");
    assert.deepEqual(
      afterRun.withState?.runOrder,
      { event: "terminal_run", revision: 2, runId: PROOF_RUN, sequence: 1 },
      "the run-order marker is the run's terminal record"
    );
    assert.equal(afterRun.withState?.proofRun?.facts?.collection_revision, 2, "the run record carries its revision");
    assert.deepEqual(afterRun.scopeOnly?.highWater, {
      at: null,
      event: null,
      revision: 0,
      runId: null,
    });
    assert.equal(afterRun.scopeOnly?.proofRun, null);

    // A later observed attempt takes revision 3. The high-water mark no longer names a terminal run.
    assert.equal(
      await recordCollectionRevisionEvent(WITH_STATE, {
        at: NOW,
        event: "batch_rejected",
      }),
      3
    );
    const afterRejection = await fences();
    assert.equal(afterRejection.withState?.highWater?.revision, 3);
    assert.equal(afterRejection.withState?.highWater?.event, "batch_rejected");
    assert.equal(afterRejection.withState?.proofRun, null);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});
