// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./interaction-form.tsx", import.meta.url)), "utf8");

test("cancelling a request asks for confirmation before submitting the cancellation", () => {
  assert.match(source, /function handleCancel\(\) \{\s*setConfirmingCancel\(true\);\s*\}/);
  assert.match(source, /function confirmCancel\(\) \{\s*submitWithStatus\(new FormData\(\), "cancelled"\);/);
  assert.match(source, /Cancel this request\? DataConnect stops waiting for your answer\./);
  assert.match(source, /Yes, cancel interaction/);
  assert.match(source, /Keep answering/);
  // DIRECTION.md, “What must stay true” #4: preserve the existing interaction-cancel control.
  assert.match(source, /Cancel interaction/);
});
