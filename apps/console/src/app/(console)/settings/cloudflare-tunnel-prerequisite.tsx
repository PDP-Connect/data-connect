"use client"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react"
import { OpenExternalLink } from "@/app/(console)/components/open-external-link.tsx"
import type { CloudflareTunnelInspection, RemoteAccessInspection } from "./remote-access.ts"
import type { RemoteAccessConfig } from "./remote-access.ts"

/**
 * A decoded Cloudflare tunnel token, or the specific reason decoding failed.
 * Mirrors `connection.TunnelToken` in Cloudflare's own `cloudflared` source
 * (`connection/connection.go`, confirmed by reading the real struct rather
 * than guessing at the shape): `{"a": AccountTag, "t": TunnelID, "s":
 * TunnelSecret, "e"?: Endpoint}`, base64-encoded (standard alphabet, with
 * padding -- `base64.StdEncoding` in `ParseToken`,
 * `cmd/cloudflared/tunnel/subcommands.go`) then JSON-encoded. `TunnelID` is
 * a `google/uuid` value, which marshals to the standard hyphenated string
 * form -- the same shape Cloudflare's dashboard shows as a tunnel's ID.
 *
 * This never surfaces `TunnelSecret` (`s`) anywhere, including in errors:
 * only `accountId` and `tunnelId` are extracted, because those are the only
 * two fields useful for the owner to cross-check against what they see in
 * their own Cloudflare dashboard, and the secret has no legitimate reason to
 * ever appear in the UI, logs, or an error message once past this function.
 */
export type CloudflareTunnelTokenDecode =
  | { ok: true; accountId: string; tunnelId: string }
  | { ok: false; reason: "empty" | "not-base64" | "not-json" | "missing-fields" }

const TUNNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decodes a pasted Cloudflare tunnel token just far enough to say "this is
 * well-formed and names account X, tunnel Y" or "this cannot be a real
 * cloudflared token" -- never far enough to need network access or an
 * additional Cloudflare API credential this app does not collect (see this
 * file's module boundary: no Cloudflare account credential is held here).
 * That is a real, honest limit: this cannot confirm the pasted HOSTNAME
 * actually routes to this token's tunnel, only that the token itself
 * parses. `CloudflareTunnelTokenStatus` below states that limit in the UI
 * rather than implying a check that was not run.
 */
export function decodeCloudflareTunnelToken(raw: string): CloudflareTunnelTokenDecode {
  const value = raw.trim()
  if (!value) {
    return { ok: false, reason: "empty" }
  }
  let decoded: string
  try {
    decoded = atob(value)
  } catch {
    return { ok: false, reason: "not-base64" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return { ok: false, reason: "not-json" }
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "missing-fields" }
  }
  const candidate = parsed as Record<string, unknown>
  const accountId = candidate.a
  const tunnelId = candidate.t
  if (
    typeof accountId !== "string" ||
    !accountId ||
    typeof tunnelId !== "string" ||
    !TUNNEL_ID_PATTERN.test(tunnelId)
  ) {
    return { ok: false, reason: "missing-fields" }
  }
  return { ok: true, accountId, tunnelId }
}

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

/**
 * The step-by-step Cloudflare-dashboard handoff this option needed and
 * didn't have: before this, the only guidance was a single link to
 * Cloudflare's own walkthrough plus two bare form fields, which assumes the
 * owner already knows what a tunnel token or a public hostname route is.
 * Written for someone who has never created a Cloudflare tunnel, per Tim's
 * standing bar that this has to work for an owner who cannot ask an agent
 * what to paste.
 *
 * Numbered against Cloudflare's own dashboard flow (Networking > Tunnels >
 * Create a tunnel > name it > choose an install method > Add a public
 * hostname route), confirmed against Cloudflare's own docs for this exact
 * page (`CLOUDFLARE_TUNNEL_SETUP_URL`) rather than assumed. One real gap in
 * that flow, called out explicitly in step 3 rather than left for the owner
 * to discover: Cloudflare's dashboard does not hand over a bare token by
 * itself -- it shows a full install command (`cloudflared service install
 * <TOKEN>` on the native-install path, or a `docker run ...  --token
 * <TOKEN>` command on the Docker path Cloudflare's dashboard also offers)
 * that embeds the token inside it, so the owner has to know to copy only
 * the value after `--token`, not the whole command.
 */
export function CloudflareTunnelSetupSteps() {
  return (
    <ol className="grid list-decimal gap-1.5 pl-5 pdpp-caption text-muted-foreground">
      <li>
        Open the{" "}
        <OpenExternalLink className="underline" href={CLOUDFLARE_TUNNEL_SETUP_URL}>
          Cloudflare Tunnel dashboard
        </OpenExternalLink>{" "}
        and sign in to the Cloudflare account you want this Personal Server
        to route through.
      </li>
      <li>
        Under <span className="font-medium text-foreground/90">Networking → Tunnels</span>,
        select <span className="font-medium text-foreground/90">Create a tunnel</span>, then
        give it a name (for example, the name of this device).
      </li>
      <li>
        On the install-method step, Cloudflare shows a command containing{" "}
        <span className="select-all font-mono">--token</span> followed by a long value.
        Copy only that value — everything after{" "}
        <span className="select-all font-mono">--token</span>, not the whole command — and
        paste it into the token field below. You do not need to run that
        command yourself; DataConnect runs cloudflared for you.
      </li>
      <li>
        Still in the dashboard, open the tunnel's{" "}
        <span className="font-medium text-foreground/90">Routes</span> tab, select{" "}
        <span className="font-medium text-foreground/90">Add route</span>, choose{" "}
        <span className="font-medium text-foreground/90">Published application</span>, and
        enter the hostname you want this Personal Server reachable at — for
        example a subdomain of a domain you already manage in Cloudflare. For
        the target, use{" "}
        <span className="select-all font-mono">http://localhost:PORT</span> — the exact
        port does not matter here, since DataConnect connects the tunnel to
        the right one itself.
      </li>
      <li>
        Paste that same hostname into the hostname field below. This step
        matters: a token and hostname that do not both point at the same
        tunnel will connect but never actually reach this Personal Server —
        see the note below the hostname field.
      </li>
    </ol>
  )
}

/**
 * Surfaces what `decodeCloudflareTunnelToken` found, for the token field
 * this option asks for -- a token that decodes cleanly is not proof the
 * PASTED HOSTNAME routes to it (that would need a live Cloudflare API call
 * with a credential this app does not collect, stated honestly rather than
 * implied), only that the pasted value has the right shape to be a real
 * cloudflared token at all. Catches the most common paste mistakes (an
 * empty field, a stray install command pasted whole instead of just the
 * token, a truncated copy) before the owner submits and waits through a
 * spawn attempt to find out.
 */
export function CloudflareTunnelTokenStatus({ token }: { token: string }) {
  if (!token.trim()) {
    return null
  }
  const decoded = decodeCloudflareTunnelToken(token)
  if (decoded.ok) {
    return (
      <span className="pdpp-caption text-muted-foreground">
        This looks like a valid tunnel token for Cloudflare account{" "}
        <span className="select-all font-mono">{decoded.accountId}</span>, tunnel{" "}
        <span className="select-all font-mono">{decoded.tunnelId}</span>. DataConnect
        cannot confirm from here that your hostname is actually routed to
        this tunnel — double-check that in the dashboard's Routes tab if the
        connection fails after saving.
      </span>
    )
  }
  // `decoded.reason === "empty"` is unreachable here: the `token.trim()`
  // check above already returns before calling `decodeCloudflareTunnelToken`
  // on an empty value.
  const message =
    decoded.reason === "not-base64"
      ? "This does not look like a valid tunnel token — it should be a single long string of letters, numbers, and a few symbols, with no spaces. If you pasted a whole install command, paste only the value after --token."
      : "This does not look like a valid tunnel token — it decoded, but not into the shape a real cloudflared token has. Copy it again from the dashboard."
  return <span className="pdpp-caption text-destructive">{message}</span>
}

/**
 * `connecting | connected | failed`, grounded in the same real signal
 * `start()` (`src-tauri/src/remote_access_cloudflare.rs`) already watches
 * cloudflared's stdout for: "Registered tunnel connection". Exists because
 * the alternative -- what this option had until now -- is the exact failure
 * mode Tim flagged: after saving, the settings page shows "Waiting for the
 * provider to report an address…" and NEVER checks again unless the owner
 * manually reloads the page (confirmed by reading `RemoteAccessSetting`'s
 * load effect: it runs once, on mount, with no polling). That single-shot
 * spinner is what stalled Tim for hours on the ngrok path; this exists so
 * Cloudflare does not repeat it.
 */
export type CloudflareTunnelConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting"; elapsedSeconds: number }
  | { phase: "connected"; origin: string }
  | { phase: "failed"; reason: string }

/**
 * The real backend timing this polls against, not an arbitrary guess:
 * `spawn_remote_access_config_watcher` (`src-tauri/src/unified.rs`) polls
 * the config file every `REMOTE_ACCESS_CONFIG_POLL_INTERVAL` (3s) to notice
 * a saved change, then `CloudflareTunnelProvider::start`'s own
 * `CONNECT_TIMEOUT` (30s) bounds how long cloudflared gets to report a
 * registered connection before `start()` gives up. This polls at 2s
 * intervals for up to 45s -- comfortably past the ~33s worst case those two
 * bounds add up to, with margin for process-spawn overhead neither of those
 * constants accounts for.
 */
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 45_000

export const CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON =
  "cloudflared did not report a connection within the expected time. Check the Cloudflare dashboard for this tunnel's status, and that the token and hostname you saved both belong to it."
export const CLOUDFLARE_TUNNEL_POLL_FETCH_FAILED_REASON =
  "Could not check the tunnel's status. Reload this page to try again."

/**
 * The pure decision `useCloudflareTunnelConnectionStatus`'s polling loop
 * makes on every tick, split out so the branching (tunnel_error wins, then
 * a real origin, then a timeout check, then keep waiting) is testable
 * without a DOM or fake timers -- the loop itself (the `setTimeout`
 * recursion, the `AbortController`-style generation guard against a stale
 * poll updating state after `start()` was called again or the component
 * unmounted) is not meaningfully testable outside React, so it stays
 * untested glue around this, matching every other pure-logic/React-glue
 * split in this file.
 */
export function nextConnectionStatus(
  outcome:
    | { kind: "config"; config: Pick<RemoteAccessConfig, "tunnel_error" | "fields"> }
    | { kind: "fetch-failed" },
  elapsedMs: number
): CloudflareTunnelConnectionStatus {
  if (outcome.kind === "config") {
    if (outcome.config.tunnel_error) {
      return { phase: "failed", reason: outcome.config.tunnel_error }
    }
    const origin = outcome.config.fields.PDPP_REFERENCE_ORIGIN
    if (origin) {
      return { phase: "connected", origin }
    }
  }
  if (elapsedMs >= POLL_TIMEOUT_MS) {
    return {
      phase: "failed",
      reason:
        outcome.kind === "fetch-failed"
          ? CLOUDFLARE_TUNNEL_POLL_FETCH_FAILED_REASON
          : CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON,
    }
  }
  return { phase: "connecting", elapsedSeconds: Math.floor(elapsedMs / 1000) }
}

/**
 * Polls `loadState` (the same `loadRemoteAccessStateAction`-shaped function
 * `RemoteAccessSetting` already loads state with) until the saved config
 * either gains a reachable origin, reports a `tunnel_error`, or the timeout
 * above elapses -- never indefinitely, and never silently. `start` (call it
 * right after a successful save) is idempotent against being called again
 * mid-poll; a fresh call resets the clock, matching "the owner tried again."
 */
export function useCloudflareTunnelConnectionStatus(
  loadState: () => Promise<{ config: RemoteAccessConfig }>
): {
  status: CloudflareTunnelConnectionStatus
  start: () => void
} {
  const [status, setStatus] = useState<CloudflareTunnelConnectionStatus>({ phase: "idle" })
  const generationRef = useRef(0)

  const start = useCallback(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const startedAt = Date.now()
    setStatus({ phase: "connecting", elapsedSeconds: 0 })

    const poll = () => {
      if (generationRef.current !== generation) return
      const elapsedMs = Date.now() - startedAt
      void loadState()
        .then(({ config }) => {
          if (generationRef.current !== generation) return
          const next = nextConnectionStatus({ kind: "config", config }, elapsedMs)
          setStatus(next)
          if (next.phase === "connecting") {
            setTimeout(poll, POLL_INTERVAL_MS)
          }
        })
        .catch(() => {
          if (generationRef.current !== generation) return
          const next = nextConnectionStatus({ kind: "fetch-failed" }, elapsedMs)
          setStatus(next)
          if (next.phase === "connecting") {
            setTimeout(poll, POLL_INTERVAL_MS)
          }
        })
    }
    setTimeout(poll, POLL_INTERVAL_MS)
  }, [loadState])

  useEffect(() => {
    return () => {
      // Invalidate any in-flight poll generation on unmount, so a stale
      // `setState` never fires after this component is gone.
      generationRef.current += 1
    }
  }, [])

  return { status, start }
}

/**
 * Renders `CloudflareTunnelConnectionStatus` -- the connecting / connected /
 * failed surface this option previously had no equivalent of, grounded in
 * `start()`'s real "Registered tunnel connection" signal via the polling
 * loop above, not a guess or a timer alone.
 */
export function CloudflareTunnelConnectionBanner({
  status,
}: {
  status: CloudflareTunnelConnectionStatus
}) {
  if (status.phase === "idle") {
    return null
  }
  if (status.phase === "connecting") {
    return (
      <p className="pdpp-caption text-muted-foreground" role="status">
        Connecting to Cloudflare… ({status.elapsedSeconds}s)
      </p>
    )
  }
  if (status.phase === "connected") {
    return (
      <p className="pdpp-caption text-foreground" role="status">
        Connected —{" "}
        <span className="select-all break-all font-mono">{status.origin}</span>
      </p>
    )
  }
  return (
    <p className="pdpp-caption text-destructive" role="alert">
      {status.reason}
    </p>
  )
}
