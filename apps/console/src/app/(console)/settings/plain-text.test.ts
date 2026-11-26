// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { humanizeKey, plain } from "./plain-text.ts";

test("plain keeps opaque values and only humanizes known labels", () => {
  for (const value of [
    "Open https://example.com/reset_password?client_id=My_App",
    "the file",
    "runtime.example.com",
    "runtime.attached=true",
    "user_name@example.com",
    "my-host.example.net",
  ]) assert.strictEqual(plain(value), value);
  assert.strictEqual(plain("Go to host.example.com, then sign_in."), "Go to host.example.com, then sign in.");
  assert.strictEqual(plain("The (runtime.attached), [secrets.backend]; installer.execute!"), "The (runtime attached), [secrets backend]; installer execute!");
  assert.strictEqual(plain("The (runtime.attached), [the file]; installer.execute!"), "The (runtime attached), [the file]; installer execute!");
  assert.strictEqual(plain("OWNER_PASSWORD_REQUIRED"), "owner password required");
  assert.strictEqual(humanizeKey("metadataVisibleTo"), "Metadata visible to");
});
