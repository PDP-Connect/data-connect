// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// After a succeeded scheduled run, the scheduler persists `result.state`
// through `setState` (runtime/scheduler/run-executor.ts). A run can succeed
// while `decideCheckpointCommits` withholds a cursor (a coverage shortfall is
// reported, not fatal), so `result.state` must carry only committed cursors.
// Otherwise the scheduler writes the withheld cursor right after the runtime
// declined to, and the next run starts past rows nothing durable remembers.
//
// Drives `createRunExecutor(...).launchRun` with a real connector subprocess.
// The only staged cursor is withheld, so the runtime makes no state PUT and
// the run needs no resource server.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import { createRunExecutor, type RunExecutorRuntimeState } from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/persists-only-committed-state";
const CONNECTOR_INSTANCE_ID = "cin_persists_only_committed_state";

// `valuations` is a detail stream of `holdings`, so a holdings cursor commits
// only once a DETAIL_COVERAGE report for that boundary credits every key.
const MANIFEST = {
  streams: [
    { name: "holdings", primary_key: ["id"] },
    {
      coverage_strategy: "parent_detail_accounting",
      name: "valuations",
      parent_streams: ["holdings"],
      primary_key: ["id"],
    },
  ],
};

function writeConnector(tmpDir: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  process.stdout.write(JSON.stringify({ type: "STATE", stream: "holdings", cursor: { page: "holdings-1" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n");
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return connectorPath;
}

function freshRuntime(): RunExecutorRuntimeState {
  return {
    announcedBackoffClass: new Map<string, string>(),
    announcedBlockedClass: new Map<string, string>(),
    exhaustedGrants: new Set<string>(),
    history: [],
    running: true,
  };
}

test("a succeeded scheduled run does not persist a cursor the runtime withheld", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-persists-only-committed-"));
  // The runtime's default detail-gap store reads the process-global DB.
  initDb(join(tmpDir, "test.db"));
  try {
    const runtime = freshRuntime();
    const persisted: unknown[] = [];
    const { launchRun } = createRunExecutor({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
        ownerSubjectId: ownerSubjectId ?? "owner_test",
      }),
      getState: async () => null,
      handleGrantFailureDisable: () => {
        // Out of scope.
      },
      isManagedConnector: () => false,
      markNeedsHuman: () => {
        // Out of scope.
      },
      maxRunWallClockMs: 0,
      onInteraction: async () => ({ status: "cancelled" }),
      onRunComplete: () => {
        // Out of scope.
      },
      persistLastRunTime: () => {
        // Out of scope.
      },
      recordAndNotify: (record) => {
        runtime.history.push(record);
        return record;
      },
      referenceBaseUrl: null,
      registerRunCancellation: null,
      resolveStaticSecretRunEnv: null,
      rsUrl: "http://localhost.invalid",
      runManagedConnectorViaController: null,
      runtime,
      schedulerStore: null,
      setState: async (_connectorId, state) => {
        persisted.push(state);
      },
    });

    const schedule: ConnectorSchedule = {
      connectorId: CONNECTOR_ID,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      connectorPath: writeConnector(tmpDir),
      intervalMs: 60_000,
      manifest: MANIFEST,
      maxRetries: 0,
      ownerSubjectId: "owner_local",
      ownerToken: "owner-token",
    };
    await launchRun(schedule, false, projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" }));

    assert.deepEqual(
      runtime.history.map((record) => record.status),
      ["succeeded"],
      "the withhold is reported, not fatal, so the run itself succeeds"
    );
    for (const state of persisted) {
      assert.ok(
        !(state && typeof state === "object" && "holdings" in state),
        `the scheduler persisted the withheld holdings cursor: ${JSON.stringify(state)}`
      );
    }
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
