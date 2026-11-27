// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { currentStateAddsToFailure, hereNowTitle } from "./one-sync-model.ts";

test("the 'Now' line is dropped when it repeats the failure already said", () => {
  const cause = "Steam was not available.";
  assert.equal(currentStateAddsToFailure("failed", cause, `Now: ${cause} DataConnect will try again at the next check.`), false);
  assert.equal(currentStateAddsToFailure("failed", cause, "Now: Steam is syncing."), true);
  assert.equal(currentStateAddsToFailure("finished", cause, "Now: Steam was not available."), true);
});

test("when nothing came from a failed sync, the totals are named as copied before it", () => {
  assert.equal(hereNowTitle("failed", false), "Already copied before this sync");
  assert.equal(hereNowTitle("failed", true), "What is here now");
  assert.equal(hereNowTitle("finished", false), "What is here now");
});
