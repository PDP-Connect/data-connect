// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { startServer } from "../../server/index.ts";

type HttpServer = {
  close: (callback: (error?: Error) => void) => void;
  closeAllConnections: () => void;
  closeIdleConnections?: () => void;
};

type TeardownOperation = () => unknown | Promise<unknown>;

export type TestServer = Awaited<ReturnType<typeof startServer>>;

type CloseState = { promise: Promise<void>; settled: boolean };
const closeStates = new WeakMap<object, CloseState>();

/** Stop all startServer workers, drain their background work and close both HTTP servers. */
export async function closeTestServer(server: TestServer): Promise<void> {
  const previous = closeStates.get(server);
  if (previous) {
    if (previous.settled) return;
    return previous.promise;
  }

  const state: CloseState = { promise: Promise.resolve(), settled: false };
  const closing = closeOnce(server);
  state.promise = closing;
  closeStates.set(server, state);
  void closing.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    }
  );
  return closing;
}

async function closeOnce(server: TestServer): Promise<void> {
  const errors: unknown[] = [];
  errors.push(
    ...(await runOperations([
      () => server.abortStartupBackfill("test teardown"),
      () => server.schedulerManager?.stop(),
      () => server.stopBrowserSurfaceLeaseSweep(),
      () => server.stopConnectorMaintenanceSweep(),
      () => server.stopPostgresDerivedIndexMaintenance(),
    ]))
  );
  errors.push(...(await runOperations([() => closeHttpServer(server.asServer), () => closeHttpServer(server.rsServer)])));
  errors.push(
    ...(await runOperations([
      // After stop(), refresh() queues a no-op restart behind any in-flight
      // refresh, so awaiting it waits for that refresh to finish.
      () => server.schedulerManager?.refresh(),
      () => server.manifestReconciliationDone,
      () => server.postgresSemanticHnswMaintenanceDone,
      () => server.startupBackfillDone,
      () => server.startupRunHistoryBackfillDone,
      () => server.startupSummaryEvidenceSweepDone,
    ]))
  );
  errors.push(...(await runOperations([() => server.stopClientEventDeliveryWorker()])));
  if (errors.length > 0) {
    throw new AggregateError(errors, "test server teardown failed");
  }
}

async function runOperations(operations: TeardownOperation[]): Promise<unknown[]> {
  const results = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
  return results.flatMap((result) => (result.status === "rejected" ? flattenErrors(result.reason) : []));
}

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error];
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  const errors: unknown[] = [];
  for (const closeConnections of [server.closeIdleConnections, server.closeAllConnections]) {
    if (!closeConnections) continue;
    try {
      closeConnections.call(server);
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "HTTP server close failed");
  }
}
