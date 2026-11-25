// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

// Source structure preserves the R5 exactness ruling (add-source-perf-design-agy-0730.md; terminal-read-architecture-fable-0730.md §2 R5).

const requests: Array<Record<string, unknown>> = [];
let fetchPage: (request: Record<string, unknown>) => Promise<unknown>;
const moduleApi = (async () => {
  mock.module("../lib/ref-client.ts", {
    exports: {
      CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX: 100,
      listConnectorSummaries: async (request: Record<string, unknown>) => {
        requests.push(request);
        return await fetchPage(request);
      },
    },
  });
  return await import("./existing-sources-by-connector.ts");
})();

function row(connectionId: string, connectorId: string, fields: Record<string, unknown> = {}) {
  return {
    connector_id: connectorId,
    connector_instance_id: connectionId,
    display_name: connectionId,
    status: "active",
    total_records: 7,
    total_records_state: "exact",
    ...fields,
  };
}

test("existing-source lookup follows cursors, projects profile data, and filters revoked rows", async () => {
  const { existingSourcesForConnector } = await moduleApi;
  requests.length = 0;
  fetchPage = async (request) =>
    request.cursor
      ? {
          data: [row("live", "gmail", { acquisition_coverage: { latest_batch: { status: "complete" } } })],
          has_more: false,
        }
      : {
          data: [
            row("status-revoked", "gmail", { status: "revoked" }),
            row("timestamp-revoked", "gmail", { revoked_at: "2026-01-01" }),
          ],
          has_more: true,
          next_cursor: "next-page",
        };
  assert.deepEqual(await existingSourcesForConnector("gmail"), [
    {
      connectionId: "live",
      displayName: "live",
      latestImportFile: null,
      latestImportStatus: "complete",
      status: "active",
      totalRecords: 7,
      totalRecordsState: "exact",
    },
  ]);
  assert.deepEqual(requests, [
    { connectorId: ["gmail"], cursor: undefined, limit: 100, profile: "retained_count_summary" },
    { connectorId: ["gmail"], cursor: "next-page", limit: 100, profile: "retained_count_summary" },
  ]);
});

test("catalog lookup batches unique connector ids into bounded scopes", async () => {
  const { existingSourcesByConnectorCatalog } = await moduleApi;
  requests.length = 0;
  let active = 0;
  let maxActive = 0;
  fetchPage = async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return {
      data: (request.connectorId as string[]).map((id) => row(`cin-${id}`, id)),
      has_more: false,
    };
  };
  const ids = Array.from({ length: 901 }, (_, index) => `connector-${index}`);
  const result = await existingSourcesByConnectorCatalog([...ids, ids[0]!]);
  assert.equal(Object.keys(result).length, 901);
  assert.equal(requests.length, 10);
  assert.deepEqual(requests.map((request) => (request.connectorId as string[]).length).sort((a, b) => a - b), [1, ...Array(9).fill(100)]);
  assert.ok(maxActive > 1 && maxActive <= 8, `expected concurrency from 2 through 8, got ${maxActive}`);
  assert.ok(requests.every((request) => request.profile === "retained_count_summary"));
});

test("source: exact results do not expose a complete or incompleteness field", async () => {
  const source = await readFile(new URL("./existing-sources-by-connector.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bcomplete\s*[:?]/);
});
