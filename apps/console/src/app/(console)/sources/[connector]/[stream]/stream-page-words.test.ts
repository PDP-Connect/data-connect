// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the stream page's total line uses words an owner knows, not stream metadata or source summary", async () => {
  const source = await readFile(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
  const label = source.slice(source.indexOf("function streamTotalEvidenceLabel"));
  assert.doesNotMatch(label.slice(0, 500), /stream metadata|source summary|Retained records for this stream/);
  assert.match(label.slice(0, 500), /DataConnect holds/);
});
