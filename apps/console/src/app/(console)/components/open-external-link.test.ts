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
 * History, twice over, because both versions of this file passed while the
 * feature was dead:
 *
 * 1. The ORIGINAL version only regex-matched `@tauri-apps/plugin-shell`'s
 *    `open()` call and passed while every OpenExternalLink call site was
 *    dead (the console's http://127.0.0.1:{port} window never gets Tauri's
 *    invoke() bridge -- Tauri Discussion #2650 -- so that import always
 *    rejected).
 * 2. The REPLACEMENT (#200) moved to the owner-authenticated HTTP bridge,
 *    but its own runtime-detection check tested for
 *    `__TAURI__`/`__TAURI_INTERNALS__` -- the exact globals Tauri never
 *    injects into this window, i.e. it gated the fix behind the very
 *    absence that motivated the fix. This file's own PREVIOUS version
 *    asserted that detection code MUST be present
 *    (`assert.match(source, /__TAURI__[\s\S]*in window.../)`), which is
 *    exactly backwards: it would pass on correct code and on the broken
 *    code equally, since both contain that string. Confirmed dead live in
 *    Tim's running build (settings links doing nothing on click) after
 *    this test was green and CI passed.
 *
 * The fix now reads a `pdpp_desktop_bridge` cookie Rust sets on the real
 * console window (`desktop_bridge_marker_cookie` /
 * `create_or_update_console_window`, `src-tauri/src/unified.rs`) -- a
 * cookie set by the one process that actually knows it created this
 * window, not a browser-observable fact about the window itself. These
 * assertions pin that: the detection must read the cookie, and must NOT
 * reference `__TAURI__`/`__TAURI_INTERNALS__` at all, so this exact class
 * of regression (a check gated on a symbol that's absent in the target
 * environment) cannot silently reappear and pass this file again.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("OpenExternalLink detects the desktop webview via the server-set cookie, never via a Tauri global", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(
    source,
    /document\.cookie/,
    "must read document.cookie -- the only signal a plain webview page can observe " +
      "that a browser tab cannot, since it's set by the Rust process, not inferred from the runtime"
  )
  assert.match(
    source,
    /pdpp_desktop_bridge/,
    "must check the specific cookie name Rust sets in create_or_update_console_window"
  )
  assert.doesNotMatch(
    source,
    /in window/,
    "must never check for a Tauri-injected global (`\"__TAURI__\" in window`) as the detection " +
      "condition -- Tauri does not inject invoke() or any global into this window " +
      "(WebviewUrl::External), so a check for one always evaluates false and silently disables " +
      "the entire bridge. This was the exact #200 regression; doc-comment mentions of the " +
      "symbol names for historical context are fine, an `in window` runtime check is not."
  )
})

test("OpenExternalLink routes a desktop-webview click through the owner-authenticated bridge, not a direct plugin-shell call", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

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

test("OpenExternalLink falls back to a normal new-tab anchor outside the desktop webview", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(source, /target="_blank"/)
  assert.match(source, /rel="noopener noreferrer"/)
  assert.match(
    source,
    /if \(!isDesktopWebview\(\)\) return/,
    "must leave the native anchor behavior untouched outside the desktop webview"
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
