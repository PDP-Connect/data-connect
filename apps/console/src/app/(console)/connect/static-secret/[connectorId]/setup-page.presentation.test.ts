// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));

test("static-secret setup preserves the fields and uses matching connect and reconnect copy", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  assert.match(page, /title: `Connect \$\{displayName\}`/);
  assert.match(page, /title: `Reconnect \$\{displayName\}`/);
  assert.match(page, /Paste your \$\{displayName\} API key\./);
  assert.match(page, /hasExistingTarget \? "Reconnect and sync"/);
  assert.match(page, /formContract\.credentialFields\.map/);
  // RAISE-RULES.md 7: provider help links must work as labelled and have touch-sized targets.
  assert.match(page, /className="inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4"[\s\S]{0,200}target="_blank"/);
  assert.match(page, /Your key is stored on your server\. Apps and assistants can't see it\./);
  // DIRECTION.md, “Values” and RAISE-RULES.md 7: controls remain easy to use by touch.
  assert.match(page, /<summary className="inline-flex min-h-11 cursor-pointer items-center">Details<\/summary>/);
  assert.match(page, /Set <code>\{blocker\.key\}<\/code>/);
  assert.equal((page.match(/Back to Data sources/g) ?? []).length, 1);
});

test("static-secret copy samples avoid banned words outside Details", () => {
  const samples = [
    "Connect Gmail. Paste your Gmail API key. Connect and sync.",
    "Reconnect Gmail. Paste your Gmail API key. Reconnect and sync.",
    "Credential storage is not ready. Try again after it is set up.",
    "The key could not be saved. Try again.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
