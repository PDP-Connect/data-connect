// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_ROOT = fileURLToPath(new URL(".", import.meta.url));
const BASELINE = 183;
const HAND_ROLLED_TEARDOWN = /(?:async\s+)?function\s+closeServer\s*\(|(?:const|let)\s+closeServer\s*=|\.\s*closeAllConnections\s*\(/;

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") && entry.name !== "close-test-server-ratchet.test.ts" ? [path] : [];
  });
}

test("test files do not increase the hand-rolled server teardown count", () => {
  const count = testFiles(TEST_ROOT).filter((path) => HAND_ROLLED_TEARDOWN.test(readFileSync(path, "utf8"))).length;

  assert.ok(
    count <= BASELINE,
    `Found ${count} test files hand-rolling server teardown (baseline ${BASELINE}). Lower the baseline by migrating files to closeTestServer; raising it requires an explicit reviewed change.`
  );
  assert.ok(
    count >= BASELINE,
    `Hand-rolled server teardown fell to ${count} files; lower BASELINE in test/close-test-server-ratchet.test.ts from ${BASELINE} to ${count} so the ratchet stays tight.`
  );
});
