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

// Round 11 (F40): a "Technical details" link is one component, so every page draws it the same way.
test("no page draws its own Technical details link", () => {
  const offenders = files(root).filter((path) => !path.endsWith("technical-details-link.tsx") && /(<Link|<a|<Text)[^>]*>\s*Technical details\s*<\/(Link|a|Text)>/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
