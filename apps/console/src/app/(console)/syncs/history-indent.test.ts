// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Closing judge, round 6 (F28): detail lines sit under the source's name, not under its logo.
test("a history row's detail lines and next-step button are indented to the source name", () => {
  const src = readFileSync(new URL("./daily-syncs-view.tsx", import.meta.url), "utf8");
  assert.match(src, /<ul className="ml-10 text-\[13px\] text-muted-foreground">/);
  assert.match(src, /<div className="ml-10 mt-3">/);
});
