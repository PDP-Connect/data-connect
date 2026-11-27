// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { keptSecretWord } from "./saved-secret-words.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

// Round 11 (F10): "Your records and <key|sign-in> are kept" takes its noun from the saved-secret function.
test("the saved-secret word is one function", () => {
  assert.equal(keptSecretWord("username_password"), "sign-in");
  assert.equal(keptSecretWord("api_key"), "key");
});

test("no sentence names what is kept by hand", () => {
  const offenders = files(root).filter((path) => /(sign-in|key)( details)? (are|is) kept/.test(readFileSync(path, "utf8").replace(/\$\{keptSecretWord[^}]*\}/g, "")) && !path.endsWith("saved-secret-words.ts") && !path.endsWith("sources/[connector]/actions.ts")); // actions.ts is pinned by source-action-contract.json (its pause toast names no source)
  assert.deepEqual(offenders, []);
});
