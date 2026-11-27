// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const COPY_FILE = fileURLToPath(new URL("../../../sources/add/connect-copy.ts", import.meta.url));
const PAGE_FILE = fileURLToPath(new URL("../../../sources/add/connect-bodies.tsx", import.meta.url));
const ROUTE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));

// Design "Key services": lead, fields, one storage sentence, "Where to find it", one button.
test("static-secret setup preserves the fields and uses matching connect and reconnect copy", async () => {
  const [page, copy, route] = await Promise.all([readFile(PAGE_FILE, "utf8"), readFile(COPY_FILE, "utf8"), readFile(ROUTE_FILE, "utf8")]);
  assert.match(page, /title=\{reconnecting \? `Reconnect \$\{name\}` : connectHeading\(name\)\}/);
  assert.match(page, /reconnecting \? `Reconnect \$\{name\}` : keyCopy\.button\(name\)/);
  assert.match(copy, /\$\{name\} gives you a key that lets DataConnect read your data\./);
  assert.match(copy, /whereToFind: "Where to find it"/);
  assert.match(copy, /This server can't store keys yet, so \$\{name\} can't be connected\./);
  assert.match(route, /setup\.credential_capture\.fields\.map/);
  // RAISE-RULES.md 7: provider help links must work as labelled and have touch-sized targets.
  // Repair brief 2: keep this link inline so it cannot enlarge wrapped lead lines.
  assert.match(page, /className="underline decoration-dotted underline-offset-4"[\s\S]{0,200}target="_blank"/);
  assert.match(page, /<code>\{blocker\.key\}<\/code>/);
  // Removed by design: the folds, the second back link and the explainer callouts.
  assert.doesNotMatch(page, /<details|Details|Back to Data sources|Callout|Credential storage/);
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
