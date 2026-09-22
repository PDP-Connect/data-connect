// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural coverage only -- this app has no JSX render harness (see
 * connection-danger-zone.test.ts), so a click cannot be simulated here. The
 * REAL runtime proof that a click reaches the OS opener lives in
 * `e2e/open-external-link.spec.ts` and in `src-tauri/src/unified.rs`'s
 * `decide_console_navigation`/`is_console_origin` unit tests plus a real
 * click driven against a standalone repro binary
 * (`src-tauri/src/bin/new_window_repro.rs`) -- not on source text here.
 *
 * History, four attempts over, because every prior version of this
 * component's OWN tests passed while the feature was dead in the real app:
 *
 * 1. The ORIGINAL version only regex-matched `@tauri-apps/plugin-shell`'s
 *    `open()` call and passed while every OpenExternalLink call site was
 *    dead (the console's http://127.0.0.1:{port} window never gets Tauri's
 *    invoke() bridge -- Tauri Discussion #2650 -- so that import always
 *    rejected).
 * 2. #200 moved to an owner-authenticated HTTP bridge gated by a
 *    `"__TAURI__" in window` check -- the exact global Tauri never injects
 *    into this window, so the gate always evaluated false.
 * 3. #209 replaced that with a `pdpp_desktop_bridge` marker cookie Rust set
 *    on the console window -- looked right, but measured live against a
 *    real running app, the cookie never landed in the webview's cookie
 *    store before the page ran (`window.set_cookie` dispatches
 *    asynchronously with no delivery guarantee).
 * 4. Two more rounds tried intercepting from Rust instead of detecting from
 *    JS: `on_new_window` for a `target="_blank"` anchor (does not fire on
 *    WebKitGTK -- confirmed by a real pointer click, not a script) and for
 *    an explicit `window.open()` call (never click-tested before the
 *    design moved on again).
 *
 * The fix that actually works: `on_navigation` (Tauri's hook for every
 * navigation attempt in the webview, no `target="_blank"` or `window.open`
 * needed, no trusted-gesture requirement) wired into
 * `create_or_update_console_window` on the Rust side, allowing navigation
 * to the console's own origin and denying-then-`open::that_detached`-ing
 * everything else. This component has nothing left to detect: it is a
 * plain anchor with no `onClick`, no cookie read, no server call. These
 * assertions pin that shape -- no detection, no interception, nothing this
 * file's JS could get wrong a fifth time.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("OpenExternalLink is a plain anchor with no click interception, detection, or server call", async () => {
  const source = await readFile(`${HERE}open-external-link.tsx`, "utf8")

  assert.doesNotMatch(
    source,
    /onClick/,
    "must not intercept the click at all -- on_navigation on the Rust side handles every " +
      "navigation attempt, including a plain anchor click, with no JS-side branching needed"
  )
  assert.doesNotMatch(
    source,
    /document\.cookie/,
    "must not read a client-observable cookie to decide anything -- measured live, " +
      "Rust's window.set_cookie() call does not reliably land in the webview's cookie store " +
      "before the page runs, which made this exact gate fail closed in #209"
  )
  assert.doesNotMatch(
    source,
    /in window/,
    "must never check for a Tauri-injected global (`\"__TAURI__\" in window`) as a detection " +
      "condition -- Tauri does not inject invoke() or any global into this window " +
      "(WebviewUrl::External), so a check for one always evaluates false. This was the exact " +
      "#200 regression."
  )
  assert.doesNotMatch(
    source,
    /window\.open\(/,
    "must not call window.open() explicitly -- on_new_window (the hook window.open ties to) " +
      "was tried and abandoned in favor of on_navigation, which needs no JS-side trigger at all"
  )
  assert.doesNotMatch(
    source,
    /openExternalUrlAction|fetch\(/,
    "must not call any server action or HTTP endpoint -- the owner-authenticated " +
      "open-external-url bridge this replaced is deleted; there is no longer a server " +
      "component to this operation at all"
  )
  assert.match(
    source,
    /<a href=\{href\} \{\.\.\.props\}>/,
    "must render a plain anchor forwarding all props, with no target/rel forced -- a plain " +
      "browser tab and the desktop console both get correct behavior from ordinary anchor " +
      "semantics plus the Rust-side on_navigation handler"
  )
})
