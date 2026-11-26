// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the console add-connection modality helpers. Which connectors
 * can enroll a local collector, and which are browser-bound, are facts of each
 * connector's manifest; see `local-collector-support.test.ts` and
 * `browser-connect-support.test.ts`. This module keeps no key list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { enrollmentKeyForCanonicalKey, isBrowserSessionBoundConnection } from "./connection-modality.ts";

test("isBrowserSessionBoundConnection classifies a connection by its source-binding kind, not the connector", () => {
  // Browser-session bindings repair by session repair, NOT static-secret capture,
  // even for a connector (like chatgpt) that also supports a username_password.
  assert.equal(isBrowserSessionBoundConnection("browser_collector"), true);
  assert.equal(isBrowserSessionBoundConnection("browser_enrollment_shell"), true);
  // Static-secret / account bindings are NOT session-bound → credential capture.
  assert.equal(isBrowserSessionBoundConnection("static_secret_draft"), false);
  assert.equal(isBrowserSessionBoundConnection("account"), false);
  assert.equal(isBrowserSessionBoundConnection("default_account"), false);
  assert.equal(isBrowserSessionBoundConnection(null), false);
  assert.equal(isBrowserSessionBoundConnection(undefined), false);
});

test("enrollmentKeyForCanonicalKey maps the two hyphenated slugs to their underscore enrollment keys", () => {
  assert.equal(enrollmentKeyForCanonicalKey("claude-code"), "claude_code");
  assert.equal(enrollmentKeyForCanonicalKey("google-takeout"), "google_takeout");
  assert.equal(enrollmentKeyForCanonicalKey("codex"), "codex");
  assert.equal(enrollmentKeyForCanonicalKey("https://registry.pdpp.dev/connectors/codex"), "codex");
});
