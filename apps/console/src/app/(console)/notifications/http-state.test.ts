// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { WebPushSettings } from "../components/web-push-settings.tsx"
test("http wins over denied permission and missing push APIs", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://home.example.test/notifications",
  })
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    Notification: { permission: "denied" },
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(dom.window, "Notification", {
    value: { permission: "denied" },
  })
  Object.defineProperty(dom.window, "isSecureContext", { value: false })
  const root = createRoot(dom.window.document.getElementById("root")!)
  try {
    await act(async () =>
      root.render(
        React.createElement(WebPushSettings, {
          plain: true,
          config: {
            object: "web_push_config",
            enabled: true,
            public_key: "practice",
            unavailable_reason: null,
          },
          subscriptions: [],
        })
      )
    )
    assert.match(
      dom.window.document.body.textContent!,
      /Notifications need a secure address/
    )
    assert.doesNotMatch(
      dom.window.document.body.textContent!,
      /Set Notifications to Allow|blocking notifications/
    )
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
