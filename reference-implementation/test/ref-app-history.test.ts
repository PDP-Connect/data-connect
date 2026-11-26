// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mountRefAppHistory } from "../server/routes/ref-app-history.ts";
import type { HistoryHandler } from "../server/routes/ref-sync-history.ts";
test("app history uses the owner gate and rejects invalid UTC distances before reading", async () => {
  const gate = () => undefined;
  let handlers: unknown[] = [];
  const errors: number[] = [];
  mountRefAppHistory({ get: (path, ...args) => { assert.equal(path, "/_ref/app-history"); handlers = args; } }, {
    requireOwnerSession: gate, ownerSubjectId: () => "owner",
    pdppError: (_res, status) => { errors.push(status); },
    handleError: (_res, error) => { throw error; },
  });
  assert.equal(handlers[0], gate);
  await (handlers[1] as HistoryHandler)({ query: { first: "2026-11-25", last: "2026-11-25", offset: "10000" } }, { json: () => undefined });
  assert.deepEqual(errors, [400]);
});
