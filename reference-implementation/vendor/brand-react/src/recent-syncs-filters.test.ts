// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Syncs "Recent syncs" filters form one compact row.
 *
 * Walkthrough 2026-10-23, item A9: `.pdpp-select { width: 100% }` made each filter
 * take a full row inside the wrapping form, so the page showed two full-width
 * selects and an Apply button on separate lines. Each select must size to its own
 * label instead, and the toolbar must wrap only when the row runs out of width.
 * JSDOM computes no layout, so this pins the CSS source values, as
 * `touch-target.test.ts` does.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CSS_FILE = fileURLToPath(new URL("./components.css", import.meta.url));

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must exist in components.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("each recent-syncs filter select sizes to its own label, not to the full row", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".rr-sync__filter .pdpp-select");
  assert.match(rule, /\bwidth:\s*auto;/, ".rr-sync__filter .pdpp-select must not take 100% of the row");
});

test("the recent-syncs filter toolbar is a wrapping row, not a column", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".rr-sync__recent-filters");
  assert.match(rule, /\bdisplay:\s*flex;/, ".rr-sync__recent-filters must be a flex row");
  assert.match(rule, /\bflex-wrap:\s*wrap;/, ".rr-sync__recent-filters must wrap only when the row is full");
  assert.doesNotMatch(rule, /flex-direction:\s*column/, ".rr-sync__recent-filters must not stack its items");
});
