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
 * A REGRESSION HISTORY WORTH READING BEFORE TRUSTING THIS FILE AGAIN:
 *
 *   1. The original version only regex-matched `@tauri-apps/plugin-shell`'s
 *      `open()` call and passed while every one of the 35 OpenExternalLink
 *      call sites was dead in the shipped app (the console's
 *      http://127.0.0.1:{port} window never gets Tauri's invoke() bridge --
 *      Tauri Discussion #2650 -- so that import always rejected).
 *
 *   2. #200 replaced that with a real HTTP bridge (openExternalUrlAction ->
 *      owner-open-external-url.ts -> open_external_url.rs) and rewrote this
 *      file to assert the new wiring -- but LEFT THE `isTauriRuntime()`
 *      GATE IN PLACE unchanged, and one of these tests
 *      (`/if \(!isTauriRuntime\(\)\) return/`) asserted that exact dead
 *      guard was still present. `window.__TAURI__` and
 *      `__TAURI_INTERNALS__` are BOTH undefined in this window for the same
 *      reason `invoke()` is unreachable -- Tauri's IPC injection never runs
 *      against a `WebviewUrl::External` load at all. The guard was
 *      therefore unconditionally false, and every click fell through to
 *      plain `target="_blank"` navigation -- silently trapping the owner in
 *      the webview again, the exact failure #200 exists to fix. A regex
 *      test asserting the guard's SOURCE TEXT existed passed throughout,
 *      because the bug was in what the guard evaluated to at runtime, which
 *      no source-text match can see. Confirmed dead against a real running
 *      app, not assumed.
 *
 *   Lesson encoded here now: a passing regex-over-source-text test proves
 *   the code was written, never that it does what it says at runtime. These
 *   assertions are still structural (same limitation as before -- no render
 *   harness) but now pin the CORRECTED wiring: no isTauriRuntime() gate at
 *   all, the bridge attempted unconditionally, with a window.open fallback
 *   for whichever case it fails in (plain browser, or the desktop app not
 *   running). Treat every assertion in this file as "the source says this",
 *   never as "this works" -- only `e2e/open-external-link.spec.ts` proves
 *   the latter.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("OpenExternalLink attempts the owner-authenticated bridge unconditionally, not a direct plugin-shell call", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  // No isTauriRuntime()-style gate: both window.__TAURI__ and
  // __TAURI_INTERNALS__ are permanently undefined in this window (Tauri
  // Discussion #2650 -- WebviewUrl::External never gets IPC injection at
  // all), so any gate keyed on either flag is unconditionally false and
  // would silently disable the bridge for every click, exactly as it did
  // from #200's merge until this fix.
  assert.doesNotMatch(
    source,
    /__TAURI__["'\s]*in window|__TAURI_INTERNALS__["'\s]*in window/,
    "must not gate on window.__TAURI__/__TAURI_INTERNALS__ -- both are always undefined in this window, " +
      "which is what made every click silently dead from #200's merge until this fix"
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

test("OpenExternalLink falls back to window.open when the bridge fails, instead of leaving the click looking dead", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(
    source,
    /openExternalUrlAction\(href\)\.then\(result => \{/,
    "must inspect the action's result rather than treating any resolved promise as success"
  )
  assert.match(
    source,
    /if \(result\.ok\) return/,
    "must distinguish an ok:false action result (e.g. not running in the desktop app's owner " +
      "session, or a rejected scheme) from silent success"
  )
  assert.match(
    source,
    /window\.open\(href, ["']_blank["'], ["']noopener,noreferrer["']\)/,
    "a failed bridge call (plain browser tab, or the desktop app not running) must still open a " +
      "normal new tab -- the click must never simply do nothing"
  )
})

test("OpenExternalLink keeps a real href/target/rel on the anchor so browser affordances (copy link, middle-click, open-in-new-tab) still work", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.match(source, /href=\{href\}/)
  assert.match(source, /target="_blank"/)
  assert.match(source, /rel="noopener noreferrer"/)
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
