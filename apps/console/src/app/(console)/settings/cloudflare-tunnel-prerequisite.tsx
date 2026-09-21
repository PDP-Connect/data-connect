"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx"
import type { CloudflareTunnelInspection, RemoteAccessInspection } from "./remote-access.ts"

/**
 * `cloudflared_binary_present` is `boolean | null`, not folded into the
 * shared availability/authentication normalizer a caller applies first: a
 * malformed/missing value must default to `null` ("unknown"), never
 * silently to `false` ("checked, not installed") -- the two read very
 * differently in the UI, and only one of them is actually backed by a real
 * check. Takes the already-normalized `RemoteAccessInspection` base (see
 * `asInspection` in `remote-access-setting.tsx`) rather than re-deriving it,
 * so there is exactly one place that decides what an unreadable
 * availability/authentication payload defaults to.
 */
export function asCloudflareTunnelInspection(
  base: RemoteAccessInspection,
  rawValue: unknown
): CloudflareTunnelInspection {
  const candidate = (rawValue && typeof rawValue === "object" ? rawValue : {}) as Partial<CloudflareTunnelInspection>
  return {
    ...base,
    cloudflared_binary_present:
      typeof candidate.cloudflared_binary_present === "boolean"
        ? candidate.cloudflared_binary_present
        : null,
  }
}

/**
 * Whether the owner still needs to install `cloudflared` before this
 * provider can start. `null`/absent inspection never renders as "missing"
 * -- only a real, checked `false` does, matching
 * `asCloudflareTunnelInspection`'s doc comment.
 */
export function cloudflaredBinaryIsMissing(
  stateIsKnown: boolean,
  inspection: CloudflareTunnelInspection | null
): boolean {
  return stateIsKnown && inspection?.cloudflared_binary_present === false
}

/**
 * Two different Cloudflare docs pages for two different owner needs, kept
 * as separate constants so neither call site can drift onto the wrong one:
 * `CLOUDFLARE_TUNNEL_SETUP_URL` is the create-a-remote-tunnel walkthrough --
 * what produces the tunnel token the settings form asks for -- and
 * `CLOUDFLARED_DOWNLOAD_URL` is the binary download page, relevant only when
 * `cloudflared` itself is missing. Rendering the wrong one in either spot
 * would send the owner to instructions for a problem they don't have.
 */
export const CLOUDFLARE_TUNNEL_SETUP_URL =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel"
export const CLOUDFLARED_DOWNLOAD_URL =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"

/**
 * The `cloudflared` binary prerequisite, shown before the owner commits to
 * this option -- never surfaced only as a post-submit spawn error. `null`
 * ("unknown") is a genuinely different case from `false` ("checked, not
 * installed") -- see `CloudflareTunnelInspection`'s doc comment -- and must
 * never be misread as a real "not installed" answer.
 *
 * External links route through `OpenExternalLink`, matching every other
 * external link in the settings page -- see that component's doc comment.
 * As of this writing `window.__TAURI__`/`__TAURI_INTERNALS__` are not
 * present in the console's own window (Tauri's `invoke()` bridge does not
 * reach this webview), so `OpenExternalLink` falls through to a plain
 * `target="_blank"` anchor rather than routing through the shell-open path
 * it prefers. A general console-to-native bridge is in progress elsewhere;
 * this deliberately does not invent a second, competing mechanism to route
 * around that gap -- once the bridge lands, `OpenExternalLink` benefits
 * automatically. The interim mitigation is the visible, `select-all`
 * plain-text URL alongside the link, so the download page is reachable by
 * copy-paste even while the link itself is a plain browser-tab open rather
 * than a native shell-open.
 */
export function CloudflaredBinaryStatus({
  missing,
  unknown,
}: {
  missing: boolean
  unknown: boolean
}) {
  if (unknown) {
    // Only reachable with an old build or a host that never ran the check
    // -- not a claim that cloudflared is installed, only that this app
    // cannot yet say either way. `start` still fails closed with an
    // actionable error if it turns out cloudflared is actually absent.
    return (
      <span className="pdpp-caption text-muted-foreground">
        Whether cloudflared is installed could not be checked here.
      </span>
    )
  }
  if (missing) {
    return (
      <span className="pdpp-caption text-destructive">
        cloudflared is not installed on this machine yet.{" "}
        <OpenExternalLink className="underline" href={CLOUDFLARED_DOWNLOAD_URL}>
          Download cloudflared
        </OpenExternalLink>
        , then come back here.{" "}
        <span className="select-all break-all font-mono text-muted-foreground">
          {CLOUDFLARED_DOWNLOAD_URL}
        </span>
      </span>
    )
  }
  return (
    <span className="pdpp-caption text-muted-foreground">
      cloudflared is installed and ready.
    </span>
  )
}
