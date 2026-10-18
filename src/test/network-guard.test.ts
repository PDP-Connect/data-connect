// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { connect } from "node:net"
import { connect as tlsConnect } from "node:tls"
import { describe, expect, it } from "vitest"

// setup.ts blocks non-loopback network access for the whole unit tier, so a
// test that forgets a mock fails here instead of reaching a real endpoint.
describe("unit test network guard", () => {
  it("rejects fetch to a non-loopback host", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(
      /network guard blocked fetch to non-loopback host "example.com"/
    )
  })

  it("rejects a raw socket to a non-loopback host", () => {
    expect(() => connect({ host: "example.com", port: 443 })).toThrow(
      /network guard blocked socket connection/
    )
  })

  it("rejects a TLS connection to a non-loopback host", () => {
    expect(() => tlsConnect({ host: "example.com", port: 443 })).toThrow(
      /network guard blocked socket connection/
    )
  })

  it("pins the protocol endpoints to neutral test origins", () => {
    expect(process.env.VITE_GATEWAY_URL).toBe("https://gateway.test")
  })
})
