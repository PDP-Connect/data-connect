// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInteractionPrompt } from "./interaction-prompt.ts";

test("uses the server prompt for OTP and plain browser steps on one line", () => {
  assert.equal(
    normalizeInteractionPrompt("Enter the code\nStrava sent to your phone.", "Sign in to Strava."),
    "Enter the code Strava sent to your phone."
  );
  assert.equal(
    normalizeInteractionPrompt("Review the security notice in your browser.", "Sign in to Strava."),
    "Review the security notice in your browser."
  );
});

test("uses the existing fallback when the server prompt is blank", () => {
  assert.equal(normalizeInteractionPrompt("  \n ", "Sign in to Strava."), "Sign in to Strava.");
});
