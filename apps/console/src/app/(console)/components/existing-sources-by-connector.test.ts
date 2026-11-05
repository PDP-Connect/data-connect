// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

// Source structure preserves the R5 exactness ruling (add-source-perf-design-agy-0730.md; terminal-read-architecture-fable-0730.md §2 R5).

const MISSING_CURSOR = /continuation/;
const PAGE_UNAVAILABLE = /page unavailable/;
const COMPLETE_FIELD = /\bcomplete\s*[:?]/;

const requests: Record<string, unknown>[] = [];
let fetchPage: (request: Record<string, unknown>) => Promise<unknown>;
const moduleApi = (async () => {
  mock.module("../lib/ref-client.ts", {
    exports: {
      CONNECTOR_SUMMARY_PAGE_LIMIT_MAX: 100,
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

test("catalog lookup traverses the unfiltered feed and selects unique live catalog connections", async () => {
  const { existingSourcesByConnectorCatalog } = await moduleApi;
  requests.length = 0;
  fetchPage = async (request) =>
    request.cursor
      ? {
          data: [row("z-goodreads", "goodreads"), row("a-goodreads", "goodreads"), row("a-goodreads", "goodreads")],
          has_more: false,
        }
      : {
          data: [row("off-catalog", "other"), row("revoked", "goodreads", { status: "revoked" })],
          has_more: true,
          next_cursor: "second",
        };
  const ids = Array.from({ length: 1001 }, (_, index) => `connector-${index}`);
  const { byConnector: result, truncated } = await existingSourcesByConnectorCatalog([...ids, "goodreads", "goodreads"]);
  assert.equal(truncated, false);
  assert.deepEqual(Object.keys(result), ["goodreads"]);
  assert.deepEqual(
    result.goodreads?.map((source) => source.connectionId),
    ["a-goodreads", "z-goodreads"]
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.connectorId === undefined && request.limit === 100));
});

test("catalog lookup rejects page failures and missing continuation", async () => {
  const { existingSourcesByConnectorCatalog } = await moduleApi;
  fetchPage = async () => ({ data: [], has_more: true });
  await assert.rejects(existingSourcesByConnectorCatalog(["goodreads"]), MISSING_CURSOR);
  fetchPage = () => Promise.reject(new Error("page unavailable"));
  await assert.rejects(existingSourcesByConnectorCatalog(["goodreads"]), PAGE_UNAVAILABLE);
});

function refusal(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

test("catalog lookup keeps the pages already read when a continuation is refused", async () => {
  const { existingSourcesByConnectorCatalog, existingSourcesForConnector } = await moduleApi;
  for (const failure of [
    refusal(431, "Request Header Fields Too Large"),
    refusal(400, "this request is too large to page: its target takes 9 bytes"),
  ]) {
    fetchPage = async (request) => {
      if (request.cursor) {
        throw failure;
      }
      return { data: [row("kept", "goodreads")], has_more: true, next_cursor: "second" };
    };
    const { byConnector, truncated } = await existingSourcesByConnectorCatalog(["goodreads"]);
    assert.equal(truncated, true);
    assert.deepEqual(
      byConnector.goodreads?.map((source) => source.connectionId),
      ["kept"]
    );
    // A single-connector lookup has no use for a partial answer: it still throws.
    await assert.rejects(existingSourcesForConnector("goodreads"), (err) => err === failure);
  }
});

test("catalog lookup still throws for other failures, including a refusal-shaped status that is not one", async () => {
  const { existingSourcesByConnectorCatalog } = await moduleApi;
  for (const failure of [refusal(400, "limit must be a positive integer"), refusal(500, "too large to page"), refusal(401, "no")]) {
    fetchPage = () => Promise.reject(failure);
    await assert.rejects(existingSourcesByConnectorCatalog(["goodreads"]), (err) => err === failure);
  }
});

test("source: exact results do not expose a complete or incompleteness field", async () => {
  const source = await readFile(new URL("./existing-sources-by-connector.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, COMPLETE_FIELD);
});
