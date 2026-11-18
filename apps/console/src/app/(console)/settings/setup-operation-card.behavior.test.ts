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

/** The page text a person sees without opening any disclosure: closed Details are removed, open ones stay. */
function shownText(container: Element) {
  const copy = container.cloneNode(true) as Element
  for (const closed of copy.querySelectorAll("details:not([open])")) closed.remove()
  return copy.textContent ?? ""
}

function withDisclosures(kind: string, disclosures: unknown) {
  const next = action(kind)
  return { ...next, consent: { ...next.consent, disclosures } }
}

const approvalFields = { digest: DIGEST, disclosureRevision: REVISION, consentFactsDigest: "consent-v1:abc" }

function pickFields(approval: Record<string, unknown> | undefined) {
  return {
    digest: approval?.digest,
    disclosureRevision: approval?.disclosureRevision,
    consentFactsDigest: approval?.consentFactsDigest,
  }
}

test("a token card shows the disclosure sentence and the cost before Save token, and no digest", async () => {
  const { act, container, sent, close } = await mount(action("provide-secret", { secretLabel: "Scoped API token" }))
  try {
    const text = shownText(container)
    assert.match(text, /This sets up the service for you\./)
    assert.match(text, /Cost/)
    assert.match(text, /Free/)
    assert.equal(text.includes(DIGEST), false)
    assert.equal(text.includes(REVISION), false)
    assert.equal(text.includes("consent-v1:abc"), false)
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => type(container, input, "secret-value"))
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Save token")!.click())
    assert.deepEqual(pickFields(sent.find(body => "secret" in body)!.approval), approvalFields)
  } finally {
    await close()
  }
})

test("a setup approval shows a top-level disclosures string and an object-valued address condition", async () => {
  const sentence = "This action creates a recurring paid subscription"
  const condition = "The address changes after every restart"
  const { act, container, sent, close } = await mount(
    withDisclosures("gozar-runs", {
      disclosures: [sentence],
      address: { conditions: [{ detail: condition, kind: "ephemeral", digest: DIGEST }] },
      evidence: { revision: REVISION, observedAt: "2026-11-18T10:00:00Z", href: "https://example.test/terms" },
    })
  )
  try {
    const text = shownText(container)
    assert.ok(text.includes(`${sentence}.`), "the top-level disclosures string shows")
    assert.ok(text.includes(`${condition}.`), "the object-valued condition shows")
    assert.equal(text.includes(DIGEST), false, "a digest stays out of the default view")
    assert.equal(text.includes(REVISION), false)
    assert.equal(text.includes("example.test"), false)
    assert.equal(text.includes("2026-11-18"), false)
    assert.equal(container.querySelector("details")!.hasAttribute("open"), false, "a readable disclosure leaves Details closed")
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Setup approval"] input[type="checkbox"]')!.click())
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Authorize the setup")!.click())
    assert.deepEqual(pickFields(sent.find(body => body.approval)!.approval), approvalFields)
  } finally {
    await close()
  }
})

test("a disclosure of an unknown shape opens Details on the setup approval and on the token card", async () => {
  const unknown = { retentionDays: 30, recurring: true }
  for (const kind of ["gozar-runs", "provide-secret"]) {
    const { container, close } = await mount(withDisclosures(kind, unknown))
    try {
      assert.equal(container.querySelector("details")!.hasAttribute("open"), true, `${kind}: Details starts open`)
      assert.match(shownText(container), /Retention days/)
    } finally {
      await close()
    }
  }
})

test("the allow card and the turn-on card show every disclosure string and still send the same approval", async () => {
  const React = await import("react")
  const { act, createElement } = React
  const { createRoot } = await import("react-dom/client")
  const { AllowCard, TurnOnCard } = await import("./turn-on.tsx")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  try {
    const step = action("run-it", { effects: { writes: [], networkOrigins: [], requiresPrivilege: false, restartRequired: false } }) as never as Record<string, any>
    step.consent.disclosures = { action: { id: "next-step", digest: DIGEST }, disclosures: ["This step bills your card every month"] }
    const allowed: unknown[] = []
    await act(async () =>
      root.render(
        createElement(AllowCard, {
          action: step as never,
          draft: { configuration: { inputRequirements: [] } } as never,
          busy: false,
          onAllow: (given: unknown) => allowed.push(given),
          onOther: () => {},
        })
      )
    )
    const allowText = shownText(container)
    assert.ok(allowText.includes("This step bills your card every month."))
    assert.match(allowText, /Cost/)
    assert.equal(allowText.includes(DIGEST), false)
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Allow")!.click())
    const given = allowed[0] as typeof step
    assert.deepEqual(
      { digest: given.digest, disclosureRevision: given.disclosure.revision, consentFactsDigest: given.consent.consentFactsDigest },
      approvalFields
    )

    const review = {
      id: "review-1",
      kind: "route",
      candidate: {
        providerId: "workshop",
        display: { label: "Workshop" },
        consentFactsDigest: "consent-v1:route",
        consent: {
          consentFactsDigest: "consent-v1:route",
          facts: [],
          scope: { kind: "route", providerId: "workshop", query: { target: "http://localhost:3000", usage: { kind: "attached" } } },
          disclosures: {
            traffic: { providerCanReadPayload: false },
            cost: { kind: "free" },
            address: { stability: "stable" },
            disclosures: ["Your address is listed in a public directory"],
            digest: DIGEST,
          },
        },
      },
    }
    const turned: unknown[] = []
    await act(async () =>
      root.render(createElement(TurnOnCard, { review: review as never, busy: false, changed: null, onTurnOn: (given: unknown) => turned.push(given) }))
    )
    const turnText = shownText(container)
    assert.ok(turnText.includes("Your address is listed in a public directory."))
    assert.equal(turnText.includes(DIGEST), false)
    assert.equal(container.querySelector("details")!.hasAttribute("open"), false)
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Turn on remote access")!.click())
    const sentReview = turned[0] as typeof review
    assert.equal(sentReview.id, "review-1")
    assert.equal(sentReview.candidate.consentFactsDigest, "consent-v1:route")
    assert.equal(sentReview.candidate.consent.consentFactsDigest, "consent-v1:route")
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test("the turn-on card shows unreadable route and step disclosures, open, above its button", async () => {
  const React = await import("react")
  const { act, createElement } = React
  const { createRoot } = await import("react-dom/client")
  const { TurnOnCard } = await import("./turn-on.tsx")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const routeConsent = (disclosures: unknown) => ({
    consentFactsDigest: "consent-v1:route",
    facts: [],
    scope: { kind: "route", providerId: "workshop", query: { target: "http://localhost:3000", usage: { kind: "attached" } } },
    disclosures,
  })
  const review = (disclosures: unknown) => ({
    id: "review-1",
    kind: "route",
    candidate: { providerId: "workshop", display: { label: "Workshop" }, consentFactsDigest: "consent-v1:route", consent: routeConsent(disclosures) },
  })
  const readableRoute = { traffic: { providerCanReadPayload: false }, cost: { kind: "free" }, address: { stability: "stable" } }
  const step = action("run-it") as never as Record<string, any>
  step.consent.disclosures = { retentionDays: 30, recurring: true }
  const cases = [
    { name: "a step", props: { review: review(readableRoute), steps: [step] } },
    { name: "the route", props: { review: review({ ...readableRoute, retentionDays: 30, recurring: true }), steps: [] } },
  ]
  try {
    for (const { name, props } of cases) {
      await act(async () => root.render(createElement(TurnOnCard, { ...props, busy: false, changed: null, onTurnOn: () => {} } as never)))
      const details = container.querySelector("details")!
      const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Turn on remote access")!
      assert.equal(details.hasAttribute("open"), true, `${name}: Details starts open`)
      assert.ok(details.compareDocumentPosition(button) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, `${name}: Details comes before the button`)
      const text = shownText(container)
      assert.match(text, /Retention days/, `${name}: the raw key shows`)
      assert.match(text, /30/, `${name}: the raw value shows`)
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
