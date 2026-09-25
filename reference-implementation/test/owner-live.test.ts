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
import { mountOwnerLiveAs } from "../server/routes/owner-live.ts"

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
    live: createLiveRevisions(),
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
    { params: { token }, raw: { on: (_event: string, listener: () => void) => (onClose = listener) } },
    {
      hijack: () => undefined,
      json: () => undefined,
      raw: { setHeader: () => undefined, statusCode: 0, write: (chunk: string) => chunks.push(chunk) },
      status: () => undefined,
    }
  )
  await sleep(70)
  onClose()
  assert.ok(chunks[0]?.startsWith("event: hello\n"), "hello is the first event")
  assert.ok(chunks.filter(chunk => chunk === "event: ping\ndata: {}\n\n").length >= 2)
  assert.ok(!chunks.some(chunk => chunk.startsWith(":")), "no comment-only keepalives")
})

test("a ping tick closes the stream once the owning session is revoked", async () => {
  type Handler = (req: unknown, res: unknown) => unknown
  const routes = new Map<string, Handler>()
  const app = {
    get: (path: string, ...args: unknown[]) => routes.set(`GET ${path}`, args.at(-1) as Handler),
    post: (path: string, ...args: unknown[]) => routes.set(`POST ${path}`, args.at(-1) as Handler),
  }
  let revoked = false
  mountOwnerLiveAs(app, {
    live: createLiveRevisions(),
    pdppError: () => undefined,
    pingIntervalMs: 20,
    requireOwnerSession: () => undefined,
    sessionRevokedSince: () => revoked,
  })
  let minted = { events_path: "" }
  const jsonRes = { json: (body: { events_path: string }) => (minted = body), status: () => jsonRes }
  await routes.get("POST /_ref/owner-live/sessions")?.({}, jsonRes)
  const token = minted.events_path.split("/")[3] ?? ""

  const chunks: string[] = []
  let ended = false
  let onClose = () => undefined as void
  await routes.get("GET /_ref/owner-live/:token/events")?.(
    {
      ownerSession: { exp: 0, iat: 0, sub: "owner" },
      params: { token },
      raw: { on: (_event: string, listener: () => void) => (onClose = listener) },
    },
    {
      hijack: () => undefined,
      json: () => undefined,
      raw: {
        end: () => (ended = true),
        setHeader: () => undefined,
        statusCode: 0,
        write: (chunk: string) => chunks.push(chunk),
      },
      status: () => undefined,
    }
  )
  await sleep(30)
  assert.ok(!ended, "must not close before the session is revoked")

  revoked = true
  await sleep(30)
  onClose()
  assert.ok(ended, "the connection must be ended once sessionRevokedSince reports the session as revoked")
})

interface StartedServer {
  asPort: number
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void }
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void }
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

test("owner logout closes an already-open live stream instead of leaving it running", async () => {
  await withTempDir(async dir => {
    const live = createLiveRevisions()
    registerDefaultLiveTopics(live, {
      appConfigPath: join(dir, "config.json"),
      autostartPath: join(dir, "autostart.json"),
      remoteAccessPath: join(dir, "remote-access.json"),
    })
    const server = (await startServer({
      asPort: 0,
      autoEnrollEligibleSchedules: false,
      dbPath: ":memory:",
      ownerAuthLoginRateLimit: false,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerLive: live,
      ownerLivePingIntervalMs: 50,
      quiet: true,
      rsPort: 0,
    })) as unknown as StartedServer
    const asUrl = `http://localhost:${server.asPort}`
    try {
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

      const stream = await fetch(`${asUrl}${eventsPath}`, { headers: { accept: "text/event-stream", cookie } })
      assert.equal(stream.status, 200)
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()

      // Wait for `hello` so the stream is confirmed live before logging out.
      let buffer = ""
      const helloDeadline = Date.now() + 2000
      while (!buffer.includes("event: hello") && Date.now() < helloDeadline) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
      }
      assert.ok(buffer.includes("event: hello"), "stream must send hello before logout")

      const logout = await fetch(`${asUrl}/owner/logout`, {
        headers: { "Content-Type": "application/json", cookie },
        method: "POST",
      })
      assert.ok([200, 204].includes(logout.status), `logout got ${logout.status}`)

      // The stream must end on its own (server-initiated close) within a
      // couple of ping intervals -- not merely stop emitting new events. If
      // this reads until the timeout without the reader ever finishing, the
      // stream stayed open past logout.
      const closedOnItsOwn = await Promise.race([
        reader.read().then(result => result.done === true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
      ])
      await reader.cancel().catch(() => undefined)
      assert.ok(closedOnItsOwn, "owner-live stream must close once its owning session is logged out")
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
