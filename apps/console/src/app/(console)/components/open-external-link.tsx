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
 * this fix moved them to owner-authenticated HTTP: route the click through
 * `openExternalUrlAction` (a Server Action -> owner-authenticated
 * `/v1/owner/open-external-url` -> Rust's `open::that_detached`,
 * `open-external-url-action.ts`).
 *
 * There is deliberately no `isTauriRuntime()`-style gate deciding whether to
 * attempt that bridge: `window.__TAURI__` and `__TAURI_INTERNALS__` are BOTH
 * undefined in this window for the same reason `invoke()` is unreachable --
 * Tauri's IPC injection never runs against a `WebviewUrl::External` load at
 * all, not just the `invoke()` call specifically. A gate keyed on either flag
 * is unconditionally false here, which is exactly what happened: the guard
 * this component shipped with silently never routed a single click through
 * the bridge above, in every build since it was added, confirmed against a
 * real running app. Every click always falls through to plain `target=
 * "_blank"` navigation instead -- correct in a normal browser tab, but back
 * to trapping the owner inside the webview for the one case this component
 * exists to fix.
 *
 * The fix: always attempt the bridge first (`preventDefault()`, then
 * `openExternalUrlAction`). In the desktop app this opens the link in the
 * owner's system browser exactly as intended. In a plain browser tab the
 * request 401s (`requireOwner` gates the route the same as every other
 * `/v1/owner/*` endpoint; see `owner-open-external-url.ts`) -- the failure
 * branch below falls back to `window.open`, so a plain-browser visitor still
 * gets a normal new tab, just one round trip later than a bare anchor would
 * have given them. No new "which runtime am I in" signal is needed or
 * assumed.
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
        event.preventDefault()
        void openExternalUrlAction(href).then(result => {
          if (result.ok) return
          // Not running inside the desktop app's owner session (a plain
          // browser tab, or the desktop app not running) -- fall back to a
          // normal new-tab open instead of leaving the click looking dead.
          window.open(href, "_blank", "noopener,noreferrer")
        })
      }}
      {...props}
    >
      {children}
    </a>
  )
}
