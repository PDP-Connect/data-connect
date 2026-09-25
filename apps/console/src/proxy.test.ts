// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import { OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session-constants"
import proxy, { isAllowedConsoleHostFor, shouldRedirectOwnerToLogin } from "./proxy.ts"

test("loopback bind host allows any request Host (regression guard: today's default posture)", () => {
  assert.equal(isAllowedConsoleHostFor("127.0.0.1:3001", "", []), true)
  assert.equal(isAllowedConsoleHostFor("127.0.0.1:3001", "127.0.0.1", []), true)
  assert.equal(isAllowedConsoleHostFor("attacker.example:3001", "127.0.0.1", []), true)
  assert.equal(isAllowedConsoleHostFor("attacker.example:3001", "localhost", []), true)
})

test("LAN bind host allows a request naming the bind address itself", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.42:3001", "192.168.1.42", ["192.168.1.42"]),
    true
  )
})

test("LAN bind host allows a request naming a trusted host", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.42:3001", "192.168.1.42", ["192.168.1.42", "vault.local"]),
    true
  )
})

test("LAN bind host rejects an attacker-controlled Host (DNS-rebinding shape)", () => {
  assert.equal(
    isAllowedConsoleHostFor("attacker.example:3001", "192.168.1.42", ["192.168.1.42"]),
    false
  )
})

test("LAN bind host rejects a request naming a different LAN address than the one bound", () => {
  assert.equal(
    isAllowedConsoleHostFor("192.168.1.99:3001", "192.168.1.42", ["192.168.1.42"]),
    false
  )
})

test("Host comparison ignores the port and is case-insensitive", () => {
  assert.equal(isAllowedConsoleHostFor("VAULT.LOCAL:8443", "192.168.1.42", ["vault.local"]), true)
})

test("hosted owner auth redirects without requiring the password in the console process", () => {
  assert.equal(
    shouldRedirectOwnerToLogin(false, { NODE_ENV: "production" }),
    true
  )
})

test("open local development stays open without an owner password", () => {
  assert.equal(
    shouldRedirectOwnerToLogin(false, { NODE_ENV: "development" }),
    false
  )
})

test("local owner auth still redirects when explicitly configured", () => {
  assert.equal(
    shouldRedirectOwnerToLogin(false, { NODE_ENV: "development", PDPP_OWNER_PASSWORD: "set" }),
    true
  )
  assert.equal(
    shouldRedirectOwnerToLogin(true, { NODE_ENV: "production" }),
    false
  )
})

function routeRequest(pathname: string, host: string, cookie?: string): Parameters<typeof proxy>[0] {
  const headers = new Headers({ host })
  if (cookie) {
    headers.set("cookie", `${OWNER_AUTH_COOKIE_NAME}=${cookie}`)
  }

  const url = new URL(`http://${host}${pathname}`)
  return {
    headers,
    nextUrl: url,
    cookies: {
      get(name: string) {
        const value = headers
          .get("cookie")
          ?.split(";")
          .map(part => part.trim())
          .find(part => part.startsWith(`${name}=`))
          ?.slice(name.length + 1)
        return value ? { name, value } : undefined
      },
    },
  } as Parameters<typeof proxy>[0]
}

test("settings redirects signed-out owners and lets signed-in owners through", async () => {
  const previousNodeEnv = Object.getOwnPropertyDescriptor(process.env, "NODE_ENV")
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value: "production",
    writable: true,
  })
  try {
    const signedOut = await proxy(routeRequest("/settings", "console.test"))
    assert.equal(signedOut.status, 307)
    assert.equal(new URL(signedOut.headers.get("location") ?? "").pathname, "/owner/login")

    const signedIn = await proxy(routeRequest("/settings", "console.test", "session"))
    assert.equal(signedIn.status, 200)
    assert.equal(signedIn.headers.get("location"), null)
  } finally {
    if (previousNodeEnv) {
      Object.defineProperty(process.env, "NODE_ENV", previousNodeEnv)
    } else {
      Reflect.deleteProperty(process.env, "NODE_ENV")
    }
  }
})

test("public /setup route is matched by the console Host allowlist", async () => {
  const previousHostname = Object.getOwnPropertyDescriptor(process.env, "HOSTNAME")
  const previousTrustedHosts = Object.getOwnPropertyDescriptor(process.env, "PDPP_TRUSTED_HOSTS")
  Object.defineProperty(process.env, "HOSTNAME", {
    configurable: true,
    enumerable: true,
    value: "192.168.1.42",
    writable: true,
  })
  Reflect.deleteProperty(process.env, "PDPP_TRUSTED_HOSTS")
  try {
    const loadModule = new Function("specifier", "return import(specifier)") as (
      specifier: string
    ) => Promise<{
      default: { default: (request: Parameters<typeof proxy>[0]) => { status: number } }
      config: { matcher: readonly string[] }
    }>
    const publicProxy = await loadModule(new URL("./proxy.ts?setup-host-policy-test", import.meta.url).href)
    assert.ok(publicProxy.config.matcher.includes("/setup"), "Next must run middleware for public setup requests")
    const denied = publicProxy.default.default(routeRequest("/setup", "attacker.example"))
    assert.equal(denied.status, 403, "the public setup route rejects an untrusted Host")
  } finally {
    if (previousHostname) Object.defineProperty(process.env, "HOSTNAME", previousHostname)
    else Reflect.deleteProperty(process.env, "HOSTNAME")
    if (previousTrustedHosts) Object.defineProperty(process.env, "PDPP_TRUSTED_HOSTS", previousTrustedHosts)
    else Reflect.deleteProperty(process.env, "PDPP_TRUSTED_HOSTS")
  }
})

test("PAR and pending approval consent preserve the AS response and owner session", async (t) => {
  const requests: Request[] = []
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    requests.push(new Request(url, init))
    return new Response("owner login", {
      status: 302,
      headers: { location: "/owner/login?return_to=%2Fconsent", "set-cookie": "csrf=test; HttpOnly" },
    })
  })

  for (const query of ["request_uri=urn%3Apdpp%3Arequest%3Atest", "approval_id=approval-test"]) {
    const response = await proxy(
      new NextRequest(`http://console.test/consent?${query}`, {
        headers: { cookie: "pdpp_owner_session=test", accept: "text/html" },
      })
    )
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "/owner/login?return_to=%2Fconsent")
    assert.equal(response.headers.get("set-cookie"), "csrf=test; HttpOnly")
    assert.equal(response.headers.get("x-middleware-rewrite"), null)
    const upstream = requests.at(-1)
    assert.ok(upstream)
    assert.equal(new URL(upstream.url).pathname, "/consent")
    assert.equal(new URL(upstream.url).search, `?${query}`)
    assert.equal(upstream.headers.get("cookie"), "pdpp_owner_session=test")
    assert.equal(upstream.headers.get("x-forwarded-host"), "console.test")
    assert.equal(upstream.headers.get("x-forwarded-proto"), "http")
  }
  assert.equal(requests.length, 2)
})

test("challenge consent and incomplete requests stay with the console page", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("challenge requests must not use the PAR proxy")
  })
  for (const query of ["", "?challenge=test", "?challenge=test&request_uri=old", "?challenge=&approval_id=old"]) {
    const response = await proxy(new NextRequest(`http://console.test/consent${query}`))
    assert.equal(response.headers.get("x-middleware-next"), "1")
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})
