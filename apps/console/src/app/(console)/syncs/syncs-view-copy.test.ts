// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./syncs-view.tsx", import.meta.url), "utf8");

test("sync groups keep the connection id out of visible text", () => {
  assert.match(source, /data-connection-id=\{group\.connectionId\}/);
  assert.doesNotMatch(source, /className="rr-sync-group__cin">\s*\{group\.connectionId\}/);
});

test("per-kind sync outcomes use sentence case", () => {
  const formatter = source.slice(source.indexOf("function formatCollectedThisRun"), source.indexOf("function coverageSuffix"));
  assert.match(formatter, /return "Skipped"/);
  assert.match(formatter, /return "No change"/);
});
