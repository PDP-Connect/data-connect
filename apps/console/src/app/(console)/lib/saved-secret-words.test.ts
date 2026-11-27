// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { savedSecretNoun, savedSecretUpdateLabel } from "./saved-secret-words.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("a saved key is a key, a saved username and password is sign-in details", () => {
  assert.equal(savedSecretNoun("api_key"), "key");
  assert.equal(savedSecretNoun("username_password"), "sign-in details");
  assert.equal(savedSecretUpdateLabel("api_key"), "Enter the key again");
  assert.equal(savedSecretUpdateLabel("username_password"), "Update sign-in details");
});

test("the source page and the status words take that name from the one rule", () => {
  const words = read("./source-status-words.ts");
  assert.match(words, /savedSecretNoun\(options\.credentialKind\)/);
  assert.match(words, /savedSecretUpdateLabel\(options\.credentialKind\)/);
  const page = read("../sources/[connector]/source-page.tsx");
  assert.match(page, /savedSecretUpdateLabel\(manifestCredentialKind\(manifest\)\)/);
  assert.doesNotMatch(page, /Your records and sign-in are kept/);
  assert.doesNotMatch(read("../sources/[connector]/add-another-account.tsx"), /second \{entry\.displayName\} sign-in/);
});
