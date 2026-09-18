// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral `RemoteAccessConfig` contract and the `user_supplied_origin`
 * validation rules, shared by the console UI and the reference server's
 * owner-authenticated remote-access routes (`server/routes/owner-remote-access.ts`).
 *
 * This is the TypeScript half of `src-tauri/src/remote_access.rs`'s
 * `validate_origin`/`validate_remote_access_config`: same HTTPS-only, no-path,
 * no-loopback rules, same four PDPP_* reachability fields. Moved here (out of
 * `apps/console`) because the reference server -- not just the console -- now
 * validates and persists this config for the `user_supplied_origin` provider;
 * `apps/console` depends on `pdpp-reference-implementation`, never the reverse,
 * so the shared contract has to live on this side for both to import it.
 * `apps/console/.../settings/remote-access.ts` re-exports the pieces below and
 * keeps the console-only presentation helpers (badges, provider option rows)
 * local to itself.
 */

export type RemoteAccessPosture = "off" | "my_devices_only" | "public_url"

export type RemoteAccessProvider = "user_supplied_origin" | "ngrok"

export type NgrokEndpointMode = "https_edge_termination" | "tls_passthrough" | "tcp_passthrough"

export interface ReachabilityFields {
  PDPP_REFERENCE_ORIGIN: string | null
  PDPP_TRUSTED_HOSTS: string
  PDPP_TRUSTED_PROXIES: string
  PDPP_BIND_HOST: "127.0.0.1"
}

export interface NgrokOptions {
  endpoint_mode: NgrokEndpointMode
  reserved_domain: string | null
}

export interface RemoteAccessConfig {
  posture: RemoteAccessPosture
  provider: RemoteAccessProvider | null
  fields: ReachabilityFields
  ngrok?: NgrokOptions | null
}

export interface RemoteAccessInspection {
  availability: "available" | "unavailable"
  authentication: "not_required" | "required" | "authenticated" | "missing"
  reason: string | null
}

export interface OriginValidation {
  ok: true
  origin: string
  host: string
  fields: ReachabilityFields
}

export interface InvalidOrigin {
  ok: false
  message: string
}

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "::1"])

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || host === "[::1]" || host.startsWith("127.") || host.endsWith(".local")
}

/** Parse the owner-supplied URL into the exact four reachability fields. */
export function validateUserSuppliedOrigin(raw: string): OriginValidation | InvalidOrigin {
  const value = raw.trim()
  if (!value) {
    return { ok: false, message: "Enter the HTTPS origin your proxy serves." }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return {
      ok: false,
      message: "Use an absolute HTTPS origin, such as https://vault.example.com.",
    }
  }

  if (url.protocol !== "https:") {
    return { ok: false, message: "Remote access requires an HTTPS origin." }
  }
  if (!url.hostname || url.username || url.password) {
    return {
      ok: false,
      message: "The origin must include a host and no embedded credentials.",
    }
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return {
      ok: false,
      message: "Use only scheme, host, and optional port. Paths are not supported.",
    }
  }
  if (isLoopbackHost(url.hostname)) {
    return { ok: false, message: "Remote access needs a non-loopback origin." }
  }

  const origin = url.origin
  return {
    ok: true,
    origin,
    host: url.hostname,
    fields: {
      PDPP_REFERENCE_ORIGIN: origin,
      PDPP_TRUSTED_HOSTS: url.hostname,
      PDPP_TRUSTED_PROXIES: "",
      PDPP_BIND_HOST: "127.0.0.1",
    },
  }
}

export function offRemoteAccessConfig(): RemoteAccessConfig {
  return {
    posture: "off",
    provider: null,
    fields: {
      PDPP_REFERENCE_ORIGIN: null,
      PDPP_TRUSTED_HOSTS: "",
      PDPP_TRUSTED_PROXIES: "",
      PDPP_BIND_HOST: "127.0.0.1",
    },
  }
}

/**
 * Validate a full `RemoteAccessConfig` the way `set_remote_access_config` /
 * `configure_remote_access` do in `src-tauri/src/remote_access.rs`, for the
 * `user_supplied_origin` provider specifically (the only provider this HTTP
 * surface owns end to end -- see the route file header for the ngrok scope
 * fence).
 *
 * Kept byte-for-byte equivalent to the Rust validator's `PublicUrl` branch for
 * `user_supplied_origin`: bind host must stay loopback, the origin must pass
 * `validateUserSuppliedOrigin`, and `PDPP_TRUSTED_HOSTS` must equal the
 * origin's host.
 */
export function validateRemoteAccessConfig(config: RemoteAccessConfig): { ok: true; config: RemoteAccessConfig } | InvalidOrigin {
  if (config.fields.PDPP_BIND_HOST !== "127.0.0.1") {
    return { ok: false, message: "Remote access must keep PDPP_BIND_HOST at 127.0.0.1." }
  }
  if (config.posture === "off") {
    return { ok: true, config: offRemoteAccessConfig() }
  }
  if (config.posture === "my_devices_only") {
    return { ok: false, message: "My devices only is unavailable until a private-overlay provider is bundled." }
  }
  // public_url
  if (config.provider !== "user_supplied_origin") {
    return {
      ok: false,
      message: "This route only manages the user_supplied_origin provider. Configure ngrok from the desktop app.",
    }
  }
  const origin = config.fields.PDPP_REFERENCE_ORIGIN
  if (!origin) {
    return { ok: false, message: "Public URL requires PDPP_REFERENCE_ORIGIN." }
  }
  const validated = validateUserSuppliedOrigin(origin)
  if (!validated.ok) {
    return validated
  }
  if (config.fields.PDPP_TRUSTED_HOSTS.trim() !== validated.host) {
    return { ok: false, message: "PDPP_TRUSTED_HOSTS must contain the origin host." }
  }
  return {
    ok: true,
    config: {
      posture: "public_url",
      provider: "user_supplied_origin",
      fields: validated.fields,
    },
  }
}

/**
 * Capability probe for the `user_supplied_origin` provider: NOT a reflection
 * of the currently stored config's posture. Matches
 * `inspect_remote_access()` in `remote_access.rs`, which always probes a
 * synthetic, always-valid `PublicUrl` configuration
 * (`https://origin.invalid`) regardless of what posture is actually saved.
 *
 * This matters for the console UI: the settings page uses this probe to
 * decide whether the posture radios are selectable AT ALL (can this
 * provider ever work here), not whether it is currently active. Tying
 * availability to the live config instead -- so `off` reports
 * "unavailable" -- would disable every posture radio, including the ones a
 * user needs to click to turn remote access ON, the moment it's off. The
 * provider needs no credential, so authentication is always "not_required".
 */
export function inspectUserSuppliedOrigin(): RemoteAccessInspection {
  return { availability: "available", authentication: "not_required", reason: null }
}
