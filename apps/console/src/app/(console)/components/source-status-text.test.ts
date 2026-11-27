// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// L7: status words ("Paused", "Disconnected") are 13 px text and need 4.5:1 in light and dark.
// A fading alpha on the muted token measured 4.30:1 in light, so no tone may thin its colour.
test("no status tone thins its text colour with an alpha", async () => {
  const source = await readFile(fileURLToPath(new URL("./source-status-text.tsx", import.meta.url)), "utf8");
  const tones = source.match(/TONE_CLASS[^{]*\{([\s\S]*?)\};/);
  const table = tones?.[1];
  assert.ok(table, "the tone table");
  assert.doesNotMatch(table, /text-[a-z-]+\/\d+/);
});
