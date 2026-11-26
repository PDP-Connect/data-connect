import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnerRecordKind } from "./source-record-label.ts";

test("known bookkeeping kinds stay off the owner list without hiding ordinary records", () => {
  for (const name of ["coverage_diagnostics", "config_inventory", "cache_inventory", "context_mode", "session_index"]) assert.equal(isOwnerRecordKind(name), false, name);
  assert.equal(isOwnerRecordKind("attachments", "claude-code"), false);
  assert.equal(isOwnerRecordKind("attachments", "mail"), true);
  for (const name of ["events", "messages", "sessions", "orders", "diagnostic_messages"]) assert.equal(isOwnerRecordKind(name), true, name);
});
