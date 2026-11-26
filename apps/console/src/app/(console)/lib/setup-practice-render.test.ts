// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { test, mock } from "node:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
mock.module("next/navigation", {
  namedExports: {
    useRouter: () => ({ refresh() {} }),
    usePathname: () => "/schedules",
    useSearchParams: () => new URLSearchParams(),
  },
})
mock.module("../schedules/actions.ts", {
  namedExports: {
    upsertScheduleAction: async () => ({ ok: true }),
    pauseScheduleAction: async () => ({ ok: true }),
    resumeScheduleAction: async () => ({ ok: true }),
    deleteScheduleAction: async () => ({ ok: true }),
  },
})
mock.module("../deployment/tokens/actions.ts", {
  namedExports: {
    renameOwnerTokenAction: async () => {},
    revokeOwnerClientTokenAction: async () => {},
    revokeOwnerTokenAction: async () => {},
  },
})
mock.module("../settings/owner-sessions-actions.ts", {
  namedExports: { revokeOwnerBearerAction: async () => ({ ok: true }) },
})
mock.module("../device-exporters/actions.ts", {
  namedExports: { revokeDeviceExporterAction: async () => {}, createEnrollmentCodeAction: async () => ({ ok: null }) },
})
mock.module("../event-subscriptions/disable-action.ts", {
  namedExports: { disableSubscriptionAction: async () => {} },
})
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const banned =
  /\b(?:exporter|heartbeat|stale|bearer|enrollment|revoked|VAPID|jitter|PDPP|Personal Server|keychain|connector|readiness|deployment|origin)\b|PDPP_[A-Z_]+|\/(?:home|tmp|var)\//i
function verify(node: React.ReactNode) {
  const document = new JSDOM(renderToStaticMarkup(node)).window.document
  assert.equal(document.querySelectorAll("details").length, 0)
  assert.doesNotMatch(document.body.textContent || "", banned)
  return document
}
test("every plain setup page practice state renders without folds, raw paths, codes or banned words", async () => {
  const { ScheduleRow } = await import("../schedules/schedule-row.tsx")
  const { buildSchedulePractice } =
    await import("../schedules/schedule-presentation.ts")
  for (const state of ["mixed", "paused", "none"])
    verify(
      React.createElement(
        "ul",
        null,
        buildSchedulePractice(state)!.map(summary =>
          React.createElement(ScheduleRow, {
            key: summary.connection_id,
            summary,
            runsHref: "/syncs",
            presentation: "plain",
            practice: true,
          })
        )
      )
    )
  const { WebPushSettings } =
    await import("../components/web-push-settings.tsx")
  for (const practice of [
    "off",
    "on",
    "blocked",
    "unsupported",
    "insecure",
    "devices",
  ])
    verify(
      React.createElement(WebPushSettings, {
        practice,
        config: {
          object: "web_push_config",
          public_key: "practice",
          enabled: true,
          unavailable_reason: null,
        },
        subscriptions: [],
      })
    )
  const { ServerChecksView } = await import("../deployment/server-checks.tsx")
  const { buildServerPractice, plainServerChecks } =
    await import("../deployment/plain-checks.ts")
  for (const state of [
    "fine",
    "search-off",
    "attention",
    "blocked",
    "checking",
  ]) {
    const model = buildServerPractice(state)!
    verify(
      React.createElement(ServerChecksView, {
        rows: plainServerChecks(model.inputs, model.address, model.probe),
      })
    )
  }
  const { PlainTokenList } =
    await import("../deployment/tokens/plain-token-list.tsx")
  const { buildTokenPractice, tokenGroups } =
    await import("../deployment/tokens/token-model.ts")
  for (const state of ["none", "scripts", "created"]) {
    const model = buildTokenPractice(state)!
    verify(
      React.createElement(PlainTokenList, {
        groups: tokenGroups(model.clients, model.details, model.owners),
        practice: true,
      })
    )
  }
  const { CollectorList } =
    await import("../device-exporters/collector-list.tsx")
  const { buildCollectorPractice } =
    await import("../device-exporters/collector-model.ts")
  for (const state of ["none", "real"]) {
    const doc = verify(
      React.createElement(CollectorList, {
        devices: buildCollectorPractice(state)!,
        practice: true,
      })
    )
    if (state === "real") assert.equal(doc.querySelectorAll("li").length, 14)
  }
  const { WebhookList } =
    await import("../event-subscriptions/webhook-view.tsx")
  const { buildWebhookPractice } =
    await import("../event-subscriptions/webhook-model.ts")
  for (const state of ["none", "states"])
    verify(
      React.createElement(WebhookList, {
        rows: buildWebhookPractice(state)!,
        names: {},
        practice: true,
      })
    )
})
