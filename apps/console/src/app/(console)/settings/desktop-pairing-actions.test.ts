// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"

type Actions = typeof import("./desktop-pairing-actions.ts")

const CODE = "ABCD-EFGH-JKLM"
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const FINGERPRINT = "MMG4-2KLG-YQZW-NEIS"
const LINK = `https://x.example/settings#code=${CODE}&key=${KEY}`

let loginRedirects: string[] = []
let accessChecks: string[] = []
let requests: { url: string; init: RequestInit }[] = []
// What the faked server answers with next.
let reply: () => Response = () => new Response(null, { status: 500 })

let loaded: Promise<Actions> | null = null

// The real action and the real response parser. Only the dashboard gate, the
// owner-login redirect, the owner-session cookie and `fetch` are faked.
function loadActions(): Promise<Actions> {
  loaded ??= (async () => {
    mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
      namedExports: {
        requireDashboardAccess: async (returnTo: string) => {
          accessChecks.push(returnTo)
        },
      },
    })
    mock.module(new URL("../lib/login-redirect.ts", import.meta.url).href, {
      namedExports: {
        redirectToOwnerLogin: async (returnTo: string) => {
          loginRedirects.push(returnTo)
        },
      },
    })
    mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
      namedExports: {
        getAsInternalUrl: () => "http://as.internal",
        withOwnerSessionCookie: async (init: RequestInit = {}) => ({
          ...init,
          headers: { ...(init.headers as object), Cookie: "owner=session" },
        }),
      },
    })
    return await import("./desktop-pairing-actions.ts")
  })()
  return loaded
}

function fakeFetch() {
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ init, url })
    return reply()
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  })
}

function created(overrides: Record<string, unknown> = {}) {
  return json(201, {
    code: CODE,
    expires_at: "2026-11-17T12:10:00.000Z",
    expires_in_seconds: 600,
    link: LINK,
    object: "desktop_pairing",
    server_fingerprint: FINGERPRINT,
    server_origin: "https://x.example",
    server_public_key: KEY,
    ...overrides,
  })
}

afterEach(() => {
  mock.restoreAll()
  loginRedirects = []
  accessChecks = []
  requests = []
})

test("a 201 response becomes a pairing the console can show", async () => {
  const { createDesktopPairingAction } = await loadActions()
  fakeFetch()
  reply = () => created()
  assert.deepEqual(await createDesktopPairingAction(), {
    code: CODE,
    expiresAt: "2026-11-17T12:10:00.000Z",
    expiresInSeconds: 600,
    link: LINK,
    ok: true,
    serverFingerprint: FINGERPRINT,
    serverOrigin: "https://x.example",
    serverPublicKey: KEY,
  })
  assert.deepEqual(accessChecks, ["/settings"])
  assert.equal(requests.length, 1)
  const [request] = requests
  assert.equal(request?.url, "http://as.internal/owner/desktop-pairings")
  assert.equal(request?.init.method, "POST")
  assert.equal(request?.init.cache, "no-store")
  const headers = (request?.init.headers ?? {}) as Record<string, string>
  assert.equal(headers.Cookie, "owner=session")
})

test("a 401 sends the owner to sign in and returns here afterwards", async () => {
  const { createDesktopPairingAction } = await loadActions()
  fakeFetch()
  reply = () =>
    json(401, {
      error: { code: "owner_session_required", message: "Sign in." },
    })
  await createDesktopPairingAction()
  assert.deepEqual(loginRedirects, ["/settings"])
})

test("a malformed 201 is rejected rather than shown", async () => {
  const { createDesktopPairingAction } = await loadActions()
  fakeFetch()
  for (const response of [
    () => created({ code: "not-a-code" }),
    () => created({ link: `https://evil.example/settings#code=${CODE}&key=${KEY}` }),
    () => created({ server_public_key: undefined }),
    () => created({ server_fingerprint: "nope" }),
    () => created({ expires_in_seconds: undefined }),
    () => new Response("<html>proxy page</html>", { status: 201 }),
  ]) {
    reply = response
    const result = await createDesktopPairingAction()
    assert.equal(result.ok, false)
    assert.ok(!result.ok && !result.message.includes(CODE))
  }
})

test("a server error message is shown to the owner", async () => {
  const { createDesktopPairingAction } = await loadActions()
  fakeFetch()
  reply = () =>
    json(429, {
      error: {
        code: "rate_limited",
        message: "Too many codes. Try again in a minute.",
      },
    })
  assert.deepEqual(await createDesktopPairingAction(), {
    message: "Too many codes. Try again in a minute.",
    ok: false,
  })
})

test("a non-2xx without an error body falls back to a plain message", async () => {
  const { createDesktopPairingAction } = await loadActions()
  fakeFetch()
  reply = () => new Response("bad gateway", { status: 502 })
  assert.deepEqual(await createDesktopPairingAction(), {
    message: "Could not create a pairing code.",
    ok: false,
  })
})
