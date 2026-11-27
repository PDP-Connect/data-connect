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
    assert.ok(rule, selector);
    assert.doesNotMatch(rule[1], /text-overflow:\s*ellipsis/);
    assert.doesNotMatch(rule[1], /white-space:\s*nowrap/);
  }
});
