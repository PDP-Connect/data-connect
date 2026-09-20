// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"

import { resolvePublicUrl } from "../server/metadata.ts"
import {
  ReachabilityContractError,
  evaluateReachabilityRequest,
  parseReachabilityContract,
  validateReachabilityContract,
  type ReachabilityContract,
} from "../server/reachability-contract.ts"

function request(
  headers: Record<string, string>,
  remoteAddress?: string
): {
  headers: Record<string, string>
  get: (name: string) => string | undefined
  path: string
  protocol: string
  socket?: { remoteAddress?: string }
} {
  return {
    headers,
    get: name => headers[name.toLowerCase()],
    path: "/mcp",
    protocol: "http",
    ...(remoteAddress === undefined ? {} : { socket: { remoteAddress } }),
  }
}

function hostedContract(
  overrides: Record<string, string> = {}
): ReachabilityContract {
  return parseReachabilityContract({
    env: {
      PDPP_BIND_HOST: "127.0.0.1",
      PDPP_REFERENCE_ORIGIN: "https://vault.example",
      ...overrides,
    },
  })
}

test("R1 refuses hosted posture without a declared origin", () => {
  const contract = parseReachabilityContract({
    env: { PDPP_BIND_HOST: "0.0.0.0" },
  })
  assert.throws(
    () => validateReachabilityContract(contract, true),
    (error: unknown) => {
      assert(error instanceof ReachabilityContractError)
      assert.equal(error.field, "PDPP_REFERENCE_ORIGIN")
      assert.match(error.message, /PDPP_REFERENCE_ORIGIN/)
      return true
    }
  )
})

test("R2 refuses a path, non-absolute origin, or hosted loopback origin", () => {
  for (const origin of [
    "/vault",
    "vault.example",
    "https://vault.example/path",
    "http://localhost:3000",
  ]) {
    assert.throws(() => {
      const contract = parseReachabilityContract({
        env: { PDPP_REFERENCE_ORIGIN: origin },
      })
      validateReachabilityContract(contract, true)
    }, /PDPP_REFERENCE_ORIGIN/)
  }
})

test("R3 refuses a hosted request whose effective host is not allowlisted", () => {
  const contract = hostedContract()
  const req = request({
    host: "attacker.example",
    origin: "https://vault.example",
  })
  const decision = evaluateReachabilityRequest(req, contract, { hosted: true })
  assert.equal(decision?.status, 400)
  assert.equal(decision?.code, "invalid_host")
  assert.doesNotMatch(decision?.message ?? "", /attacker\.example/)
  assert.match(decision?.message ?? "", /PDPP_REFERENCE_ORIGIN/)
})

test("R3b a loopback-originated request presenting the trusted Host is allowed, and a bare loopback Host matching bindHost is also allowed", () => {
  // This is the exact shape of the RI's own internal readiness self-probe
  // (src-tauri/src/commands/process_supervisor.rs's HttpGet readiness check,
  // always dialed over 127.0.0.1) once a public origin like an ngrok tunnel
  // is configured. Presenting vault.example -- the reachability contract's
  // own trusted host -- must pass even though the TCP connection itself is
  // loopback.
  //
  // The bare 127.0.0.1 authority Rust's HTTP client (and, critically, every
  // caller that cannot override its own Host header -- Node's built-in
  // fetch silently ignores an explicit Host override) sends with no
  // override must ALSO pass now: isAllowedRequestHost accepts a
  // non-proxied request whose Host exactly matches contract.bindHost when
  // that bindHost is itself loopback-only (127.0.0.1/::1/localhost, NOT
  // 0.0.0.0 -- see the bind-all case in R3c below). This is not a loopback
  // exemption independent of the server's own bind posture: a listener
  // bound to 127.0.0.1 can only ever receive this request if it already
  // arrived over loopback, so nothing external can forge it. Without this,
  // the RI's own internal callers (the readiness probe, the Tauri owner-
  // login bootstrap, and the console's own server-side token-minting calls,
  // none of which can present a Host other than their own loopback
  // authority) are indistinguishable from a DNS-rebinding attacker and are
  // rejected identically, which made the whole managed stack unable to
  // finish booting once ngrok assigned a public origin.
  const contract = hostedContract({ PDPP_TRUSTED_HOSTS: "vault.example" })
  const trusted = request({ host: "vault.example", origin: "https://vault.example" })
  assert.equal(evaluateReachabilityRequest(trusted, contract, { hosted: true }), null)

  const bareLoopback = request({ host: "127.0.0.1:38365", origin: "https://vault.example" })
  assert.equal(evaluateReachabilityRequest(bareLoopback, contract, { hosted: true }), null)
})

test("R3c an external request is still refused even when it claims a loopback Host", () => {
  // Pins the actual boundary the R3b exemption relies on: a Host claiming
  // to be loopback is only trusted because a loopback-bound listener could
  // not have received the connection otherwise. An UNTRUSTED host that is
  // simply not loopback and not in the allowlist must still be refused --
  // the exemption is specific to loopback claims, not a general relaxation.
  const contract = hostedContract({ PDPP_TRUSTED_HOSTS: "vault.example" })
  const external = request({
    host: "attacker.example",
    origin: "https://vault.example",
  })
  const decision = evaluateReachabilityRequest(external, contract, {
    hosted: true,
  })
  assert.equal(decision?.status, 400)
  assert.equal(decision?.code, "invalid_host")
})

test("R3d a bind-all posture (0.0.0.0) does not get the loopback Host exemption", () => {
  // isLoopbackOriginHost("0.0.0.0") is true (it appears in that helper's
  // own allowlist for other purposes), but isLoopbackBindHost("0.0.0.0") is
  // deliberately false -- 0.0.0.0 means the listener accepts connections
  // from ANY interface, so "the connection could only have come from
  // loopback" does not hold and a remote attacker really could reach this
  // listener while claiming Host: 127.0.0.1. This proves isAllowedRequestHost
  // uses isLoopbackBindHost (bind-safety), not isLoopbackOriginHost
  // (loopback-shaped-string), to decide whether the exemption applies.
  const contract = hostedContract({
    PDPP_BIND_HOST: "0.0.0.0",
    PDPP_TRUSTED_HOSTS: "vault.example",
  })
  const claimedLoopback = request({
    host: "127.0.0.1:38365",
    origin: "https://vault.example",
  })
  const decision = evaluateReachabilityRequest(claimedLoopback, contract, {
    hosted: true,
  })
  assert.equal(decision?.status, 400)
  assert.equal(decision?.code, "invalid_host")
})

test("R3e an x-forwarded-host claiming loopback from an untrusted peer is still refused", () => {
  // The loopback exemption only applies to the request's OWN Host header,
  // never to x-forwarded-host, and only when the peer is a trusted proxy in
  // the first place (isAllowedRequestHost already gates x-forwarded-host
  // behind isTrustedProxyPeer). A non-trusted-proxy remote peer forging
  // x-forwarded-host: 127.0.0.1 must not pass -- it never holds a genuine
  // loopback connection, and PDPP_TRUSTED_PROXIES is empty here, so this
  // header is not even consulted; the request falls back to its own Host,
  // which is the non-loopback attacker-controlled value.
  const contract = hostedContract({ PDPP_TRUSTED_HOSTS: "vault.example" })
  const spoofed = request(
    {
      host: "attacker.example",
      "x-forwarded-host": "127.0.0.1",
      origin: "https://vault.example",
    },
    "203.0.113.9"
  )
  const decision = evaluateReachabilityRequest(spoofed, contract, {
    hosted: true,
  })
  assert.equal(decision?.status, 400)
  assert.equal(decision?.code, "invalid_host")
})

test("R4 refuses a bad Origin on MCP with HTTP 403", () => {
  const contract = hostedContract()
  const decision = evaluateReachabilityRequest(
    request({ host: "vault.example", origin: "https://attacker.example" }),
    contract,
    { hosted: true, mcpSurface: true }
  )
  assert.equal(decision?.status, 403)
  assert.equal(decision?.code, "invalid_origin")
  assert.match(decision?.message ?? "", /PDPP_REFERENCE_ORIGIN/)
})

test("R5 discards forwarded headers from a peer outside PDPP_TRUSTED_PROXIES", () => {
  const contract = hostedContract({ PDPP_TRUSTED_PROXIES: "10.0.0.0/8" })
  const req = request(
    {
      host: "vault.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
    "192.0.2.20"
  )
  assert.equal(
    evaluateReachabilityRequest(req, contract, { hosted: true }),
    null
  )
  assert.equal(req.headers["x-forwarded-host"], undefined)
  assert.equal(resolvePublicUrl(req, null), "https://vault.example")
})

test("R5 reads the effective forwarded host only from a trusted proxy peer", () => {
  const contract = hostedContract({ PDPP_TRUSTED_PROXIES: "10.0.0.0/8" })
  const req = request(
    {
      host: "127.0.0.1",
      "x-forwarded-host": "vault.example",
      "x-forwarded-proto": "https",
    },
    "10.0.0.1"
  )
  assert.equal(evaluateReachabilityRequest(req, contract, { hosted: true }), null)
})

test("R5 fails closed when the proxy peer is absent or the host is ambiguous", () => {
  const contract = hostedContract({ PDPP_TRUSTED_PROXIES: "10.0.0.0/8" })
  const noPeer = request({ "x-forwarded-host": "vault.example" })
  assert.equal(
    evaluateReachabilityRequest(noPeer, contract, { hosted: true })?.status,
    400
  )

  const ambiguousHost = request(
    { host: "vault.example, attacker.example" },
    "10.0.0.1"
  )
  assert.equal(
    evaluateReachabilityRequest(ambiguousHost, contract, { hosted: true })
      ?.status,
    400
  )
})

test("R6 keeps a declared origin authoritative over trusted forwarded headers", () => {
  const contract = hostedContract({ PDPP_TRUSTED_PROXIES: "10.0.0.0/8" })
  const req = request(
    {
      host: "vault.example",
      "x-forwarded-proto": "http",
    },
    "10.0.0.1"
  )
  assert.equal(
    evaluateReachabilityRequest(req, contract, { hosted: true }),
    null
  )
  assert.equal(
    resolvePublicUrl(req, "http://localhost:7662"),
    "https://vault.example"
  )
})

test("the four fields reject malformed proxy and bind declarations", () => {
  assert.throws(
    () =>
      parseReachabilityContract({
        env: { PDPP_TRUSTED_PROXIES: "10.0.0.0/8,not-an-ip" },
      }),
    /PDPP_TRUSTED_PROXIES/
  )
  assert.throws(
    () =>
      parseReachabilityContract({
        env: { PDPP_TRUSTED_PROXIES: "10.0.0.0/8/9" },
      }),
    /PDPP_TRUSTED_PROXIES/
  )
  assert.throws(
    () => parseReachabilityContract({ env: { PDPP_BIND_HOST: "not-an-ip" } }),
    /PDPP_BIND_HOST/
  )
})
