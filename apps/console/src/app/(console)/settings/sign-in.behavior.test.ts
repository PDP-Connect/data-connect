// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { requestReachability } from "./reachability-actions.ts"

const opened: string[] = []
mock.module(new URL("../../../../../../src/lib/open-resource.ts", import.meta.url).href, {
  exports: {
    openResource: async (target: string) => {
      opened.push(target)
      return true
    },
  },
})
mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  exports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) },
})
// The banned shapes of the copy scan: a code with underscores, the word reachability.
const bannedIn = (text: string) =>
  [/reachability/i, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i].filter(pattern => pattern.test(text))
const loadProviderSetup = async () => (await import("./provider-setup.tsx")).ProviderSetup

const LINK = "https://login.example.test/a/one-time-code-4711"
const reservation = {
  operationId: "op-1",
  providerId: "tailscale-funnel",
  providerLabel: "Tailscale",
  draftId: "draft-1",
  actionId: "tailscale-setup",
  expectedConfigurationRevision: "config-1",
  usage: "session",
}
const path = "/setup-operations/op-1"
const consent = (id: string) => ({
  facts: [],
  disclosures: { action: id },
  consentFactsDigest: `facts-${id}`,
  scope: { kind: "setup", actionDigest: `digest-${id}`, actionId: id, disclosureRevision: "1" },
})
const browserAction = {
  id: "tailscale-browser",
  kind: "open-url",
  label: "Approve Tailscale sign-in in your browser",
  digest: "digest-tailscale-browser",
  disclosure: { revision: "1", text: "Sign in", links: [] },
  step: { browser: { expiresAt: new Date(Date.now() + 600_000).toISOString(), pollAfterMs: 2000 } },
  consent: consent("tailscale-browser"),
}
const loginAction = {
  id: "tailscale-login",
  kind: "gozar-runs",
  label: "Start Tailscale sign-in",
  digest: "digest-tailscale-login",
  disclosure: { revision: "1", text: "Sign in", links: [] },
  consent: consent("tailscale-login"),
}
const view = (state: string, nextAction: unknown, revision = 3) => ({
  operationId: "op-1",
  revision,
  state,
  resources: [],
  evidence: { known: false },
  scope: { draftId: "draft-1", configurationRevision: "config-1" },
  nextAction,
})

type Call = { url: string; body?: Record<string, unknown> }

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const copied: string[] = []
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(node => node.textContent === label)
  return { dom, container, root, copied, button }
}

function transport(current: () => unknown, calls: Call[], gate?: () => Promise<void>): typeof requestReachability {
  return async (url, body) => {
    calls.push({ url, ...(body ? { body } : {}) })
    if (url === `${path}/handoff`) {
      await gate?.()
      return { ok: true, data: { href: LINK } }
    }
    return { ok: true, data: current() }
  }
}

async function render(
  root: ReturnType<typeof createRoot>,
  request: typeof requestReachability,
  extra: Record<string, unknown> = {}
) {
  const ProviderSetup = await loadProviderSetup()
  return act(async () =>
    root.render(
      createElement(ProviderSetup, {
        reservation,
        request,
        disabled: false,
        acknowledgeDisconnect: true,
        onChange: async () => {},
        onReadiness: () => {},
        ...extra,
      })
    )
  )
}

test("a sign-in step says Sign in to the service, with one button that calls the handoff once", async () => {
  opened.length = 0
  const { dom, container, root, button } = setup()
  const calls: Call[] = []
  try {
    await render(root, transport(() => view("authorization-required", browserAction), calls))
    const text = container.textContent ?? ""
    assert.match(text, /Needs your action/)
    assert.match(text, /Sign in to Tailscale to finish\./)
    assert.ok(button("Sign in to Tailscale"))
    assert.deepEqual(bannedIn(text), [])
    assert.doesNotMatch(text, /authorization-required/)
    await act(async () => button("Sign in to Tailscale")!.click())
    const handoffs = calls.filter(call => call.url === `${path}/handoff`)
    assert.equal(handoffs.length, 1)
    assert.deepEqual(handoffs[0]!.body, {
      approval: {
        kind: "setup",
        digest: "digest-tailscale-browser",
        disclosureRevision: "1",
        consentFactsDigest: "facts-tailscale-browser",
      },
      providerId: "tailscale-funnel",
      actionId: "tailscale-browser",
      draftId: "draft-1",
      expectedConfigurationRevision: "config-1",
      expectedSetupRevision: 3,
      acknowledgeDisconnect: true,
    })
    assert.deepEqual(opened, [LINK])
    assert.match(container.textContent ?? "", /Waiting for you to finish signing in…/)
    assert.equal(button("Sign in to Tailscale"), undefined)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("pending to complete across polls moves on with no click, reading in order and posting nothing", async () => {
  const { dom, container, root, button } = setup()
  const calls: Call[] = []
  let state = "pending"
  const seen: string[] = []
  try {
    const request = transport(() => (state === "complete" ? view("complete", null, 4) : view("pending", browserAction)), calls)
    const props = { onChange: async (next: { state: string }) => void seen.push(next.state) }
    await render(root, request, { ...props, pollTick: 0 })
    await act(async () => button("Sign in to Tailscale")!.click())
    calls.length = 0
    seen.length = 0
    await render(root, request, { ...props, pollTick: 1 })
    await render(root, request, { ...props, pollTick: 2 })
    state = "complete"
    await render(root, request, { ...props, pollTick: 3 })
    await render(root, request, { ...props, pollTick: 4 })
    assert.deepEqual(
      calls.map(call => `${call.body ? "POST" : "GET"} ${call.url.split("?")[0]}`),
      [`GET ${path}`, `GET ${path}`, `GET ${path}`]
    )
    assert.deepEqual(seen, ["pending", "pending", "complete"])
    // Done: no leftover card.
    assert.equal(container.textContent, "")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

for (const [state, line] of [
  ["denied", "Tailscale sign-in was cancelled."],
  ["expired", "Tailscale sign-in took too long."],
] as const) {
  test(`${state} shows its own words and Try again runs the same setup again`, async () => {
    const { dom, container, root, button } = setup()
    const calls: Call[] = []
    let current: unknown = view(state, loginAction, 5)
    try {
      await render(root, transport(() => current, calls))
      const text = container.textContent ?? ""
      assert.match(text, new RegExp(line.replaceAll(".", "\\.")))
      assert.equal(text.includes(state), false)
      assert.deepEqual(bannedIn(text), [])
      calls.length = 0
      current = view("pending", browserAction, 6)
      await act(async () => button("Try again")!.click())
      assert.deepEqual(calls, [
        {
          url: path,
          body: {
            approval: {
              kind: "setup",
              digest: "digest-tailscale-login",
              disclosureRevision: "1",
              consentFactsDigest: "facts-tailscale-login",
            },
            providerId: "tailscale-funnel",
            actionId: "tailscale-login",
            draftId: "draft-1",
            expectedConfigurationRevision: "config-1",
            expectedSetupRevision: 5,
            acknowledgeDisconnect: true,
          },
        },
      ])
      assert.match(container.textContent ?? "", /Sign in to Tailscale to finish\./)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}

test("Copy sign-in link copies the link and the link is never in the page", async () => {
  opened.length = 0
  const { dom, container, root, copied, button } = setup()
  const calls: Call[] = []
  try {
    await render(root, transport(() => view("pending", browserAction), calls))
    await act(async () => button("Copy sign-in link")!.click())
    assert.deepEqual(copied, [LINK])
    assert.deepEqual(opened, [])
    assert.equal(container.innerHTML.includes("one-time-code"), false)
    assert.equal(container.textContent?.includes("login.example.test"), false)
    // Still there while waiting.
    await act(async () => button("Sign in to Tailscale")!.click())
    assert.match(container.textContent ?? "", /Waiting for you to finish signing in…/)
    assert.ok(button("Copy sign-in link"))
    assert.equal(container.innerHTML.includes("one-time-code"), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("leaving the way stops polling its setup and never opens its link", async () => {
  opened.length = 0
  const { dom, container, root, button } = setup()
  const calls: Call[] = []
  let onWay = true
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  try {
    const request = transport(() => view("pending", browserAction), calls, () => gate)
    const props = { isCurrentWay: () => onWay }
    await render(root, request, { ...props, pollTick: 0 })
    // The owner clicks Sign in; before the host answers the owner picks another way.
    let click: Promise<void> = Promise.resolve()
    await act(async () => {
      click = Promise.resolve(button("Sign in to Tailscale")!.click())
    })
    onWay = false
    await render(root, request, { ...props, pollTick: 1 })
    await act(async () => release())
    await click
    assert.deepEqual(opened, [])
    assert.equal(container.textContent, "")
    calls.length = 0
    await render(root, request, { ...props, pollTick: 2 })
    await render(root, request, { ...props, pollTick: 3 })
    assert.deepEqual(calls, [])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})


test("retained non-current setup can be undone once; empty completed cleanup stays hidden", async () => {
  const { dom, container, root, button } = setup()
  const calls: Call[] = []
  let current = { ...view("pending", browserAction), resources: [{ handle: "resource-1", label: "Sign-in", removal: "retained" }] }
  const request = transport(() => current, calls)
  try {
    await render(root, request, { isCurrentWay: () => false, reservation: { ...reservation, cleanup: true } })
    assert.ok(button("Undo setup"))
    assert.equal(button("Sign in to Tailscale"), undefined)
    current = { ...view("cancelled", null, 4), resources: [] }
    await act(async () => button("Undo setup")!.click())
    assert.deepEqual(calls.filter(call => call.body), [{ url: path + "/cancel", body: { providerId: reservation.providerId } }])
    assert.equal(container.textContent, "")
    await render(root, transport(() => view("complete", null, 5), []), { reservation: { ...reservation, cleanup: true } })
    assert.equal(container.textContent, "")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

for (const state of ["pending", "denied", "expired"]) {
  test(state + " sign-in exposes secondary cancellation", async () => {
    const { dom, root, button } = setup()
    const calls: Call[] = []
    try {
      await render(root, transport(() => view(state, browserAction), calls))
      assert.ok(button("Cancel setup"))
      await act(async () => button("Cancel setup")!.click())
      assert.equal(calls.filter(call => call.url === path + "/cancel").length, 1)
    } finally { await act(async () => root.unmount()); dom.window.close() }
  })
}

test("poll and focus coalesce, and older revisions cannot replace the installed step", async () => {
  const { dom, root, container } = setup()
  let reads = 0
  const releases: Array<(result: Awaited<ReturnType<typeof requestReachability>>) => void> = []
  const seen: number[] = []
  const request: typeof requestReachability = async () => {
    if (++reads === 1) return { ok: true, data: view("pending", browserAction, 3) }
    return new Promise(resolve => releases.push(resolve))
  }
  const extra = { onChange: async (next: { revision: number }) => { seen.push(next.revision) } }
  try {
    await render(root, request, extra)
    await render(root, request, { ...extra, pollTick: 1 })
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); dom.window.dispatchEvent(new dom.window.Event("pageshow")) })
    assert.equal(reads, 2, "only one physical read is in flight")
    await act(async () => releases.shift()!({ ok: true, data: view("pending", browserAction, 5) }))
    assert.equal(reads, 3, "one trailing read coalesces both events")
    await act(async () => releases.shift()!({ ok: true, data: view("pending", browserAction, 4) }))
    assert.deepEqual(seen, [3, 5], "older revision is rejected before onChange")
    await render(root, request, { ...extra, pollTick: 2 })
    await act(async () => releases.shift()!({ ok: true, data: view("complete", null, 6) }))
    assert.equal(container.textContent, "")
    await render(root, request, { ...extra, pollTick: 3 })
    assert.equal(reads, 4, "waiting ended")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("unmount invalidates an unresolved setup observation", async () => {
  const { dom, root } = setup()
  let release!: (result: Awaited<ReturnType<typeof requestReachability>>) => void
  let observed = 0
  const request: typeof requestReachability = () => new Promise(resolve => { release = resolve })
  await render(root, request, { onChange: async () => { observed++ } })
  await act(async () => root.unmount())
  await act(async () => release({ ok: true, data: view("complete", null, 10) }))
  assert.equal(observed, 0)
  dom.window.close()
})

test("new read completes before an invalidated old read without resurrecting pending", async () => {
  const { dom, root, container } = setup()
  let release!: (result: Awaited<ReturnType<typeof requestReachability>>) => void
  const seen: number[] = []
  const oldRequest: typeof requestReachability = () => new Promise(resolve => { release = resolve })
  const extra = { onChange: async (next: { revision: number }) => { seen.push(next.revision) } }
  try {
    await render(root, oldRequest, extra)
    await render(root, transport(() => view("complete", null, 8), []), extra)
    assert.deepEqual(seen, [8])
    await act(async () => release({ ok: true, data: view("pending", browserAction, 7) }))
    assert.deepEqual(seen, [8])
    assert.equal(container.textContent, "")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("a completed cleanup card with retained resources still offers Undo setup", async () => {
  const { dom, root, button } = setup()
  try {
    await render(root, transport(() => ({
      ...view("complete", null), resources: [{ handle: "r", label: "Service", removal: "required" }],
    }), []), { reservation: { ...reservation, cleanup: true } })
    assert.ok(button("Undo setup"))
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("a timed-out setup read releases the latch and ignores its late response", async t => {
  const { dom, root, container } = setup()
  let reads = 0
  let release!: (result: Awaited<ReturnType<typeof requestReachability>>) => void
  const seen: number[] = []
  const request: typeof requestReachability = async () => {
    reads++
    if (reads === 1) return { ok: true, data: view("pending", browserAction, 3) }
    if (reads === 2) return new Promise(resolve => { release = resolve })
    return { ok: true, data: view("complete", null, 5) }
  }
  const extra = { onChange: async (next: { revision: number }) => { seen.push(next.revision) } }
  try {
    await render(root, request, extra)
    t.mock.timers.enable({ apis: ["setTimeout"] })
    await render(root, request, { ...extra, pollTick: 1 })
    assert.equal(reads, 2)
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")) })
    assert.equal(reads, 2)
    await act(async () => t.mock.timers.tick(15_001))
    // Codes may appear under Details only; scan the main text.
    const main = container.cloneNode(true) as Element
    for (const node of main.querySelectorAll("[data-diagnostics]")) node.remove()
    assert.ok((main.textContent ?? "").trim().length > 0, "the timeout shows its message")
    assert.deepEqual(bannedIn(main.textContent ?? ""), [])
    await render(root, request, { ...extra, pollTick: 2 })
    assert.equal(reads, 3, "the next tick starts a replacement read")
    assert.deepEqual(seen, [3, 5])
    assert.equal(container.textContent, "")
    await act(async () => release({ ok: true, data: view("pending", browserAction, 4) }))
    assert.deepEqual(seen, [3, 5], "late timed-out response cannot restore pending")
    assert.equal(container.textContent, "")
  } finally {
    await act(async () => root.unmount())
    t.mock.timers.reset()
    dom.window.close()
  }
})
