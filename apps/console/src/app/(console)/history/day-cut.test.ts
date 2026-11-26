// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { personOffset, personDay, personDate, historyDayCount, historyHref } from "./day-cut.ts";
test("the person's cookie overrides the server; missing and invalid cookies use the server", () => {
  assert.equal(personOffset("120", -360), 120);
  for (const value of [undefined,"","bad","841","2.5"]) { assert.equal(personOffset(value, -360),-360); }
  assert.equal(personDay("2026-11-24T23:30:00Z",120),"2026-11-25");
  assert.equal(personDay("2026-11-24T23:30:00Z",-360),"2026-11-24");
});
test("day paging validates URL input and filters reset the day count", () => {
  assert.equal(historyDayCount("14"),14); assert.equal(historyDayCount("bad"),7);
  assert.equal(historyHref("/syncs", { days: "14", connection_id: "mail" }, { days: undefined, only_problems: "true" }), "/syncs?connection_id=mail&only_problems=true");
});

test("absolute dates use the same reader day as history on both sides of midnight", () => {
  assert.equal(personDate("2026-11-26T01:12:00Z", -360), "25 Nov 2026");
  assert.equal(personDate("2026-11-25T23:12:00Z", 120), "26 Nov 2026");
});
