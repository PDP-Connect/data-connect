// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const PANEL_FILE = fileURLToPath(
  new URL("./local-connector-sources-panel.tsx", import.meta.url)
)

test("developer local source settings keep provenance and source switching visible", async () => {
  const source = await readFile(PANEL_FILE, "utf8")
  assert.match(source, /data-testid="local-connector-sources"/)
  assert.match(source, />\s*Local\s*</)
  assert.match(source, /data-testid="local-source-path"/)
  assert.match(source, /Unsigned developer source/)
  assert.match(source, /Use local/)
  assert.match(source, /Use registry/)
  assert.match(source, /Reload/)
  assert.match(source, /Remove/)
})
