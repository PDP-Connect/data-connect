// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const LAUNCH_FILE = fileURLToPath(new URL("./launch/page.tsx", import.meta.url));
const LAUNCH_PANEL_FILE = fileURLToPath(new URL("./launch/launch-panel.tsx", import.meta.url));

test("browser-session setup keeps one clear action and a single way back", async () => {
  const [page, launch, panel] = await Promise.all([
    readFile(PAGE_FILE, "utf8"),
    readFile(LAUNCH_FILE, "utf8"),
    readFile(LAUNCH_PANEL_FILE, "utf8"),
  ]);
  assert.match(page, /`Connect \$\{displayName\}`/);
  assert.match(page, /Sign in to \$\{displayName\} in the browser below\./);
  // Setup-pages brief 1: Reconnect must not say the data source cannot be connected while it offers Reconnect.
  assert.match(page, /const setupDescription = repairMode \|\| supportedBrowserCollector\s*\? `Sign in to/);
  assert.match(page, /repairMode \? `Reconnect \$\{displayName\}` : "Connect account"/);
  // RAISE-RULES.md 7: provider help links must work as labelled and have touch-sized targets.
  assert.match(page, /className="inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4"[\s\S]{0,200}target="_blank"/);
  assert.equal((page.match(/Back to Data sources/g) ?? []).length, 1);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /browserConnect\.canAddAccount/);
  // RAISE-RULES.md 1: keep the route to an existing source available in Details.
  assert.match(page, /href="\/sources"[\s\S]{0,200}Choose an existing data source/);
  assert.match(launch, /title=\{`Connect \$\{displayName\}`\}/);
  assert.match(launch, /Back to Data sources/);
  assert.match(panel, /The browser could not open\. Try again\./);
  assert.match(panel, /Open sync history/);
  assert.match(panel, /state\.error\.replaceAll\(\/PDPP/);
});

test("browser-session copy examples use plain words in start, repair, unavailable, and failed states", () => {
  const samples = [
    "Connect Gmail. Sign in to Gmail in the browser below. Connect account.",
    "Reconnect Gmail. Sign in to Gmail in the browser below. Reconnect Gmail.",
    "This data source cannot be connected here yet. Add a data source.",
    "Could not start the browser. Try again.",
  ];
  const banned = /\b(?:PDPP|verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server)\b/i;
  for (const sample of samples) assert.doesNotMatch(sample, banned);
});
