// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for why Web Push is unavailable on this device.
 *
 * Walkthrough item A8: the desktop app showed one headline, "This browser
 * cannot receive DataConnect notifications.", for six different causes,
 * including a server with no VAPID keys. These tests pin one cause per
 * condition, and an owner-facing title and next step for each.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  describeWebPushUnavailable,
  type WebPushCapabilities,
  type WebPushUnavailableCause,
  webPushUnavailableCause,
} from "./web-push-availability.ts";

const ALL_CAUSES: readonly WebPushUnavailableCause[] = [
  "insecure-context",
  "no-service-worker",
  "no-push-api",
  "no-notification-api",
  "server-not-configured",
  "permission-denied",
];

const DEVICE_CAUSES: readonly WebPushUnavailableCause[] = ["no-service-worker", "no-push-api", "no-notification-api"];

const CAPABLE_DEVICE: WebPushCapabilities = {
  hasNotificationApi: true,
  hasPushManager: true,
  hasServiceWorker: true,
  isSecureContext: true,
  permission: "default",
  serverEnabled: true,
};

const HTTPS_PATTERN = /HTTPS/;
const LOCALHOST_PATTERN = /localhost/;
const THIS_BROWSER_TITLE_PATTERN = /^This browser /;
const ON_THIS_COMPUTER_PATTERN = /on this computer/;
const PHONE_PATTERN = /phone/;
const VAPID_KEYS_PATTERN = /VAPID keys/;
const RESTART_PATTERN = /restart/;
const BROWSER_PATTERN = /browser/i;
const ALLOW_NOTIFICATIONS_PATTERN = /Allow notifications/;
const RELOAD_PATTERN = /reload this page/;
const MOBILE_PATTERN = /mobile/i;

test("a device that meets every precondition has no unavailable cause", () => {
  assert.equal(webPushUnavailableCause(CAPABLE_DEVICE), null);
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, permission: "granted" }), null);
});

test("each failed precondition reports its own cause", () => {
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, isSecureContext: false }), "insecure-context");
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, hasServiceWorker: false }), "no-service-worker");
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, hasPushManager: false }), "no-push-api");
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, hasNotificationApi: false }), "no-notification-api");
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, serverEnabled: false }), "server-not-configured");
  assert.equal(webPushUnavailableCause({ ...CAPABLE_DEVICE, permission: "denied" }), "permission-denied");
});

test("the first failed check wins, so a browser gap and a server gap are not conflated", () => {
  assert.equal(
    webPushUnavailableCause({ ...CAPABLE_DEVICE, hasPushManager: false, serverEnabled: false }),
    "no-push-api"
  );
  assert.equal(
    webPushUnavailableCause({ ...CAPABLE_DEVICE, serverEnabled: false, permission: "denied" }),
    "server-not-configured"
  );
});

test("every cause has its own owner-facing title", () => {
  const titles = ALL_CAUSES.map((cause) => describeWebPushUnavailable(cause).title);
  assert.equal(new Set(titles).size, ALL_CAUSES.length);
});

test("insecure-context names an HTTPS or localhost address as the fix", () => {
  const { detail } = describeWebPushUnavailable("insecure-context");
  assert.match(detail, HTTPS_PATTERN);
  assert.match(detail, LOCALHOST_PATTERN);
});

test("browser causes say where alerts work on this computer and on a phone", () => {
  for (const cause of DEVICE_CAUSES) {
    const { detail, title } = describeWebPushUnavailable(cause);
    assert.match(title, THIS_BROWSER_TITLE_PATTERN, cause);
    assert.match(detail, ON_THIS_COMPUTER_PATTERN, cause);
    assert.match(detail, PHONE_PATTERN, cause);
  }
});

test("server-not-configured names the server action and does not blame the browser", () => {
  const { detail, title } = describeWebPushUnavailable("server-not-configured");
  assert.match(detail, VAPID_KEYS_PATTERN);
  assert.match(detail, RESTART_PATTERN);
  assert.doesNotMatch(`${title} ${detail}`, BROWSER_PATTERN);
});

test("permission-denied tells the owner to allow notifications and reload", () => {
  const { detail } = describeWebPushUnavailable("permission-denied");
  assert.match(detail, ALLOW_NOTIFICATIONS_PATTERN);
  assert.match(detail, RELOAD_PATTERN);
});

test("no cause implies that notifications only work on mobile", () => {
  for (const cause of ALL_CAUSES) {
    const { detail, title } = describeWebPushUnavailable(cause);
    assert.doesNotMatch(`${title} ${detail}`, MOBILE_PATTERN, cause);
  }
});
