// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeTestServer, type TestServer } from "./helpers/close-test-server.ts";

function fakeHttpServer() {
  let closeCalls = 0;
  return {
    close(callback: (error?: Error) => void) {
      closeCalls += 1;
      callback();
    },
    closeAllConnections() {},
    closeIdleConnections() {},
    get closeCalls() {
      return closeCalls;
    },
  };
}

function fakeTestServer(overrides: Partial<TestServer> = {}) {
  const asServer = fakeHttpServer();
  const rsServer = fakeHttpServer();
  const settled = Promise.resolve();
  const server = {
    abortStartupBackfill() {},
    asServer,
    manifestReconciliationDone: settled,
    postgresSemanticHnswMaintenanceDone: settled,
    rsServer,
    schedulerManager: { refresh: async () => undefined, stop() {} },
    startupBackfillDone: settled,
    startupRunHistoryBackfillDone: settled,
    startupSummaryEvidenceSweepDone: settled,
    stopBrowserSurfaceLeaseSweep() {},
    stopClientEventDeliveryWorker: async () => undefined,
    stopConnectorMaintenanceSweep() {},
    stopPostgresDerivedIndexMaintenance() {},
    ...overrides,
  } as unknown as TestServer;
  return { asServer, rsServer, server };
}

test("closeTestServer stops workers, awaits teardown, and is idempotent", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  timer.unref();
  let workerStops = 0;
  const { server } = fakeTestServer({
    schedulerManager: {
      cancelRun: () => ({ run_id: "unused", status: "cancelled" }),
      refresh: async () => undefined,
      start: async () => undefined,
      stop() {
        workerStops += 1;
        clearInterval(timer);
      },
    },
  });

  await closeTestServer(server);
  const ticksAfterClose = ticks;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await closeTestServer(server);

  assert.equal(workerStops, 1);
  assert.equal(ticks, ticksAfterClose, "background work must stop before teardown returns");
});

test("closeTestServer reports stop failures and still closes both HTTP servers", async () => {
  const stopError = new Error("sweep stop failed");
  const { asServer, rsServer, server } = fakeTestServer({
    stopConnectorMaintenanceSweep() {
      throw stopError;
    },
  });

  await assert.rejects(closeTestServer(server), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(stopError));
    return true;
  });
  await closeTestServer(server);

  assert.equal(asServer.closeCalls, 1);
  assert.equal(rsServer.closeCalls, 1);
});
