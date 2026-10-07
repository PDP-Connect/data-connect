// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

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
  assert.equal(await scheduler.resetStateAndUpsertActiveRun?.(run), true);
  assert.deepEqual((await state.getState(scope)).state, {});
  assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);

  await state.putState(scope, { issues: { cursor: "active-run-cursor" } });
  assert.equal(
    await scheduler.resetStateAndUpsertActiveRun?.({ ...run, run_id: "run-reset-2", run_generation: 2 }),
    false
  );
  assert.deepEqual((await state.getState(scope)).state, { issues: { cursor: "active-run-cursor" } });
  assert.equal((await scheduler.getActiveRun(scope.connectorInstanceId))?.run_id, run.run_id);
});
