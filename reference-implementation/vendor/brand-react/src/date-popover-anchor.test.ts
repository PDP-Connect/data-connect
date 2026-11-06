// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Explore date-filter popover must hang from the chip's right edge.
 *
 * Walkthrough 2026-10-23, item A7: the chip sits at the right end of the Explore
 * search row, but the popover was anchored with `left: 0` at 280 px wide. It ran
 * 102 px past the window at every desktop width from 900 to 1920 px, so the To
 * field and Apply were unreachable. JSDOM computes no layout, so this pins the CSS
 * source values a browser resolves into the fitted position, as
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

/** The text of every `@media (max-width: 860px) { … }` block, braces matched. */
function phoneBlocks(css: string): string[] {
  const open = "@media (max-width: 860px) {";
  const blocks: string[] = [];
  for (let at = css.indexOf(open); at !== -1; at = css.indexOf(open, at + open.length)) {
    let depth = 0;
    let end = at;
    for (let i = at + open.length - 1; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(css.slice(at, end + 1));
  }
  return blocks;
}

test("the date popover is anchored to the chip's right edge, so it stays inside the window on desktop", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".rr-x-datechip__popover");
  assert.match(rule, /\bright:\s*0;/, ".rr-x-datechip__popover must anchor to the right edge");
  assert.match(rule, /\bleft:\s*auto;/, ".rr-x-datechip__popover must not anchor to the left edge");
});

test("on the phone grammar the sheet spans the command bar, not the chip, so it is not squeezed to the chip's width", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const phone = phoneBlocks(css).join("\n");
  assert.match(ruleBody(phone, ".rr-x-searchrow"), /\bposition:\s*relative;/, "the command bar must contain the sheet");
  assert.match(ruleBody(phone, ".rr-x-datechip"), /\bposition:\s*static;/, "the chip must not contain the sheet");
});
