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

  it("still allows data: URLs, which never leave the process", async () => {
    await expect((await fetch("data:text/plain,ok")).text()).resolves.toBe("ok")
  })

  it("pins the protocol endpoints to neutral test origins", () => {
    expect({
      VITE_SESSION_RELAY_URL: process.env.VITE_SESSION_RELAY_URL,
      VITE_GATEWAY_URL: process.env.VITE_GATEWAY_URL,
      VITE_ACCOUNT_URL: process.env.VITE_ACCOUNT_URL,
      VITE_HYDRA_PUBLIC_URL: process.env.VITE_HYDRA_PUBLIC_URL,
      VITE_TUNNEL_SERVER_ADDR: process.env.VITE_TUNNEL_SERVER_ADDR,
    }).toEqual({
      VITE_SESSION_RELAY_URL: "https://session-relay.test",
      VITE_GATEWAY_URL: "https://gateway.test",
      VITE_ACCOUNT_URL: "https://account.test",
      VITE_HYDRA_PUBLIC_URL: "https://oauth.test",
      VITE_TUNNEL_SERVER_ADDR: "frpc.tunnel.test",
    })
  })
})
