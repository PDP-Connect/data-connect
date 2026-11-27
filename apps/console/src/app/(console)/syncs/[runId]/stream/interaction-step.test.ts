// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { interactionStepLabel } from "./interaction-step.ts";

test("the step comes from what the run is asking for", () => {
  assert.equal(interactionStepLabel("otp"), "Step 2 of 2: enter the security code");
  assert.equal(interactionStepLabel("manual_action"), "Step 1 of 2: sign in");
  assert.equal(interactionStepLabel(undefined), "Step 1 of 2: sign in");
});

test("the instruction panel takes its step line from the interaction, not a fixed 'Step 1'", () => {
  const source = readFileSync(new URL("./stream-viewer.tsx", import.meta.url), "utf8");
  assert.match(source, /interactionStepLabel\(interactionKind\)/);
  assert.doesNotMatch(source, /<p className="pdpp-caption text-muted-foreground">Step 1 of 2: sign in<\/p>/);
});
