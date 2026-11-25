// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./[connectorId]/page.tsx", import.meta.url));

test("provider authorization has the account action and one way back", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /title=[\s\S]{0,200}Connect \{displayName\}/);
  assert.match(page, /Allow DataConnect to read your \{displayName\} account\./);
  assert.match(page, /Continue to \{displayName\}/);
  assert.equal((page.match(/Back to Data sources/g) ?? []).length, 1);
  // The setup status message is specific to the provider authorization page.
  assert.match(page, /supportsProviderAuth\(/);
  assert.match(page, /notFound\(\)/);
});

test("provider authorization start and failure copy avoid banned words outside Details", () => {
  const samples = [
    "Connect Gmail. Allow DataConnect to read your Gmail account. Continue to Gmail.",
    "Could not start access. Try again.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
