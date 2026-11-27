// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packagesCopy } from "../settings/packages/package-rows-model.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("Experimental is a badge, not a plain word in the title", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8");
  assert.match(page, /data-testid="experimental-badge"/);
  assert.match(page, /rounded-full border/);
});

test("the empty line has room above it, away from the button", async () => {
  const list = await readFile(`${HERE}collector-list.tsx`, "utf8");
  assert.match(list, /<p className="pt-6[^"]*">No collectors yet\.<\/p>/);
});

test("with no data source updates the page says everything is up to date", () => {
  assert.equal(packagesCopy.empty, "Every data source is up to date.");
});
