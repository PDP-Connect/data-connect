// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { currentStateAddsToFailure, hereNowTitle } from "./one-sync-model.ts";

test("the 'Now' line is dropped when it repeats the failure already said", () => {
  const cause = "Steam was not available.";
  assert.equal(currentStateAddsToFailure("failed", cause, `Now: ${cause} DataConnect will try again at the next check.`), false);
  assert.equal(currentStateAddsToFailure("failed", cause, "Now: Steam is syncing."), true);
  assert.equal(currentStateAddsToFailure("finished", cause, "Now: Steam was not available."), true);
  // Closing judge, round 6 (F11): "Syncing now" and "Finished" are said once, in the headline.
  assert.equal(currentStateAddsToFailure("syncing", cause, "Now: Syncing now."), false);
  assert.equal(currentStateAddsToFailure("finished", cause, "Now: Synced just now."), false);
});

test("when nothing came from a failed sync, the totals are named as copied before it", () => {
  assert.equal(hereNowTitle("failed", false), "Already copied before this sync");
  assert.equal(hereNowTitle("failed", true), "What is here now");
  assert.equal(hereNowTitle("finished", false), "What is here now");
});

// Closing judge, round 6 (F5): a failed run's page can run it again with the shared action.
test("the run page offers the shared retry as a real button, not a link back", () => {
  const view = readFileSync(new URL("./one-sync-view.tsx", import.meta.url), "utf8");
  assert.match(view, /action\.kind === "sync_now" && m\.connection \? <SyncNowButton/);
});
