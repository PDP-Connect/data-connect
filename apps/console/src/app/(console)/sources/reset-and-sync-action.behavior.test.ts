// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

let resetCalls = 0;
let runCalls = 0;
let resetFailure: Error | null = null;
let revalidated: string[] = [];

const actionModule = (async () => {
  mock.module("next/cache", {
    namedExports: { revalidatePath: (path: string) => revalidated.push(path) },
  });
  mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
    namedExports: { requireDashboardAccess: async () => {} },
  });
  mock.module(new URL("../lib/connection-control-result.ts", import.meta.url).href, {
    namedExports: { profilePurgeSentence: () => "" },
  });
  mock.module(new URL("../lib/delete-connection-with-run-cancel.ts", import.meta.url).href, {
    namedExports: { deleteConnectionWithRunCancel: async () => ({ status: "deleted" }) },
  });
  mock.module(new URL("../lib/operator-runs.ts", import.meta.url).href, {
    namedExports: {
      cancelRun: async () => ({}),
      deleteConnection: async () => ({}),
      deleteConnectionSchedule: async () => ({}),
      deleteConnectorSchedule: async () => ({}),
      pauseConnection: async () => ({}),
      pauseConnectionSchedule: async () => ({}),
      pauseConnectorSchedule: async () => ({}),
      purgeConnectionBrowserProfile: async () => ({}),
      reactivateConnection: async () => ({}),
      resetConnectionState: async () => {
        resetCalls += 1;
        if (resetFailure) throw resetFailure;
        return { run_id: "run-reset-1" };
      },
      resumeConnection: async () => ({}),
      resumeConnectionSchedule: async () => ({}),
      resumeConnectorSchedule: async () => ({}),
      revokeConnection: async () => ({}),
      runConnectionNow: async () => {
        runCalls += 1;
        return { run_id: "run-extra" };
      },
      runConnectorNow: async () => ({}),
      saveConnectionSchedule: async () => ({}),
      saveConnectorSchedule: async () => ({}),
      setConnectionDisplayName: async () => ({}),
    },
  });
  mock.module("next/navigation", { namedExports: { redirect: () => {} } });
  return await import("./[connector]/actions.ts");
})();

test("reset action admits one full sync through the reset request", async () => {
  const actions = await actionModule;
  resetCalls = 0;
  runCalls = 0;
  resetFailure = null;
  revalidated = [];

  assert.deepEqual(await actions.resetAndSyncConnectionAction("source-1"), {
    ok: true,
    run_id: "run-reset-1",
  });
  assert.equal(resetCalls, 1);
  assert.equal(runCalls, 0);
  assert.deepEqual(revalidated, ["/sources/source-1"]);
});

test("reset refusal stays visible and does not start a run", async () => {
  const actions = await actionModule;
  resetCalls = 0;
  runCalls = 0;
  revalidated = [];
  resetFailure = new Error("A collection run is already active.");

  assert.deepEqual(await actions.resetAndSyncConnectionAction("source-1"), {
    ok: false,
    message: "A collection run is already active.",
  });
  assert.equal(resetCalls, 1);
  assert.equal(runCalls, 0);
  assert.deepEqual(revalidated, []);
});
