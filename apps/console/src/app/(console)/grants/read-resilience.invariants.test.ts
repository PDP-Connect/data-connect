// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ERROR_FILE = `${HERE}error.tsx`;

test("the Apps boundary gives one plain sentence and a Try again action", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  // Brief decision 6: a failed state has one plain sentence and a Try again action.
  assert.match(src, /Apps could not be loaded\./);
  assert.match(src, /<IcButton onClick=\{reset\}[^>]*>Try again<\/IcButton>/);
  assert.doesNotMatch(src, /setTimeout|retryCounter|ListLoadingSkeleton/);
});

test("the Apps boundary stays free of server-only imports", async () => {
  const src = await readFile(ERROR_FILE, "utf8");
  assert.doesNotMatch(src, /^import[\s\S]*from\s+["'][^"']*(owner-token|server-only|ref-client)/m);
});
