// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import type { requestReachability } from "./reachability-client.ts"

// react-dom decides whether the page can fire input events when it loads, so a window must exist first.
const boot = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
Object.assign(globalThis, { window: boot.window, document: boot.window.document })

mock.module(new URL("./reachability-client.ts", import.meta.url).href, {
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

type Reply = Awaited<ReturnType<typeof requestReachability>>

async function mount(
  nextAction: unknown,
  options: { state?: string; reply?: (url: string, body?: Record<string, unknown>) => Promise<Reply> | undefined } = {}
) {
  const React = await import("react")
  const { act, createElement } = React
  const { createRoot } = await import("react-dom/client")
  const { ProviderSetup } = await import("./provider-setup.tsx")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
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
  const request: typeof requestReachability = async (url, body) => {
    if (body) sent.push(body as Sent)
    const custom = options.reply?.(url, body as Record<string, unknown> | undefined)
    if (custom) return custom
    return {
      ok: true,
      data: {
        operationId: "op-1",
        revision: 1,
        state: options.state ?? "authorization-required",
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
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
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
    const turnText = container.textContent ?? ""
    // The leftover sentence sits in the card's Details, one click away.
    assert.ok(turnText.includes("Your address is listed in a public directory."))
    // Codes stay inside Details: nothing outside the collapsed Details shows them.
    const outsideDetails = (() => {
      const copy = container.cloneNode(true) as Element
      for (const details of copy.querySelectorAll("details")) details.remove()
      return copy.textContent ?? ""
    })()
    assert.equal(outsideDetails.includes(DIGEST), false)
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
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
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
  const { typedRouteDisclosures } = await import("./real-gozar-shapes.fixture.ts")
  const step = action("run-it") as never as Record<string, any>
  step.consent.disclosures = { retentionDays: 30, recurring: true }
  const cases = [
    { name: "a step", props: { review: review(readableRoute), steps: [step] } },
    { name: "the route", props: { review: review({ ...readableRoute, retentionDays: 30, recurring: true }), steps: [] } },
    { name: "a route list", props: { review: review([{ retentionDays: 30, recurring: true }]), steps: [] } },
    { name: "a worded field", props: { review: review({ ...readableRoute, cost: { kind: "free", retentionDays: 30, recurring: true } }), steps: [] } },
  ]
  try {
    for (const { name, props } of cases) {
      await act(async () => root.render(createElement(TurnOnCard, { ...props, busy: false, changed: null, onTurnOn: () => {} } as never)))
      const details = container.querySelector("details")!
      const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Turn on remote access")!
      assert.equal(details.hasAttribute("open"), true, `${name}: Details starts open`)
      // Details sits below the button, as in the approved mockups, and opens on its own.
      assert.ok(button.compareDocumentPosition(details) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, `${name}: Details comes after the button`)
      const text = shownText(container)
      assert.match(text, /Retention days/, `${name}: the raw key shows`)
      assert.match(text, /30/, `${name}: the raw value shows`)
      assert.match(text, /Recurring/, `${name}: the second raw key shows`)
    }
    // Readable leftovers show as the short lines above the button; unreadable ones
    // open Details below it. Either way the card shows them. A free cost that also
    // carries price fields is a contradiction, so Details opens for it too.
    for (const { disclosures, values, open } of [
      { disclosures: { ...readableRoute, cost: { kind: "free", amount: 12, currency: "USD", period: "month" } }, values: [/12/, /USD/, /month/], open: true },
      { disclosures: { ...readableRoute, address: { stability: "rotating" } }, values: [/Stability/, /rotating/], open: true },
      { disclosures: { ...readableRoute, cost: { kind: "paid", amount: 12, currency: "USD" } }, values: [/12/, /USD/, /price is in Details/], open: true },
      { disclosures: { ...readableRoute, traffic: { providerCanReadPayload: "yes" } }, values: [/yes/i], open: true },
    ]) {
      await act(async () => root.render(createElement(TurnOnCard, { review: review(disclosures), busy: false, changed: null, onTurnOn: () => {} } as never)))
      const details = container.querySelector("details")!
      const label = JSON.stringify(disclosures)
      assert.equal(details.hasAttribute("open"), open, `${label}: Details opens exactly when something is unreadable`)
      for (const value of values) assert.match(shownText(container), value, `${label}: the leftover value shows on the card`)
    }
    await act(async () => root.render(createElement(TurnOnCard, { review: review(readableRoute), busy: false, changed: null, onTurnOn: () => {} } as never)))
    assert.equal(container.querySelector("details")!.hasAttribute("open"), false)
    const typedCases = [
      { name: "complete typed route", disclosures: typedRouteDisclosures, open: false,
        // One line per kind above the button, in the approved order.
        words: [
          /People who open the address must sign in with your password\. Apps also need your permission\./,
          /Workshop can see what passes through\./,
          /Free\. The address stays the same and stays on while DataConnect runs\./,
        ],
        // Every other classified line moved into Details, one click below the button.
        detailsWords: [
          /People can reach the sign-in page over the internet\./,
          /The secure connection ends at the service, not at your device\./,
          /These can read your traffic: route-service\./,
          /These can see when and how much you connect: route-service, connection-operator\./,
        ],
        // The cost summary is a leftover sentence: it lives in Details, one click away.
        cardWords: [/There is no charge/] },
      { name: "unencrypted transport", disclosures: { ...typedRouteDisclosures, transport: "http" }, open: false,
        words: [/Workshop can see what passes through\./],
        detailsWords: [/unencrypted HTTP/], cardWords: [] as RegExp[] },
      { name: "unrecognized reach", disclosures: { ...readableRoute, reach: "regional" }, open: true,
        words: [] as RegExp[], detailsWords: [] as RegExp[], cardWords: [/regional/] },
    ]
    for (const { name, disclosures, open, words, detailsWords, cardWords } of typedCases) {
      await act(async () => root.render(createElement(TurnOnCard, { review: review(disclosures), busy: false, changed: null, onTurnOn: () => {} } as never)))
      const details = container.querySelector("details")!
      const button = container.querySelector("button")!
      assert.equal(details.hasAttribute("open"), open, name)
      const range = dom.window.document.createRange()
      range.setStart(container.querySelector("section")!, 0)
      range.setEndBefore(button)
      const before = range.toString()
      // One line per kind stays above the button, where the approval is read.
      for (const word of words) assert.match(before, word, name)
      // The lines the short set replaced sit inside Details, still on the card.
      for (const word of detailsWords) assert.match(details.textContent ?? "", word, name)
      for (const word of cardWords) assert.match(container.textContent ?? "", word, name)
      // Reader names are approved values and show above the button; the evidence reference is metadata.
      if (!open) assert.doesNotMatch(before, /route-evidence/, name)
    }
    // Gozar reports "unknown" stability for routes it did not create; the card says so in words.
    await act(async () => root.render(createElement(TurnOnCard, { review: review({ ...readableRoute, address: { stability: "unknown" } }), busy: false, changed: null, onTurnOn: () => {} } as never)))
    assert.match(shownText(container), /We can't tell whether the address stays the same and stays on while DataConnect runs\./)
    assert.equal(container.querySelector("details")!.hasAttribute("open"), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

// ---------- a blank optional input is omitted; only required inputs gate the button ----------

const press = (container: Element, label: string) => {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === label)
  assert.ok(button, `no button ${label}`)
  return button
}

test("the setup input card enables Save for an input the action marks optional, and sends nothing for a blank one", async () => {
  for (const [kind, label, field] of [["provide-value", "Save", "value"], ["provide-secret", "Save token", "secret"]] as const) {
    const optional = await mount(action(kind, { required: false, valueLabel: "Account name", secretLabel: "Token" }))
    try {
      assert.equal(press(optional.container, label).disabled, false, `${kind}: optional blank input can be saved`)
      await optional.act(async () => press(optional.container, label).click())
      const command = optional.sent.find(body => body.approval)!
      assert.equal(field in command, false, `${kind}: a blank optional input is omitted, not sent as an empty string`)
    } finally {
      await optional.close()
    }
    const required = await mount(action(kind, { valueLabel: "Account name", secretLabel: "Token" }))
    try {
      assert.equal(press(required.container, label).disabled, true, `${kind}: no flag means required`)
    } finally {
      await required.close()
    }
  }
})

test("the approval card for an input step enables its button for an optional input and omits the blank one", async () => {
  const { act, container, sent, close } = await mount(action("provide-value", { required: false, valueLabel: "Account name" }), { state: "blocked" })
  try {
    assert.equal(container.querySelector('input[type="text"]') !== null, true, "the generic approval card is on screen")
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Setup approval"] input[type="checkbox"]')!.click())
    assert.equal(press(container, "Authorize the setup").disabled, false)
    await act(async () => press(container, "Authorize the setup").click())
    assert.equal("value" in sent.find(body => body.approval)!, false)
  } finally {
    await close()
  }
  const required = await mount(action("provide-value", { valueLabel: "Account name" }), { state: "blocked" })
  try {
    await required.act(async () => required.container.querySelector<HTMLInputElement>('[aria-label="Setup approval"] input[type="checkbox"]')!.click())
    assert.equal(press(required.container, "Authorize the setup").disabled, true)
  } finally {
    await required.close()
  }
})

// ---------- a typed secret is held by its field, not by React state ----------

function propsOf(node: Element) {
  const key = Object.keys(node).find(name => name.startsWith("__reactProps$"))
  return (key ? (node as unknown as Record<string, Record<string, unknown>>)[key] : {}) ?? {}
}

test("the approval card keeps a typed secret out of React state, and clears it on submit, cancel and unmount", async () => {
  // Submit
  const submit = await mount(action("provide-secret", { secretLabel: "Scoped API token" }), { state: "blocked" })
  try {
    const input = submit.container.querySelector<HTMLInputElement>('input[type="password"]')!
    assert.equal("value" in propsOf(input), false, "the field is uncontrolled: no value prop mirrors the secret")
    await submit.act(async () => type(submit.container, input, "secret-value"))
    assert.equal(propsOf(input).value, undefined, "typing does not put the secret into a prop")
    await submit.act(async () => submit.container.querySelector<HTMLInputElement>('[aria-label="Setup approval"] input[type="checkbox"]')!.click())
    await submit.act(async () => press(submit.container, "Authorize the setup").click())
    assert.equal(submit.sent.find(body => "secret" in body)!.secret, "secret-value")
    assert.equal(input.value, "", "submit clears the field")
  } finally {
    await submit.close()
  }
  // Cancel: the request is held open, so the card is still on screen while the cancel runs.
  const never = new Promise<Reply>(() => {})
  const cancel = await mount(action("provide-secret", { secretLabel: "Scoped API token" }), {
    state: "blocked",
    reply: url => (url.endsWith("/cancel") ? never : undefined),
  })
  try {
    const input = cancel.container.querySelector<HTMLInputElement>('input[type="password"]')!
    await cancel.act(async () => type(cancel.container, input, "half-typed"))
    await cancel.act(async () => press(cancel.container, "Cancel setup").click())
    const left = cancel.container.querySelector<HTMLInputElement>('input[type="password"]')
    assert.equal(left?.value ?? "", "", "Cancel setup leaves no typed secret in a field")
    assert.equal(input.value, "", "the field that held it is cleared")
  } finally {
    await cancel.close()
  }
  // Unmount
  const gone = await mount(action("provide-secret", { secretLabel: "Scoped API token" }), { state: "blocked" })
  const input = gone.container.querySelector<HTMLInputElement>('input[type="password"]')!
  await gone.act(async () => type(gone.container, input, "left-behind"))
  await gone.close()
  assert.equal(input.value, "", "unmounting clears the field")
})

// ---------- the allow and turn-on cards: optional input, and one click is one send ----------

async function renderCard(element: (React: typeof import("react")) => unknown) {
  const React = await import("react")
  const { act } = React
  const { createRoot } = await import("react-dom/client")
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  await act(async () => root.render(element(React) as never))
  return { act, container, dom, close: async () => { await act(async () => root.unmount()); dom.window.close() } }
}

test("the allow card gates Allow on required inputs only, and sends nothing for a blank optional one", async () => {
  const { AllowCard } = await import("./turn-on.tsx")
  const step = action("run-it", { effects: { writes: [], networkOrigins: [], requiresPrivilege: false, restartRequired: false } }) as never as Record<string, any>
  const field = (required: boolean) => ({ actionId: "next-step", id: "name", label: "Account name", secret: false, help: "", kind: "text", required, obtainUrl: null })
  for (const required of [false, true]) {
    const given: unknown[] = []
    const card = await renderCard(({ createElement }) =>
      createElement(AllowCard, { action: step as never, draft: { configuration: { inputRequirements: [field(required)] } } as never, busy: false, onAllow: (_a: unknown, input: unknown) => given.push(input), onOther: () => {} })
    )
    try {
      assert.equal(press(card.container, "Allow").disabled, required, `required=${required}`)
      if (!required) {
        await card.act(async () => press(card.container, "Allow").click())
        assert.deepEqual(given, [{}], "a blank optional input is omitted")
      }
    } finally {
      await card.close()
    }
  }
})

test("two fast clicks on Allow or Turn on remote access call the handler once", async () => {
  const { AllowCard, TurnOnCard } = await import("./turn-on.tsx")
  const step = action("run-it", { effects: { writes: [], networkOrigins: [], requiresPrivilege: false, restartRequired: false } }) as never as Record<string, any>
  step.consent.disclosures = { action: { id: "next-step", digest: DIGEST }, disclosures: ["This step is free"] }
  let allows = 0
  let release!: () => void
  const slow = () => new Promise<void>(resolve => { release = resolve })
  const allow = await renderCard(({ createElement }) =>
    createElement(AllowCard, { action: step as never, draft: { configuration: { inputRequirements: [] } } as never, busy: false, onAllow: () => { allows += 1; return slow() }, onOther: () => {} })
  )
  try {
    const button = press(allow.container, "Allow")
    await allow.act(async () => { button.click(); button.click() })
    assert.equal(allows, 1)
    await allow.act(async () => release())
    await allow.act(async () => press(allow.container, "Allow").click())
    assert.equal(allows, 2, "once the first send settles, the next click is accepted")
    await allow.act(async () => release())
  } finally {
    await allow.close()
  }
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
        disclosures: { traffic: { providerCanReadPayload: false }, cost: { kind: "free" }, address: { stability: "stable" }, disclosures: [], digest: DIGEST },
      },
    },
  }
  let turns = 0
  const turn = await renderCard(({ createElement }) =>
    createElement(TurnOnCard, { review: review as never, busy: false, changed: null, onTurnOn: () => { turns += 1; return slow() } })
  )
  try {
    const button = press(turn.container, "Turn on remote access")
    await turn.act(async () => { button.click(); button.click() })
    assert.equal(turns, 1)
    await turn.act(async () => release())
  } finally {
    await turn.close()
  }
})
