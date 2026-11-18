// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { migrateLegacySetupReservations } from "../../../lib/legacy-setup-reservations.ts"
import type { requestReachability } from "./reachability-actions.ts"
import { type ServiceEntry, setupCards } from "./setup-services.ts"

mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  namedExports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) },
})
mock.module(new URL("./reachability-actions.ts", import.meta.url).href, {
  namedExports: {
    requestReachability: async () => {
      throw new Error("Use the test transport")
    },
  },
})

const settingsDir = new URL(".", import.meta.url)

test("settings sources keep no setup or draft state in browser storage", () => {
  const sources = readdirSync(settingsDir).filter(
    name => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
  )
  assert.ok(sources.includes("remote-access-setting.tsx"))
  for (const name of sources) {
    const text = readFileSync(new URL(name, settingsDir), "utf8")
    assert.doesNotMatch(text, /localStorage|sessionStorage/, name)
  }
})

function entry(providerId: string, operationId: string): ServiceEntry {
  return {
    providerId,
    providerLabel: "Tunnel service",
    draftId: "draft-1",
    usage: "durable",
    committed: false,
    setup: {
      operationId,
      actionId: "sign-in",
      expectedConfigurationRevision: "config",
    },
  }
}

test("one card per service even if a response carries two setups", () => {
  const cards = setupCards([
    entry("svc", "op-complete"),
    entry("other", "op-other"),
    entry("svc", "op-blocked"),
  ])
  assert.deepEqual(
    cards.map(card => [card.providerId, card.operationId]),
    [
      ["svc", "op-blocked"],
      ["other", "op-other"],
    ]
  )
  assert.deepEqual(setupCards(undefined), [])
  assert.deepEqual(setupCards([{ ...entry("svc", "x"), setup: null }]), [])
})

function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}
const legacy = (operationId: string) => ({
  operationId,
  providerId: "svc",
  providerLabel: "Tunnel service",
  draftId: "draft-1",
  actionId: "sign-in",
  expectedConfigurationRevision: "config",
  usage: "durable",
})

test("migration keeps what the server holds, drops stale entries, then clears the browser copy", async () => {
  const local = memoryStore({
    "reachability-setup-reservations-v1": JSON.stringify([
      legacy("op-live"),
      legacy("op-stale"),
      { operationId: "broken" },
    ]),
  })
  const session = memoryStore({ "reachability-draft": "{}" })
  const asked: string[] = []
  const request = (async (path: string, body?: Record<string, unknown>) => {
    assert.equal(path, "/setups/adopt")
    asked.push(String(body?.operationId))
    return {
      ok: true,
      data:
        body?.operationId === "op-live"
          ? { adopted: true }
          : { adopted: false, reason: "unknown" },
    }
  }) as typeof requestReachability
  const result = await migrateLegacySetupReservations(request, { local, session })
  assert.deepEqual(asked, ["op-live", "op-stale"])
  assert.deepEqual(result, { adopted: 1, dropped: 1, deferred: 0, cleanup: 0, draft: "none" })
  assert.equal(local.items.size, 0)
  assert.equal(session.items.size, 0)
})

test("migration keeps a saved setup when the server cannot answer", async () => {
  const local = memoryStore({
    "reachability-setup-reservations-v1": JSON.stringify([legacy("op-live")]),
  })
  const request = (async () => ({
    ok: false,
    code: "reachability_unavailable",
    message: "down",
  })) as typeof requestReachability
  const result = await migrateLegacySetupReservations(request, {
    local,
    session: memoryStore(),
  })
  assert.deepEqual(result, { adopted: 0, dropped: 0, deferred: 1, cleanup: 0, draft: "none" })
  assert.deepEqual(
    JSON.parse(local.items.get("reachability-setup-reservations-v1")!),
    [legacy("op-live")]
  )
})

test("the state that showed two cards for one service renders one", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx")
  const view = (operationId: string, state: string) => ({
    operationId,
    revision: 1,
    state,
    resources: [],
    evidence: { known: false },
    scope: { draftId: null, configurationRevision: "config" },
    nextAction: null,
  })
  const request: typeof requestReachability = async url => {
    if (url.startsWith("/setup-operations/op-complete"))
      return { ok: true, data: view("op-complete", "complete") }
    if (url.startsWith("/setup-operations/op-blocked"))
      return { ok: true, data: view("op-blocked", "blocked") }
    const observations: Record<string, unknown> = {
      "/catalog": { providers: [] },
      "/state": {
        routes: [],
        reasons: {},
        starting: false,
        services: [
          { ...entry("svc", "op-complete"), draftId: null },
          { ...entry("svc", "op-blocked"), draftId: null },
        ],
      },
      "/host-settings": { known: false, reason: "unavailable" },
      "/host-capabilities": {},
    }
    assert.ok(Object.hasOwn(observations, url), url)
    return { ok: true, data: observations[url] }
  }
  try {
    await act(async () =>
      root.render(createElement(RemoteAccessSetting, { request }))
    )
    const cards = container.querySelectorAll(
      '[aria-label^="Setup for"]'
    )
    assert.equal(cards.length, 1)
    assert.doesNotMatch(container.textContent ?? "", /Ready to turn on/)
    assert.match(container.textContent ?? "", /Needs your action/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

const draftPointer = JSON.stringify({ providerId: "svc", draftId: "draft-1", usage: "durable" })

test("migration sends the saved draft to the host and keeps it until the host answers", async () => {
  const session = memoryStore({ "reachability-draft": draftPointer })
  const sent: unknown[] = []
  let answer: unknown = { ok: false, code: "reachability_unavailable", message: "down" }
  const request = (async (path: string, body?: Record<string, unknown>) => {
    assert.equal(path, "/setups/adopt-draft")
    sent.push(body)
    return answer
  }) as typeof requestReachability
  const local = memoryStore()
  // The host did not answer: the pointer stays, so the next load tries again.
  assert.equal((await migrateLegacySetupReservations(request, { local, session })).draft, "deferred")
  assert.equal(session.items.get("reachability-draft"), draftPointer)
  // The host took it, already has a draft, or says the draft is gone: all final.
  for (const data of [{ adopted: true }, { adopted: false, reason: "service_has_draft" }, { adopted: false, reason: "unknown" }]) {
    session.setItem("reachability-draft", draftPointer)
    answer = { ok: true, data }
    assert.equal((await migrateLegacySetupReservations(request, { local, session })).draft, "sent")
    assert.equal(session.items.has("reachability-draft"), false)
  }
  assert.deepEqual(sent[0], { providerId: "svc", draftId: "draft-1", usage: "durable" })
})

test("migration drops a draft pointer that names nothing, and reports a leftover setup", async () => {
  const session = memoryStore({ "reachability-draft": "{}" })
  const local = memoryStore({ "reachability-setup-reservations-v1": JSON.stringify([legacy("op-second")]) })
  const request = (async (path: string) => {
    assert.equal(path, "/setups/adopt")
    return { ok: true, data: { adopted: false, reason: "needs_cleanup" } }
  }) as typeof requestReachability
  const result = await migrateLegacySetupReservations(request, { local, session })
  assert.deepEqual(result, { adopted: 0, dropped: 0, deferred: 0, cleanup: 1, draft: "none" })
  assert.equal(session.items.size, 0)
  assert.equal(local.items.size, 0)
})

test("a leftover setup gets its own card beside the service's setup", () => {
  const cards = setupCards([{ ...entry("svc", "op-live"), cleanup: ["op-left-1", "op-left-2"] }])
  assert.deepEqual(
    cards.map(card => card.operationId),
    ["op-live", "op-left-1", "op-left-2"]
  )
  assert.match(cards[1]!.providerLabel, /left over/)
  // A service with only leftovers still shows them.
  assert.deepEqual(
    setupCards([{ ...entry("svc", "x"), setup: null, cleanup: ["op-left"] }]).map(card => card.operationId),
    ["op-left"]
  )
})

async function mountSetting(request: typeof requestReachability, withStorage?: (dom: JSDOM) => void) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  withStorage?.(dom)
  const root = createRoot(dom.window.document.querySelector("#root")!)
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx")
  await act(async () => root.render(createElement(RemoteAccessSetting, { request })))
  return {
    container: dom.window.document.querySelector("#root")!,
    async stop() {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

test("polling starts only after the browser-storage migration finishes", async () => {
  const calls: string[] = []
  let finish: (value: unknown) => void = () => {}
  const request = (async (url: string) => {
    calls.push(url)
    if (url === "/setups/adopt") return new Promise(resolve => (finish = resolve))
    return { ok: true, data: url === "/catalog" ? { providers: [] } : url === "/state" ? { routes: [], reasons: {}, starting: false } : url === "/host-settings" ? { known: false, reason: "unavailable" } : {} }
  }) as unknown as typeof requestReachability
  const screen = await mountSetting(request, dom => {
    Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true })
    Object.defineProperty(globalThis, "sessionStorage", { value: dom.window.sessionStorage, configurable: true })
    dom.window.localStorage.setItem("reachability-setup-reservations-v1", JSON.stringify([legacy("op-live")]))
  })
  try {
    assert.deepEqual(calls, ["/setups/adopt"], "a poll ran before the migration finished")
    await act(async () => finish({ ok: true, data: { adopted: true } }))
    assert.ok(calls.includes("/catalog") && calls.includes("/state"))
  } finally {
    await screen.stop()
  }
})

test("a failed draft read is retried on the next poll", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  let draftReads = 0
  const services = [{ ...entry("svc", "op-x"), setup: null, draftId: "draft-1" }]
  const request = (async (url: string) => {
    if (url.startsWith("/drafts/draft-1")) {
      draftReads += 1
      return draftReads === 1
        ? { ok: false, code: "reachability_unavailable", message: "down" }
        : { ok: true, data: { draftId: "draft-1", configuration: { revision: "r", actions: [], inputRequirements: [], values: {}, credentials: {} } } }
    }
    return { ok: true, data: url === "/catalog" ? { providers: [] } : url === "/state" ? { routes: [], reasons: {}, starting: false, services } : url === "/host-settings" ? { known: false, reason: "unavailable" } : {} }
  }) as unknown as typeof requestReachability
  const screen = await mountSetting(request)
  try {
    assert.equal(draftReads, 1)
    await act(async () => t.mock.timers.tick(3000))
    await act(async () => {})
    assert.equal(draftReads, 2, "the failed read was not retried")
    await act(async () => t.mock.timers.tick(3000))
    await act(async () => {})
    assert.equal(draftReads, 2, "a successful read is not repeated")
  } finally {
    await screen.stop()
  }
})
