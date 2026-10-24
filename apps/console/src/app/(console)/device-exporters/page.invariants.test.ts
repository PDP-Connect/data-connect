// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const REFERENCE_EXPERIMENTAL_CHIP_RE = /reference-experimental/;

// Walkthrough item A10: the constant "surface reference-experimental" chip is a
// developer label, not a consumer affordance.
test("source: device exporters page shows no reference-experimental chip", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, REFERENCE_EXPERIMENTAL_CHIP_RE);
});
