// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mountRefSyncHistory, type HistoryHandler } from "../server/routes/ref-sync-history.ts";
test("sync history uses the owner gate and rejects invalid days before reading", async () => {
  const gate = () => undefined;
  let handlers: unknown[] = [];
  const errors: number[] = [];
  mountRefSyncHistory({ get: (path, ...args) => { assert.equal(path, "/_ref/sync-history"); handlers = args; } }, {
    requireOwnerSession: gate,
    pdppError: (_res, status) => { errors.push(status); },
    handleError: (_res, error) => { throw error; },
  });
  assert.equal(handlers[0], gate);
  const handler = handlers[1] as HistoryHandler;
  await handler({ query: { first: "bad", last: "2026-11-25" } }, { json: () => undefined });
  assert.deepEqual(errors, [400]);
});
