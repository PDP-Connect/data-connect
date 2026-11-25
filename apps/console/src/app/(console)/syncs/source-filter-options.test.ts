// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  loadSourceFilterOptions,
  SOURCE_FILTER_CAP_NOTE,
  SOURCE_FILTER_MAX_PAGES,
} from "./source-filter-options.ts";

const CAP_NOTE_RE = /^Only the first 1,000 data sources are listed here\.$/;
const LOAD_FAILED_NOTE_RE = /could not be loaded/;

test("source filter options include sources beyond the first 100", async () => {
  const sources = Array.from({ length: 101 }, (_, index) => ({
    connector_display_name: `Source ${index + 1}`,
    connector_id: `source-${index + 1}`,
  }));
  const requestedCursors: string[] = [];

  const result = await loadSourceFilterOptions(
    { hasMore: true, items: sources.slice(0, 100), kind: "ok", nextCursor: "page-2" },
    async (cursor) => {
      requestedCursors.push(cursor);
      return {
        hasMore: false,
        items: sources.slice(100),
        kind: "ok",
        nextCursor: undefined,
      };
    },
    undefined
  );

  assert.deepEqual(requestedCursors, ["page-2"]);
  assert.equal(result.options.length, 102);
  assert.equal(result.options.at(-1)?.value, "source-99");
  assert.equal(result.options.some((option) => option.value === "source-101"), true);
  assert.equal(result.note, null);
});

test("an active filter for a source on a later page keeps that source's own name", async () => {
  // history-repair brief P2: filtering by a source past the first page must show its name, not its key.
  const result = await loadSourceFilterOptions(
    { hasMore: true, items: [{ connector_display_name: "Alpha", connector_id: "alpha" }], kind: "ok", nextCursor: "p2" },
    async () => ({ hasMore: false, items: [{ connector_display_name: "Zeta mail", connector_id: "zeta" }], kind: "ok" }),
    "zeta"
  );

  assert.deepEqual(
    result.options.map((option) => option.label),
    ["All data sources", "Alpha", "Zeta mail"]
  );
});

test("source filter reports when its bounded page walk reaches the cap", async () => {
  let reads = 0;
  const result = await loadSourceFilterOptions(
    { hasMore: true, items: [{ connector_id: "first" }], kind: "ok", nextCursor: "cursor-1" },
    async (cursor) => {
      reads += 1;
      return {
        hasMore: true,
        items: [{ connector_id: cursor }],
        kind: "ok",
        nextCursor: `cursor-${Number(cursor.slice("cursor-".length)) + 1}`,
      };
    },
    undefined
  );

  // The walk reruns on every History load (and every 3 s while a sync is live): keep it small.
  assert.equal(SOURCE_FILTER_MAX_PAGES, 10);
  assert.equal(reads, SOURCE_FILTER_MAX_PAGES - 1);
  assert.equal(result.note, SOURCE_FILTER_CAP_NOTE);
  assert.match(result.note ?? "", CAP_NOTE_RE);
  assert.equal(result.options.length, SOURCE_FILTER_MAX_PAGES + 1);
});

test("a failed later page keeps the sources already read and says some are missing", async () => {
  const result = await loadSourceFilterOptions(
    { hasMore: true, items: [{ connector_id: "first" }], kind: "ok", nextCursor: "p2" },
    async () => ({ kind: "error" }),
    undefined
  );

  assert.deepEqual(
    result.options.map((option) => option.value),
    ["", "first"]
  );
  assert.match(result.note ?? "", LOAD_FAILED_NOTE_RE);
});
