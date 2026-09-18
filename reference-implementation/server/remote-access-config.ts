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
  /**
   * The port an owner-run reverse proxy must target, pinned so it survives
   * restarts instead of chasing the desktop supervisor's per-launch
   * ephemeral allocation (`src-tauri/src/commands/process_supervisor.rs`'s
   * `allocate_loopback_port`). Only meaningful for `user_supplied_origin`.
   * `null`/absent keeps today's dynamic-port behavior.
   *
   * This is a supervisor launch parameter, not a PLATFORM-OWNED env var like
   * PORT/AS_PORT/RS_PORT (see README.md, "Config precedence") -- it never
   * goes through the config-store precedence resolver. It rides in this same
   * remote-access.json the desktop supervisor already reads to build each
   * process's environment.
   */
  console_port?: number | null
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
    console_port: null,
  }
}

/** A pinned port must be a real TCP port number, matching the Rust validator's `console_port == Some(0)` rejection. */
function isValidPinnedPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

/**
 * Parse and validate the owner's pinned-port form input. Empty input means
 * "no pin, keep dynamic allocation" -- distinct from an invalid one, which
 * must be rejected rather than silently falling back to unpinned.
 */
export function validatePinnedConsolePort(raw: string): { ok: true; port: number | null } | InvalidOrigin {
  const value = raw.trim()
  if (!value) {
    return { ok: true, port: null }
  }
  const port = Number.parseInt(value, 10)
  if (!isValidPinnedPort(port) || String(port) !== value) {
    return { ok: false, message: "Enter a port number between 1 and 65535, or leave it blank." }
  }
  return { ok: true, port }
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
  if (config.console_port != null && !isValidPinnedPort(config.console_port)) {
    return { ok: false, message: "Pinned console port must be an integer between 1 and 65535." }
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
      console_port: config.console_port ?? null,
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
