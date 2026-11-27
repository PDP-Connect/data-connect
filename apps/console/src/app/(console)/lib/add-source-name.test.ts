// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

// Round 10 (F49): the page is called "Add a data source"; no other page names it "Add source" on screen.
test("no page text calls the add page 'Add source'", () => {
  const offenders = files(root).filter((path) =>
    readFileSync(path, "utf8").split("\n").some((line) => /\bAdd source\b/.test(line) && !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)));
  assert.deepEqual(offenders, []);
});
