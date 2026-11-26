// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A remote access change restarts the desktop stack: the config watcher
 * (`src-tauri/src/unified.rs::spawn_remote_access_config_watcher`) rewrites
 * `remote-access.json` to clear a sealed provider token, then tears the
 * stack down. The reference server's live tick reports that rewrite, so this
 * tab refetches the `remote-access` topic while the console is going away.
 * In the WebKitGTK webview that fetch rejects with `TypeError: Load failed`.
 *
 * These tests drive the real `RemoteAccessSetting` inside the real
 * `LiveProvider`. Only the server actions and the owner-live EventSource are
 * fakes; the fakes reject with the exact WebKit error during the restart.
 */

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { after, mock, test } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  readonly listeners = new Map<string, (event: { data: string }) => void>()
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, listener)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) })
  }

  static latest(): FakeEventSource {
    const latest = FakeEventSource.instances.at(-1)
    assert.ok(latest, "the live channel should have opened an EventSource")
    return latest
  }
}

const harness = (async () => {
  Object.assign(globalThis, { React })
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://127.0.0.1:7664/settings",
  })
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    EventSource: FakeEventSource,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
  })
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator })
  const unused = async () => {
    throw new Error("not used by this test")
  }
  mock.module(new URL("./remote-access-actions.ts", import.meta.url).href, {
    namedExports: {
      loadRemoteAccessStateAction: unused,
      requestOwnerPasswordWindowAction: unused,
      restartAfterOwnerPasswordSetAction: unused,
      setConsolePortAction: unused,
      setRemoteAccessConfigAction: unused,
    },
  })
  mock.module(new URL("../lib/live-channel-actions.ts", import.meta.url).href, {
    namedExports: { mintLiveChannelAction: async () => ({ eventsPath: "/_ref/owner-live/token/events" }) },
  })
  // Query cache GC timers run for minutes; unref them so the test file
  // exits. Set on both module formats: the component may load either one.
  const require = createRequire(import.meta.url)
  const unrefTimeouts = {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(),
  }
  for (const query of [require("@tanstack/react-query"), await import("@tanstack/react-query")]) {
    query.timeoutManager.setTimeoutProvider(unrefTimeouts)
  }
  const [{ LiveProvider }, { RemoteAccessSetting }, { offRemoteAccessConfig }] = await Promise.all([
    import("../components/live-provider.tsx"),
    import("./remote-access-setting.tsx"),
    import("./remote-access.ts"),
  ])
  return { dom, LiveProvider, offRemoteAccessConfig, RemoteAccessSetting }
})()

const available = { availability: "available", reason: null }

async function settle(ms = 0) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

async function fire(event: () => void) {
  await act(async () => event())
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    await settle(25)
  }
}

async function renderSetting(loadState: () => Promise<unknown>, saveConfig?: () => Promise<unknown>) {
  const { dom, LiveProvider, offRemoteAccessConfig, RemoteAccessSetting } = await harness
  FakeEventSource.instances = []
  const container = dom.window.document.createElement("div")
  dom.window.document.body.append(container)
  const root = createRoot(container)
  const state = () => ({
    cloudflareTunnelInspection: available,
    config: offRemoteAccessConfig(),
    effectiveConsolePort: 7664,
    inspection: available,
    myDevicesOnlyInspection: available,
    ngrokInspection: available,
    ownerPasswordOwnerSet: true,
    stableConsolePort: 7664,
  })
  await act(async () => {
    root.render(
      createElement(
        LiveProvider,
        null,
        createElement(RemoteAccessSetting, {
          loadState: (() => loadState().then(() => state())) as never,
          saveConfig: saveConfig as never,
        })
      )
    )
  })
  const text = () => container.textContent ?? ""
  await waitFor(() => !text().includes("Reading the current remote access state"), "the first read")
  await waitFor(() => FakeEventSource.instances.length > 0, "the live channel")
  await fire(() => FakeEventSource.latest().emit("hello", { revisions: { "remote-access": "r1" } }))
  return { cleanup: () => act(async () => root.unmount()).then(() => container.remove()), container, text }
}

test("a refetch that fails during the remote-access restart reads as reconnecting, then resolves", async () => {
  let stackUp = true
  let reads = 0
  const { cleanup, text } = await renderSetting(async () => {
    reads += 1
    if (!stackUp) throw new TypeError("Load failed")
  })
  try {
    // The watcher clears the sealed token (revision r2), then tears the stack down.
    stackUp = false
    const readsBeforeRestart = reads
    await fire(() => {
      const channel = FakeEventSource.latest()
      channel.emit("invalidate", { revision: "r2", topic: "remote-access" })
      channel.onerror?.()
    })
    // The refetch and TanStack's one retry (after 1 s) both fail.
    await waitFor(() => reads >= readsBeforeRestart + 2, "the refetch and its retry")
    await settle(50)
    assert.doesNotMatch(text(), /TypeError|Load failed/)
    assert.match(text(), /DataConnect is restarting or not answering\. Reconnecting…/)

    // The stack is back. The channel reconnects and reports the revision this
    // tab already saw, so only the failed read makes it refetch.
    stackUp = true
    await waitFor(() => FakeEventSource.instances.length > 1, "the channel to reconnect")
    await fire(() => FakeEventSource.latest().emit("hello", { revisions: { "remote-access": "r2" } }))
    await waitFor(() => !text().includes("Reconnecting…"), "the reconnect message to clear")
    assert.doesNotMatch(text(), /TypeError|Load failed/)
  } finally {
    await cleanup()
  }
})

test("a read the server refuses is still reported as it is", async () => {
  let refuse = false
  const { cleanup, text } = await renderSetting(async () => {
    if (refuse) throw new Error("Remote access config is unreadable: EACCES")
  })
  try {
    refuse = true
    await fire(() => FakeEventSource.latest().emit("invalidate", { revision: "r2", topic: "remote-access" }))
    await waitFor(() => text().includes("Remote access config is unreadable: EACCES"), "the server error")
    assert.doesNotMatch(text(), /Reconnecting…/)
  } finally {
    await cleanup()
  }
})

test("a save the restart cuts off says so instead of showing the browser error", async () => {
  const { cleanup, container, text } = await renderSetting(
    async () => {},
    async () => {
      throw new TypeError("Load failed")
    }
  )
  try {
    const myDevicesOnly = container.querySelector<HTMLInputElement>('input[aria-label="My devices only"]')
    assert.ok(myDevicesOnly, "the My devices only option should render")
    await fire(() => myDevicesOnly.click())
    await waitFor(() => text().includes("before it confirmed this change"), "the save failure")
    assert.doesNotMatch(text(), /TypeError|Load failed/)
  } finally {
    await cleanup()
  }
})

after(async () => {
  ;(await harness).dom.window.close()
})
