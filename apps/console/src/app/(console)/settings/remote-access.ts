// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `RemoteAccessConfig` contract and `validateUserSuppliedOrigin` are
 * pure, zero-Tauri-dependency logic now shared with the reference server's
 * owner-authenticated remote-access routes
 * (`reference-implementation/server/routes/owner-remote-access.ts`), which
 * validate and persist this same config. `apps/console` depends on
 * `pdpp-reference-implementation`, never the reverse, so the shared contract
 * lives there and this module re-exports it. Everything below this re-export
 * is console-only presentation (badges, selectable provider rows).
 */
import type {
  InvalidOrigin,
  NgrokEndpointMode,
  RemoteAccessConfig,
  RemoteAccessPosture,
  RemoteAccessProvider,
} from "pdpp-reference-implementation/remote-access-config"

export {
  inspectUserSuppliedOrigin,
  offRemoteAccessConfig,
  validateUserSuppliedOrigin,
  type InvalidOrigin,
  type NgrokEndpointMode,
  type NgrokOptions,
  type OriginValidation,
  type ReachabilityFields,
  type RemoteAccessConfig,
  type RemoteAccessInspection,
  type RemoteAccessPosture,
  type RemoteAccessProvider,
} from "pdpp-reference-implementation/remote-access-config"

/**
 * The badge states only what we can actually verify about who can read
 * plaintext. We never assert a negative we cannot prove: a user-supplied proxy
 * terminates TLS unless the owner configures passthrough, and we have no way to
 * inspect an endpoint we do not operate. A uniformly reassuring badge is worse
 * than none, so each posture reports its real, distinct property.
 */
export type PrivacyBadge =
  | "No provider - this device only"
  | "Unavailable - no provider yet"
  | "Depends on your proxy - it can read your data unless it passes TLS through"

export function privacyBadgeForPosture(
  posture: RemoteAccessPosture
): PrivacyBadge {
  switch (posture) {
    // No provider exists in this posture, so any provider-privacy claim would
    // imply a third party that is not there.
    case "off":
      return "No provider - this device only"
    // Not selectable (no embedded provider ships yet). Asserting a privacy
    // property for something that cannot be chosen would be a claim about
    // software that does not exist.
    case "my_devices_only":
      return "Unavailable - no provider yet"
    // The owner supplies this endpoint. Whether the operator reads plaintext
    // depends on that proxy's TLS termination, which we cannot verify.
    case "public_url":
      return "Depends on your proxy - it can read your data unless it passes TLS through"
  }
}

/**
 * The payload-privacy property belongs to the endpoint the owner picks within
 * Public URL, not to the posture. An ngrok HTTPS edge terminates TLS and can
 * read plaintext; ngrok TLS passthrough cannot. Keying this on posture alone
 * would state the opposite of the truth for an edge-terminated ngrok endpoint,
 * so each Public URL option carries its own, never-blank badge.
 */
export type ProviderPrivacyBadge =
  | "Provider cannot read your data"
  | "Provider can read your data"
  | "Depends on your proxy - it can read your data unless it passes TLS through"

export function privacyBadgeForNgrokMode(
  mode: NgrokEndpointMode
): ProviderPrivacyBadge {
  switch (mode) {
    case "https_edge_termination":
      // ngrok holds the certificate and reads plaintext at its edge.
      return "Provider can read your data"
    case "tls_passthrough":
    case "tcp_passthrough":
      // Proven for ngrok Rust SDK 0.19.0 specifically: session.rs sets
      // `passthrough_tls = opts.tls_termination.is_none()`, and the adapter
      // never calls `termination()`, so the edge relays ciphertext. An SDK
      // upgrade must re-verify this before the claim can be trusted again.
      return "Provider cannot read your data"
  }
}

export interface PublicUrlOption {
  id: string
  provider: RemoteAccessProvider
  ngrokMode: NgrokEndpointMode | null
  label: string
  description: string
  badge: ProviderPrivacyBadge
  /** True when the owner must paste an ngrok authtoken before enabling. */
  requiresAuthtoken: boolean
  /** Stated only where ngrok's published plan limits make it load-bearing. */
  planNote: string | null
}

/**
 * Every selectable Public URL option, each with a badge that is never blank and
 * never "unknown". Order runs least-friction first.
 */
export const publicUrlOptions: readonly PublicUrlOption[] = [
  {
    id: "ngrok_https_edge_termination",
    provider: "ngrok",
    ngrokMode: "https_edge_termination",
    label: "ngrok — HTTPS",
    description:
      "ngrok gives this Personal Server a public HTTPS address. ngrok terminates TLS at its edge, so it can read requests and responses.",
    badge: "Provider can read your data",
    requiresAuthtoken: true,
    planNote:
      "Works on the ngrok free plan. Free endpoints show an ngrok interstitial page and get a random ngrok-free.app hostname.",
  },
  {
    id: "ngrok_tls_passthrough",
    provider: "ngrok",
    ngrokMode: "tls_passthrough",
    label: "ngrok — TLS passthrough",
    description:
      "ngrok relays encrypted bytes without decrypting them. ngrok still sees connection metadata and can take the connection offline.",
    badge: "Provider cannot read your data",
    requiresAuthtoken: true,
    planNote:
      "Requires a paid ngrok plan: ngrok lists TLS endpoints as not available on the free plan.",
  },
  {
    id: "user_supplied_origin",
    provider: "user_supplied_origin",
    ngrokMode: null,
    label: "A proxy you run",
    description:
      "Use a reverse proxy or tunnel you already operate. DataConnect only records the origin it should expect.",
    // DataConnect does not operate this proxy and cannot inspect where it
    // terminates TLS, so it cannot prove the operator is unable to read the
    // traffic. We never assert a negative we cannot prove.
    badge:
      "Depends on your proxy - it can read your data unless it passes TLS through",
    requiresAuthtoken: false,
    planNote: null,
  },
]

/** The option preselected when the owner opens the Public URL flow. */
export const DEFAULT_PUBLIC_URL_OPTION_ID = "ngrok_https_edge_termination"

export function publicUrlOptionById(id: string): PublicUrlOption | null {
  return publicUrlOptions.find(option => option.id === id) ?? null
}

/**
 * A reserved domain is optional. Empty means "let ngrok assign a hostname",
 * which the owner has accepted. A supplied value must be a bare hostname,
 * because the SDK's `domain()` takes a host and not a URL.
 */
export function validateReservedDomain(
  raw: string
): { ok: true; domain: string | null } | InvalidOrigin {
  const value = raw.trim()
  if (!value) return { ok: true, domain: null }
  if (/[:/?#]/.test(value)) {
    return {
      ok: false,
      message:
        "Enter only the hostname, such as vault.ngrok.app — no scheme, port, or path.",
    }
  }
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
      value
    )
  ) {
    return { ok: false, message: "Enter a valid reserved domain hostname." }
  }
  return { ok: true, domain: value.toLowerCase() }
}

/** Remote postures cannot become active before the owner-password step. */
export function remoteAccessRequiresOwnerPassword(
  current: RemoteAccessPosture,
  next: RemoteAccessPosture
): boolean {
  return current === "off" && next !== "off"
}

export interface TunnelErrorGuidance {
  message: string
  /** Present only when a specific, working alternative exists to offer. */
  suggestSwitchTo: "ngrok_https_edge_termination" | null
}

/**
 * Turn `RemoteAccessConfig.tunnel_error` (set by `apply_ngrok_tunnel_outcome`
 * in `src-tauri/src/unified.rs` when the provider's tunnel failed to start)
 * into copy the owner can act on. `ERR_NGROK_312` specifically means "TLS
 * endpoints need a paid ngrok plan"
 * (https://ngrok.com/docs/errors/err_ngrok_312) -- a plan limit, not a broken
 * build, and one with a free-plan alternative (`publicUrlOptions[0]`, ngrok
 * HTTPS) worth surfacing directly rather than leaving the owner to guess.
 * Every other tunnel failure still gets the raw message rather than a guess
 * at its cause.
 */
export function describeTunnelError(tunnelError: string): TunnelErrorGuidance {
  if (tunnelError.includes("ERR_NGROK_312")) {
    return {
      message:
        "ngrok TLS passthrough needs a paid ngrok plan (ERR_NGROK_312): ngrok does not offer TLS endpoints on the free plan.",
      suggestSwitchTo: "ngrok_https_edge_termination",
    }
  }
  return { message: tunnelError, suggestSwitchTo: null }
}

export type RemoteAccessOriginDisplay =
  | { kind: "error"; guidance: TunnelErrorGuidance }
  | { kind: "waiting" }
  | { kind: "origin"; origin: string }

/**
 * What `RemoteAccessSetting` shows in the Public URL origin slot, as a pure
 * function of the persisted config -- kept separate from the component so
 * the failure path (a Public URL posture whose provider never reached a
 * reachable origin) is exercised by a plain unit test rather than a DOM
 * renderer, matching every other decision in this module. `tunnel_error`
 * wins over a present-but-stale origin: `apply_ngrok_tunnel_outcome`
 * (`src-tauri/src/unified.rs`) never clears `PDPP_REFERENCE_ORIGIN` on a
 * failed restart attempt, so an old origin sitting next to a fresh failure
 * would otherwise look like a still-working tunnel.
 */
export function remoteAccessOriginDisplay(
  config: RemoteAccessConfig
): RemoteAccessOriginDisplay {
  if (config.tunnel_error) {
    return { kind: "error", guidance: describeTunnelError(config.tunnel_error) }
  }
  const origin = config.fields.PDPP_REFERENCE_ORIGIN
  return origin ? { kind: "origin", origin } : { kind: "waiting" }
}
