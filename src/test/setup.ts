// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Socket } from "node:net"

function installStoragePolyfill(target: "localStorage" | "sessionStorage") {
  const current = globalThis[target] as Storage | undefined
  if (
    current &&
    typeof current.getItem === "function" &&
    typeof current.setItem === "function" &&
    typeof current.removeItem === "function" &&
    typeof current.clear === "function"
  ) {
    return
  }

  const store = new Map<string, string>()
  const polyfill: Storage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  }

  Object.defineProperty(globalThis, target, {
    value: polyfill,
    configurable: true,
    writable: true,
  })
}

installStoragePolyfill("localStorage")
installStoragePolyfill("sessionStorage")

// Networked protocol integrations are opt-in in production. Tests that cover
// their request shape use neutral, non-routable example origins instead.
process.env.VITE_SESSION_RELAY_URL = "https://session-relay.test"
process.env.VITE_GATEWAY_URL = "https://gateway.test"
process.env.VITE_ACCOUNT_URL = "https://account.test"
process.env.VITE_HYDRA_PUBLIC_URL = "https://oauth.test"
process.env.VITE_TUNNEL_SERVER_ADDR = "frpc.tunnel.test"

const networkGuardMarker = Symbol.for("pdpp.unit-test-network-guard")

function assertLoopbackHost(protocol: string, host: string) {
  const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (["localhost", "127.0.0.1", "::1"].includes(normalizedHost)) {
    return
  }

  throw new Error(
    `Unit test network guard blocked ${protocol} to non-loopback host "${host}".`
  )
}

if (!Reflect.get(globalThis, networkGuardMarker)) {
  const originalFetch = globalThis.fetch
  // async, so a blocked call rejects like a real network failure instead of
  // throwing synchronously at the call site.
  globalThis.fetch = async (input, init) => {
    const inputUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const url = new URL(inputUrl, "http://localhost")
    assertLoopbackHost("fetch", url.hostname)
    return originalFetch.call(globalThis, input, init)
  }

  const originalConnect = Socket.prototype.connect
  Object.defineProperty(Socket.prototype, "connect", {
    configurable: true,
    writable: true,
    value: function (this: Socket, ...args: unknown[]) {
      // net.connect() and tls.connect() pass their normalized [options, cb]
      // array as the single argument.
      const address = Array.isArray(args[0]) ? args[0][0] : args[0]
      if (typeof address === "number") {
        assertLoopbackHost(
          "socket connection",
          typeof args[1] === "string" ? args[1] : "localhost"
        )
      } else if (typeof address === "object" && address !== null) {
        const options = address as {
          host?: string
          hostname?: string
          path?: string
        }
        if (!options.path) {
          assertLoopbackHost(
            "socket connection",
            options.host ?? options.hostname ?? "localhost"
          )
        }
      }

      return Reflect.apply(originalConnect, this, args) as Socket
    },
  })

  Reflect.set(globalThis, networkGuardMarker, true)
}
