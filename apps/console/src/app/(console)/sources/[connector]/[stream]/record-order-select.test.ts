// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SELECT_FILE = fileURLToPath(new URL("./record-order-select.tsx", import.meta.url));

test("the sort control uses a sentence-case label", async () => {
  const src = await readFile(SELECT_FILE, "utf8");

  // DIRECTION.md, “Values”: labels use sentence case.
  assert.match(src, /<span>Sort<\/span>/);
  assert.match(src, /aria-label="sort records"/);
});
