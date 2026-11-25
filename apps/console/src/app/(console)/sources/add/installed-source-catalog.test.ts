// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { RefConnectorRetainedCountSummary } from "../../lib/ref-client.ts";

const requests: Record<string, unknown>[] = [];
let fetchPage: (request: Record<string, unknown>) => Promise<unknown>;
const catalogModule = (async () => {
  mock.module("../../lib/ref-client.ts", {
    exports: {
      CONNECTOR_SUMMARY_PAGE_LIMIT_MAX: 100,
      listConnectorSummaries: async (request: Record<string, unknown>) => {
        requests.push(request);
        return await fetchPage(request);
      },
    },
  });
  return await import("./installed-source-catalog.ts");
})();

function row(overrides: Partial<RefConnectorRetainedCountSummary> = {}): RefConnectorRetainedCountSummary {
  return {
    acquisition_coverage: null,
    connection_id: "connection-1",
    connector_display_name: "Reddit",
    connector_id: "seed-reddit",
    connector_instance_id: "connection-1",
    display_name: "My Reddit archive",
    revoked_at: null,
    status: "active",
    total_records: 2,
    total_records_state: "known",
    ...overrides,
  };
}

test("installed source projection keeps added sources outside the catalog by their display name", async () => {
  const { projectInstalledSourceCatalog } = await catalogModule;
  const result = projectInstalledSourceCatalog(
    [
      row(),
      row({ connector_id: "spotify", connector_instance_id: "connection-2", display_name: "Spotify" }),
      row({ connector_instance_id: "connection-revoked", status: "revoked" }),
    ],
    ["spotify"]
  );

  assert.deepEqual(result.uncataloguedSources, [
    { connectorId: "seed-reddit", connectionId: "connection-1", displayName: "My Reddit archive" },
  ]);
  assert.deepEqual(result.byConnector["seed-reddit"]?.map((source) => source.displayName), ["My Reddit archive"]);
  assert.equal(result.byConnector.spotify?.[0]?.displayName, "Spotify");
});

test("installed source catalog follows cursors and requests the retained-count facts", async () => {
  const { readInstalledSourceCatalog } = await catalogModule;
  requests.length = 0;
  fetchPage = async (request) => request.cursor
    ? { data: [row({ connector_id: "spotify", connector_instance_id: "connection-2", display_name: "Spotify" })], has_more: false }
    : { data: [row()], has_more: true, next_cursor: "next-page" };

  const result = await readInstalledSourceCatalog(["spotify"]);

  assert.deepEqual(result.uncataloguedSources, [
    { connectorId: "seed-reddit", connectionId: "connection-1", displayName: "My Reddit archive" },
  ]);
  assert.deepEqual(requests, [
    { cursor: undefined, limit: 100, profile: "retained_count_summary" },
    { cursor: "next-page", limit: 100, profile: "retained_count_summary" },
  ]);
});

test("installed source catalog keeps rows from earlier pages when a continuation is refused", async () => {
  const { readInstalledSourceCatalog } = await catalogModule;
  requests.length = 0;
  fetchPage = async (request) => {
    if (request.cursor) throw Object.assign(new Error("header too large"), { status: 431 });
    return { data: [row()], has_more: true, next_cursor: "next-page" };
  };

  const result = await readInstalledSourceCatalog(["spotify"]);

  assert.equal(result.truncated, true);
  assert.deepEqual(result.uncataloguedSources, [
    { connectorId: "seed-reddit", connectionId: "connection-1", displayName: "My Reddit archive" },
  ]);
  assert.equal(requests.length, 2);
});
