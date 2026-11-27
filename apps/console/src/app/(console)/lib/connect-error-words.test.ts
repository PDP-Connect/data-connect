// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectErrorWords } from "./connect-error-words.ts";

test("a server message that echoes a typed key never reaches the words", () => {
  for (const raw of ["Invalid key sk-live-abc123", "sk-live-abc123 is not valid", "Failed to fetch sk-live-abc123"]) {
    assert.doesNotMatch(connectErrorWords(raw), /sk-live-abc123/);
  }
  assert.equal(connectErrorWords("Invalid key sk-live-abc123"), "The service did not accept what was entered. Check it and try again.");
  assert.equal(connectErrorWords("kaboom sk-live-abc123"), "Something went wrong. Nothing was saved.");
});

test("the connect form fold renders the authored words, not the server message", () => {
  const parts = readFileSync(new URL("../sources/add/connect-parts.tsx", import.meta.url), "utf8");
  assert.match(parts, /connectErrorWords\(message\)/);
  assert.doesNotMatch(parts, /message\.replaceAll/);
});
