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
