// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { connectorInstallCatalogFixture, connectorInstallStatusFixture } from "./connector-install-fixtures.ts";

let catalogPayload: unknown = connectorInstallCatalogFixture;
let statusPayload: unknown = connectorInstallStatusFixture;
/** HTTP status the fake server answers for a route suffix; unlisted routes answer 200. */
let failingRoutes: Record<string, number> = {};
/** Milliseconds the fake server waits before answering a route suffix. */
let routeDelays: Record<string, number> = {};

mock.module("server-only", { namedExports: {} });
mock.module("./verify-session.ts", { namedExports: { verifyDashboardSession: async () => undefined } });
mock.module("./owner-token.ts", {
  namedExports: {
    getOwnerToken: async () => "token",
    getRsInternalUrl: () => "http://reference.invalid",
    ReferenceServerUnreachableError: class extends Error {},
    ResourceServerHttpError: class extends Error {
      constructor(
        readonly path: string,
        readonly status: number,
        readonly body: string
      ) {
        super(`RS ${path} failed (${status}): ${body}`);
      }
    },
  },
});
globalThis.fetch = (async (url: string | URL | Request) => {
  const path = String(url);
  const delay = Object.entries(routeDelays).find(([suffix]) => path.endsWith(suffix));
  if (delay) {
    await new Promise((resolve) => setTimeout(resolve, delay[1]));
  }
  const failing = Object.entries(failingRoutes).find(([suffix]) => path.endsWith(suffix));
  if (failing) {
    return new Response("not served", { status: failing[1] });
  }
  const body = path.endsWith("/status")
    ? statusPayload
    : path.endsWith("/catalog")
      ? catalogPayload
      : { data: [], object: "connector_install_local_sources" };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
}) as typeof fetch;
const client = import("./connector-install-client.ts");

const CATALOG_ROWS = connectorInstallCatalogFixture.data;
const STATUS_ROWS = connectorInstallStatusFixture.data;

test("a malformed status entry fails the snapshot instead of rendering its package as not installed", async () => {
  const { getConnectorInstallSnapshot, listConnectorInstallStatus } = await client;
  const [first] = STATUS_ROWS;
  assert.ok(first);
  catalogPayload = connectorInstallCatalogFixture;
  statusPayload = { ...connectorInstallStatusFixture, data: [{ ...first, activated_at: "" }] };
  await assert.rejects(getConnectorInstallSnapshot(), /status/i);
  await assert.rejects(listConnectorInstallStatus(), /status/i);
});

test("a malformed catalog entry is skipped and counted without hiding the other packages", async () => {
  const { getConnectorInstallSnapshot } = await client;
  const [first, ...rest] = CATALOG_ROWS;
  assert.ok(first);
  catalogPayload = { ...connectorInstallCatalogFixture, data: [{ ...first, digest: "sha256:not-a-digest" }, ...rest] };
  statusPayload = connectorInstallStatusFixture;
  const snapshot = await getConnectorInstallSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.catalog.length, rest.length);
  assert.equal(snapshot.skippedEntries, 1);
});

for (const route of ["/catalog", "/status"] as const) {
  for (const status of [404, 405, 501]) {
    test(`an old server that answers ${status} for ${route} yields no snapshot instead of a failure`, async () => {
      const { getConnectorInstallSnapshot } = await client;
      catalogPayload = connectorInstallCatalogFixture;
      statusPayload = connectorInstallStatusFixture;
      failingRoutes = { [route]: status };
      try {
        assert.equal(await getConnectorInstallSnapshot(), null);
      } finally {
        failingRoutes = {};
      }
    });
  }
}

for (const status of [404, 405, 501]) {
  test(`a server without developer local sources (${status}) still returns the package facts`, async () => {
    const { getConnectorInstallSnapshot } = await client;
    catalogPayload = connectorInstallCatalogFixture;
    statusPayload = connectorInstallStatusFixture;
    failingRoutes = { "/local-sources": status };
    try {
      const snapshot = await getConnectorInstallSnapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.catalog.length, CATALOG_ROWS.length);
      assert.equal(snapshot.status.length, STATUS_ROWS.length);
      assert.deepEqual(snapshot.localSources, []);
    } finally {
      failingRoutes = {};
    }
  });
}

for (const status of [401, 403, 500, 502]) {
  test(`a ${status} from an install route still fails the snapshot`, async () => {
    const { getConnectorInstallSnapshot } = await client;
    failingRoutes = { "/status": status };
    try {
      await assert.rejects(getConnectorInstallSnapshot(), (err: unknown) => (err as { status?: number }).status === status);
    } finally {
      failingRoutes = {};
    }
  });
}

// Which failure the page sees must not depend on which route answered first.
const ROUTES = ["/catalog", "/status", "/local-sources"] as const;
for (const unavailableRoute of ["/catalog", "/status"] as const) {
  for (const hardRoute of ROUTES.filter((route) => route !== unavailableRoute)) {
    for (const [first, second] of [
      [unavailableRoute, hardRoute],
      [hardRoute, unavailableRoute],
    ] as const) {
      test(`a 405 from ${unavailableRoute} does not hide a 401 from ${hardRoute} (${first} answers first)`, async () => {
        const { getConnectorInstallSnapshot } = await client;
        catalogPayload = connectorInstallCatalogFixture;
        statusPayload = connectorInstallStatusFixture;
        failingRoutes = { [unavailableRoute]: 405, [hardRoute]: 401 };
        routeDelays = { [second]: 25 };
        try {
          await assert.rejects(getConnectorInstallSnapshot(), (err: unknown) => (err as { status?: number }).status === 401);
        } finally {
          failingRoutes = {};
          routeDelays = {};
        }
      });
    }
  }
}

for (const [first, second] of [
  ["/catalog", "/status"],
  ["/status", "/catalog"],
] as const) {
  test(`two unavailable install routes still yield no snapshot (${first} answers first)`, async () => {
    const { getConnectorInstallSnapshot } = await client;
    failingRoutes = { "/catalog": 404, "/status": 501 };
    routeDelays = { [second]: 25 };
    try {
      assert.equal(await getConnectorInstallSnapshot(), null);
    } finally {
      failingRoutes = {};
      routeDelays = {};
    }
  });
}

for (const order of ["status first", "catalog first"]) {
  test(`a malformed status entry is not hidden by an unavailable catalog route (${order})`, async () => {
    const { getConnectorInstallSnapshot } = await client;
    const [row] = STATUS_ROWS;
    assert.ok(row);
    statusPayload = { ...connectorInstallStatusFixture, data: [{ ...row, activated_at: "" }] };
    failingRoutes = { "/catalog": 405 };
    routeDelays = order === "status first" ? { "/catalog": 25 } : { "/status": 25 };
    try {
      await assert.rejects(getConnectorInstallSnapshot(), /status/i);
    } finally {
      failingRoutes = {};
      routeDelays = {};
      statusPayload = connectorInstallStatusFixture;
    }
  });
}
