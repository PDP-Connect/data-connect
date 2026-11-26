// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior of the Desktop settings toggles across the read states. The real
 * component runs under a real query client in jsdom; only the four owner
 * server actions are replaced, with controllable promises and call spies.
 */

import assert from "node:assert/strict"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { JSDOM } from "jsdom"
import { mock, test } from "node:test"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

type Setting = typeof import("./desktop-settings-setting.tsx")
type Props = NonNullable<Parameters<Setting["DesktopSettingsSetting"]>[0]>

interface Deferred<T> {
  promise: Promise<T>
  reject: (reason: unknown) => void
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, reject, resolve }
}

const harness = (async () => {
  Object.assign(globalThis, { React })
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
  })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator })
  // Importing the real server actions needs a Next.js request; the component
  // is given its own spies through props, so these are never called.
  const unused = async () => {
    throw new Error("the default server action must not be used in this test")
  }
  mock.module(new URL("./desktop-settings-actions.ts", import.meta.url).href, {
    namedExports: {
      loadAppConfigAction: unused,
      loadAutostartAction: unused,
      saveAppConfigFieldAction: unused,
      setAutostartAction: unused,
    },
  })
  mock.module(new URL("../lib/live-channel-actions.ts", import.meta.url).href, {
    namedExports: { mintLiveChannelAction: unused },
  })
  const { DesktopSettingsSetting } = await import("./desktop-settings-setting.tsx")
  return { dom, DesktopSettingsSetting }
})()

interface Rig {
  autostartRead: Deferred<unknown>[]
  appConfigRead: Deferred<unknown>[]
  container: HTMLElement
  queryClient: QueryClient
  saveCalls: Array<{ field: string; value: unknown }>
  setAutostartCalls: boolean[]
  toggle: (id: string) => Promise<void>
  checkbox: (id: string) => HTMLInputElement
  settle: () => Promise<void>
}

// Each read pops the next controllable promise; the last one is reused for
// later reloads when the queue runs dry.
async function mounted(run: (rig: Rig) => Promise<void>) {
  const { dom, DesktopSettingsSetting } = await harness
  const autostartRead: Deferred<unknown>[] = []
  const appConfigRead: Deferred<unknown>[] = []
  const saveCalls: Rig["saveCalls"] = []
  const setAutostartCalls: boolean[] = []
  const next = (queue: Deferred<unknown>[]) => {
    const item = deferred<unknown>()
    queue.push(item)
    return item.promise
  }
  const props = {
    loadAppConfig: () => next(appConfigRead),
    loadAutostart: () => next(autostartRead),
    saveAppConfigField: async (patch: { field: string; value: unknown }) => {
      saveCalls.push(patch)
      return { config: {}, ok: true }
    },
    setAutostart: async (enabled: boolean) => {
      setAutostartCalls.push(enabled)
      return { enabled, ok: true }
    },
  } as unknown as Props
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  const container = dom.window.document.createElement("div")
  dom.window.document.body.append(container)
  const root = createRoot(container)
  // TanStack batches observer notifications on a zero-delay timer.
  const settle = () => act(async () => { await new Promise(done => setTimeout(done, 10)) })
  const checkbox = (id: string) => {
    const found = container.querySelector<HTMLInputElement>(`#${id}`)
    assert.ok(found, `expected checkbox #${id}`)
    return found
  }
  try {
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(DesktopSettingsSetting, props))
      )
    )
    await run({
      appConfigRead,
      autostartRead,
      checkbox,
      container,
      queryClient,
      saveCalls,
      setAutostartCalls,
      settle,
      toggle: id => act(async () => checkbox(id).click()),
    })
  } finally {
    await act(async () => root.unmount())
    queryClient.clear()
    container.remove()
  }
}

const IDS = ["autostart-enabled", "start-minimized", "close-to-tray"]

function assertNothingActionable(rig: Rig, why: string) {
  for (const id of IDS) {
    assert.equal(rig.checkbox(id).disabled, true, `${id} must be disabled ${why}`)
    assert.equal(rig.checkbox(id).checked, false, `${id} must not show a guessed value ${why}`)
  }
}

async function interactWithAll(rig: Rig) {
  for (const id of IDS) await rig.toggle(id)
}

function assertNoWrites(rig: Rig) {
  assert.deepEqual(rig.saveCalls, [], "no app-config write may happen")
  assert.deepEqual(rig.setAutostartCalls, [], "no autostart write may happen")
}

test("while both reads are pending nothing is actionable, nothing shows as checked, and interaction writes nothing", async () => {
  await mounted(async rig => {
    assert.match(rig.container.textContent ?? "", /Reading the current desktop settings/)
    assertNothingActionable(rig, "while loading")
    await interactWithAll(rig)
    assertNoWrites(rig)
  })
})

test("when one read fails and the other succeeds the section is failed, not partly trusted", async () => {
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({ enabled: true, pending: false })
    rig.appConfigRead[0]!.reject(new Error("config unreadable"))
    await rig.settle()
    assert.match(rig.container.textContent ?? "", /could not be read, so they are not\s+shown/)
    assertNothingActionable(rig, "after a partial read failure")
    await interactWithAll(rig)
    assertNoWrites(rig)
  })
})

test("a successful load shows the real states and each toggle makes exactly one intended write", async () => {
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({ enabled: true, pending: false })
    rig.appConfigRead[0]!.resolve({ closeToTray: true, startMinimized: false })
    await rig.settle()
    for (const id of IDS) assert.equal(rig.checkbox(id).disabled, false, `${id} is actionable once loaded`)
    assert.equal(rig.checkbox("autostart-enabled").checked, true)
    assert.equal(rig.checkbox("start-minimized").checked, false)
    assert.equal(rig.checkbox("close-to-tray").checked, true)
    assertNoWrites(rig)

    await rig.toggle("start-minimized")
    assert.deepEqual(rig.saveCalls, [{ field: "startMinimized", value: true }])
    assert.deepEqual(rig.setAutostartCalls, [])
    await rig.settle()

    await rig.toggle("close-to-tray")
    assert.deepEqual(rig.saveCalls, [
      { field: "startMinimized", value: true },
      { field: "closeToTray", value: false },
    ])
    assert.deepEqual(rig.setAutostartCalls, [])
    await rig.settle()

    await rig.toggle("autostart-enabled")
    assert.deepEqual(rig.setAutostartCalls, [false])
    assert.equal(rig.saveCalls.length, 2, "autostart must not go through the app-config save")
  })
})

test("an explicit closeToTray false reads off, while an omitted closeToTray reads on", async () => {
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({ enabled: false, pending: false })
    rig.appConfigRead[0]!.resolve({ closeToTray: false })
    await rig.settle()
    assert.equal(rig.checkbox("close-to-tray").checked, false)
  })
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({ enabled: false, pending: false })
    rig.appConfigRead[0]!.resolve({})
    await rig.settle()
    assert.equal(rig.checkbox("close-to-tray").checked, true, "AppConfig defaults closeToTray to true")
  })
})

test("omitted startMinimized and omitted autostart enabled read off once loaded", async () => {
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({})
    rig.appConfigRead[0]!.resolve({})
    await rig.settle()
    assert.equal(rig.checkbox("autostart-enabled").disabled, false)
    assert.equal(rig.checkbox("autostart-enabled").checked, false)
    assert.equal(rig.checkbox("start-minimized").checked, false)
  })
})

// loadStateOf() deliberately keeps the last successful read on screen after a
// failed refetch. This pins that choice: a transient reload failure must not
// flip a setting the owner already saw to its "off" default.
test("a failed reload keeps the last successfully read values on screen", async () => {
  await mounted(async rig => {
    rig.autostartRead[0]!.resolve({ enabled: true, pending: false })
    rig.appConfigRead[0]!.resolve({ closeToTray: true, startMinimized: true })
    await rig.settle()

    await act(async () => {
      void rig.queryClient.invalidateQueries({ queryKey: ["desktop.app-config"] })
      void rig.queryClient.invalidateQueries({ queryKey: ["desktop.autostart"] })
    })
    rig.appConfigRead[1]!.reject(new Error("reload failed"))
    rig.autostartRead[1]!.reject(new Error("reload failed"))
    await rig.settle()

    assert.equal(rig.checkbox("start-minimized").checked, true)
    assert.equal(rig.checkbox("autostart-enabled").checked, true)
    assert.equal(rig.checkbox("close-to-tray").checked, true)
  })
})
