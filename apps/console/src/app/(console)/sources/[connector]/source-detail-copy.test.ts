// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_ERROR_COPY } from "./source-detail-copy.ts";

test("action errors use plain copy while raw server text is disclosed separately", () => {
  // Brief decision 4: show a plain sentence and keep the raw response in folded Details.
  assert.equal(ACTION_ERROR_COPY, "This could not be done. Try again.");
});
