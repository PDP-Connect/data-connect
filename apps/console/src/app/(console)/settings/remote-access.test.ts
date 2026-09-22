// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import {
  cloudflareTunnelDurableAddressState,
  describeTunnelError,
  ngrokDurableAddressState,
  offRemoteAccessConfig,
  originVerificationDisplay,
  privacyBadgeForNgrokMode,
  privacyBadgeForPosture,
  publicUrlOptionById,
  publicUrlOptions,
  remoteAccessOriginDisplay,
  remoteAccessRequiresOwnerPassword,
  validateCloudflareTunnelHostname,
  validateNgrokDomain,
  validatePinnedConsolePort,
  validateUserSuppliedOrigin,
  type OriginVerification,
  type RemoteAccessConfig,
} from "./remote-access.ts"

test("user-supplied origins normalize the four reachability fields", () => {
  assert.deepEqual(
    validateUserSuppliedOrigin(" https://vault.example.com:8443/ "),
    {
      ok: true,
      origin: "https://vault.example.com:8443",
      host: "vault.example.com",
      fields: {
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com:8443",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
        PDPP_BIND_HOST: "127.0.0.1",
      },
    }
  )
})

test("origin validation refuses paths, non-HTTPS values, credentials, and loopback", () => {
  for (const value of [
    "https://vault.example.com/mcp",
    "http://vault.example.com",
    "https://user:secret@vault.example.com",
    "https://127.0.0.1:8443",
    "vault.example.com",
  ]) {
    const result = validateUserSuppliedOrigin(value)
    assert.equal(result.ok, false, value)
  }
})

const ALL_POSTURES = ["off", "my_devices_only", "public_url"] as const

test("every posture carries an explicit, non-blank privacy badge", () => {
  for (const posture of ALL_POSTURES) {
    const badge = privacyBadgeForPosture(posture)
    assert.equal(typeof badge, "string", posture)
    assert.ok(badge.trim().length > 0, `${posture} must never render blank`)
    assert.doesNotMatch(badge, /unknown/i, `${posture} must not read as unknown`)
    // Short enough to sit in a row beside the posture label.
    assert.ok(badge.length <= 80, `${posture} badge is too long for a row`)
  }
})

test("no posture claims a provider cannot read the owner's data", () => {
  // The regression that shipped: a uniformly reassuring badge. We cannot verify
  // an endpoint we do not operate, so this negative must never be asserted.
  for (const posture of ALL_POSTURES) {
    assert.doesNotMatch(
      privacyBadgeForPosture(posture),
      /cannot read your data/i,
      `${posture} must not assert an unverifiable privacy guarantee`
    )
  }
})

test("each posture reports a distinct property rather than one blanket claim", () => {
  const badges = ALL_POSTURES.map(privacyBadgeForPosture)
  assert.equal(new Set(badges).size, badges.length)
})

test("public_url says the answer depends on the owner's proxy", () => {
  const badge = privacyBadgeForPosture("public_url")
  assert.match(badge, /depends on your proxy/i)
  // The concrete risk must be visible at choice time, not buried in prose.
  assert.match(badge, /can read your data/i)
  assert.match(badge, /TLS/i)
})

test("off does not imply a provider exists", () => {
  const badge = privacyBadgeForPosture("off")
  assert.match(badge, /no provider/i)
  assert.doesNotMatch(badge, /\bproxy\b/i)
})

test("my_devices_only asserts no provider and no unverifiable privacy guarantee", () => {
  const badge = privacyBadgeForPosture("my_devices_only")
  assert.match(badge, /no provider/i)
  assert.match(badge, /local network/i)
  assert.doesNotMatch(badge, /read your data/i)
})

test("ngrok edge termination is disclosed as readable, passthrough as not", () => {
  assert.equal(
    privacyBadgeForNgrokMode("https_edge_termination"),
    "Provider can read your data"
  )
  assert.equal(
    privacyBadgeForNgrokMode("tls_passthrough"),
    "Provider cannot read your data"
  )
  assert.equal(
    privacyBadgeForNgrokMode("tcp_passthrough"),
    "Provider cannot read your data"
  )
})

test("every selectable public URL option states a badge and stays consistent", () => {
  assert.ok(publicUrlOptions.length >= 3)
  for (const option of publicUrlOptions) {
    assert.match(
      option.badge,
      /^Provider (cannot|can) read your data$|^Depends on your proxy - it can read your data unless it passes TLS through$/
    )
    assert.ok(option.label.length > 0)
    assert.ok(option.description.length > 0)
    // The row badge must agree with the mode's own privacy answer.
    if (option.ngrokMode) {
      assert.equal(option.badge, privacyBadgeForNgrokMode(option.ngrokMode))
    }
  }
})

test("both ngrok profiles are offered with opposite privacy answers", () => {
  const edge = publicUrlOptionById("ngrok_https_edge_termination")
  const passthrough = publicUrlOptionById("ngrok_tls_passthrough")
  assert.notEqual(edge, null)
  assert.notEqual(passthrough, null)
  assert.equal(edge?.badge, "Provider can read your data")
  assert.equal(passthrough?.badge, "Provider cannot read your data")
  assert.equal(edge?.requiresAuthtoken, true)
  assert.equal(passthrough?.requiresAuthtoken, true)
  assert.equal(
    publicUrlOptionById("user_supplied_origin")?.requiresAuthtoken,
    false
  )
})

test("the HTTPS edge ngrok option warns the owner about the first-visit interstitial", () => {
  // Confirmed live, 2026-09-20: ngrok's free-plan interstitial appears on a
  // remote visitor's first request from a new browser/device and is easily
  // mistaken for a broken deployment if the owner has no warning it exists.
  const edge = publicUrlOptionById("ngrok_https_edge_termination")
  assert.match(edge?.planNote ?? "", /first browser visit/i)
  assert.match(edge?.planNote ?? "", /warning page/i)
  assert.match(edge?.planNote ?? "", /not a sign anything is broken/i)
})

test("Cloudflare Tunnel is offered as a selectable public URL option with an honest badge", () => {
  const option = publicUrlOptionById("cloudflare_tunnel")
  assert.notEqual(option, null)
  assert.equal(option?.provider, "cloudflare_tunnel")
  // Never soften this: Cloudflare terminates TLS at its edge for every
  // named tunnel, no passthrough mode exists the way ngrok offers one.
  assert.equal(option?.badge, "Provider can read your data")
  assert.equal(option?.requiresAuthtoken, true)
})

test("the Cloudflare Tunnel option explains why it is not a Quick Tunnel", () => {
  // This is the durable record of the rejected alternative -- see the
  // corpus entry and report for the full reasoning (SSE unsupported, 200
  // in-flight cap, Cloudflare's own testing-only guidance).
  const option = publicUrlOptionById("cloudflare_tunnel")
  assert.match(option?.planNote ?? "", /quick tunnel/i)
  assert.match(option?.planNote ?? "", /server-sent events|sse/i)
})

test("a Cloudflare tunnel hostname is required and must be a bare hostname", () => {
  for (const invalid of ["", "   ", "https://vault.example.com", "vault.example.com:443", "vault.example.com/mcp", "vault", "-vault.example.com"]) {
    assert.equal(validateCloudflareTunnelHostname(invalid).ok, false, invalid)
  }
  assert.deepEqual(validateCloudflareTunnelHostname(" Vault.Example.COM "), {
    ok: true,
    hostname: "vault.example.com",
  })
})

test("cloudflareTunnelDurableAddressState is not_applicable for a non-cloudflare provider", () => {
  const config: RemoteAccessConfig = {
    ...offRemoteAccessConfig(),
    provider: "user_supplied_origin",
  }
  assert.deepEqual(cloudflareTunnelDurableAddressState(config), { kind: "not_applicable" })
})

test("cloudflareTunnelDurableAddressState is always available once a hostname is configured -- unlike ngrok, there is no discovery gap", () => {
  const config: RemoteAccessConfig = {
    ...offRemoteAccessConfig(),
    provider: "cloudflare_tunnel",
    cloudflare_tunnel: { hostname: "vault.example.com" },
  }
  assert.deepEqual(cloudflareTunnelDurableAddressState(config), {
    kind: "available",
    address: "vault.example.com",
  })
})

test("an ngrok domain is optional and must be a bare hostname", () => {
  assert.deepEqual(validateNgrokDomain(""), { ok: true, domain: null })
  assert.deepEqual(validateNgrokDomain("   "), { ok: true, domain: null })
  assert.deepEqual(validateNgrokDomain(" Vault.NGROK.app "), {
    ok: true,
    domain: "vault.ngrok.app",
  })
  for (const invalid of [
    "https://vault.ngrok.app",
    "vault.ngrok.app:443",
    "vault.ngrok.app/mcp",
    "vault",
    "-vault.ngrok.app",
  ]) {
    assert.equal(validateNgrokDomain(invalid).ok, false, invalid)
  }
})

test("ngrokDurableAddressState is not_applicable for a non-ngrok provider", () => {
  const config: RemoteAccessConfig = {
    ...offRemoteAccessConfig(),
    provider: "user_supplied_origin",
  }
  assert.deepEqual(ngrokDurableAddressState(config), { kind: "not_applicable" })
})

test("ngrokDurableAddressState is available when a domain is already saved -- this is the stable-hostname-across-restarts property", () => {
  // The config this function reads is exactly what a config-change restart
  // persists and reloads (`RemoteAccessConfig.ngrok.reserved_domain`), so
  // "available with this address" here is the same address every restart
  // sees -- there is nothing time-varying in this derivation.
  const config: RemoteAccessConfig = {
    ...offRemoteAccessConfig(),
    provider: "ngrok",
    ngrok: {
      endpoint_mode: "https_edge_termination",
      reserved_domain: "moderately-worthy-tetra.ngrok-free.app",
    },
  }
  assert.deepEqual(ngrokDurableAddressState(config), {
    kind: "available",
    address: "moderately-worthy-tetra.ngrok-free.app",
  })
})

test("ngrokDurableAddressState is auth_insufficient with a concrete next step when no domain is saved yet", () => {
  const config: RemoteAccessConfig = {
    ...offRemoteAccessConfig(),
    provider: "ngrok",
    ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
  }
  const state = ngrokDurableAddressState(config)
  assert.equal(state.kind, "auth_insufficient")
  if (state.kind === "auth_insufficient") {
    assert.match(state.reason, /dashboard\.ngrok\.com\/domains/)
  }
})

test("remote posture selection requires an owner password in either remote direction", () => {
  assert.equal(
    remoteAccessRequiresOwnerPassword("off", "my_devices_only"),
    true
  )
  assert.equal(remoteAccessRequiresOwnerPassword("off", "public_url"), true)
  assert.equal(remoteAccessRequiresOwnerPassword("public_url", "off"), false)
})

test("off is a loopback-only empty contract", () => {
  assert.deepEqual(offRemoteAccessConfig(), {
    posture: "off",
    provider: null,
    fields: {
      PDPP_REFERENCE_ORIGIN: null,
      PDPP_TRUSTED_HOSTS: "",
      PDPP_TRUSTED_PROXIES: "",
      PDPP_BIND_HOST: "127.0.0.1",
    },
    console_port: null,
  })
})

test("ERR_NGROK_312 names the paid-plan cause and offers the free-plan HTTPS alternative", () => {
  const guidance = describeTunnelError(
    "ngrok TLS endpoint failed: ERR_NGROK_312: TLS endpoints require a paid plan"
  )
  assert.match(guidance.message, /paid ngrok plan/)
  assert.match(guidance.message, /ERR_NGROK_312/)
  assert.equal(guidance.suggestSwitchTo, "ngrok_https_edge_termination")
})

test("matches ngrok's real free-plan rejection, which carries the code lowercase in a docs URL", () => {
  // Captured verbatim (owner identity redacted) from a live ngrok session
  // request against a free-plan account, 2026-09-19. The code never appears
  // as a standalone uppercase token in ngrok's own text -- only lowercase,
  // inside "https://ngrok.com/docs/errors/err_ngrok_312".
  const guidance = describeTunnelError(
    "ngrok TLS endpoint failed: rpc error response:\n" +
      "Failed to create a TLS endpoint for the account 'redacted@example.com'.\n" +
      "Only Pay-as-you-go plans may create TLS endpoints.\n" +
      "This account is on the 'Free' plan.\n" +
      "Upgrade to a Pay-as-you-go plan at: https://dashboard.ngrok.com/billing/choose-a-plan?plan=paygo\n\n" +
      "https://ngrok.com/docs/errors/err_ngrok_312"
  )
  assert.match(guidance.message, /paid ngrok plan/)
  assert.equal(guidance.suggestSwitchTo, "ngrok_https_edge_termination")
})

test("a tunnel failure without a known cause is shown as-is, with no invented suggestion", () => {
  const guidance = describeTunnelError("ngrok session failed: connection refused")
  assert.equal(guidance.message, "ngrok session failed: connection refused")
  assert.equal(guidance.suggestSwitchTo, null)
})

function ngrokConfig(overrides: Partial<RemoteAccessConfig>): RemoteAccessConfig {
  return {
    posture: "public_url",
    provider: "ngrok",
    fields: offRemoteAccessConfig().fields,
    ngrok: { endpoint_mode: "tls_passthrough", reserved_domain: null },
    ...overrides,
  }
}

test("a failed tunnel start renders the error, not the waiting string", () => {
  const display = remoteAccessOriginDisplay(
    ngrokConfig({ tunnel_error: "ngrok TLS endpoint failed: ERR_NGROK_312" })
  )
  assert.equal(display.kind, "error")
  if (display.kind === "error") {
    assert.match(display.guidance.message, /paid ngrok plan/)
    assert.equal(display.guidance.suggestSwitchTo, "ngrok_https_edge_termination")
  }
})

test("a successful start renders the origin", () => {
  const display = remoteAccessOriginDisplay(
    ngrokConfig({
      fields: {
        PDPP_REFERENCE_ORIGIN: "https://vault.ngrok.app",
        PDPP_TRUSTED_HOSTS: "vault.ngrok.app",
        PDPP_TRUSTED_PROXIES: "",
        PDPP_BIND_HOST: "127.0.0.1",
      },
    })
  )
  assert.deepEqual(display, { kind: "origin", origin: "https://vault.ngrok.app" })
})

test("no origin and no failure yet renders the waiting state", () => {
  const display = remoteAccessOriginDisplay(ngrokConfig({}))
  assert.deepEqual(display, { kind: "waiting" })
})

test("a tunnel_error takes priority over a stale origin left from a previous successful start", () => {
  const display = remoteAccessOriginDisplay(
    ngrokConfig({
      fields: {
        PDPP_REFERENCE_ORIGIN: "https://old.ngrok.app",
        PDPP_TRUSTED_HOSTS: "old.ngrok.app",
        PDPP_TRUSTED_PROXIES: "",
        PDPP_BIND_HOST: "127.0.0.1",
      },
      tunnel_error: "ngrok TLS endpoint failed: ERR_NGROK_312",
    })
  )
  assert.equal(display.kind, "error")
})

test("a blank pinned-port input means no pin, not an error", () => {
  assert.deepEqual(validatePinnedConsolePort(""), { ok: true, port: null })
  assert.deepEqual(validatePinnedConsolePort("   "), { ok: true, port: null })
})

test("a pinned port must be a valid TCP port number", () => {
  assert.deepEqual(validatePinnedConsolePort("4310"), {
    ok: true,
    port: 4310,
  })
  for (const invalid of ["0", "-1", "65536", "abc", "4310.5", "80px"]) {
    assert.equal(validatePinnedConsolePort(invalid).ok, false, invalid)
  }
  // Surrounding whitespace is tolerated, matching validateUserSuppliedOrigin's trim.
  assert.deepEqual(validatePinnedConsolePort(" 80 "), { ok: true, port: 80 })
})

function cloudflareConfigWith(originVerified: OriginVerification | null): RemoteAccessConfig {
  return {
    posture: "public_url",
    provider: "cloudflare_tunnel",
    fields: {
      PDPP_BIND_HOST: "127.0.0.1",
      PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
      PDPP_TRUSTED_HOSTS: "vault.example.com",
      PDPP_TRUSTED_PROXIES: "",
    },
    cloudflare_tunnel: { hostname: "vault.example.com" },
    origin_verified: originVerified,
  }
}

const OWNER_MAINTAINED = { kind: "owner_maintained", where_to_set: "the dashboard" } as const

function observation(overrides: Partial<OriginVerification> = {}): OriginVerification {
  return {
    origin: "https://vault.example.com",
    checked_at: 1_000,
    stale_after: 150,
    outcome: { kind: "reaches_this_console" },
    binding: OWNER_MAINTAINED,
    agent: "running",
    ...overrides,
  }
}

test("an origin nobody has checked is unverified, never healthy", () => {
  const display = originVerificationDisplay(cloudflareConfigWith(null), 1_000)
  assert.deepEqual(display, { reading: { kind: "unverified" }, binding: null, agentExited: false })
})

test("a fresh proof reads as reaching this console", () => {
  const display = originVerificationDisplay(cloudflareConfigWith(observation()), 1_000 + 149)
  assert.deepEqual(display.reading, { kind: "reaches_this_console", checkedAt: 1_000 })
  assert.deepEqual(display.binding, OWNER_MAINTAINED)
})

test("a reading older than its own staleness window decays to stale, keeping the binding", () => {
  const display = originVerificationDisplay(cloudflareConfigWith(observation()), 1_000 + 151)
  assert.deepEqual(display.reading, { kind: "stale", checkedAt: 1_000 })
  // Who owns the route does not decay: it is the provider's property.
  assert.deepEqual(display.binding, OWNER_MAINTAINED)
})

test("the 2026-09-22 misroute is reported, not swallowed", () => {
  const display = originVerificationDisplay(
    cloudflareConfigWith(observation({ outcome: { kind: "reaches_something_else", status: 404 } })),
    1_010
  )
  assert.deepEqual(display.reading, { kind: "reaches_something_else", checkedAt: 1_000, status: 404 })
})

test("an unreachable origin carries its reason, and an exited agent is surfaced", () => {
  const display = originVerificationDisplay(
    cloudflareConfigWith(
      observation({ outcome: { kind: "unreachable", reason: "connection refused" }, agent: "exited" })
    ),
    1_010
  )
  assert.deepEqual(display.reading, { kind: "unreachable", checkedAt: 1_000, reason: "connection refused" })
  assert.equal(display.agentExited, true)
})

test("a reading taken against another origin says nothing about this one", () => {
  const display = originVerificationDisplay(
    cloudflareConfigWith(observation({ origin: "https://old.example.com" })),
    1_010
  )
  assert.deepEqual(display, { reading: { kind: "unverified" }, binding: null, agentExited: false })
})
