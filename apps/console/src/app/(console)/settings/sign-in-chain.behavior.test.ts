// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import type { requestReachability } from "./reachability-client.ts"

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
const bannedIn = (text: string) =>
  [/reachability/i, /gozar/i, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i].filter(pattern => pattern.test(text))
const loadProviderSetup = async () => (await import("./provider-setup.tsx")).ProviderSetup

const LINK = "https://login.example.test/a/one-time-code-4711"
const ADMIN = "https://login.example.test/admin/dns"
const EMAIL = "owner@example.test"
const TAILNET = "tail-1234.ts.net"
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

type Facts = (id: string) => string
const sharedFacts: Facts = () => "facts-shared"
const ownFacts: Facts = id => `facts-${id}`

function step(id: string, facts: Facts, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "gozar-runs",
    label: `Step ${id}`,
    digest: `digest-${id}`,
    disclosure: { revision: "1", text: "Sign in", links: [] },
    consent: {
      facts: [],
      // Real shape: gozar's setup consent disclosures are { action: { id, disclosure: { text, revision, links } } }.
      disclosures: { action: { id, disclosure: { revision: "1", text: `Facts for ${id}.`, links: [] } } },
      consentFactsDigest: facts(id),
      scope: { kind: "setup", actionDigest: `digest-${id}`, actionId: id, disclosureRevision: "1" },
    },
    ...extra,
  }
}
const actions = (facts: Facts): Record<string, ReturnType<typeof step>> => ({
  "tailscale-setup": step("tailscale-setup", facts, { step: { actor: "machine" } }),
  "tailscale-account": step("tailscale-account", facts, {
    kind: "provide-value",
    valueLabel: "Enter the intended Tailscale sign-in email",
    step: { actor: "owner" },
  }),
  "tailscale-tailnet": step("tailscale-tailnet", facts, {
    kind: "provide-value",
    help: `Find the MagicDNS suffix for your tailnet in ${ADMIN}`,
    step: { actor: "owner" },
  }),
  "tailscale-login": step("tailscale-login", facts, { step: { actor: "machine" } }),
  "tailscale-browser": step("tailscale-browser", facts, {
    kind: "open-url",
    step: { actor: "owner", browser: { expiresAt: new Date(Date.now() + 600_000).toISOString(), pollAfterMs: 2000 } },
  }),
  "tailscale-node": step("tailscale-node", facts, {
    kind: "provide-value",
    step: { actor: "owner", options: [{ value: "node-choice", label: `host-1 (${EMAIL})` }] },
  }),
})

const view = (state: string, nextAction: unknown, revision: number) => ({
  operationId: "op-1",
  revision,
  state,
  resources: [],
  evidence: { known: false },
  scope: { draftId: "draft-1", configurationRevision: "config-1" },
  nextAction,
})

type Call = { url: string; body?: Record<string, any> }
const SEQUENCE = [
  "tailscale-setup",
  "tailscale-account",
  "tailscale-tailnet",
  "tailscale-login",
  "tailscale-browser",
  "tailscale-node",
  "done",
]

// A scripted setup: each approved action moves it on one step; the browser
// step moves on when the owner has signed in.
function fakeTailscale(facts: Facts) {
  const all = actions(facts)
  const state = { at: 0, signedIn: false }
  const current = () => {
    if (SEQUENCE[state.at] === "tailscale-browser" && state.signedIn) state.at++
    const id = SEQUENCE[state.at]!
    if (id === "done") return view("complete", null, state.at + 3)
    return view(id === "tailscale-browser" ? "pending" : "authorization-required", all[id], state.at + 3)
  }
  return { state, current }
}

function transport(
  current: () => unknown,
  calls: Call[],
  advance: (body: Record<string, any>) => void = () => {},
  gate?: () => Promise<void>
): typeof requestReachability {
  return async (url, body) => {
    calls.push({ url, ...(body ? { body: body as Record<string, any> } : {}) })
    if (url === `${path}/handoff`) return { ok: true, data: { href: LINK } }
    if (body) {
      await gate?.()
      advance(body as Record<string, any>)
    }
    return { ok: true, data: current() }
  }
}

// react-dom reads the document once, when it loads. It loads here, after a
// page exists, so that it listens for typing.
async function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
  const { createRoot } = await import("react-dom/client")
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)
  const field = (label: string) =>
    [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))?.querySelector("input,select") as
      | HTMLInputElement
      | undefined
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
  }
  return { dom, container, root, button, field, type }
}

async function render(
  root: ReturnType<(typeof import("react-dom/client"))["createRoot"]>,
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

const posts = (calls: Call[]) => calls.filter(call => call.body && call.url === path)
const approvalOk = (call: Call) =>
  typeof call.body?.approval?.consentFactsDigest === "string" &&
  call.body.approval.digest === `digest-${call.body.actionId}` &&
  call.body.approval.consentFactsDigest === call.body.approval.consentFactsDigest

test("signed out: one card throughout, one click runs the chain and opens the browser once, then the computer needs its own click", async () => {
  opened.length = 0
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const fake = fakeTailscale(sharedFacts)
  try {
    const request = transport(fake.current, calls, body => {
      if (body.actionId === SEQUENCE[fake.state.at]) fake.state.at++
    })
    await render(root, request, { pollTick: 0 })
    const text = () => container.textContent ?? ""
    assert.match(text(), /Needs your action/)
    assert.match(text(), /Sign in to Tailscale to finish\./)
    assert.ok(field("Tailscale email"))
    assert.ok(field("Your tailnet name (ends in .ts.net)"))
    const find = [...container.querySelectorAll("a")].find(node => node.textContent === "Find it in Tailscale")
    assert.ok(find, "the tailnet field says where to find the name")
    assert.equal(find.getAttribute("href"), "https://login.tailscale.com/admin/dns")
    assert.match(text(), /Tailscale shows it under DNS in its admin console\./)
    assert.ok(container.querySelector('[aria-label="What this does"]'), "what the approval does is in the default view")
    assert.deepEqual(bannedIn(text()), [])
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    calls.length = 0
    await act(async () => button("Sign in to Tailscale")!.click())
    assert.deepEqual(
      calls.map(call => `${call.url === path ? "POST" : call.url.endsWith("/handoff") ? "HANDOFF" : "GET"} ${call.body?.actionId ?? ""}`),
      [
        "POST tailscale-setup",
        "POST tailscale-account",
        "POST tailscale-tailnet",
        "POST tailscale-login",
        "HANDOFF tailscale-browser",
      ]
    )
    assert.ok(posts(calls).every(approvalOk))
    assert.equal(posts(calls)[1]!.body!.value, EMAIL)
    assert.equal(posts(calls)[2]!.body!.value, TAILNET)
    assert.deepEqual(opened, [LINK])
    assert.match(text(), /Waiting for you to finish signing in…/)
    assert.equal(container.querySelectorAll("section").length, 1)
    assert.deepEqual(bannedIn(text()), [])
    // The owner signs in; the next poll finds the node step. Nothing is confirmed for them, even with its facts on the card.
    fake.state.signedIn = true
    calls.length = 0
    await render(root, request, { pollTick: 1 })
    assert.deepEqual(
      calls.map(call => `${call.body ? "POST" : "GET"} ${call.body?.actionId ?? ""}`.trim()),
      ["GET"]
    )
    await act(async () => button("Use this computer (host-1)")!.click())
    assert.deepEqual(posts(calls).map(call => call.body!.actionId), ["tailscale-node"])
    assert.equal(posts(calls)[0]!.body!.value, "node-choice")
    assert.ok(approvalOk(posts(calls)[0]!))
    assert.equal(container.textContent, "")
    assert.equal(opened.length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("the node step shows one button when the facts are new, and the button approves with its own digest", async () => {
  opened.length = 0
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const fake = fakeTailscale(id => (id === "tailscale-node" ? "facts-node" : "facts-shared"))
  try {
    const request = transport(fake.current, calls, body => {
      if (body.actionId === SEQUENCE[fake.state.at]) fake.state.at++
    })
    await render(root, request, { pollTick: 0 })
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    await act(async () => button("Sign in to Tailscale")!.click())
    fake.state.signedIn = true
    calls.length = 0
    await render(root, request, { pollTick: 1 })
    assert.deepEqual(posts(calls), [])
    assert.ok(button("Use this computer (host-1)"))
    assert.equal(field("Tailscale email"), undefined)
    await act(async () => button("Use this computer (host-1)")!.click())
    assert.equal(posts(calls).length, 1)
    assert.equal(posts(calls)[0]!.body!.approval.consentFactsDigest, "facts-node")
    assert.equal(container.textContent, "")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("new facts mid-chain stop the chain, show the facts, and nothing is approved unseen", async () => {
  opened.length = 0
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const fake = fakeTailscale(id => (id === "tailscale-tailnet" || id === "tailscale-login" ? `facts-${id}` : "facts-shared"))
  try {
    const request = transport(fake.current, calls, body => {
      if (body.actionId === SEQUENCE[fake.state.at]) fake.state.at++
    })
    await render(root, request)
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    calls.length = 0
    await act(async () => button("Sign in to Tailscale")!.click())
    // The entry check and the email ran; the tailnet step has facts nobody has seen.
    assert.deepEqual(posts(calls).map(call => call.body!.actionId), ["tailscale-setup", "tailscale-account"])
    assert.ok(button("Sign in to Tailscale"))
    assert.match(container.textContent ?? "", /Sign in to Tailscale to finish\./)
    assert.equal(opened.length, 0)
    assert.match(container.querySelector('[aria-label="What this does"]')!.textContent ?? "", /Facts for tailscale-tailnet\./)
    // The owner clicks again with those facts on the card; the login step's facts are new again.
    await act(async () => button("Sign in to Tailscale")!.click())
    assert.deepEqual(posts(calls).map(call => call.body!.actionId), [
      "tailscale-setup",
      "tailscale-account",
      "tailscale-tailnet",
    ])
    assert.equal(calls.filter(call => call.url.endsWith("/handoff")).length, 0)
    assert.ok(posts(calls).every(approvalOk))
    for (const call of posts(calls)) {
      assert.equal(call.body!.approval.consentFactsDigest, call.body!.actionId === "tailscale-tailnet" ? "facts-tailscale-tailnet" : "facts-shared")
    }
    assert.deepEqual(bannedIn(container.textContent ?? ""), [])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

for (const [id, line] of [
  ["tailscale-magicdns", "Turn on MagicDNS for your tailnet."],
  ["tailscale-https", "Turn on HTTPS certificates for your tailnet."],
] as const) {
  test(`administrator step ${id} says what to do in plain words`, async () => {
    opened.length = 0
    const { dom, container, root, button } = await setup()
    const calls: Call[] = []
    const admin = step(id, sharedFacts, {
      kind: "open-url",
      href: ADMIN,
      label: "Enable MagicDNS in the intended tailnet",
      help: "A tailnet administrator can enable MagicDNS. Refresh setup to check the daemon's DNS settings.",
      step: { actor: "administrator" },
    })
    try {
      await render(root, transport(() => view("blocked", admin, 9), calls))
      const text = container.textContent ?? ""
      assert.match(text, /Needs your action/)
      assert.ok(text.includes(line))
      assert.deepEqual(bannedIn(text), [])
      assert.doesNotMatch(text, /daemon|refresh setup|administrator can/i)
      await act(async () => button("Open Tailscale admin")!.click())
      assert.deepEqual(opened, [ADMIN])
      calls.length = 0
      await act(async () => button("Check again")!.click())
      assert.deepEqual(calls.map(call => `${call.body ? "POST" : "GET"} ${call.url.split("?")[0]}`), [`GET ${path}`])
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}

const SECRET = "tok-9f3a1c77-secret-value"
const ngrokReservation = { ...reservation, providerId: "ngrok-https-edge", providerLabel: "ngrok", actionId: "ngrok-setup" }
const tokenAction = step("auth", sharedFacts, {
  kind: "provide-secret",
  label: "Provide your ngrok agent authtoken",
  secretLabel: "ngrok agent authtoken",
  inputId: "auth",
  help: "Use an agent authtoken, not an API key.",
  obtainUrl: "https://dashboard.example.test/get-started/your-authtoken",
  step: { actor: "owner" },
})

test("a pasted account token is in the submit body only: not in the page, the field after saving, or any console output", async () => {
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const logged: string[] = []
  const methods = ["log", "info", "warn", "error", "debug"] as const
  const originals = methods.map(name => console[name])
  methods.forEach(name => {
    console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
  })
  try {
    await render(root, transport(() => view("authorization-required", tokenAction, 4), calls), {
      reservation: ngrokReservation,
    })
    const text = () => container.textContent ?? ""
    assert.match(text(), /Needs your action/)
    assert.match(text(), /Add your ngrok token to finish\./)
    const input = field("ngrok agent authtoken")!
    assert.equal(input.type, "password")
    assert.equal(container.querySelector("a")?.textContent, "Get a token")
    assert.equal(container.querySelector("a")?.getAttribute("href"), "https://dashboard.example.test/get-started/your-authtoken")
    assert.equal((button("Save token") as HTMLButtonElement).disabled, true)
    await type(input, SECRET)
    assert.equal(container.innerHTML.includes(SECRET), false)
    assert.equal((button("Save token") as HTMLButtonElement).disabled, false)
    calls.length = 0
    await act(async () => button("Save token")!.click())
    assert.equal(posts(calls).length, 1)
    assert.equal(posts(calls)[0]!.body!.secret, SECRET)
    assert.equal(posts(calls)[0]!.body!.actionId, "auth")
    assert.ok(approvalOk(posts(calls)[0]!))
    assert.equal(JSON.stringify(calls.map(call => ({ ...call, body: { ...call.body, secret: undefined } }))).includes(SECRET), false)
    assert.equal(container.innerHTML.includes(SECRET), false)
    assert.equal(logged.some(line => line.includes(SECRET)), false)
    assert.deepEqual(bannedIn(text()), [])
  } finally {
    methods.forEach((name, index) => {
      console[name] = originals[index]!
    })
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("another input an account service asks for is a plain labeled field with its own Save", async () => {
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const domain = step("reserved-domain", sharedFacts, {
    kind: "provide-value",
    label: "Provide your assigned development or reserved domain",
    valueLabel: "Assigned development or reserved domain",
    valuePlaceholder: "example.ngrok.app",
    step: { actor: "owner" },
  })
  try {
    await render(root, transport(() => view("authorization-required", domain, 5), calls), { reservation: ngrokReservation })
    const input = field("Assigned development or reserved domain")!
    assert.equal(input.type, "text")
    assert.equal(input.placeholder, "example.ngrok.app")
    await type(input, "mine.example.test")
    calls.length = 0
    await act(async () => button("Save")!.click())
    assert.equal(posts(calls)[0]!.body!.value, "mine.example.test")
    assert.ok(approvalOk(posts(calls)[0]!))
    assert.deepEqual(bannedIn(container.textContent ?? ""), [])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("leaving the way mid-chain sends no further request for it", async () => {
  opened.length = 0
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const fake = fakeTailscale(sharedFacts)
  let onWay = true
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  try {
    const request = transport(
      fake.current,
      calls,
      body => {
        if (body.actionId === SEQUENCE[fake.state.at]) fake.state.at++
      },
      () => gate
    )
    const props = { isCurrentWay: () => onWay }
    await render(root, request, props)
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    calls.length = 0
    let click: Promise<void> = Promise.resolve()
    await act(async () => {
      click = Promise.resolve(button("Sign in to Tailscale")!.click())
    })
    onWay = false
    await act(async () => release())
    await click
    await render(root, request, { ...props, pollTick: 1 })
    await render(root, request, { ...props, pollTick: 2 })
    // Only the request already in flight went out.
    assert.deepEqual(calls.map(call => call.body?.actionId), ["tailscale-setup"])
    assert.deepEqual(opened, [])
    assert.equal(container.textContent, "")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("a node step that comes back with changed facts after the click is not approved, and its facts show", async () => {
  opened.length = 0
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const fake = fakeTailscale(sharedFacts)
  let changed = false
  try {
    const request = transport(
      () => {
        const now = fake.current() as { nextAction: { id: string } | null; revision: number }
        if (changed && now.nextAction?.id === "tailscale-node") {
          return { ...now, revision: now.revision + 1, nextAction: actions(id => `facts-changed-${id}`)["tailscale-node"] }
        }
        return now
      },
      calls,
      body => {
        if (body.actionId === SEQUENCE[fake.state.at] && body.actionId !== "tailscale-node") fake.state.at++
      }
    )
    await render(root, request, { pollTick: 0 })
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    await act(async () => button("Sign in to Tailscale")!.click())
    fake.state.signedIn = true
    changed = true
    calls.length = 0
    await render(root, request, { pollTick: 1 })
    // The node step's facts were never shown: no automatic approval, and the button asks.
    assert.deepEqual(posts(calls), [])
    assert.match(container.querySelector('[aria-label="What this does"]')!.textContent ?? "", /Facts for tailscale-node\./)
    await act(async () => button("Use this computer (host-1)")!.click())
    assert.equal(posts(calls).length, 1)
    assert.equal(posts(calls)[0]!.body!.approval.consentFactsDigest, "facts-changed-tailscale-node")
    // The host answers with the same step and different facts: nothing more is approved unseen.
    assert.equal(posts(calls).length, 1)
    assert.ok(button("Use this computer (host-1)"))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("a response that does not move the setup on stops the chain after one request", async () => {
  const { dom, container, root, button, field, type } = await setup()
  const calls: Call[] = []
  const all = actions(sharedFacts)
  try {
    const request = transport(() => view("authorization-required", all["tailscale-setup"], 3), calls)
    await render(root, request)
    await type(field("Tailscale email")!, EMAIL)
    await type(field("Your tailnet name (ends in .ts.net)")!, TAILNET)
    calls.length = 0
    await act(async () => button("Sign in to Tailscale")!.click())
    assert.equal(posts(calls).length, 1)
    assert.match(container.textContent ?? "", /Try again/)
    assert.deepEqual(bannedIn(container.textContent ?? ""), [])
    assert.ok(button("Sign in to Tailscale"), "the owner can try again")
    assert.equal(container.querySelector("details summary")?.textContent !== undefined, true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

for (const mode of ["server message", "thrown error"] as const) {
  test(`a failed token save never puts the token in the page or the copied details (${mode})`, async () => {
    const { dom, container, root, button, field, type } = await setup()
    const copied: string[] = []
    Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true })
    const calls: Call[] = []
    const request: typeof requestReachability = async (url, body) => {
      calls.push({ url, ...(body ? { body: body as Record<string, any> } : {}) })
      if (!body) return { ok: true, data: view("authorization-required", tokenAction, 4) }
      if (mode === "thrown error") throw new Error(`could not store ${SECRET}`)
      return { ok: false, code: "internal_error", message: `rejected ${SECRET}`, serverMessage: `echo ${SECRET}` } as never
    }
    try {
      await render(root, request, { reservation: ngrokReservation })
      const input = field("ngrok agent authtoken")!
      await type(input, SECRET)
      await act(async () => button("Save token")!.click())
      assert.equal(posts(calls).length, 1)
      assert.equal(input.value, "")
      assert.equal(container.innerHTML.includes(SECRET), false)
      assert.equal((container.textContent ?? "").includes(SECRET), false)
      for (const copy of [...container.querySelectorAll("button")].filter(node => /^Copy diagnostics$/.test(node.textContent ?? ""))) {
        await act(async () => copy.click())
      }
      assert.equal(copied.some(text => text.includes(SECRET)), false)
      assert.match(container.textContent ?? "", /Try again|couldn.t/i)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}

test("a login jump to a known-digest node still requires its own computer click", async () => {
  const { dom, container, root, button } = await setup()
  const calls: Call[] = []
  const all = actions(sharedFacts)
  const node = { ...all["tailscale-node"], step: { actor: "owner", options: [{ value: "other-node", label: "other-host (someone-else@example.test)" }] } }
  let current = view("authorization-required", all["tailscale-login"], 3)
  const request = transport(() => current, calls, body => {
    if (body.actionId === "tailscale-login") current = view("authorization-required", node, 4)
    if (body.actionId === "tailscale-node") current = view("complete", null, 5)
  })
  try {
    await render(root, request)
    await act(async () => button("Sign in to Tailscale")!.click())
    assert.deepEqual(posts(calls).map(call => call.body!.actionId), ["tailscale-login"])
    assert.ok(button("Use this computer (other-host)"))
    assert.deepEqual(bannedIn(container.textContent ?? ""), [])
    await act(async () => button("Use this computer (other-host)")!.click())
    const submitted = posts(calls).filter(call => call.body!.actionId === "tailscale-node")
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.body!.value, "other-node")
    assert.equal(submitted[0]!.body!.approval.consentFactsDigest, node.consent!.consentFactsDigest)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
