// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
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
process.env.VITE_SESSION_RELAY_URL ??= "https://session-relay.test"
process.env.VITE_GATEWAY_URL ??= "https://gateway.test"
process.env.VITE_ACCOUNT_URL ??= "https://account.test"
process.env.VITE_HYDRA_PUBLIC_URL ??= "https://oauth.test"
process.env.VITE_TUNNEL_SERVER_ADDR ??= "frpc.tunnel.test"
