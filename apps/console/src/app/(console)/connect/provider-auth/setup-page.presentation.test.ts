// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./[connectorId]/page.tsx", import.meta.url));

test("provider authorization has the account action and shared service heading", async () => {
  const page = await readFile(PAGE_FILE, "utf8") + await readFile(new URL("./[connectorId]/provider-auth-body.tsx", import.meta.url), "utf8");
  assert.match(page, /<ConnectHeader/);
  assert.match(page, /DataConnect never sees your/);
  assert.match(page, /Continue to \{displayName\}/);
  assert.equal((page.match(/Back to Data sources/g) ?? []).length, 0);
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
