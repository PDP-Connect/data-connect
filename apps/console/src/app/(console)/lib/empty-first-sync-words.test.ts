// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as syncCause from "./sync-cause.ts";
import { outcomeCopy } from "../connect/status/[connectionId]/first-sync-outcome.ts";
import { UNMEASURED_CAVEAT } from "./source-status-words.ts";

// Round 7 (F27, F35).
test("the list row and the first-sync page say an empty first sync in the same words, with what to check", () => {
  const words = readFileSync(fileURLToPath(new URL("./source-status-words.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(words, /First sync found no records/);
  assert.match(words, /emptyFirstSyncWords\(name\)/);
  const { EMPTY_FIRST_SYNC_CHECK, emptyFirstSyncWords } = syncCause as unknown as { EMPTY_FIRST_SYNC_CHECK: string; emptyFirstSyncWords: (name: string) => string };
  assert.equal(outcomeCopy.emptyHeadline("Steam"), emptyFirstSyncWords("Steam"));
  assert.match(emptyFirstSyncWords("Steam"), /Steam is connected, but nothing came back\./);
  assert.match(EMPTY_FIRST_SYNC_CHECK, /^Check /);
});

test("the caveat about an unmeasured copy says whether the person has anything to do", () => {
  assert.match(UNMEASURED_CAVEAT, /can't yet tell whether it got everything\. Nothing for you to do\.$/);
});
