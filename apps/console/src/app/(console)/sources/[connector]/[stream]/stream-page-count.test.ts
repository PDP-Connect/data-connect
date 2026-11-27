// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStreamPageCount } from "./stream-page-count.ts";

const base = { filtered: false, hasMore: false, matchingCount: null, pageNumber: 1, shown: 2, totalHeld: 2 };

test("one page that holds everything reads '2 records', not 'Page 1 · 2 of 2'", () => {
  // Round 10 (F26): the header already says "2 records"; an unfiltered single page adds no second line.
  assert.equal(formatStreamPageCount(base), null);
  assert.equal(formatStreamPageCount({ ...base, shown: 1, totalHeld: 1 }), null);
  assert.equal(formatStreamPageCount({ ...base, filtered: true, matchingCount: 2 }), "2 matching records");
});

test("a page number still shows when there is more than one page", () => {
  assert.equal(formatStreamPageCount({ ...base, hasMore: true, totalHeld: 40 }), "Page 1 · 2 of 40");
  assert.equal(formatStreamPageCount({ ...base, pageNumber: 2 }), "Page 2 · 2 of 2");
});
