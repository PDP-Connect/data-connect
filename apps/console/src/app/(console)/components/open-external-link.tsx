// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client"

import type { AnchorHTMLAttributes, MouseEvent } from "react"

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
 * owner on a third-party page inside a window with no browser chrome. In
 * Tauri, route the click through the shell plugin's system-browser opener
 * instead; in a normal browser, target="_blank" already does the right
 * thing.
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
        void import("@tauri-apps/plugin-shell")
          .then(({ open }) => open(href))
          .catch(error => {
            // A rejected promise here (e.g. the console window's Tauri
            // capability does not grant shell:allow-open) previously failed
            // silently: no browser tab opened and nothing was logged. Surface
            // it so a missing grant is visible instead of looking like a dead
            // link.
            console.error(`Failed to open external link ${href}:`, error)
          })
      }}
      {...props}
    >
      {children}
    </a>
  )
}
