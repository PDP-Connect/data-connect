// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { decodeHistoryCursor, HistoryInputError, historyBounds } from "../lib/history-query.ts";

test("a cursor that is not valid JSON is owner input, with a fixed message", () => {
  assert.throws(() => decodeHistoryCursor("not-a-cursor!"), (error: unknown) =>
    error instanceof HistoryInputError && error.message === "Invalid cursor");
  assert.deepEqual(decodeHistoryCursor(Buffer.from(JSON.stringify(["a", "1"])).toString("base64url")), ["a", "1"]);
});

test("invalid day ranges are owner input errors", () => {
  assert.throws(() => historyBounds({ first: "bad", last: "2026-11-25", offset: 0 }), HistoryInputError);
});
