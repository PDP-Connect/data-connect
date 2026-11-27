// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// A kind's name in the facet list is never cut with an ellipsis: it wraps.
test("Explore facet names wrap instead of ending in an ellipsis", () => {
  const css = readFileSync(new URL("./explore-page.css", import.meta.url), "utf8");
  const rule = /\.explore-page \.rr-x-facet__label\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /white-space:\s*normal/);
  assert.match(rule, /text-overflow:\s*clip/);
  const name = /\.explore-page \.rr-x-facet__name\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(name, /white-space:\s*normal/);
  assert.match(name, /overflow:\s*visible/);
});
