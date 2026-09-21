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
 * Two different Cloudflare docs pages for two different owner needs, kept
 * as separate constants so neither call site can drift onto the wrong one:
 * `CLOUDFLARE_TUNNEL_SETUP_URL` is the create-a-remote-tunnel walkthrough --
 * what produces the tunnel token the settings form asks for -- and
 * `CLOUDFLARED_DOWNLOAD_URL` is the binary download page, relevant only as a
 * manual fallback if the automatic download this app now does itself
 * (`ensure_cloudflared_available`, `src-tauri/src/remote_access_cloudflare.rs`)
 * fails -- for example, no network access at the moment the owner submits.
 */
export const CLOUDFLARE_TUNNEL_SETUP_URL =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel"
export const CLOUDFLARED_DOWNLOAD_URL =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"

/**
 * The `cloudflared` binary prerequisite, shown before the owner commits to
 * this option. Building a Tauri `externalBin` sidecar (bundling the binary
 * into every install) was investigated and dropped -- see that module's own
 * doc comment for why. Download-on-first-use replaced it: the Rust side
 * downloads and checksum-verifies a real `cloudflared` copy automatically
 * the first time this provider starts, if no system install is already on
 * `PATH`, so a MISSING binary is no longer a blocker the owner has to
 * resolve themselves before continuing -- it just means the first start
 * takes a few extra seconds for the download. `null` ("unknown", e.g. an
 * old build or a host that never ran the check) reads the same as
 * "present" here for exactly that reason: there is no longer a real-world
 * case where the owner needs to act before submitting, only a case where
 * `start()` might need a little longer the first time.
 */
export function CloudflaredBinaryStatus({
  missing,
}: {
  missing: boolean
}) {
  if (missing) {
    return (
      <span className="pdpp-caption text-muted-foreground">
        cloudflared is not installed on this machine yet — DataConnect will
        download and verify it automatically the first time you save this.
        That download needs network access; if it fails, you can{" "}
        <OpenExternalLink className="underline" href={CLOUDFLARED_DOWNLOAD_URL}>
          install cloudflared yourself
        </OpenExternalLink>{" "}
        instead.
      </span>
    )
  }
  return (
    <span className="pdpp-caption text-muted-foreground">
      cloudflared is installed and ready.
    </span>
  )
}
