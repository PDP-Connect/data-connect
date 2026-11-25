// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildEmptyGrantsDemoData, buildGrantsDemoData } from "./grants-demo-data.ts";

test("empty Apps demo has no rows or waiting requests while atlas keeps both", () => {
  const empty = buildEmptyGrantsDemoData();
  const atlas = buildGrantsDemoData();
  assert.equal(empty.grants.data.length, 0);
  assert.equal(empty.approvals.data.length, 0);
  assert.ok(atlas.grants.data.length > 0);
  assert.ok(atlas.approvals.data.length > 0);
});
