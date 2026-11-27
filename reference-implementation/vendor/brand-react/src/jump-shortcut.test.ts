// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_JUMP_SHORTCUT_LABEL, jumpShortcutLabel } from "./jump-shortcut.ts";

test("Apple platforms get the Command glyph", () => {
  for (const platform of ["MacIntel", "macOS", "iPhone", "iPad"]) {
    assert.equal(jumpShortcutLabel(platform), "⌘K", platform);
  }
});

test("other platforms and unknown platforms get Ctrl K", () => {
  for (const platform of ["Linux x86_64", "Win32", "Windows", "Android", "", undefined, null]) {
    assert.equal(jumpShortcutLabel(platform), "Ctrl K", String(platform));
  }
  assert.equal(DEFAULT_JUMP_SHORTCUT_LABEL, "Ctrl K");
});
