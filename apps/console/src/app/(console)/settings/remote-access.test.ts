// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import {
  describeTunnelError,
  offRemoteAccessConfig,
  privacyBadgeForNgrokMode,
  privacyBadgeForPosture,
  publicUrlOptionById,
  publicUrlOptions,
  remoteAccessOriginDisplay,
  remoteAccessRequiresOwnerPassword,
  validateReservedDomain,
  validateUserSuppliedOrigin,
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

test("my_devices_only asserts no privacy property while it cannot be selected", () => {
  const badge = privacyBadgeForPosture("my_devices_only")
  assert.match(badge, /unavailable/i)
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

test("a reserved domain is optional and must be a bare hostname", () => {
  assert.deepEqual(validateReservedDomain(""), { ok: true, domain: null })
  assert.deepEqual(validateReservedDomain("   "), { ok: true, domain: null })
  assert.deepEqual(validateReservedDomain(" Vault.NGROK.app "), {
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
    assert.equal(validateReservedDomain(invalid).ok, false, invalid)
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
