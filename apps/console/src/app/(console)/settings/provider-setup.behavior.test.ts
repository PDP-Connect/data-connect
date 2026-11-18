// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { requestReachability } from "./reachability-actions.ts"
import { ProviderSetup } from "./provider-setup.tsx"

test("only completed setup enables route review, including when instructions are visible", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = dom.window.document.querySelector("#root")!
  const root = createRoot(container)
  const reservation = {
    operationId: randomUUID(),
    providerId: randomUUID(),
    draftId: randomUUID(),
    providerLabel: "Workshop",
    actionId: "guidance",
    expectedConfigurationRevision: "config",
    usage: "attached",
  }
  let state = "blocked"
  const request: typeof requestReachability = async () => ({
    ok: true,
    data: {
      operationId: reservation.operationId,
      revision: 1,
      state,
      resources: [],
      scope: { draftId: reservation.draftId, configurationRevision: "config" },
      evidence: { known: false, reason: "verification-pending" },
      nextAction: {
        id: "guidance",
        kind: "instructions",
        label: "Ask the administrator",
        instructions: "Check this exact listener.",
      },
    },
  })
  function Screen() {
    const [ready, setReady] = React.useState(false)
    const onReadiness = React.useCallback(
      (_draftId: string, revision: string | null) =>
        setReady(revision !== null),
      []
    )
    return createElement(
      React.Fragment,
      null,
      createElement(ProviderSetup, {
        reservation,
        request,
        disabled: false,
        acknowledgeDisconnect: false,
        onChange: async () => {},
        onReadiness,
      }),
      createElement("button", { disabled: !ready }, "Commit and review route")
    )
  }
  try {
    await act(async () => root.render(createElement(Screen)))
    const buttons = [...container.querySelectorAll("button")]
    const review = buttons.find(
      button => button.textContent === "Commit and review route"
    )!
    const check = buttons.find(
      button => button.textContent === "Check setup status"
    )!
    for (const pending of ["blocked", "reconciling", "denied", "pending"]) {
      state = pending
      await act(async () => check.click())
      assert.match(container.textContent ?? "", /Check this exact listener/)
      assert.equal(review.disabled, true, pending)
    }
    state = "complete"
    await act(async () => check.click())
    assert.match(container.textContent ?? "", /Check this exact listener/)
    assert.equal(review.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

mock.module(new URL("./reachability-actions.ts", import.meta.url).href, {
  namedExports: {
    requestReachability: async () => {
      throw new Error("Use the test transport")
    },
  },
})

for (const viaPoll of [false, true]) {
  test(`the active draft can commit after ${viaPoll ? "a changed revision observed by polling" : "a resource-only mutation at the same revision"}`, async t => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
    Object.assign(globalThis, {
      React,
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    const container = dom.window.document.querySelector("#root")!
    const root = createRoot(container)
    const reservation = {
      operationId: randomUUID(),
      providerId: randomUUID(),
      draftId: randomUUID(),
      providerLabel: "Workshop",
      actionId: "allocate",
      expectedConfigurationRevision: "config",
      usage: "attached",
    }
    const { RemoteAccessSetting } = await import("./remote-access-setting.tsx")
    const path = `/setup-operations/${reservation.operationId}`
    const draftPath = `/drafts/${reservation.draftId}`
    let rev = "config"
    let state = viaPoll ? "pending" : "authorization-required"
    let cachedRevision: string | null = null
    let commits = 0
    let draftReads = 0
    const request: typeof requestReachability = async (url, body) => {
      if (url === path && body) {
        assert.equal(state, "authorization-required")
        cachedRevision = null
        state = "complete"
      }
      if (url.startsWith(path)) {
        const browser = state === "pending"
        return {
          ok: true,
          data: {
            operationId: reservation.operationId,
            revision: state === "complete" ? 2 : 1,
            state,
            resources: [],
            evidence: { known: false },
            scope: { draftId: reservation.draftId, configurationRevision: rev },
            nextAction:
              state === "complete"
                ? null
                : {
                    id: "allocate",
                    kind: browser ? "open-url" : "gozar-runs",
                    label: "Allocate workshop",
                    disclosure: { revision: "1", text: "Workshop", links: [] },
                    digest: "action-digest",
                    ...(browser && {
                      step: {
                        browser: {
                          expiresAt: new Date(
                            Date.now() + 60_000
                          ).toISOString(),
                          pollAfterMs: 1000,
                        },
                      },
                    }),
                    consent: {
                      facts: [],
                      disclosures: { action: "Allocate workshop" },
                      consentFactsDigest: "facts",
                      scope: {
                        kind: "setup",
                        actionDigest: "action-digest",
                        actionId: "allocate",
                        disclosureRevision: "1",
                      },
                    },
                  },
          },
        }
      }
      if (url.startsWith(`${draftPath}?`)) {
        cachedRevision = rev
        draftReads++
        return {
          ok: true,
          data: {
            draftId: reservation.draftId,
            configuration: {
              revision: rev,
              actions: [],
              inputRequirements: [],
              values: {},
              credentials: {},
            },
          },
        }
      }
      if (url === `${draftPath}/commit`) {
        assert.equal(body?.expectedRevision, rev)
        assert.equal(cachedRevision, rev)
        commits++
        return { ok: true, data: { revision: rev } }
      }
      if (url === `${draftPath}/review`) {
        return {
          ok: false,
          code: "fixture-end",
          message: "Fixture ends after commit",
        }
      }
      const observations: Record<string, unknown> = {
        "/catalog": { providers: [] },
        "/state": {
          routes: [],
          reasons: {},
          starting: false,
          services: [
            {
              providerId: reservation.providerId,
              providerLabel: reservation.providerLabel,
              draftId: reservation.draftId,
              usage: reservation.usage,
              committed: false,
              setup: {
                operationId: reservation.operationId,
                actionId: reservation.actionId,
                expectedConfigurationRevision: reservation.expectedConfigurationRevision,
              },
            },
          ],
        },
        "/host-settings": { known: false, reason: "unavailable" },
        "/host-capabilities": {},
      }
      assert.ok(Object.hasOwn(observations, url), url)
      return { ok: true, data: observations[url] }
    }
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        node => node.textContent === label
      )!
    try {
      if (viaPoll) t.mock.timers.enable({ apis: ["setTimeout"] })
      await act(async () =>
        root.render(createElement(RemoteAccessSetting, { request }))
      )
      assert.equal(button("Save and review").disabled, true)
      assert.equal(draftReads, 1)
      if (viaPoll) {
        rev = "from-other-client"
        state = "complete"
        cachedRevision = null
        await act(async () => t.mock.timers.tick(1000))
      } else {
        const approval = container.querySelector<HTMLInputElement>(
          '[aria-label="Setup approval"] input[type="checkbox"]'
        )!
        await act(async () => approval.click())
        await act(async () => button("Allocate workshop").click())
      }
      assert.equal(draftReads, 2)
      const commit = button("Save and review")
      assert.equal(commit.disabled, false)
      await act(async () => commit.click())
      assert.equal(commits, 1)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}
