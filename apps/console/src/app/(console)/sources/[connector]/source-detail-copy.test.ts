// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { plainDataSourceCopy } from "./source-detail-copy.ts";

test("owner-facing detail copy replaces the page's internal vocabulary", () => {
  const copy = plainDataSourceCopy(
    "The connector's stream run has coverage. This connection's grant uses a bearer token from the manifest projection on the fleet reference server."
  );

  // PAGE-RULES item 6: visible copy uses plain data-source, record and sync words.
  assert.doesNotMatch(copy, /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|connection|instance|reference server)\b/i);
  assert.match(copy, /data source/);
  assert.match(copy, /kind of record/);
  assert.match(copy, /sync/);
});
