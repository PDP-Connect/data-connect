// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import type { requestReachability } from "./reachability-actions.ts"

// react-dom decides whether the page can fire input events when it loads, so a window must exist first.
const boot = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
Object.assign(globalThis, { window: boot.window, document: boot.window.document })

mock.module(new URL("./reachability-actions.ts", import.meta.url).href, {
  namedExports: {
    requestReachability: async () => {
      throw new Error("Use the test transport")
    },
  },
})
type Sent = { secret?: string; actionId?: string; approval?: { digest: string; disclosureRevision: string; consentFactsDigest: string } }

const DIGEST = "71498c0538f166717168ec2400387126de3598ee826910bd01639bb213ac5441"
const REVISION = "disc-1feeeecb3810"

// An active setup operation shaped like the host's: the next action carries its own
// consent, and the disclosures nest the action itself (digest, revision, kind).
function action(kind: string, extra: Record<string, unknown> = {}) {
  const disclosure = { revision: REVISION, text: "This sets up the service for you.", links: [] }
  return {
    id: "next-step",
    kind,
    label: "Authorize the setup",
    digest: DIGEST,
    instructions: "Create a token and paste it into the private field.",
    disclosure,
    ...extra,
    consent: {
      consentFactsDigest: "consent-v1:abc",
      facts: [
        { id: "cost", group: "cost", label: "Cost", known: true, value: "Free", reason: null, source: "the service", asOf: null, affectsConsent: true },
      ],
      disclosures: { action: { id: "next-step", kind, digest: DIGEST, disclosure } },
      scope: { kind: "setup", actionId: "next-step", actionDigest: DIGEST, disclosureRevision: REVISION, providerId: "workshop" },
    },
  }
}

async function mount(nextAction: unknown) {
  const React = await import("react")
  const { act, createElement } = React
  const { createRoot } = await import("react-dom/client")
  const { ProviderSetup } = await import("./provider-setup.tsx")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const sent: Sent[] = []
  const reservation = {
    operationId: "op-1",
    providerId: "workshop",
    draftId: "draft-1",
    providerLabel: "Workshop",
    actionId: "next-step",
    expectedConfigurationRevision: "config",
    usage: "attached",
  }
  const request: typeof requestReachability = async (_url, body) => {
    if (body) sent.push(body as Sent)
    return {
      ok: true,
      data: {
        operationId: "op-1",
        revision: 1,
        state: "authorization-required",
        resources: [],
        scope: { draftId: "draft-1", configurationRevision: "config", providerId: "workshop" },
        evidence: { known: false, reason: "verification-pending" },
        nextAction,
      },
    }
  }
  await act(async () =>
    root.render(
      createElement(ProviderSetup, {
        reservation,
        request,
        disabled: false,
        acknowledgeDisconnect: false,
        onChange: async () => {},
        onReadiness: () => {},
      })
    )
  )
  return { act, container, sent, close: async () => { await act(async () => root.unmount()); dom.window.close() } }
}

/** The page text a person sees without opening any disclosure. */
function visibleText(container: Element) {
  const copy = container.cloneNode(true) as Element
  for (const closed of copy.querySelectorAll("details")) closed.remove()
  return copy.textContent ?? ""
}

function type(container: Element, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(container.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new (container.ownerDocument.defaultView!.Event)("input", { bubbles: true }))
}

test("a secret input shows a border and a placeholder, and the save sends the action's own digest", async () => {
  const { act, container, sent, close } = await mount(action("provide-secret", { secretLabel: "Scoped API token" }))
  try {
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    assert.match(input.className, /\bborder\b/)
    assert.match(input.className, /\bborder-border\b/)
    assert.notEqual(input.getAttribute("placeholder"), null)
    assert.notEqual(input.getAttribute("placeholder"), "")
    assert.equal(visibleText(container).includes(DIGEST), false, "no digest in the default view")
    await act(async () => type(container, input, "secret-value"))
    const save = [...container.querySelectorAll("button")].find(b => b.textContent === "Save token")!
    await act(async () => save.click())
    const command = sent.find(body => "secret" in body)!
    assert.equal(command.secret, "secret-value")
    assert.equal(command.approval!.digest, DIGEST)
    assert.equal(command.approval!.disclosureRevision, REVISION)
    assert.equal(command.actionId, "next-step")
  } finally {
    await close()
  }
})

test("an approval card lists sentences and facts, keeps the raw descriptor in Details, and approves the same digest", async () => {
  const { act, container, sent, close } = await mount(action("gozar-runs"))
  try {
    const text = visibleText(container)
    assert.match(text, /This sets up the service for you\./)
    assert.match(text, /Cost/)
    assert.equal(text.includes(DIGEST), false, "no digest in the default view")
    assert.equal(text.includes(REVISION), false, "no revision in the default view")
    const details = container.querySelector("details")!
    assert.match(details.querySelector("summary")!.textContent ?? "", /^Details$/)
    assert.equal(details.hasAttribute("open"), false)
    assert.ok((details.textContent ?? "").includes(DIGEST), "the full descriptor is still readable in Details")
    const box = container.querySelector<HTMLInputElement>('[aria-label="Setup approval"] input[type="checkbox"]')!
    await act(async () => box.click())
    const approve = [...container.querySelectorAll("button")].find(b => b.textContent === "Authorize the setup")!
    await act(async () => approve.click())
    const command = sent.find(body => body.approval)!
    assert.equal(command.approval!.digest, DIGEST)
    assert.equal(command.approval!.consentFactsDigest, "consent-v1:abc")
  } finally {
    await close()
  }
})
