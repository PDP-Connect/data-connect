// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("on touch the disconnect confirmation label is a 44 px press area for its checkbox", async () => {
  const css = await readFile(`${HERE}sources-view.css`, "utf8");
  const block = /@media \(pointer: coarse\) \{[^@]*?\.rr-s-confirm label \{[^}]*min-height: 44px;[^}]*\}/.exec(css);
  assert.ok(block, "a coarse-pointer rule gives .rr-s-confirm label a 44 px minimum height");
  assert.match(css, /\.rr-s-confirm input\[type="checkbox"\] \{[^}]*height: 22px;[^}]*width: 22px;/);
});

test("the touch-size comment says native fields do change size", async () => {
  const css = await readFile(`${HERE}../../globals.css`, "utf8");
  assert.match(css, /its drawn size does change/);
  assert.doesNotMatch(css, /The drawn control does not change:/);
});
