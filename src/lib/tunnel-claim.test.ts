// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />

import { describe, expect, it } from "vitest"
import { recoverMessageAddress } from "viem"

/**
 * Verify that the FRP tunnel auth_sig can be used to recover the server wallet.
 *
 * The FRP server performs the same recovery: given the base64url claim string
 * and the EIP-191 signature, it calls ecrecover to obtain the signer address,
 * then checks whether that address is a registered server in the Gateway.
 *
 * This test uses real fixture data captured from frpc.toml to confirm the
 * signing/recovery round-trip works end-to-end.
 */

// Fixture from ~/data-connect/personal-server/tunnel/frpc.toml
const FIXTURE = {
  authClaim:
    "eyJhdWQiOiJodHRwczovL3R1bm5lbC52YW5hLm9yZyIsImlhdCI6MTc3MTg2MzgxMCwiZXhwIjoxNzcxODY0MTEwLCJvd25lciI6IjB4MzA0MjUzREE0NjQzNDBENDRCOEVlRTRlOTA2NTRERDA3QmU4YjQyNyIsIndhbGxldCI6IjB4MDdEMTcyNjM1NkZBRTRmMUNkRmU4YkQ3YjgzODM5OGM0RjlmMzliZCIsInN1YmRvbWFpbiI6IjB4MDdkMTcyNjM1NmZhZTRmMWNkZmU4YmQ3YjgzODM5OGM0ZjlmMzliZCIsInJ1bklkIjoiNTMzOWM4MmItNzU2NC00NzcyLTllZGQtYTgxN2MzMDE3Y2M4In0",
  authSig:
    "0x0e773410bf580738c88d39b00abb9efa3ad502829f7ab110aa0a5f3c9d1a897e0624d44b8e34655e84496c6e202725ca551cf7a0348776a098971400c3a847941b" as `0x${string}`,
  expectedWallet: "0x07D1726356FAE4f1CdFe8bD7b838398c4F9f39bd",
  expectedOwner: "0x304253DA464340D44B8EeE4e90654DD07Be8b427",
}

function base64urlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padLength = (4 - (base64.length % 4)) % 4
  base64 += "=".repeat(padLength)
  return Buffer.from(base64, "base64").toString("utf-8")
}

interface TunnelClaimPayload {
  aud: string
  iat: number
  exp: number
  owner: string
  wallet: string
  subdomain: string
  runId: string
}

function parseTunnelClaim(claimBase64: string, signature: string) {
  if (!claimBase64 || !signature) {
    throw new Error("Missing claim or signature")
  }
  if (!signature.startsWith("0x")) {
    throw new Error("Invalid signature format")
  }

  const decoded = base64urlDecode(claimBase64)
  const payload = JSON.parse(decoded) as TunnelClaimPayload

  const requiredFields: (keyof TunnelClaimPayload)[] = [
    "aud",
    "iat",
    "exp",
    "owner",
    "wallet",
    "subdomain",
    "runId",
  ]
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`Missing required field: ${field}`)
    }
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("iat and exp must be numbers")
  }

  return {
    payloadBase64: claimBase64,
    payload,
    signature: signature as `0x${string}`,
  }
}

async function verifyTunnelClaim(params: {
  claimBase64: string
  signature: `0x${string}`
  clockSkewSeconds?: number
  now?: number
}) {
  const { payloadBase64, payload, signature } = parseTunnelClaim(
    params.claimBase64,
    params.signature
  )

  // Recover signer from EIP-191 signature over the base64url payload string
  const signer = await recoverMessageAddress({
    message: payloadBase64,
    signature,
  })

  // Time checks
  const now = params.now ?? Math.floor(Date.now() / 1000)
  const clockSkew = params.clockSkewSeconds ?? 60

  if (payload.exp < now - clockSkew) {
    throw new Error("Token expired")
  }
  if (payload.iat > now + clockSkew) {
    throw new Error("Token issued in the future")
  }

  return { signer, payload }
}

describe("tunnel claim verification", () => {
  it("recovers server wallet from auth_sig (EIP-191)", async () => {
    const { signer, payload } = await verifyTunnelClaim({
      claimBase64: FIXTURE.authClaim,
      signature: FIXTURE.authSig,
      // Pin `now` to the claim's iat so time checks pass
      now: 1771863810,
    })

    // The recovered signer should be the server wallet (case-insensitive)
    expect(signer.toLowerCase()).toBe(
      FIXTURE.expectedWallet.toLowerCase()
    )

    // Payload should contain the expected owner
    expect(payload.owner).toBe(FIXTURE.expectedOwner)
    expect(payload.wallet).toBe(FIXTURE.expectedWallet)
    expect(payload.aud).toBe("https://tunnel.vana.org")
    expect(payload.subdomain).toBe(
      FIXTURE.expectedWallet.toLowerCase()
    )
  })

  it("parseTunnelClaim decodes all required fields", () => {
    const { payload } = parseTunnelClaim(FIXTURE.authClaim, FIXTURE.authSig)

    expect(payload.aud).toBe("https://tunnel.vana.org")
    expect(payload.iat).toBe(1771863810)
    expect(payload.exp).toBe(1771864110)
    expect(payload.owner).toBe(FIXTURE.expectedOwner)
    expect(payload.wallet).toBe(FIXTURE.expectedWallet)
    expect(payload.subdomain).toBe("0x07d1726356fae4f1cdfe8bd7b838398c4f9f39bd")
    expect(payload.runId).toBe("5339c82b-7564-4772-9edd-a817c3017cc8")
  })

  it("rejects expired claims", async () => {
    await expect(
      verifyTunnelClaim({
        claimBase64: FIXTURE.authClaim,
        signature: FIXTURE.authSig,
        // Set now far in the future so the claim is expired
        now: 1771864110 + 3600,
      })
    ).rejects.toThrow("Token expired")
  })

  it("rejects missing claim", () => {
    expect(() => parseTunnelClaim("", FIXTURE.authSig)).toThrow(
      "Missing claim or signature"
    )
  })

  it("rejects missing signature", () => {
    expect(() => parseTunnelClaim(FIXTURE.authClaim, "")).toThrow(
      "Missing claim or signature"
    )
  })

  it("rejects invalid signature format", () => {
    expect(() =>
      parseTunnelClaim(FIXTURE.authClaim, "not-hex")
    ).toThrow("Invalid signature format")
  })
})
