// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const globals = readFileSync(join(here, "..", "globals.css"), "utf8");
const sourcesCss = readFileSync(join(here, "sources", "sources-view.css"), "utf8");

function coarseBlocks(css: string): string {
  return css.split("@media (pointer: coarse)").slice(1).join("\n");
}

test("a bare checkbox is drawn at 22px on a coarse pointer, pressed through its 44px label", () => {
  const coarse = coarseBlocks(globals);
  assert.match(coarse, /input\[type="checkbox"\][^{}]*\{[^}]*height:\s*22px/);
  assert.match(coarse, /label:has\(>\s*input\[type="checkbox"\][^{]*\{[^}]*min-height:\s*44px/);
});

test("the row menu trigger is 44px on a coarse pointer", () => {
  const coarse = coarseBlocks(sourcesCss);
  assert.match(coarse, /\.rr-s-menu-trigger[^{}]*\{[^}]*(width|min-width):\s*44px/);
  assert.match(coarse, /\.rr-s-menu-trigger[^{}]*\{[^}]*(height|min-height):\s*44px/);
});

// Round 7 (F30, F47): `.pdpp-btn--sm` sets min-height: 0 outside any layer, so the Tailwind class
// `min-h-11` on a small button lost and the button drew 33px tall.
test("a small button that asks for min-h-11 gets it, whatever the brand sheet says", () => {
  assert.match(globals, /\.pdpp-btn--sm\.min-h-11\s*\{[^}]*min-height:\s*44px/);
});
