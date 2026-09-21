// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural coverage only -- this app has no JSX render harness (see
 * connection-danger-zone.test.ts), so a click cannot be simulated here. The
 * REAL runtime proof that a click reaches the OS opener lives in
 * `e2e/open-external-link.spec.ts`, which drives a real browser against a
 * running console and asserts on the resulting network request and the
 * queue file the Rust watcher consumes -- not on source text.
 *
 * The prior version of this file only regex-matched
 * `@tauri-apps/plugin-shell`'s `open()` call and passed while every one of
 * the 35 OpenExternalLink call sites was dead in the shipped app (the
 * console's http://127.0.0.1:{port} window never gets Tauri's invoke()
 * bridge -- Tauri Discussion #2650 -- so that import always rejected).
 * These assertions instead pin the wiring to the owner-authenticated HTTP
 * bridge that replaced it: `open-external-url-action.ts` -> `owner-open-
 * external-url.ts` -> `open_external_url.rs`, so a regression back to a
 * direct plugin-shell call (or a dropped failure log) still fails a fast
 * unit test even before the e2e spec would catch it.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("OpenExternalLink routes the Tauri-runtime click through the owner-authenticated bridge, not a direct plugin-shell call", async () => {
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
    /openExternalUrlAction\(href\)/,
    "must route through the Server Action bridge (owner-authenticated HTTP -> Rust), " +
      "not a direct @tauri-apps/plugin-shell call the console window can never reach"
  )
  assert.doesNotMatch(
    source,
    /import\(["']@tauri-apps\/plugin-shell["']\)|from ["']@tauri-apps\/plugin-shell["']/,
    "must not import plugin-shell directly -- that IPC bridge is absent in the console window " +
      "(this was the exact PR #186 regression: a capability grant with no reachable invoke())"
  )
})

test("OpenExternalLink surfaces a failed bridge call instead of failing silently", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(
    source,
    /openExternalUrlAction\(href\)\.then\(result => \{/,
    "must inspect the action's result rather than treating any resolved promise as success"
  )
  assert.match(
    source,
    /if \(result\.ok\) return/,
    "must distinguish an ok:false action result (e.g. a rejected scheme) from a thrown error"
  )
  assert.match(
    source,
    /console\.error\(`Failed to open external link \$\{href\}/,
    "a rejected/failed open must not vanish -- it must be visible, not look like a dead link"
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

test("the bridge action delegates to the owner-authenticated open-external-url client, doing no validation of its own", async () => {
  const source = await readFile(`${HERE}open-external-url-action.ts`, "utf8")

  assert.match(source, /"use server"/)
  assert.match(
    source,
    /import \{ openExternalUrl \} from "\.\.\/lib\/open-external-url-client\.ts"/,
    "must call the shared owner-token HTTP client, not fetch() directly (would duplicate auth handling)"
  )
  assert.match(source, /export async function openExternalUrlAction/)
})
