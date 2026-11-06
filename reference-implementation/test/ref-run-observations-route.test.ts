// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Adapter tests for the owner-only run observations route
// `GET /_ref/runs/:runId/observations` (server/routes/ref-run-observations.ts).
// The route is mounted into a fake Express-like app, as ref-run-status-route
// does. The store is injected, so these tests cover the route's gating and
// namespace behavior, not the store's persistence.

import assert from "node:assert/strict";
import test from "node:test";
import { mountRefRunObservations } from "../server/routes/ref-run-observations.ts";
import type {
  ConnectorObservationRunKey,
  ConnectorObservationRunRecord,
  ConnectorObservationRunStore,
} from "../server/stores/connector-observation-store.ts";

const ROUTE = "GET /_ref/runs/:runId/observations";
const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/observations-route";
const INSTANCE_ID = "instance_owner_1";
const RUN_ID = "run_observations_route";

type Session = "owner" | "client" | "anonymous";

interface Captured {
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  status: number;
}

function fakeRecord(): ConnectorObservationRunRecord {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    diagnosis: { attribution: "none", basis: [], category: "unknown", contributing: [] },
    recordedAt: "2026-11-02T00:00:00.000Z",
    runId: RUN_ID,
    snapshot: { defects: [], facts: [], truncated: false },
  };
}

function fakeStore(record: ConnectorObservationRunRecord | null): ConnectorObservationRunStore {
  const calls: unknown[] = [];
  return {
    get(key: ConnectorObservationRunKey) {
      calls.push(key);
      if (
        record &&
        key.connectorId === record.connectorId &&
        key.connectorInstanceId === record.connectorInstanceId &&
        key.runId === record.runId
      ) {
        return Promise.resolve(record);
      }
      return Promise.resolve(null);
    },
    list() {
      return Promise.resolve([]);
    },
    put() {
      return Promise.reject(new Error("the diagnostic route never writes"));
    },
  } as unknown as ConnectorObservationRunStore;
}

// Runs the route the way the HTTP stack would: session middleware first, then
// the handler only when the middleware calls next.
async function invoke(
  session: Session,
  query: Record<string, string | undefined>,
  store: ConnectorObservationRunStore,
  runId = RUN_ID
): Promise<Captured> {
  type Handler = (req: unknown, res: unknown, next?: () => void) => unknown;
  const routes: { middleware: Handler[]; handler: Handler | undefined } = { handler: undefined, middleware: [] };
  const app = {
    get(path: string, ...handlers: Handler[]) {
      assert.equal(`GET ${path}`, ROUTE);
      routes.middleware = handlers.slice(0, -1);
      routes.handler = handlers.at(-1);
      return app;
    },
  };
  mountRefRunObservations(app as never, {
    handleError: (_res, err) => {
      throw err;
    },
    pdppError: (res, status, code, message, param) => {
      (res as { status: (n: number) => { json: (b: unknown) => void } }).status(status).json({
        error: { code, message, ...(param ? { param } : {}) },
      });
    },
    requireOwnerSession: ((
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void
    ) => {
      if (session === "owner") {
        next();
        return;
      }
      res
        .status(session === "client" ? 403 : 401)
        .json({ error: { code: session === "client" ? "forbidden" : "unauthorized" } });
    }) as never,
    store,
  });

  const captured: Captured = { body: null, headers: {}, status: 200 };
  const response = {
    json(body: unknown) {
      captured.body = body as Record<string, unknown>;
      return response;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      captured.status = code;
      return response;
    },
  };
  const req = { params: { runId }, query };
  let nextCalled = false;
  const runMiddleware = (fn: Handler) =>
    fn(req, response, () => {
      nextCalled = true;
    });
  for (const middleware of routes.middleware) {
    nextCalled = false;
    runMiddleware(middleware);
    if (!nextCalled) {
      return captured;
    }
  }
  await routes.handler?.(req, response);
  return captured;
}

const OWNER_QUERY = { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };

test("an anonymous request is refused by the owner session gate", async () => {
  const result = await invoke("anonymous", OWNER_QUERY, fakeStore(fakeRecord()));
  assert.equal(result.status, 401);
  assert.equal((result.body?.error as { code?: string } | undefined)?.code, "unauthorized");
  assert.notEqual(result.body?.object, "run_observations");
});

test("a client credential is refused by the owner session gate", async () => {
  const result = await invoke("client", OWNER_QUERY, fakeStore(fakeRecord()));
  assert.equal(result.status, 403);
  assert.equal((result.body?.error as { code?: string } | undefined)?.code, "forbidden");
  assert.notEqual(result.body?.object, "run_observations");
});

test("an owner session reads the stored record", async () => {
  const result = await invoke("owner", OWNER_QUERY, fakeStore(fakeRecord()));
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store", "private diagnostic facts must not enter an HTTP cache");
  assert.equal(result.body?.object, "run_observations");
  assert.equal(result.body?.run_id, RUN_ID);
  assert.deepEqual(result.body?.snapshot, { defects: [], facts: [], truncated: false });
});

test("a run that exists under another connector or instance is not found", async () => {
  const store = fakeStore(fakeRecord());
  const otherConnector = await invoke(
    "owner",
    { ...OWNER_QUERY, connector_id: "https://registry.pdpp.dev/connectors/other" },
    store
  );
  assert.equal(otherConnector.status, 404);
  const otherInstance = await invoke("owner", { ...OWNER_QUERY, connector_instance_id: "instance_other" }, store);
  assert.equal(otherInstance.status, 404);
});

test("an unknown run id is a typed not_found 404", async () => {
  const result = await invoke("owner", OWNER_QUERY, fakeStore(null), "run_missing");
  assert.equal(result.status, 404);
  assert.equal((result.body?.error as { code?: string } | undefined)?.code, "not_found");
});

test("the route requires both namespace query parameters", async () => {
  const missingConnector = await invoke("owner", { connector_instance_id: INSTANCE_ID }, fakeStore(fakeRecord()));
  assert.equal(missingConnector.status, 400);
  const missingInstance = await invoke("owner", { connector_id: CONNECTOR_ID }, fakeStore(fakeRecord()));
  assert.equal(missingInstance.status, 400);
});
