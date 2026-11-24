// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exec } from "../lib/db.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { referenceQueries } from "../server/queries/index.ts";
import {
  createPostgresConnectorStateStore,
  createSqliteConnectorStateStore,
} from "../server/stores/connector-state-store.ts";
import { createPostgresSchedulerStore, createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

test("reset clears state and admits one run atomically, preserving state on refusal", async (t) => {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), "pdpp-reset-run-admission-"));
  t.after(() => {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  });
  initDb(join(dir, "pdpp.sqlite"));

  const state = createSqliteConnectorStateStore();
  const scheduler = createSqliteSchedulerStore();
  const scope = { connectorId: "github", connectorInstanceId: "source-1" };
  const run = {
    connector_id: scope.connectorId,
    connector_instance_id: scope.connectorInstanceId,
    run_generation: 1,
    run_id: "run-reset-1",
    scenario_id: "scenario-1",
    started_at: new Date().toISOString(),
    trace_id: "trace-1",
  };

  await state.putState(scope, { issues: { cursor: "old-cursor" } });
  await state.putState(scope, { $collection_scope: { since: "2026-01-01T00:00:00.000Z" } });
  assert.equal(await scheduler.resetStateAndUpsertActiveRun?.(run), true);
  assert.deepEqual(
    (await state.getState(scope)).state,
    { $collection_scope: { since: "2026-01-01T00:00:00.000Z" } },
    "reset must preserve the owner-declared collection boundary and clear stream cursors"
  );
  assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);

  await state.putState(scope, { issues: { cursor: "active-run-cursor" } });
  assert.equal(
    await scheduler.resetStateAndUpsertActiveRun?.({ ...run, run_generation: 2, run_id: "run-reset-2" }),
    false
  );
  assert.deepEqual((await state.getState(scope)).state, {
    $collection_scope: { since: "2026-01-01T00:00:00.000Z" },
    issues: { cursor: "active-run-cursor" },
  });
  assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);

  exec(referenceQueries.connectorInstancesDeleteConnectorStateByInstance, [scope.connectorInstanceId]);
  assert.deepEqual((await state.getState(scope)).state, {}, "connection deletion still clears every cursor row");
});

test("Postgres reset preserves $collection_scope and rolls state deletion back on admission conflict", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated",
}, async () => {
  assert.ok(POSTGRES_URL, "dedicated local PostgreSQL test URL is configured");
  const databaseName = `pdpp_test_scheduler_reset_${process.pid}_${Date.now().toString(36)}`;

  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        const state = createPostgresConnectorStateStore();
        const scheduler = createPostgresSchedulerStore();
        const scope = { connectorId: "github", connectorInstanceId: "source-pg-1" };
        const run = {
          connector_id: scope.connectorId,
          connector_instance_id: scope.connectorInstanceId,
          run_generation: 1,
          run_id: "run-reset-pg-1",
          scenario_id: "scenario-pg-1",
          started_at: new Date().toISOString(),
          trace_id: "trace-pg-1",
        };

        await state.putState(scope, { issues: { cursor: "old-cursor" } });
        await state.putState(scope, { $collection_scope: { since: "2026-01-01T00:00:00.000Z" } });
        assert.equal(await scheduler.resetStateAndUpsertActiveRun?.(run), true);
        assert.deepEqual((await state.getState(scope)).state, {
          $collection_scope: { since: "2026-01-01T00:00:00.000Z" },
        });
        assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);

        await state.putState(scope, { issues: { cursor: "active-run-cursor" } });
        assert.equal(
          await scheduler.resetStateAndUpsertActiveRun?.({ ...run, run_generation: 2, run_id: "run-reset-pg-2" }),
          false
        );
        assert.deepEqual((await state.getState(scope)).state, {
          $collection_scope: { since: "2026-01-01T00:00:00.000Z" },
          issues: { cursor: "active-run-cursor" },
        });
        assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);

        await postgresQuery("DELETE FROM connector_state WHERE connector_instance_id = $1", [
          scope.connectorInstanceId,
        ]);
        assert.deepEqual((await state.getState(scope)).state, {}, "connection deletion still clears every cursor row");
      } finally {
        await closePostgresStorage();
      }
    }
  );
});
