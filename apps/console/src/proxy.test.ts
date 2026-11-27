// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
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

// The own-address provider proves a public origin by sending a service
// challenge to it. The public path is reverse proxy -> console -> resource
// server, and the answer binds the Host the resource server received. So the
// console must forward this one path to the resource server with the public
// Host unchanged; every other proxied path rewrites Host to the upstream.
test("the gozar service challenge reaches the resource server with the public Host", async (t) => {
  // Dynamic: this package compiles tests as CommonJS and the library uses top-level await.
  const { createServiceVerifier } = await import("@tnunamak/gozar")
  const verify = createServiceVerifier()
  const seen: { host: string | undefined }[] = []
  const resourceServer = createServer((req, res) => {
    seen.push({ host: req.headers.host })
    if (!verify(req, res)) {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => resourceServer.listen(0, "127.0.0.1", resolve))
  t.after(() => resourceServer.close())
  const rsPort = (resourceServer.address() as AddressInfo).port
  const previous = Object.getOwnPropertyDescriptor(process.env, "PDPP_RS_URL")
  process.env.PDPP_RS_URL = `http://127.0.0.1:${rsPort}`
  t.after(() => {
    if (previous) Object.defineProperty(process.env, "PDPP_RS_URL", previous)
    else Reflect.deleteProperty(process.env, "PDPP_RS_URL")
  })

  const nonce = "ab".repeat(32)
  const publicHost = "vault.example.com"
  const response = await proxy(
    new NextRequest(`http://${publicHost}/.well-known/gozar/service?nonce=${nonce}`, {
      headers: { host: publicHost },
    })
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("x-middleware-next"), null, "must not fall through to a Next page")
  const body = (await response.json()) as { authority: string; localPort: number; nonce: string; proof: string }
  assert.deepEqual(seen, [{ host: publicHost }])
  assert.equal(body.authority, publicHost)
  assert.equal(body.localPort, rsPort)
  assert.equal(body.nonce, nonce)
  assert.match(body.proof, /^[0-9a-f]{64}$/)
})

test("under a desktop supervisor the service challenge is not forwarded to the resource server", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("the desktop challenge is answered inside the console process")
  })
  const previous = Object.getOwnPropertyDescriptor(process.env, "PDPP_MANAGED_DESKTOP_HOST")
  process.env.PDPP_MANAGED_DESKTOP_HOST = "1"
  t.after(() => {
    if (previous) Object.defineProperty(process.env, "PDPP_MANAGED_DESKTOP_HOST", previous)
    else Reflect.deleteProperty(process.env, "PDPP_MANAGED_DESKTOP_HOST")
  })
  const response = await proxy(
    new NextRequest(`http://console.test/.well-known/gozar/service?nonce=${"ab".repeat(32)}`)
  )
  // Falls through to the rewrite that serves it from the console process.
  assert.equal(response.headers.get("x-middleware-next"), "1")
  assert.equal(fetchMock.mock.callCount(), 0)
})
