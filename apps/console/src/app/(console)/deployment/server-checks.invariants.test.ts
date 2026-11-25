// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CHECKS_FILE = fileURLToPath(new URL("./server-checks.tsx", import.meta.url))

test("server checks render as plain rows with status words and folded detail", async () => {
  const src = await readFile(CHECKS_FILE, "utf8")
  // Brief settings-pages, decision 2: checks stay visible; technical notes stay under Details.
  assert.match(src, /<Section title="Checks">/)
  assert.match(src, /<details className="sm:col-start-2">/)
  assert.match(src, /displayCheckName\(row\.check\)/)
  assert.match(src, /text-attention/)
  assert.match(src, /text-destructive/)
  assert.doesNotMatch(src, /StatusBadge|text-\[color:var\(--success\)\]/)
})

test("the public-origin action and browser probe stay available", async () => {
  const src = await readFile(CHECKS_FILE, "utf8")
  // Control list DP5: keep the existing origin-copy action and browser metadata probe.
  assert.match(src, /Use this origin/)
  assert.match(src, /PDPP_REFERENCE_ORIGIN=\$\{browserOrigin\}/)
  assert.match(src, /\.well-known\/oauth-authorization-server/)
})
