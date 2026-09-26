// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner live-invalidation channel (server/live-revisions.ts,
 * server/routes/owner-live.ts): the revision registry, the owner gate on the
 * `/_ref/owner-live` routes, and the end-to-end path from a file write by
 * another process to an `invalidate` event on an attached stream.
 */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { startServer } from "../server/index.ts"
import { createLiveRevisions, fileRevision, registerDefaultLiveTopics } from "../server/live-revisions.ts"
import { LIVE_TOPICS } from "../server/live-topics.ts"
import { createOwnerSessionController } from "../server/owner-session.ts"
import { mountOwnerLiveAs } from "../server/routes/owner-live.ts"
import { getOwnerSessionStore } from "../server/stores/owner-session-store.ts"

const OWNER_PASSWORD = "live-channel-test-password"

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "owner-live-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test("fileRevision follows content, not rewrites of the same content", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "autostart.json")
    assert.equal(await fileRevision(path), "absent")
    await writeFile(path, '{"enabled":false}\n')
    const first = await fileRevision(path)
    await sleep(15)
    await writeFile(path, '{"enabled":false}\n')
    assert.equal(await fileRevision(path), first, "the 3 s watcher rewrite must not look like a change")
    await writeFile(path, '{"enabled":true}\n')
    assert.notEqual(await fileRevision(path), first)
  })
})

test("the tick reports external writes only while someone is subscribed", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "remote-access.json")
    await writeFile(path, "{}")
    const live = createLiveRevisions({ tickMs: 20 })
    live.register("remote-access", () => fileRevision(path))
    await live.snapshot()

    const seen: string[] = []
    const unsubscribe = live.subscribe(topic => seen.push(topic))
    await writeFile(path, '{"posture":"public_url"}')
    await sleep(120)
    assert.deepEqual(seen, ["remote-access"])

    unsubscribe()
    await writeFile(path, '{"posture":"off"}')
    await sleep(120)
    assert.deepEqual(seen, ["remote-access"], "no subscriber, so no tick and no event")
  })
})

test("a tab connecting late does not hide a pending change from tabs already attached", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "autostart.json")
    await writeFile(path, "{}")
    const live = createLiveRevisions({ tickMs: 50 })
    live.register("desktop.autostart", () => fileRevision(path))
    const first: string[] = []
    live.subscribe(topic => first.push(topic))
    await live.snapshot()
    await writeFile(path, '{"enabled":true}')
    // The second tab's hello snapshot lands before the tick sees the write.
    live.subscribe(() => undefined)
    await live.snapshot()
    await sleep(150)
    assert.deepEqual(first, ["desktop.autostart"])
  })
})

test("bump emits at once, even when the content hash did not change", async () => {
  const live = createLiveRevisions({ tickMs: 60_000 })
  live.register("desktop.autostart", async () => "same")
  const seen: Array<[string, string]> = []
  live.subscribe((topic, revision) => seen.push([topic, revision]))
  await live.snapshot()
  live.bump("desktop.autostart")
  await sleep(10)
  assert.deepEqual(seen, [["desktop.autostart", "same"]])
})

test("registerDefaultLiveTopics gives every shared topic a revision", async () => {
  await withTempDir(async dir => {
    const live = createLiveRevisions()
    registerDefaultLiveTopics(live, {
      appConfigPath: join(dir, "config.json"),
      autostartPath: join(dir, "autostart.json"),
      remoteAccessPath: join(dir, "remote-access.json"),
    })
    assert.deepEqual(Object.keys(await live.snapshot()).sort(), [...LIVE_TOPICS].sort())
  })
})

test("pings are real events on the configured interval", async () => {
  type Handler = (req: unknown, res: unknown) => unknown
  const routes = new Map<string, Handler>()
  const app = {
    get: (path: string, ...args: unknown[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: unknown[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  }
  mountOwnerLiveAs(app, {
    isOwnerSessionActive: async () => true,
    live: createLiveRevisions(),
    onSessionLogout: () => () => undefined,
    pdppError: () => undefined,
    pingIntervalMs: 20,
    requireOwnerSession: () => undefined,
  })
  let minted = { events_path: "" }
  const jsonRes = { json: (body: { events_path: string }) => (minted = body), status: () => jsonRes }
  await routes.get("POST /_ref/owner-live/sessions")?.({}, jsonRes)
  const token = minted.events_path.split("/")[3] ?? ""

  const chunks: string[] = []
  let onClose = () => undefined as void
  await routes.get("GET /_ref/owner-live/:token/events")?.(
    { headers: {}, params: { token }, raw: { on: (_event: string, listener: () => void) => (onClose = listener) } },
    {
      hijack: () => undefined,
      json: () => undefined,
      raw: { end: () => undefined, setHeader: () => undefined, statusCode: 0, write: (chunk: string) => chunks.push(chunk) },
      status: () => undefined,
    }
  )
  await sleep(70)
  onClose()
  assert.ok(chunks[0]?.startsWith("event: hello\n"), "hello is the first event")
  assert.ok(chunks.filter(chunk => chunk === "event: ping\ndata: {}\n\n").length >= 2)
  assert.ok(!chunks.some(chunk => chunk.startsWith(":")), "no comment-only keepalives")
})

interface StartedServer {
  asPort: number
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void }
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void }
}

for (const outcome of ["revoked", "store-error", "logout-during-read"] as const) {
  test(`idle owner stream ${outcome}: ping revalidates and closes exactly once`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    type Handler = (req: unknown, res: unknown) => unknown
    const routes = new Map<string, Handler>()
    const app = {
      get: (path: string, ...args: unknown[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
      post: (path: string, ...args: unknown[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
    }
    let readCount = 0
    let expired = false
    let resolveRead: (active: boolean) => void = () => undefined
    let logout: () => void = () => undefined
    let onClose: () => void = () => undefined
    let invalidate: (topic: "desktop.autostart", revision: string) => void = () => undefined
    let unsubscribed = 0
    let stoppedWatchingLogout = 0
    let ended = 0
    const chunks: string[] = []
    mountOwnerLiveAs(app, {
      isOwnerSessionActive: async () => {
        readCount += 1
        if (!expired) return true
        if (outcome === "store-error") throw new Error("session store unavailable")
        if (outcome === "logout-during-read") return await new Promise<boolean>(resolve => { resolveRead = resolve })
        return false
      },
      live: {
        bump: () => undefined,
        register: () => undefined,
        snapshot: async () => ({}),
        subscribe: listener => {
          invalidate = listener
          return () => { unsubscribed += 1 }
        },
      },
      onSessionLogout: (_req, listener) => {
        logout = listener
        return () => { stoppedWatchingLogout += 1 }
      },
      pdppError: () => undefined,
      pingIntervalMs: 10,
      requireOwnerSession: () => undefined,
    })
    let minted = { events_path: "" }
    const jsonRes = { json: (body: { events_path: string }) => (minted = body), status: () => jsonRes }
    await routes.get("POST /_ref/owner-live/sessions")?.({}, jsonRes)
    const token = minted.events_path.split("/")[3] ?? ""
    await routes.get("GET /_ref/owner-live/:token/events")?.(
      { headers: {}, params: { token }, raw: { on: (_event: string, listener: () => void) => { onClose = listener } } },
      {
        hijack: () => undefined,
        json: () => undefined,
        raw: {
          end: () => { ended += 1 },
          setHeader: () => undefined,
          statusCode: 0,
          write: (chunk: string) => { chunks.push(chunk); return true },
        },
        status: () => undefined,
      }
    )
    assert.equal(readCount, 1, "hello checks the session too")
    expired = true
    t.mock.timers.tick(10)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(readCount, 2, "an idle stream checks on the ping interval")
    if (outcome === "logout-during-read") {
      logout()
      resolveRead(true)
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(ended, 1)
    assert.equal(unsubscribed, 1)
    assert.equal(stoppedWatchingLogout, 1)
    assert.equal(chunks.length, 1, "no ping or invalidation is sent after session loss")
    assert.match(chunks[0] ?? "", /^event: hello/)
    logout()
    onClose()
    invalidate("desktop.autostart", "late")
    t.mock.timers.tick(100)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ended, 1, "logout and socket close cannot end twice")
    assert.equal(unsubscribed, 1)
    assert.equal(stoppedWatchingLogout, 1)
    assert.equal(readCount, 2, "closed streams stop timers and queued validation")
    assert.equal(chunks.length, 1)
  })
}

async function readEvents(
  response: Response,
  until: (events: Array<{ event: string; data: unknown }>) => boolean,
  timeoutMs: number
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const events: Array<{ event: string; data: unknown }> = []
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  while (!until(events) && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)])
    if (!next || next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    let end = buffer.indexOf("\n\n")
    while (end >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message"
      events.push({ data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null"), event })
      end = buffer.indexOf("\n\n")
    }
  }
  await reader.cancel()
  return events
}

test("owner-live routes: owner session required; an external write reaches the stream within 1.5 s", async () => {
  await withTempDir(async dir => {
    const autostartPath = join(dir, "autostart.json")
    await writeFile(autostartPath, '{"enabled":false}\n')
    const live = createLiveRevisions()
    registerDefaultLiveTopics(live, {
      appConfigPath: join(dir, "config.json"),
      autostartPath,
      remoteAccessPath: join(dir, "remote-access.json"),
    })
    const server = (await startServer({
      asPort: 0,
      autoEnrollEligibleSchedules: false,
      dbPath: ":memory:",
      ownerAuthLoginRateLimit: false,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerLive: live,
      quiet: true,
      rsPort: 0,
    })) as unknown as StartedServer
    const asUrl = `http://localhost:${server.asPort}`
    try {
      const anonymousMint = await fetch(`${asUrl}/_ref/owner-live/sessions`, { method: "POST", redirect: "manual" })
      assert.ok([401, 302, 303].includes(anonymousMint.status), `anonymous mint got ${anonymousMint.status}`)

      const login = await fetch(`${asUrl}/owner/login`, {
        body: JSON.stringify({ password: OWNER_PASSWORD }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "manual",
      })
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      assert.ok(cookie, "owner login sets a session cookie")

      const mint = await fetch(`${asUrl}/_ref/owner-live/sessions`, { headers: { cookie }, method: "POST" })
      assert.equal(mint.status, 201)
      const { events_path: eventsPath } = (await mint.json()) as { events_path: string }

      const anonymousAttach = await fetch(`${asUrl}${eventsPath}`, { redirect: "manual" })
      assert.notEqual(anonymousAttach.status, 200, "a token without the owner session must not attach")
      await anonymousAttach.body?.cancel()
      const badToken = await fetch(`${asUrl}/_ref/owner-live/not-a-token/events`, { headers: { cookie } })
      assert.equal(badToken.status, 401)

      const stream = await fetch(`${asUrl}${eventsPath}`, { headers: { accept: "text/event-stream", cookie } })
      assert.equal(stream.status, 200)
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/)
      const writeAt = { value: 0 }
      setTimeout(() => {
        writeAt.value = Date.now()
        void writeFile(autostartPath, '{"enabled":true}\n')
      }, 200)
      const events = await readEvents(stream, seen => seen.some(e => e.event === "invalidate"), 5000)
      const receivedAt = Date.now()

      const hello = events.find(e => e.event === "hello")?.data as { revisions: Record<string, string> } | undefined
      assert.deepEqual(Object.keys(hello?.revisions ?? {}).sort(), [...LIVE_TOPICS].sort())
      const invalidate = events.find(e => e.event === "invalidate")?.data as { topic: string } | undefined
      assert.equal(invalidate?.topic, "desktop.autostart")
      assert.ok(receivedAt - writeAt.value < 1500, `invalidate took ${receivedAt - writeAt.value} ms`)
    } finally {
      server.asServer.closeAllConnections()
      server.rsServer.closeAllConnections()
      await Promise.allSettled([
        new Promise<void>(resolve => server.asServer.close(resolve)),
        new Promise<void>(resolve => server.rsServer.close(resolve)),
      ])
    }
  })
})

test("owner logout closes already attached live streams sharing its server-side session", async () => {
  const live = createLiveRevisions()
  live.register("desktop.autostart", async () => "unchanged")
  const server = (await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthLoginRateLimit: false,
    ownerAuthPassword: OWNER_PASSWORD,
    ownerLive: live,
    quiet: true,
    rsPort: 0,
  })) as unknown as StartedServer
  const asUrl = `http://localhost:${server.asPort}`
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  try {
    const login = async () => {
      const response = await fetch(`${asUrl}/owner/login`, {
        body: JSON.stringify({ password: OWNER_PASSWORD }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "manual",
      })
      assert.equal(response.status, 302)
      return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    }
    const cookie = await login()
    const otherCookie = await login()
    assert.ok(cookie && otherCookie && cookie !== otherCookie, "separate sign-ins get separate opaque session cookies")

    // Two tabs share the first cookie and keep both streams open across logout.
    for (let tab = 0; tab < 2; tab += 1) {
      const mint = await fetch(`${asUrl}/_ref/owner-live/sessions`, { headers: { cookie }, method: "POST" })
      assert.equal(mint.status, 201)
      const { events_path: eventsPath } = (await mint.json()) as { events_path: string }
      const stream = await fetch(`${asUrl}${eventsPath}`, { headers: { cookie } })
      assert.equal(stream.status, 200)
      assert.ok(stream.body)
      const reader = stream.body.getReader()
      readers.push(reader)
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/)
    }

    const otherMint = await fetch(`${asUrl}/_ref/owner-live/sessions`, {
      headers: { cookie: otherCookie },
      method: "POST",
    })
    assert.equal(otherMint.status, 201)
    const { events_path: otherEventsPath } = (await otherMint.json()) as { events_path: string }
    const otherStream = await fetch(`${asUrl}${otherEventsPath}`, { headers: { cookie: otherCookie } })
    assert.equal(otherStream.status, 200)
    assert.ok(otherStream.body)
    const otherReader = otherStream.body.getReader()
    readers.push(otherReader)
    assert.match(new TextDecoder().decode((await otherReader.read()).value), /event: hello/)

    const rejectedLogout = await fetch(`${asUrl}/owner/logout`, {
      headers: { "Content-Type": "text/plain", cookie },
      method: "POST",
      redirect: "manual",
    })
    assert.equal(rejectedLogout.status, 403, "a missing CSRF pair must not close authenticated streams")
    const anonymousLogout = await fetch(`${asUrl}/owner/logout`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
    assert.equal(anonymousLogout.status, 204)
    live.bump("desktop.autostart")
    for (const reader of readers) {
      const next = await Promise.race([reader.read(), sleep(1500).then(() => null)])
      assert.ok(next && !next.done, "rejected or anonymous logout leaves authenticated streams open")
      assert.match(new TextDecoder().decode(next.value), /event: invalidate/)
    }

    const logout = await fetch(`${asUrl}/owner/logout`, {
      headers: { "Content-Type": "application/json", cookie },
      method: "POST",
      redirect: "manual",
    })
    assert.equal(logout.status, 204)
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/)
    live.bump("desktop.autostart")

    for (const reader of readers.slice(0, 2)) {
      const next = await Promise.race([reader.read(), sleep(1500).then(() => null)])
      assert.ok(next, "logout closes the same-session stream promptly")
      assert.equal(next.done, true, "a logged-out tab receives no later invalidation")
    }
    const otherNext = await Promise.race([otherReader.read(), sleep(1500).then(() => null)])
    assert.ok(otherNext && !otherNext.done, "a different owner session remains connected")
    assert.match(new TextDecoder().decode(otherNext.value), /event: invalidate/)
  } finally {
    await Promise.allSettled(readers.map(reader => reader.cancel()))
    server.asServer.closeAllConnections()
    server.rsServer.closeAllConnections()
    await Promise.allSettled([
      new Promise<void>(resolve => server.asServer.close(resolve)),
      new Promise<void>(resolve => server.rsServer.close(resolve)),
    ])
  }
})

for (const revocation of ["revoke-all", "revoke-others", "session-id", "desktop-replacement", "other-instance"] as const) {
  test(`${revocation} closes an attached owner live stream before another invalidation`, async () => {
    const live = createLiveRevisions()
    live.register("desktop.autostart", async () => "unchanged")
    const server = (await startServer({
      asPort: 0,
      autoEnrollEligibleSchedules: false,
      dbPath: ":memory:",
      ownerAuthLoginRateLimit: false,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerLive: live,
      quiet: true,
      rsPort: 0,
    })) as unknown as StartedServer
    const asUrl = `http://localhost:${server.asPort}`
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const loginOptions = {
        body: JSON.stringify({ password: OWNER_PASSWORD }),
        headers: {
          "Content-Type": "application/json",
          ...(revocation === "desktop-replacement" ? { "X-PDPP-Owner-Session-Label": "This computer" } : {}),
        },
        method: "POST",
        redirect: "manual" as const,
      }
      const login = await fetch(`${asUrl}/owner/login`, loginOptions)
      assert.equal(login.status, 302)
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      const mint = await fetch(`${asUrl}/_ref/owner-live/sessions`, { headers: { cookie }, method: "POST" })
      assert.equal(mint.status, 201)
      const { events_path: eventsPath } = (await mint.json()) as { events_path: string }
      const stream = await fetch(`${asUrl}${eventsPath}`, { headers: { cookie } })
      assert.equal(stream.status, 200)
      assert.ok(stream.body)
      reader = stream.body.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/)

      // Session management updates the shared store without notifying the local
      // logout listener. An already-authorized stream must read that state again.
      if (revocation === "desktop-replacement") {
        const replacement = await fetch(`${asUrl}/owner/login`, loginOptions)
        assert.equal(replacement.status, 302)
      } else if (revocation === "other-instance") {
        // Another controller uses the shared database without access to this
        // server's in-process logout listeners, as a second AS instance would.
        const otherController = createOwnerSessionController({ password: OWNER_PASSWORD, sessionStore: getOwnerSessionStore() })
        assert.equal(await otherController.revokeSessionFromCookieHeader(cookie), true)
      } else {
        let revokerCookie = cookie
        let revokePath = `/owner/sessions/${revocation}`
        if (revocation === "revoke-others") {
          const otherLogin = await fetch(`${asUrl}/owner/login`, loginOptions)
          assert.equal(otherLogin.status, 302)
          revokerCookie = (otherLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
        } else if (revocation === "session-id") {
          const sessions = await fetch(`${asUrl}/owner/sessions`, { headers: { cookie } })
          assert.equal(sessions.status, 200)
          const body = await sessions.json() as { sessions: Array<{ current: boolean; id: string }> }
          const current = body.sessions.find(session => session.current)
          assert.ok(current)
          revokePath = `/owner/sessions/${current.id}/revoke`
        }
        const revoked = await fetch(`${asUrl}${revokePath}`, {
          headers: { "Content-Type": "application/json", cookie: revokerCookie },
          method: "POST",
        })
        assert.equal(revoked.status, 204)
      }
      live.bump("desktop.autostart")
      const next = await Promise.race([reader.read(), sleep(1500).then(() => null)])
      assert.ok(next, "the revoked stream must close promptly")
      assert.equal(next.done, true, "revocation must prevent another invalidation on the existing stream")
    } finally {
      await reader?.cancel()
      server.asServer.closeAllConnections()
      server.rsServer.closeAllConnections()
      await Promise.allSettled([
        new Promise<void>(resolve => server.asServer.close(resolve)),
        new Promise<void>(resolve => server.rsServer.close(resolve)),
      ])
    }
  })
}
