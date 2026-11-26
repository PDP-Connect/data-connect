import assert from "node:assert/strict"
import { test } from "node:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { WebPushSettings } from "../components/web-push-settings.tsx"
;(globalThis as typeof globalThis & { React: typeof React }).React = React
for (const practice of [
  "off",
  "on",
  "blocked",
  "unsupported",
  "insecure",
  "devices",
]) {
  test(`notifications practice ${practice} renders without technical copy`, () => {
    const html = renderToStaticMarkup(
      React.createElement(WebPushSettings, {
        config: {
          object: "web_push_config",
          unavailable_reason: null,
          enabled: true,
          public_key: "practice-key",
        },
        subscriptions: [],
        practice,
      })
    )
    const document = new JSDOM(html).window.document
    assert.equal(document.querySelectorAll("details").length, 0)
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /VAPID|PDPP|owner|connector|heartbeat|environment/
    )
    if (practice === "on")
      assert.match(document.body.textContent!, /Send a test/)
    if (practice === "blocked")
      assert.match(document.body.textContent!, /Check again/)
  })
}
