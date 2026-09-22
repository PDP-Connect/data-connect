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

export type RemoteAccessProvider = "user_supplied_origin" | "ngrok" | "cloudflare_tunnel"

export type NgrokEndpointMode = "https_edge_termination" | "tls_passthrough" | "tcp_passthrough"

export interface ReachabilityFields {
  PDPP_REFERENCE_ORIGIN: string | null
  PDPP_TRUSTED_HOSTS: string
  PDPP_TRUSTED_PROXIES: string
  /**
   * Loopback for every posture except `my_devices_only`, where this is the
   * machine's own LAN IP (see `MyDevicesOnlyOptions`) -- never `0.0.0.0`
   * ("0.0.0.0 Day" lets a malicious website reach an all-interfaces bind
   * from the browser; a specific LAN IP does not have that exposure).
   */
  PDPP_BIND_HOST: string
}

export interface NgrokOptions {
  endpoint_mode: NgrokEndpointMode
  reserved_domain: string | null
}

/**
 * Options the `my_devices_only` posture consumes: no provider, no vendor,
 * no daemon -- just the machine's own LAN IP, detected at launch (DHCP makes
 * it unstable across restarts, so this is never owner-typed the way
 * `user_supplied_origin`'s origin is). `lan_host` must be a private/
 * link-local address (RFC1918 or IPv4 link-local); a detected address that
 * turns out to be public (e.g. a cloud VM with no private interface) must
 * refuse this posture rather than silently bind a public interface.
 */
export interface MyDevicesOnlyOptions {
  lan_host: string
}

/**
 * Options the Cloudflare named-tunnel provider consumes. Unlike
 * `NgrokOptions.reserved_domain`, `hostname` is never optional: a named
 * tunnel with no hostname routed to it in the Cloudflare dashboard/API is
 * not usable as a Public URL provider, so there is no "not yet configured"
 * state to represent (see `src-tauri/src/remote_access_cloudflare.rs`'s
 * module doc comment for why this is a named tunnel, never a Quick Tunnel).
 */
export interface CloudflareTunnelOptions {
  hostname: string
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
  cloudflare_tunnel?: CloudflareTunnelOptions | null
  my_devices_only?: MyDevicesOnlyOptions | null
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
   * The Cloudflare named-tunnel token, sealed the same way and for the same
   * reason as `ngrok_authtoken_sealed` above -- see that field's doc comment
   * for the full handoff sequence, which applies unchanged.
   */
  cloudflare_tunnel_token_sealed?: string | null
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
  /**
   * The desktop supervisor's latest observation of the public origin
   * (`record_origin_verification` in `src-tauri/src/unified.rs`): what
   * answered its origin-proof challenge, when, and who owns the mapping from
   * the public origin to this computer. Written only by the supervisor.
   * `RemoteAccessConfigStore.save` never persists it from a request, and
   * `load` returns it only when it parses (`parseOriginVerification`).
   * Absent means nobody has checked, which must never render as healthy.
   */
  origin_verified?: OriginVerification | null
}

/** Mirrors `OriginProbeOutcome` in `src-tauri/src/remote_access.rs`. */
export type OriginProbeOutcome =
  | { kind: "reaches_this_console" }
  | { kind: "reaches_something_else"; status: number }
  | { kind: "unreachable"; reason: string }

/**
 * Mirrors `OriginBinding` in `src-tauri/src/remote_access.rs`, answered by
 * `PublicUrlProvider::origin_binding`. The console renders guidance from
 * this answer, never from the provider id.
 */
export type OriginBinding =
  | { kind: "app_supplied" }
  | { kind: "owner_maintained"; where_to_set: string }

/** Mirrors `TunnelAgentHealth` in `src-tauri/src/remote_access.rs`. */
export type TunnelAgentHealth = "stopped" | "running" | "exited"

/** Mirrors `OriginVerification` in `src-tauri/src/remote_access.rs`. */
export interface OriginVerification {
  origin: string
  /** Unix seconds. */
  checked_at: number
  /** Seconds after `checked_at` the reading still counts as evidence. */
  stale_after: number
  outcome: OriginProbeOutcome
  binding: OriginBinding
  agent?: TunnelAgentHealth | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseOriginProbeOutcome(value: unknown): OriginProbeOutcome | null {
  if (!isRecord(value)) return null
  if (value.kind === "reaches_this_console") return { kind: "reaches_this_console" }
  if (value.kind === "reaches_something_else" && Number.isInteger(value.status)) {
    return { kind: "reaches_something_else", status: value.status as number }
  }
  if (value.kind === "unreachable" && typeof value.reason === "string") {
    return { kind: "unreachable", reason: value.reason }
  }
  return null
}

function parseOriginBinding(value: unknown): OriginBinding | null {
  if (!isRecord(value)) return null
  if (value.kind === "app_supplied") return { kind: "app_supplied" }
  if (value.kind === "owner_maintained" && typeof value.where_to_set === "string" && value.where_to_set.trim()) {
    return { kind: "owner_maintained", where_to_set: value.where_to_set }
  }
  return null
}

/**
 * Read the supervisor's observation, or `null` if it is absent or in any
 * shape other than the current one. An observation is re-taken every
 * minute, so a record from an older build is worth nothing -- and a guessed
 * reading is worse than none, because the console would render it.
 */
export function parseOriginVerification(value: unknown): OriginVerification | null {
  if (!isRecord(value)) return null
  const outcome = parseOriginProbeOutcome(value.outcome)
  const binding = parseOriginBinding(value.binding)
  if (
    typeof value.origin !== "string" ||
    !Number.isFinite(value.checked_at) ||
    !Number.isFinite(value.stale_after) ||
    !outcome ||
    !binding
  ) {
    return null
  }
  const agent =
    value.agent === "stopped" || value.agent === "running" || value.agent === "exited" ? value.agent : null
  return {
    origin: value.origin,
    checked_at: value.checked_at as number,
    stale_after: value.stale_after as number,
    outcome,
    binding,
    agent,
  }
}

export interface RemoteAccessInspection {
  availability: "available" | "unavailable"
  authentication: "not_required" | "required" | "authenticated" | "missing"
  reason: string | null
}

/**
 * Cloudflare Tunnel's capability probe extends the shared shape with one
 * field no other provider needs: whether the `cloudflared` binary itself is
 * present on this machine, checked at RS-spawn time by the Tauri supervisor
 * (`src-tauri/src/unified.rs`'s `CLOUDFLARED_BINARY_PRESENT_ENV`) and passed
 * through as an env var, mirroring how `MANAGED_DESKTOP_HOST_ENV` already
 * crosses the same process boundary. The owner needs to see this BEFORE
 * picking the option and pasting a token, not discover it as a spawn
 * failure afterward. `null` means "unknown" -- the desktop host env var was
 * absent entirely (an old build, or a non-desktop deployment where
 * `availability` is already `unavailable` for an unrelated reason) --
 * distinct from `false`, which is a real, checked "not installed."
 */
export interface CloudflareTunnelInspection extends RemoteAccessInspection {
  cloudflared_binary_present: boolean | null
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
 * True for an RFC1918 IPv4 address, IPv4 link-local, or an IPv6 ULA/
 * link-local address -- NEVER true for loopback or `0.0.0.0`. This is the
 * "real LAN interface" check for `my_devices_only`: it must reject a
 * loopback address masquerading as a LAN host, and it must reject a
 * detected address that turns out to be public (e.g. a cloud VM with no
 * private interface), so this posture never silently binds a public one.
 */
function isPrivateLanHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (ipv4) {
    const first = Number(ipv4[1])
    const second = Number(ipv4[2])
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    )
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
}

/**
 * Validate the `my_devices_only` posture: no provider, no daemon, no third
 * party -- the console and reference server bind the machine's own LAN
 * address instead of loopback, so devices on the same network reach it
 * directly. `lan_host` is detected at launch (see
 * `src-tauri/src/remote_access.rs`'s LAN-detection helper), never
 * owner-typed, since DHCP makes it unstable across restarts.
 *
 * The owner password stays mandatory -- `resolveOwnerExposurePosture`
 * (`owner-exposure-posture.ts`) already fails closed whenever the bind host
 * is non-loopback, and binding a LAN address triggers that same gate.
 */
function validateMyDevicesOnlyConfig(config: RemoteAccessConfig): { ok: true; config: RemoteAccessConfig } | InvalidOrigin {
  const lanHost = config.my_devices_only?.lan_host?.trim()
  if (!lanHost) {
    return { ok: false, message: "My devices only requires a detected LAN address." }
  }
  if (!isPrivateLanHost(lanHost)) {
    return {
      ok: false,
      message: "My devices only requires a private network address; the detected address is not on a private range.",
    }
  }
  const port = config.console_port
  const origin = port != null ? `http://${lanHost}:${port}` : `http://${lanHost}`
  return {
    ok: true,
    config: {
      posture: "my_devices_only",
      provider: null,
      fields: {
        PDPP_REFERENCE_ORIGIN: origin,
        PDPP_TRUSTED_HOSTS: lanHost,
        PDPP_TRUSTED_PROXIES: "",
        PDPP_BIND_HOST: lanHost,
      },
      console_port: config.console_port ?? null,
      my_devices_only: { lan_host: lanHost },
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
 * bind host must stay loopback for `off`/`public_url`; `my_devices_only` is
 * the one posture allowed a private LAN bind host instead (see
 * `validateMyDevicesOnlyConfig`). `user_supplied_origin` requires the origin
 * to pass `validateUserSuppliedOrigin` with `PDPP_TRUSTED_HOSTS` equal to the
 * origin's host; ngrok is accepted with empty reachability fields (the ngrok
 * edge assigns the origin at tunnel start, same as
 * `validate_remote_access_config`'s `discovers_own_origin` branch).
 */
/**
 * Whether persisting `next` in place of `current`, given whether this
 * submission carries a fresh provider credential, risks tearing down the
 * very connection an owner reached this route through. Exists for
 * `owner-remote-access.ts`'s POST /config handler, paired with
 * `isRemoteOriginRequest` (`reachability-contract.ts`): if the request is
 * remote AND this returns true, the config change could strand the owner
 * with no path back except physical access to the machine -- Tim's exact
 * scenario.
 *
 * `submittingCredential` has to be an explicit input, not inferred by
 * diffing `current` against `next`: neither `ngrok_authtoken_sealed` nor
 * `cloudflare_tunnel_token_sealed` round-trips through this comparison (the
 * route seals a fresh plaintext credential on every ngrok/cloudflare_tunnel
 * submission -- see `owner-remote-access.ts`'s POST handler -- so `next`
 * never contains the OLD sealed value to compare against), and there is no
 * cheap way to tell "the resubmitted token happens to be identical" from
 * "it changed" without decrypting and comparing plaintext, which is more
 * invasive than this check warrants. A fresh credential could always be
 * wrong even when the hostname/domain did not change, so ANY submitted
 * credential for a provider that needs one is treated as risky -- not just
 * a changed hostname.
 *
 * Deliberately narrower than "any config change": a change that needs no
 * credential at all and keeps the SAME provider and hostname/domain (for
 * example, only re-pinning `console_port`) does not risk disconnection,
 * because the Tauri config watcher
 * (`spawn_remote_access_config_watcher`, `src-tauri/src/unified.rs`) only
 * restarts the stack when the persisted config actually differs from what
 * is already running, and an unchanged provider/hostname pair with no new
 * credential reconnects to the exact same tunnel, not a new one that could
 * fail. The genuinely risky changes are: leaving `public_url` entirely
 * (posture change), switching which provider serves the tunnel, changing
 * that provider's hostname/domain, or submitting any fresh credential.
 *
 * A provider CHANGE is flagged even when `current`'s provider had no
 * working tunnel (e.g. `tunnel_error` was already set): the safe default is
 * to warn, not to guess whether the owner is currently connected through
 * it. `isRemoteOriginRequest` already answered the question that matters --
 * this request itself arrived on the public origin, so SOMETHING is
 * currently serving it -- so there is no cheaply-available extra evidence
 * that would justify skipping the warning.
 */
export function wouldDisconnectRemoteOwner(
  current: RemoteAccessConfig,
  next: RemoteAccessConfig,
  submittingCredential: boolean
): boolean {
  if (current.posture !== "public_url") {
    // Nothing to disconnect FROM -- there was no remote tunnel serving this
    // request's own connection in the first place. (In practice
    // `isRemoteOriginRequest` already implies `current.posture ===
    // "public_url"`, since a remote origin can only exist if a tunnel is
    // configured -- this is a defensive, independent check, not a
    // redundant one to remove.)
    return false
  }
  if (next.posture !== "public_url") {
    return true
  }
  if (next.provider !== current.provider) {
    return true
  }
  if (submittingCredential) {
    return true
  }
  if (current.provider === "ngrok") {
    return current.ngrok?.reserved_domain !== next.ngrok?.reserved_domain
  }
  if (current.provider === "cloudflare_tunnel") {
    return current.cloudflare_tunnel?.hostname !== next.cloudflare_tunnel?.hostname
  }
  if (current.provider === "user_supplied_origin") {
    return current.fields.PDPP_REFERENCE_ORIGIN !== next.fields.PDPP_REFERENCE_ORIGIN
  }
  return false
}

export function validateRemoteAccessConfig(config: RemoteAccessConfig): { ok: true; config: RemoteAccessConfig } | InvalidOrigin {
  if (config.console_port != null && !isValidPinnedPort(config.console_port)) {
    return { ok: false, message: "Pinned console port must be an integer between 1 and 65535." }
  }
  if (config.posture === "off") {
    if (config.fields.PDPP_BIND_HOST !== "127.0.0.1") {
      return { ok: false, message: "Remote access must keep PDPP_BIND_HOST at 127.0.0.1." }
    }
    return { ok: true, config: offRemoteAccessConfig() }
  }
  if (config.posture === "my_devices_only") {
    return validateMyDevicesOnlyConfig(config)
  }
  if (config.fields.PDPP_BIND_HOST !== "127.0.0.1") {
    return { ok: false, message: "Remote access must keep PDPP_BIND_HOST at 127.0.0.1." }
  }
  // public_url
  if (config.provider === "ngrok") {
    return validateNgrokConfig(config)
  }
  if (config.provider === "cloudflare_tunnel") {
    return validateCloudflareTunnelConfig(config)
  }
  if (config.provider !== "user_supplied_origin") {
    return {
      ok: false,
      message: "This route only manages the user_supplied_origin, ngrok, and cloudflare_tunnel providers.",
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
 * A named Cloudflare tunnel's hostname is ALWAYS a durable address the
 * moment it is configured -- there is no "not yet configured" state the way
 * ngrok's free-plan dev domain has, because the owner already routed the
 * hostname to this tunnel in Cloudflare's dashboard/API before selecting
 * this provider is even possible. Mirrors the Rust free function
 * `cloudflare_tunnel_durable_address` in
 * `src-tauri/src/remote_access_cloudflare.rs`.
 */
export function cloudflareTunnelDurableAddress(hostname: string): DurableAddressState {
  return { kind: "available", address: hostname }
}

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
  if (config.provider === "cloudflare_tunnel" && config.cloudflare_tunnel?.hostname) {
    return cloudflareTunnelDurableAddress(config.cloudflare_tunnel.hostname)
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
 * Mirrors `validate_remote_access_config`'s Cloudflare-tunnel branch in
 * `src-tauri/src/remote_access.rs` (via `resolve_public_url_provider`'s
 * Cloudflare arm in `remote_access_providers.rs`). Unlike
 * `validateNgrokConfig`, the origin is ALWAYS knowable from config here --
 * `cloudflareTunnelDurableAddress` never returns `auth_insufficient` -- so
 * this function has no "origin must stay empty" branch at all. But
 * "knowable" means DERIVABLE from the hostname the owner already typed, not
 * "the console must also submit it": the origin is exactly `https://` +
 * hostname, so this function computes it via `validateUserSuppliedOrigin`
 * rather than requiring the console to send a `PDPP_REFERENCE_ORIGIN` it has
 * no way to construct correctly itself (query strings, ports, trailing
 * slashes) -- the same reason `validateMyDevicesOnlyConfig` synthesizes its
 * origin from `lan_host` instead of trusting a client-submitted one. A
 * `PDPP_REFERENCE_ORIGIN` already present in `config.fields` that disagrees
 * with the hostname is still rejected, so a stale or hand-edited value can
 * never silently diverge from what this provider will actually serve.
 *
 * `cloudflare_tunnel_token_sealed` passes through untouched, same as
 * `ngrok_authtoken_sealed` in `validateNgrokConfig`.
 */
function validateCloudflareTunnelConfig(config: RemoteAccessConfig): { ok: true; config: RemoteAccessConfig } | InvalidOrigin {
  const hostname = config.cloudflare_tunnel?.hostname?.trim()
  if (!hostname) {
    return { ok: false, message: "Cloudflare tunnel requires a hostname." }
  }
  const submittedOrigin = config.fields.PDPP_REFERENCE_ORIGIN?.trim()
  const validated = validateUserSuppliedOrigin(submittedOrigin || `https://${hostname}`)
  if (!validated.ok) {
    return validated
  }
  if (validated.host !== hostname) {
    return { ok: false, message: "PDPP_REFERENCE_ORIGIN must match the configured Cloudflare tunnel hostname." }
  }
  return {
    ok: true,
    config: {
      posture: "public_url",
      provider: "cloudflare_tunnel",
      fields: validated.fields,
      cloudflare_tunnel: { hostname },
      cloudflare_tunnel_token_sealed: config.cloudflare_tunnel_token_sealed ?? null,
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

const CLOUDFLARED_BINARY_PRESENT_ENV = "PDPP_CLOUDFLARED_BINARY_PRESENT"

function readTriStateFlag(env: NodeJS.ProcessEnv, name: string): boolean | null {
  const raw = env[name]
  return raw === "1" ? true : raw === "0" ? false : null
}

/**
 * Capability probe for the Cloudflare named-tunnel provider. Mirrors
 * `inspectNgrok`: it too genuinely needs a native host (a keychain slot for
 * the tunnel token and Rust-side `cloudflared` process supervision in
 * `src-tauri/src/remote_access_cloudflare.rs`), so the same
 * `MANAGED_DESKTOP_HOST_ENV` gate applies. Additionally reports whether the
 * `cloudflared` binary is installed -- see `CloudflareTunnelInspection`'s
 * doc comment for why this must be answerable before the owner commits to
 * this option.
 */
export function inspectCloudflareTunnel(env: NodeJS.ProcessEnv = process.env): CloudflareTunnelInspection {
  if (!isManagedDesktopHostPresent(env)) {
    return {
      availability: "unavailable",
      authentication: "not_required",
      cloudflared_binary_present: null,
      reason:
        "Cloudflare Tunnel needs the DataConnect desktop app: it stores your tunnel token in the OS keychain and supervises the cloudflared process natively. This deployment has no desktop host to do that, so Cloudflare Tunnel cannot be enabled here. Use \"A proxy you run\" instead.",
    }
  }
  return {
    availability: "available",
    authentication: "not_required",
    cloudflared_binary_present: readTriStateFlag(env, CLOUDFLARED_BINARY_PRESENT_ENV),
    reason: null,
  }
}
