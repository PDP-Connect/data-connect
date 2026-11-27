// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { sourceRecordLabelInSentence } from "./source-record-label.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnerRecordKind } from "./source-record-label.ts";

test("known bookkeeping kinds stay off the owner list without hiding ordinary records", () => {
  for (const name of ["coverage_diagnostics", "config_inventory", "cache_inventory", "context_mode", "session_index"]) assert.equal(isOwnerRecordKind(name), false, name);
  assert.equal(isOwnerRecordKind("attachments", "claude-code"), false);
  assert.equal(isOwnerRecordKind("attachments", "mail"), true);
  for (const name of ["events", "messages", "sessions", "orders", "diagnostic_messages"]) assert.equal(isOwnerRecordKind(name), true, name);
});

test("local collector bookkeeping uses the same predicate on every owner surface",()=>{
 for(const kind of ["usage","file_history","debug_artifacts","downloads","logs","attachments"]) {assert.equal(isOwnerRecordKind(kind,"claude-code"),false,kind);}
 for(const kind of ["history","memories"]) {assert.equal(isOwnerRecordKind(kind,"codex"),false,kind);}
 assert.equal(isOwnerRecordKind("history","mail"),true);
});

// Round 10 (F17): a record kind inside a sentence drops its capital, by this one function.
test("a record kind inside a sentence is lower-cased when it opens with a common word", () => {
  const streams = [{ name: "friends", display: { label: "Your Steam friends" } }] as never;
  assert.equal(sourceRecordLabelInSentence("friends", streams), "your Steam friends");
  assert.equal(sourceRecordLabelInSentence("transactions"), "transactions");
});
