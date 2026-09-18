// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("OpenExternalLink opens in the system browser from the Tauri webview", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(
    source,
    /__TAURI__[\s\S]*in window[\s\S]*__TAURI_INTERNALS__[\s\S]*in window/,
    "must detect the Tauri webview runtime"
  )
  assert.match(
    source,
    /event\.preventDefault\(\)/,
    "must stop the webview from navigating to the external URL itself"
  )
  assert.match(
    source,
    /@tauri-apps\/plugin-shell/,
    "must route through the shell plugin's system-browser opener"
  )
  assert.match(source, /open\(href\)/, "must open the link's own href, not a stale value")
})

test("OpenExternalLink surfaces a failed open instead of failing silently", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(
    source,
    /\.then\(\(\{ open \}\) => open\(href\)\)\s*\.catch\(/,
    "a rejected open() (e.g. a missing shell:allow-open grant) must not vanish as an unhandled rejection"
  )
})

test("OpenExternalLink falls back to a normal new-tab anchor in a plain browser", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(source, /target="_blank"/)
  assert.match(source, /rel="noopener noreferrer"/)
  assert.match(
    source,
    /if \(!isTauriRuntime\(\)\) return/,
    "must leave the native anchor behavior untouched outside Tauri"
  )
})
