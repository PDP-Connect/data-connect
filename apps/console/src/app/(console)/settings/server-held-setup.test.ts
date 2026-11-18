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
  assert.deepEqual(result, { adopted: 1, dropped: 1, deferred: 0 })
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
  assert.deepEqual(result, { adopted: 0, dropped: 0, deferred: 1 })
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
      '[aria-label^="Provider setup for"]'
    )
    assert.equal(cards.length, 1)
    assert.doesNotMatch(container.textContent ?? "", /Setup complete/)
    assert.match(container.textContent ?? "", /Setup needs attention/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
