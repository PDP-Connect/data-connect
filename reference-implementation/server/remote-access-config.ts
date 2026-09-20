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
  /**
   * The ngrok authtoken, sealed with `createCredentialCipherFromEnv()`
   * (`stores/credential-encryption.ts`) under `PDPP_CREDENTIAL_ENCRYPTION_KEY`
   * -- the SAME key `src-tauri/src/owner_credential.rs` generates and already
   * passes to this process. Present only for the brief window between the
   * owner submitting a new ngrok authtoken over HTTP and the Tauri
   * supervisor's config watcher (`spawn_remote_access_config_watcher` in
   * `src-tauri/src/unified.rs`) decrypting it into the OS keychain and
   * writing this field back to `null`. Never the plaintext token: this file
   * is read by both processes and neither should ever persist the token
   * unsealed at rest, even briefly.
   */
  ngrok_authtoken_sealed?: string | null
  /**
   * Set by `start_managed_stack` (`src-tauri/src/unified.rs`) when the
   * selected provider's tunnel failed to start -- for example ngrok's
   * `ERR_NGROK_312` (TLS endpoints require a paid plan). The stack keeps
   * running without a public origin in this case rather than aborting
   * startup; this field is how the console learns that happened instead of
   * showing an unconditional "waiting for an address" state forever. Cleared
   * on the next successful tunnel start, and cleared immediately by
   * `offRemoteAccessConfig()` / `validateNgrokConfig()` whenever the owner
   * changes posture or provider, so a stale failure from a since-abandoned
   * provider never lingers on screen.
   */
  tunnel_error?: string | null
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
 * `configure_remote_access` do in `src-tauri/src/remote_access.rs`, for both
 * providers this route family now owns: `user_supplied_origin` end to end,
 * and ngrok's config/posture shape (the authtoken handoff is a separate
 * concern -- see `owner-remote-access.ts`'s route handler, which seals it
 * before it ever reaches this function).
 *
 * Kept byte-for-byte equivalent to the Rust validator's `PublicUrl` branch:
 * bind host must stay loopback; `user_supplied_origin` requires the origin to
 * pass `validateUserSuppliedOrigin` with `PDPP_TRUSTED_HOSTS` equal to the
 * origin's host; ngrok is accepted with empty reachability fields (the ngrok
 * edge assigns the origin at tunnel start, same as
 * `validate_remote_access_config`'s `discovers_own_origin` branch).
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
  if (config.provider === "ngrok") {
    return validateNgrokConfig(config)
  }
  if (config.provider !== "user_supplied_origin") {
    return {
      ok: false,
      message: "This route only manages the user_supplied_origin and ngrok providers.",
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

const NGROK_ENDPOINT_MODES: readonly NgrokEndpointMode[] = [
  "https_edge_termination",
  "tls_passthrough",
  "tcp_passthrough",
]

/**
 * The states a durable public address can be in for a provider, derived
 * purely from stored config -- no network call. Mirrors `DurableAddressState`
 * in `src-tauri/src/remote_access.rs`, restricted to the subset reachable
 * today (see that enum's doc comment for the full 8-variant shape and why the
 * rest are kept there but not here): `Provisionable`/`NotProvisionable` are a
 * real-but-currently-unreachable ngrok product state (a free account with
 * zero domains, which does not happen -- every free-plan account is assigned
 * one at creation); `Revoked`/`DiscoveryUnreachable`/`AvailableMultiple` need
 * an actual reachability check neither this server nor the console can
 * perform without a verified ngrok API path (see
 * `ngrokDurableAddress`'s doc comment for why), so they are not derivable
 * from config alone.
 */
export type DurableAddressState =
  | { kind: "not_applicable" }
  | { kind: "available"; address: string }
  | { kind: "auth_insufficient"; reason: string }

/**
 * `config.ngrok.reserved_domain` already means "the owner has told us their
 * stable ngrok address" -- if it is set, that field IS the durable address,
 * with no further check needed. If it is unset, this app has no verified way
 * to look one up automatically (ngrok's account-management API needs a
 * separate API key, not the tunnel authtoken this app already holds, and
 * asking for a second credential to read a value off a dashboard is worse UX
 * than asking for the value itself), so the honest state is
 * `auth_insufficient` with the concrete next step, never a silent guess.
 *
 * Kept byte-for-byte equivalent to the Rust free function
 * `ngrok_durable_address_for_reserved_domain` in
 * `src-tauri/src/remote_access_ngrok.rs`, which both a live `NgrokProvider`
 * and the config-only `PublicUrlProvider` (`remote_access_providers.rs`)
 * call, so there is one implementation per language, not two per language
 * that could drift out of step with each other.
 */
export function ngrokDurableAddress(reservedDomain: string | null | undefined): DurableAddressState {
  if (reservedDomain) {
    return { kind: "available", address: reservedDomain }
  }
  return {
    kind: "auth_insufficient",
    reason:
      "ngrok's free plan assigns one stable domain to your account, but this app cannot look it up automatically. Copy it from dashboard.ngrok.com/domains and paste it below.",
  }
}

/**
 * `user_supplied_origin` has no durable-address concept at all: the owner
 * supplies the whole origin directly, so there is nothing to discover,
 * provision, or lose. Matches `UserSuppliedOriginProvider::durable_address()`
 * in `src-tauri/src/remote_access.rs`, the honesty check for the shape above
 * -- a provider with nothing to report costs one constant, not a branch.
 */
export const USER_SUPPLIED_ORIGIN_DURABLE_ADDRESS: DurableAddressState = { kind: "not_applicable" }

/**
 * The durable-address state for whichever provider `config` currently
 * selects. `null` for `off`/`my_devices_only` or an unrecognized provider,
 * where the question does not apply.
 */
export function durableAddressState(config: RemoteAccessConfig): DurableAddressState | null {
  if (config.provider === "user_supplied_origin") {
    return USER_SUPPLIED_ORIGIN_DURABLE_ADDRESS
  }
  if (config.provider === "ngrok") {
    return ngrokDurableAddress(config.ngrok?.reserved_domain ?? null)
  }
  return null
}

/**
 * The single rule `validateNgrokConfig` (and, in Rust,
 * `validate_remote_access_config`) uses to decide whether
 * `PDPP_REFERENCE_ORIGIN` is required in stored config already, or must stay
 * empty until a live session reports it: true for every state where a
 * concrete origin is already resolvable from config alone
 * (`not_applicable` -- `user_supplied_origin` always supplies the whole
 * origin, so it is "known up front" even with no discovery concept at all --
 * and `available`, a durable address already exists). False for
 * `auth_insufficient`, meaning the provider itself must report the origin
 * once a session starts -- ngrok with no configured domain.
 *
 * Mirrors `DurableAddressState::origin_is_knowable_from_config` in
 * `src-tauri/src/remote_access.rs` exactly; see that method's doc comment for
 * why this replaced a separate, provider-kind-hardcoded concept
 * (`discovers_own_origin`) that a config-only rule (this function's prior
 * incarnation, which rejected ANY non-empty ngrok origin unconditionally)
 * drifted out of step with the moment a dev domain made ngrok's origin
 * knowable up front. Confirmed live, 2026-09-19: that drift is exactly what
 * broke -- the owner's dev-domain origin was rejected here, the RS threw, and
 * the console's settings page crashed.
 */
export function originIsKnowableFromConfig(state: DurableAddressState): boolean {
  return state.kind === "not_applicable" || state.kind === "available"
}

/**
 * Mirrors `validate_remote_access_config`'s ngrok branch in
 * `src-tauri/src/remote_access.rs` plus `resolve_public_url_provider`'s
 * origin-timing rule in `src-tauri/src/remote_access_providers.rs`: derives
 * whether an origin is required in config yet from `ngrokDurableAddress` via
 * `originIsKnowableFromConfig`, the same single rule the Rust side uses,
 * rather than a fact hardcoded to this function alone.
 *
 * `ngrok_authtoken_sealed` passes through untouched; this function only
 * validates config shape, never the credential.
 */
function validateNgrokConfig(config: RemoteAccessConfig): { ok: true; config: RemoteAccessConfig } | InvalidOrigin {
  const ngrok = config.ngrok
  if (!ngrok || !NGROK_ENDPOINT_MODES.includes(ngrok.endpoint_mode)) {
    return { ok: false, message: "ngrok requires an endpoint mode." }
  }
  if (ngrok.endpoint_mode === "tcp_passthrough" && ngrok.reserved_domain) {
    return { ok: false, message: "ngrok TCP endpoints reserve an address, not a domain." }
  }
  const ngrokOptions = { endpoint_mode: ngrok.endpoint_mode, reserved_domain: ngrok.reserved_domain ?? null }
  const origin = config.fields.PDPP_REFERENCE_ORIGIN
  const originKnowableFromConfig = originIsKnowableFromConfig(ngrokDurableAddress(ngrok.reserved_domain ?? null))

  if (!origin) {
    if (config.fields.PDPP_TRUSTED_HOSTS.trim()) {
      return {
        ok: false,
        message: "PDPP_TRUSTED_HOSTS must be empty until ngrok reports an origin.",
      }
    }
    return {
      ok: true,
      config: {
        posture: "public_url",
        provider: "ngrok",
        fields: offRemoteAccessConfig().fields,
        ngrok: ngrokOptions,
        ngrok_authtoken_sealed: config.ngrok_authtoken_sealed ?? null,
        // Passed through, not synthesized: a reload of a file the Tauri
        // supervisor wrote a failure to (`apply_ngrok_tunnel_outcome` in
        // src-tauri/src/unified.rs) must keep reporting it, while a config
        // the console just submitted never carries this field in the first
        // place, so it naturally clears on the owner's next submission
        // without this function needing to tell those two callers apart.
        tunnel_error: config.tunnel_error ?? null,
      },
    }
  }
  if (!originKnowableFromConfig) {
    // An origin is present but the provider's own durable-address state
    // says it should not be knowable yet (no domain configured): reject
    // rather than silently trust a value nothing vouches for -- this is the
    // ngrok-without-a-domain case, and it must keep failing closed the same
    // way it did before this fix.
    return {
      ok: false,
      message: "PDPP_REFERENCE_ORIGIN must be empty until ngrok reports an origin.",
    }
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
      provider: "ngrok",
      fields: validated.fields,
      ngrok: ngrokOptions,
      ngrok_authtoken_sealed: config.ngrok_authtoken_sealed ?? null,
      tunnel_error: config.tunnel_error ?? null,
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

/**
 * Set by `src-tauri/src/unified.rs::ri_environment` ONLY when this RI process
 * is a child of the Tauri desktop supervisor with remote-access configuration
 * enabled (`remote_access_configuration_supported()`), never in a plain
 * self-hosted deployment. ngrok's authtoken handoff and tunnel supervision
 * both depend on the supervisor's config watcher
 * (`spawn_remote_access_config_watcher`) being alive to consume
 * `ngrok_authtoken_sealed` and start the tunnel -- with no Tauri host, a
 * submitted ngrok config would sit in `remote-access.json` forever, sealed
 * and inert. Reusing the SAME reachability contract shape as
 * `ReachabilityEnv` (a plain env read) keeps this consistent with the rest of
 * the deployment-detection story instead of adding a second heartbeat
 * mechanism.
 */
export const MANAGED_DESKTOP_HOST_ENV = "PDPP_MANAGED_DESKTOP_HOST"

export function isManagedDesktopHostPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_DESKTOP_HOST_ENV] === "1"
}

/**
 * Capability probe for the ngrok provider. Unlike `user_supplied_origin`,
 * ngrok genuinely needs a native host: an OS keychain slot for its authtoken
 * and Rust-side (`src-tauri/src/remote_access_ngrok.rs`) tunnel process
 * supervision, neither of which a plain Node RI process can do for itself.
 * When no Tauri supervisor is present, the row must say so plainly rather
 * than accept a config that will never activate (see the module doc comment
 * above `MANAGED_DESKTOP_HOST_ENV`).
 */
export function inspectNgrok(env: NodeJS.ProcessEnv = process.env): RemoteAccessInspection {
  if (!isManagedDesktopHostPresent(env)) {
    return {
      availability: "unavailable",
      authentication: "not_required",
      reason:
        "ngrok needs the DataConnect desktop app: it stores your authtoken in the OS keychain and supervises the tunnel process natively. This deployment has no desktop host to do that, so ngrok cannot be enabled here. Use \"A proxy you run\" instead.",
    }
  }
  return { availability: "available", authentication: "not_required", reason: null }
}
