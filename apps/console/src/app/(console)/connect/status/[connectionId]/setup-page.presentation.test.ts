// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));

test("setup status keeps its source title, one sentence, and one primary action", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /description=\{`\$\{described\.headline\}\.`\}/);
  assert.match(page, /\{displayName\}/);
  assert.match(page, /Open \{displayName\}/);
  assert.match(page, /Back to Data sources/);
  assert.equal((page.match(/variant: "default"/g) ?? []).length, 2);
  assert.match(page, /<details className="mt-5 max-w-2xl">/);
  assert.match(page, /Health projected/);
  assert.match(page, /Reason: \{status\.last_error\.reason\.replaceAll/);
  assert.match(page, /status\.connection_id/);
  assert.match(page, /sourceRecordsHref\(status\)/);
});

test("status copy samples avoid banned words outside Details", () => {
  const samples = [
    "Gmail. Connection active. Open Gmail.",
    "Gmail. First sync running.",
    "Gmail. First sync failed. Re-enter credential and retry.",
    "Gmail. Import complete. Open Gmail.",
    "Gmail. No records collected.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
