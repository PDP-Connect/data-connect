// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// L1: a long source name is read in full. It wraps; it is never cut with an ellipsis.
test("a source row's name and kind lines wrap instead of ending in an ellipsis", async () => {
  const css = await readFile(fileURLToPath(new URL("./sources-view.css", import.meta.url)), "utf8");
  for (const selector of [".rr-s-row__name", ".rr-s-row__kind"]) {
    const rule = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
    const body = rule?.[1];
    assert.ok(body, selector);
    assert.doesNotMatch(body, /text-overflow:\s*ellipsis/);
    assert.doesNotMatch(body, /white-space:\s*nowrap/);
  }
});

// The "…" menu stays at the top right when a row wraps, on desktop as on phone.
test("the row menu is top-aligned on desktop and the phone layout adds no offset", async () => {
  const css = await readFile(fileURLToPath(new URL("./sources-view.css", import.meta.url)), "utf8");
  const desktop = css.match(/\n\.rr-s-menu-trigger \{([^}]*)\}/)?.[1];
  assert.ok(desktop, "desktop menu rule");
  assert.match(desktop, /align-self:\s*start/);
  const phone = css.match(/\n  \.rr-s-menu-trigger \{([^}]*)\}/)?.[1];
  assert.ok(phone, "phone menu rule");
  assert.match(phone, /margin-top:\s*0/);
});

test("the filter field sets no height of its own, so the shared 44 px touch rule applies", async () => {
  const css = await readFile(fileURLToPath(new URL("./sources-view.css", import.meta.url)), "utf8");
  const rule = /\.rr-s-filter__input \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(rule);
  assert.doesNotMatch(rule, /(?:min-)?height/);
});
