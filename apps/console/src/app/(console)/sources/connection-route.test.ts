// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const requests: unknown[] = [];
let fallbackRows: Array<Record<string, unknown>> | null = null;
let sourcesOnly = false;
let responseRows: Array<Record<string, unknown>> = [];
const route = (async () => {
  mock.module("../lib/ref-client.ts", {
    exports: {
      listConnectorSummaries: async (request: unknown) => {
        requests.push(request);
        if (fallbackRows && !(request as { connectionRouteId?: string }).connectionRouteId) return { data: (request as { sourcesVisibility?: boolean }).sourcesVisibility ? fallbackRows : [] };
        return { data: sourcesOnly && !(request as { sourcesVisibility?: boolean }).sourcesVisibility ? [] : responseRows };
      },
    },
  });
  return await import("./connection-route.ts");
})();

test("resolver scopes detail reads and prefers stable connection identity", async () => {
  const { resolveConnectionForRecordsRoute } = await route;
  const exact = { connection_id: "cin-exact", connector_instance_id: "cin-exact", connector_id: "gmail" };
  responseRows = [
    { connection_id: "other", connector_instance_id: "other", connector_id: "cin-exact" },
    exact,
  ];
  requests.length = 0;
  assert.equal(await resolveConnectionForRecordsRoute("cin-exact"), exact);
  assert.deepEqual(requests, [{ connectionRouteId: "cin-exact", sourcesVisibility: true }]);
});

test("resolver uses an unambiguous connector id, then a unique case-insensitive display name", async () => {
  const { resolveConnectionForRecordsRoute } = await route;
  const connector = { connection_id: "cin-1", connector_instance_id: "cin-1", connector_id: "gmail" };
  responseRows = [connector];
  requests.length = 0;
  assert.equal(await resolveConnectionForRecordsRoute("gmail"), connector);
  assert.equal(requests.length, 1);

  const display = { connection_id: "cin-2", connector_instance_id: "cin-2", connector_id: "claude-code", display_name: "Claude-Test" };
  responseRows = [display];
  requests.length = 0;
  assert.equal(await resolveConnectionForRecordsRoute("claude-test"), display);
  assert.deepEqual(requests, [
    { connectionRouteId: "claude-test", sourcesVisibility: true },
    { limit: 100, sourcesVisibility: true },
  ]);
});

test("explicit connection id is tried first and ambiguous display names resolve to null", async () => {
  const { resolveConnectionForRecordsRoute } = await route;
  const explicit = { connection_id: "cin-explicit", connector_instance_id: "cin-explicit" };
  responseRows = [explicit];
  requests.length = 0;
  assert.equal(await resolveConnectionForRecordsRoute("gmail", "cin-explicit"), explicit);
  assert.deepEqual(requests, [{ connectionRouteId: "cin-explicit", sourcesVisibility: true }]);

  responseRows = [
    { connection_id: "a", display_name: "Shared" },
    { connection_id: "b", display_name: "Shared" },
  ];
  requests.length = 0;
  assert.equal(await resolveConnectionForRecordsRoute("shared"), null);
  assert.equal(requests.length, 2);
});


test("a setup-failed list row still resolves when the scoped route omits retired shells", async () => {
  const { resolveConnectionForRecordsRoute } = await route;
  const failed = { connection_id: "cin-never", connector_instance_id: "cin-never", connector_id: "northwind", display_name: "Northwind", source_visibility: "setup_failed", total_records: 0 };
  responseRows = [failed];
  sourcesOnly = true;
  // Scoped reads currently do not apply the Sources visibility rule. Exercise that empty response.
  const original = failed.connection_id;
  responseRows = [];
  fallbackRows = [failed];
  assert.equal((await resolveConnectionForRecordsRoute(original))?.connection_id, original);
  fallbackRows = null;
  sourcesOnly = false;
});
