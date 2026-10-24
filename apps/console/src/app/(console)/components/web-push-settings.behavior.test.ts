// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior of the summary "Enable this device" button when enabling fails.
 *
 * PR review (P2): the summary button and the setup panel run the same enable
 * flow, but a failure message rendered only inside the setup panel, which starts
 * closed. The owner clicked Enable, nothing visible changed, and nothing was
 * announced. These tests pin that a failed attempt is announced beside the
 * button while the panel is closed, is not repeated while the panel is open, and
 * clears once a later attempt succeeds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { WebPushConfig } from "../lib/ref-client.ts";

const SUBSCRIPTION_ERROR = "Subscription store unavailable.";
const LAST_CHECK_FAILURE = /Last check: Subscription failed: Subscription store unavailable\./;

const CONFIG: WebPushConfig = {
  enabled: true,
  object: "web_push_config",
  public_key: "AQID",
  unavailable_reason: null,
};

function refusedSubscription(): Response {
  return new Response(JSON.stringify({ error: { message: SUBSCRIPTION_ERROR } }), {
    headers: { "Content-Type": "application/json" },
    status: 503,
  });
}

function acceptedSubscription(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

// Per-test answers. Each test sets these before mounting.
const scenario: {
  permissionAnswer: NotificationPermission;
  subscriptionResponse: () => Response;
} = {
  permissionAnswer: "granted",
  subscriptionResponse: refusedSubscription,
};

const pushSubscription = {
  endpoint: "https://push.example.test/subscription-1",
  toJSON: () => ({
    endpoint: "https://push.example.test/subscription-1",
    keys: { auth: "auth", p256dh: "key" },
  }),
};

const registration = {
  pushManager: {
    getSubscription: () => Promise.resolve(null),
    subscribe: () => Promise.resolve(pushSubscription),
  },
  update: () => Promise.resolve(undefined),
};

// Stand-ins for the browser features the component probes. The component checks
// PushManager and Notification on `window`, and calls Notification as a global.
function PushManager() {
  // Constructed by nothing; the component only tests that the name exists.
}

const harness = (async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const { window } = dom;
  function NotificationStub() {
    // Constructed by nothing; the component reads the static members only.
  }
  const notification = Object.assign(NotificationStub, {
    permission: "default" as NotificationPermission,
    requestPermission: () => Promise.resolve(scenario.permissionAnswer),
  });
  Object.assign(globalThis, {
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
    Notification: notification,
    PushManager,
    React,
    document: window.document,
    fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === "/_ref/web-push/subscriptions" && init?.method === "POST") {
        return Promise.resolve(scenario.subscriptionResponse());
      }
      throw new Error(`unexpected request: ${String(input)}`);
    },
    window,
  });
  Object.assign(window, { Notification: notification, PushManager });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: () => Promise.resolve(registration),
      register: () => Promise.resolve(registration),
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  const { WebPushSettings } = await import("./web-push-settings.tsx");
  return { WebPushSettings, window };
})();

// Lets the promise chain in enable() and the Response body read finish inside the
// act scope, so React sees every state update the click causes.
function pause() {
  return new Promise<void>((resolve) => setTimeout(resolve, 25));
}

async function mounted(run: (container: HTMLElement) => void | Promise<void>) {
  const { WebPushSettings, window } = await harness;
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(WebPushSettings, { config: CONFIG, subscriptions: [] }));
      await pause();
    });
    await run(container);
  } finally {
    await act(() => {
      root.unmount();
    });
    container.remove();
  }
}

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  assert.ok(found, `expected button: ${label}`);
  return found;
}

async function press(container: HTMLElement, label: string) {
  const target = buttonNamed(container, label);
  await act(async () => {
    target.click();
    await pause();
  });
}

function alertText(container: HTMLElement): string | null {
  return container.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
}

test("a failed Enable is announced beside the button while the setup panel is closed", async () => {
  scenario.permissionAnswer = "granted";
  scenario.subscriptionResponse = refusedSubscription;
  await mounted(async (container) => {
    await press(container, "Enable this device");
    assert.equal(alertText(container), `Subscription failed: ${SUBSCRIPTION_ERROR}`);
    assert.equal(container.querySelector("#web-push-setup"), null, "the setup panel stays closed");
  });
});

test("with the setup panel open, the failure appears once, in the panel's status line", async () => {
  scenario.permissionAnswer = "granted";
  scenario.subscriptionResponse = refusedSubscription;
  await mounted(async (container) => {
    await press(container, "Enable this device");
    await press(container, "Set up notifications");
    assert.equal(alertText(container), null, "no second notice while the panel is open");
    assert.match(container.textContent ?? "", LAST_CHECK_FAILURE);
  });
});

test("a dismissed permission prompt is announced beside the button", async () => {
  scenario.permissionAnswer = "default";
  scenario.subscriptionResponse = acceptedSubscription;
  await mounted(async (container) => {
    await press(container, "Enable this device");
    assert.equal(alertText(container), "Permission was not granted.");
  });
  scenario.permissionAnswer = "granted";
});

test("a later Enable that succeeds clears the failure notice", async () => {
  scenario.permissionAnswer = "granted";
  scenario.subscriptionResponse = refusedSubscription;
  await mounted(async (container) => {
    await press(container, "Enable this device");
    assert.ok(alertText(container), "the first failure is announced");
    scenario.subscriptionResponse = acceptedSubscription;
    await press(container, "Enable this device");
    assert.equal(alertText(container), null, "a successful attempt leaves no stale failure behind");
  });
  scenario.subscriptionResponse = refusedSubscription;
});

// jsdom has no layout engine, so this checks the classes that decide whether the
// two summary buttons can wrap inside a narrow card. The browser render measures
// the overflow itself.
test("the summary buttons share a row that wraps instead of overflowing the card", async () => {
  await mounted((container) => {
    const row = buttonNamed(container, "Enable this device").parentElement;
    assert.ok(row, "the summary buttons have a container");
    assert.equal(buttonNamed(container, "Set up notifications").parentElement, row, "both buttons share the row");
    assert.ok(row.classList.contains("flex-wrap"), "the row wraps on a narrow card");
    assert.ok(!row.classList.contains("shrink-0"), "the row can shrink to the card instead of keeping full width");
  });
});
