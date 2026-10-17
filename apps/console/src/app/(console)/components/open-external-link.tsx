// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client"

import type { AnchorHTMLAttributes } from "react"

type OpenExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
}

/**
 * A plain anchor, deliberately with no click interception, no runtime
 * detection, and no server round-trip.
 *
 * In the real Tauri console window, Rust's `on_navigation` handler
 * (`decide_console_navigation`, wired up in `create_or_update_console_window`
 * in `src-tauri/src/unified.rs`) intercepts EVERY navigation attempt inside
 * the webview, including a plain anchor click -- no `target="_blank"`
 * needed. It allows navigation whose origin matches the console's own
 * (so moving between pages inside the console still works), and for
 * anything else denies the in-app navigation and hands the URL to the
 * OS's system browser via `open::that_detached` instead. In a plain
 * browser tab (no Tauri host, no such handler attached to anything), the
 * same anchor just navigates or opens a new tab per its own `target`
 * attribute, ordinary browser behavior.
 *
 * Three prior fixes (#186's capability grant, #200's `"__TAURI__" in
 * window` check, #209's `pdpp_desktop_bridge` marker cookie), plus two
 * earlier rounds of this same fix (`on_new_window`, which does not fire
 * for a plain anchor click on WebKitGTK -- confirmed by a real pointer
 * click, not a script), all tried to have THIS component detect which
 * environment it was in and branch accordingly. This component has no
 * detection left to fail: the decision lives entirely in Rust, at
 * window-construction time, independent of anything this file's JS can
 * observe or get wrong.
 */
export function OpenExternalLink({ href, children, ...props }: OpenExternalLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  )
}
