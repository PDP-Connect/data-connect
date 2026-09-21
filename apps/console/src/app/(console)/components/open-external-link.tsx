// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client"

import type { AnchorHTMLAttributes, MouseEvent } from "react"
import { openExternalUrlAction } from "./open-external-url-action.ts"

type OpenExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel"
> & {
  href: string
}

const DESKTOP_BRIDGE_COOKIE_NAME = "pdpp_desktop_bridge"

/**
 * True only inside the real Tauri console window. There is NO Tauri-
 * provided signal for this: the console window is `WebviewUrl::External`,
 * so Tauri never injects `__TAURI__`/`__TAURI_INTERNALS__` into it (Tauri
 * Discussion #2650) -- checking for those globals, which a prior version of
 * this function did, is backwards. It gates the bridge behind the exact
 * symbol whose ABSENCE is the entire reason the bridge exists, so that
 * check always evaluated false and the bridge never ran in the shipped
 * app: every OpenExternalLink click silently fell through to a bare anchor
 * that does nothing in the webview. Verified live against a running
 * desktop build: `window.__TAURI__` and `window.__TAURI_INTERNALS__` are
 * both undefined in the console window, exactly as this file's other
 * comments already said.
 *
 * Instead this reads `pdpp_desktop_bridge`, a non-secret marker cookie
 * `desktop_bridge_marker_cookie` (`src-tauri/src/unified.rs`) sets on the
 * console window the ONE time Rust creates or navigates it
 * (`create_or_update_console_window`). A plain browser tab pointed at the
 * same console URL from outside the app never goes through that Rust code
 * path, so it never receives this cookie -- unlike a Tauri-provided
 * global, this is a real signal the desktop process actively sets, not an
 * inference about the environment.
 */
const isDesktopWebview = () =>
  typeof document !== "undefined" &&
  document.cookie
    .split("; ")
    .some(entry => entry === `${DESKTOP_BRIDGE_COOKIE_NAME}=1`)

/**
 * The console renders inside the Tauri desktop webview and in a plain
 * browser. A bare anchor navigates the webview itself in Tauri, trapping the
 * owner on a third-party page inside a window with no browser chrome.
 *
 * In the desktop webview, route the click through `openExternalUrlAction`
 * (a Server Action -> owner-authenticated `/v1/owner/open-external-url` ->
 * Rust's `open::that_detached`, `open-external-url-action.ts`) instead; in
 * a normal browser, target="_blank" already does the right thing.
 */
export function OpenExternalLink({
  href,
  onClick,
  children,
  ...props
}: OpenExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (!isDesktopWebview()) return
        event.preventDefault()
        void openExternalUrlAction(href).then(result => {
          if (result.ok) return
          // A failed request here (e.g. a rejected scheme, or the desktop
          // app not running) previously failed silently: no browser tab
          // opened and nothing was logged. Surface it so a failure is
          // visible instead of looking like a dead link.
          console.error(`Failed to open external link ${href}: ${result.message}`)
        })
      }}
      {...props}
    >
      {children}
    </a>
  )
}
