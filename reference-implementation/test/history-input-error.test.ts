// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { decodeHistoryCursor, HistoryInputError, historyBounds } from "../lib/history-query.ts";
import { readSyncHistory } from "../lib/sync-history.ts";
import { readAppHistory } from "../lib/app-history.ts";
import { mountRefSyncHistory, type HistoryHandler, type HistoryRouteContext } from "../server/routes/ref-sync-history.ts";
import { mountRefAppHistory } from "../server/routes/ref-app-history.ts";

test("a cursor that is not valid JSON is owner input, with a fixed message", () => {
  assert.throws(() => decodeHistoryCursor("not-a-cursor!"), (error: unknown) =>
    error instanceof HistoryInputError && error.message === "Invalid cursor");
  assert.deepEqual(decodeHistoryCursor(Buffer.from(JSON.stringify(["a", "1"])).toString("base64url")), ["a", "1"]);
});

test("invalid day ranges are owner input errors", () => {
  assert.throws(() => historyBounds({ first: "bad", last: "2026-11-25", offset: 0 }), HistoryInputError);
});

const valid = { first: "2026-11-01", last: "2026-11-30", offset: 0 };
const timestamp = "2026-11-25T00:00:00.000Z";
const encode = (fields: unknown) => Buffer.from(JSON.stringify(fields)).toString("base64url");

for (const field of ["first", "last", "day", "before"] as const) {
  test(`an impossible ${field} date is a HistoryInputError`, () => {
    assert.throws(() => historyBounds({ ...valid, [field]: "2026-13-45" }), HistoryInputError);
  });
}

const badCursors = [
  [null, "1"], [42, "1"], ["not-a-time", "1"], ["2026-13-45T00:00:00Z", "1"],
  [timestamp, 1], [timestamp, null], [timestamp, ""], [timestamp, {}],
];
for (const [name, read, id] of [
  ["sync", (input: typeof valid & { cursor: string }) => readSyncHistory({ ...input, day: "2026-11-25", connection_id: "account" }, "postgres", noStorage), "1"],
  ["app", (input: typeof valid & { cursor: string }) => readAppHistory("owner", { ...input, day: "2026-11-25", client_ids: ["app"] }, "postgres", noStorage), "evt_test"],
] as const) {
  test(`${name} rejects malformed cursor fields before any storage call`, async () => {
    for (const fields of [...badCursors, [timestamp, name === "sync" ? "not-a-number" : "   "]]) {
      await assert.rejects(read({ ...valid, cursor: encode(fields) }), HistoryInputError);
    }
    if (name === "sync") await assert.rejects(read({ ...valid, cursor: encode([timestamp, "9223372036854775808"]) }), HistoryInputError);
    // Timestamp rollovers have a finite Date.parse result but are not real calendar dates.
    await assert.rejects(read({ ...valid, cursor: encode(["2026-02-30T00:00:00.000Z", id]) }), HistoryInputError);
  });
}
async function noStorage(): Promise<{ rows: unknown[] }> { assert.fail("invalid cursor reached storage"); }

for (const mount of [mountRefSyncHistory, mountRefAppHistory]) {
  test(`${mount.name} answers 400 for impossible dates and malformed cursors`, async () => {
    let handler!: HistoryHandler;
    const ctx: HistoryRouteContext & { ownerSubjectId: () => string } = {
      requireOwnerSession: () => undefined,
      ownerSubjectId: () => "owner",
      pdppError: (_res, status, code) => ({ status, code }),
      handleError: () => { throw new Error("invalid history input reached the server-error handler"); },
    };
    mount({ get: (_path, ...handlers) => { handler = handlers.at(-1) as HistoryHandler; } }, ctx);
    const res = { json: () => assert.fail("invalid input produced a success response") };
    for (const field of ["first", "last", "day", "before"]) {
      assert.deepEqual(await handler({ query: { ...valid, [field]: "2026-13-45" } }, res), { status: 400, code: "invalid_request" });
    }
    for (const fields of badCursors) {
      assert.deepEqual(await handler({ query: { ...valid, day: "2026-11-25", connection_id: "account", client_ids: "app", cursor: encode(fields) } }, res), { status: 400, code: "invalid_request" });
    }
  });
}
