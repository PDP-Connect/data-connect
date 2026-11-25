// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("../../../sources/add/connect-bodies.tsx", import.meta.url));
const COPY_FILE = fileURLToPath(new URL("../../../sources/add/connect-copy.ts", import.meta.url));
const LAUNCH_FILE = fileURLToPath(new URL("./launch/page.tsx", import.meta.url));
const LAUNCH_PANEL_FILE = fileURLToPath(new URL("./launch/launch-panel.tsx", import.meta.url));

// Design "Sign-in services" and "Cannot be connected on this install".
test("browser-session setup keeps one clear action and one way back", async () => {
  const [page, launch, panel, copy] = await Promise.all([
    readFile(PAGE_FILE, "utf8"),
    readFile(LAUNCH_FILE, "utf8"),
    readFile(LAUNCH_PANEL_FILE, "utf8"),
    readFile(COPY_FILE, "utf8"),
  ]);
  assert.match(page, /title=\{repairMode \? `Reconnect \$\{name\}` : connectHeading\(name\)\}/);
  assert.match(copy, /DataConnect signs in to \$\{name\} for you, in a browser you can watch\. If \$\{name\} asks for a code, you type it there\./);
  assert.match(copy, /Your password is stored encrypted on the computer that runs DataConnect\. It is sent only to \$\{name\}\./);
  assert.match(copy, /Save my sign-in so DataConnect can sign in again without me/);
  // Reconnect still works where adding a new account is unavailable.
  assert.match(page, /if \(!\(repairMode \|\| canConnect\)\)/);
  assert.match(await readFile(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8"), /notFound\(\)/);
  // The live sign-in pages are not part of this change (design "Not in this trial").
  assert.match(launch, /title=\{`Connect \$\{displayName\}`\}/);
  assert.match(launch, /Back to Data sources/);
  assert.match(panel, /The browser could not open\. Try again\./);
  assert.match(panel, /Open sync history/);
  assert.match(panel, /state\.error\.replaceAll\(\/PDPP/);
});

test("browser-session copy examples use plain words in start, repair, unavailable, and failed states", () => {
  const samples = [
    "Connect Gmail. DataConnect signs in to Gmail for you, in a browser you can watch.",
    "Reconnect Gmail. Reconnect Gmail.",
    "Gmail can't be added here yet. Back to all services.",
    "The sign-in could not start. Try again.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
