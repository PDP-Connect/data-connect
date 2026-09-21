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

const isTauriRuntime = () =>
  typeof window !== "undefined" &&
  ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)

/**
 * The console renders inside the Tauri desktop webview and in a plain
 * browser. A bare anchor navigates the webview itself in Tauri, trapping the
 * owner on a third-party page inside a window with no browser chrome.
 *
 * The console window loads via `WebviewUrl::External` at
 * `http://127.0.0.1:{port}`, so Tauri never injects its `invoke()` bridge
 * into it (Tauri Discussion #2650) -- no capability grant changes that (PR
 * #186 tried `shell:allow-open` in `src-tauri/capabilities/console.json`;
 * verified against the merged build that `window.__TAURI__` is still
 * undefined there). A direct `@tauri-apps/plugin-shell` `open()` call from
 * this component is therefore unreachable, same as
 * `get_autostart_enabled`/`configure_remote_access` were before #189 and
 * this fix moved them to owner-authenticated HTTP. In Tauri, route the click
 * through `openExternalUrlAction` (a Server Action -> owner-authenticated
 * `/v1/owner/open-external-url` -> Rust's `open::that_detached`,
 * `open-external-url-action.ts`) instead; in a normal browser,
 * target="_blank" already does the right thing.
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
        if (!isTauriRuntime()) return
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
