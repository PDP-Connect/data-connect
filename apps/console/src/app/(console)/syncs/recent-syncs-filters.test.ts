// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIEW_FILE = fileURLToPath(new URL("syncs-view.tsx", import.meta.url));

// Walkthrough 2026-10-23, item A9. The "" option is "any outcome" / "any source",
// and Base UI treats "" as no selection, so each trigger shows its placeholder.
// Without a placeholder it shows an em dash, and the owner cannot tell which filter
// is which until the list opens. Each select therefore needs a visible label and a
// placeholder that names what it filters.
test("each recent-syncs filter shows a visible label and a placeholder that names it", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, /htmlFor="recent-syncs-outcome"[^>]*>\s*Outcome\s*<\/label>/);
  assert.match(src, /htmlFor="recent-syncs-source"[^>]*>\s*Source\s*<\/label>/);
  assert.match(src, /placeholder="any outcome"/);
  assert.match(src, /placeholder="any source"/);
});
