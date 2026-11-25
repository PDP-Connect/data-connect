// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import test from "node:test";
import { isCurrentBrowserSubscriptionRegistered, unavailableSentence, WebPushSettings } from "./web-push-settings.tsx";
import type { WebPushSubscriptionSummary } from "../lib/ref-client.ts";

const HERE = new URL(".", import.meta.url).pathname;
const APP_ROOT = join(HERE, "..", "..", "..", "..");
const SERVICE_WORKER_KNOWN_TYPES_PATTERN = /PDPP_KNOWN_PUSH_TYPES\.has\(payload\.type\)/;
const SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN = /pdpp\.assistance_requested/;
const SERVICE_WORKER_ESCALATION_TYPE_ALLOWED_PATTERN = /pdpp\.escalation/;
const SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN = /pdpp\.pending_interaction/;
const SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN = /pdpp\.test_notification/;
const SERVICE_WORKER_SKIP_WAITING_PATTERN = /self\.skipWaiting\(\)/;
const SERVICE_WORKER_CLIENTS_CLAIM_PATTERN = /self\.clients\.claim\(\)/;
// The SW allows the overview root plus clean owner-section prefixes at segment
// boundaries.
const SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN =
  /url === "\/"[\s\S]*PDPP_ALLOWED_URL_PREFIXES\.some\(\(prefix\) => url === prefix \|\| url\.startsWith\(`\$\{prefix\}\/`\)\)/;
const SERVICE_WORKER_ALLOWLIST_HAS_SOURCES = /"\/sources"/;
const SERVICE_WORKER_ALLOWLIST_HAS_SYNCS = /"\/syncs"/;
const SERVICE_WORKER_ALLOWLIST_HAS_NOTIFICATIONS = /"\/notifications"/;
const SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN = /pdppIsAllowedDashboardUrl\(rawUrl\)/;
const SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN = /rawUrl\.startsWith\("\/"\)/;
const SERVICE_WORKER_UNIQUE_TEST_TAG_PATTERN = /pdpp-test-notification-\$\{suffix\}/;
const SERVICE_WORKER_TEST_RENOTIFY_PATTERN = /renotify:\s*isTestNotification/;
const SERVICE_WORKER_MATCH_CLIENTS_PATTERN = /clients\.matchAll/;
const SERVICE_WORKER_OPEN_WINDOW_PATTERN = /clients\.openWindow\(url\)/;
const SENSITIVE_WORD_PATTERN = /password|cookie|token|otp|answer/i;
const SERVICE_WORKER_REGISTER_PATTERN = /navigator\.serviceWorker\.register\("\/pdpp-dashboard-sw\.js"\)/;
const SERVICE_WORKER_LOOKUP_PATTERN = /navigator\.serviceWorker\.getRegistration\("\/"\)/;
const SERVICE_WORKER_UPDATE_PATTERN = /registration\?\.update\(\)/;
const PUSH_SUBSCRIBE_PATTERN = /registration\.pushManager\.subscribe/;
const PUSH_EXISTING_SUBSCRIPTION_PATTERN = /registration\.pushManager\.getSubscription\(\)/;
const WEB_PUSH_POST_PATTERN = /fetch\("\/_ref\/web-push\/subscriptions"/;
const WEB_PUSH_DELETE_PATTERN = /method:\s*"DELETE"/;
const FIRST_SAVED_ENDPOINT_PATTERN = /subscriptions\[0\]\?\.endpoint/;
const DIAGNOSTICS_TOGGLE_SHOW_PATTERN = /Show diagnostics/;
const DIAGNOSTICS_TOGGLE_HIDE_PATTERN = /Hide diagnostics/;
const DIAGNOSTICS_ARIA_LABEL_PATTERN = /aria-label="Web Push diagnostics"/;
const DIAGNOSTICS_PWA_INSTALL_PATTERN = /installing the PWA alone does not subscribe/;
const DIAGNOSTICS_PER_DEVICE_ENABLE_PATTERN = /Each phone, tablet, and browser profile must be enabled separately/;
const DIAGNOSTICS_SETUP_STEP_DEVICE_PATTERN = /Open the right device/;
const DIAGNOSTICS_SETUP_STEP_PERMISSION_PATTERN = /Allow notifications/;
const DIAGNOSTICS_SETUP_STEP_SUBSCRIBE_PATTERN = /Subscribe this device/;
const DIAGNOSTICS_SETUP_STEP_TEST_PATTERN = /Send a test/;
const DIAGNOSTICS_INSTALL_DISTINCT_FROM_SUBSCRIBE_PATTERN = /A PWA install is not enough/;
const DIAGNOSTICS_DEVICE_SUBSCRIBED_PATTERN = /This device is subscribed/;
const DIAGNOSTICS_SERVER_UNRECOGNIZED_PATTERN = /server does not list it/;
const DIAGNOSTICS_DEVICE_DISPLAY_CONFIRMATION_PATTERN = /Only the device can confirm whether it displayed/;
// history-pages brief, decision 4: the one enable control reads "Turn on notifications".
const DIAGNOSTICS_ENABLE_DEVICE_BUTTON_PATTERN = />\s*Turn on notifications\s*</;
const DIAGNOSTICS_TURN_OFF_BUTTON_PATTERN = />Turn off</;
const TURN_OFF_CONFIRMATION_PATTERN = /Turn off notifications for \{label\}\? This device will stop receiving them\./;
const SERVER_LIST_GATES_ENABLE_PATTERN = /const enabled = matchesThisBrowser && !unavailable/;
const OLD_SUBSCRIPTION_CONFLICT_COPY_PATTERN = /This device is not receiving notifications yet|Turn off this device/;
const OUTSIDE_DETAILS_TITLE_SUBSCRIPTION_PATTERN = /title:\s*"[^"]*subscription/i;
const OLD_SUBSCRIPTION_REMOVE_ACTION_PATTERN = /onClick=\{\(\) => onDisable\(endpoint\)\}/;
const LOCAL_SUBSCRIPTION_CLEANUP_HANDLER_PATTERN = /onDisable=\{disable\}/;
const DIAGNOSTICS_TEST_PUSH_PATTERN = /fetch\("\/_ref\/web-push\/test"/;
const DIAGNOSTICS_TEST_PUSH_METHOD_PATTERN = /method:\s*"POST"/;
const DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN = />\s*Send test notification\s*</;
const DIAGNOSTICS_SEND_DISABLED_PATTERN = /disabled=\{busy \|\| !endpoint \|\| Boolean\(unavailable\)\}/;
const DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN = /No active subscriptions for this owner/;
const WEB_PUSH_RESPONSE_ERROR_HELPER_PATTERN =
  /async function webPushResponseError\(response: Response, fallbackAction: string\)/;
const WEB_PUSH_RESPONSE_ERROR_MESSAGE_PATTERN = /body\.error\?\.message \|\| body\.message \|\| body\.error\?\.code/;
const WEB_PUSH_SUBSCRIBE_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Subscription failed"\)/;
const WEB_PUSH_TEST_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Test notification failed"\)/;
const WEB_PUSH_UNSUBSCRIBE_STRUCTURED_ERROR_PATTERN =
  /throw await webPushResponseError\(response, "Unsubscribe failed"\)/;
const SSR_SAFE_WINDOW_HELPER_DEF_PATTERN = /function hasWindowFeature\(/;
const SSR_SAFE_NAVIGATOR_HELPER_DEF_PATTERN = /function hasNavigatorFeature\(/;
const SSR_SAFE_WINDOW_HELPER_GUARD_PATTERN = /typeof window !== "undefined"/;
const SSR_SAFE_NAVIGATOR_HELPER_GUARD_PATTERN = /typeof navigator !== "undefined"/;
const SSR_SAFE_DIAGNOSTIC_PUSHMANAGER_PATTERN = /hasWindowFeature\("PushManager"\)/;
const SSR_SAFE_DIAGNOSTIC_NOTIFICATION_PATTERN = /hasWindowFeature\("Notification"\)/;
const SSR_SAFE_DIAGNOSTIC_SERVICE_WORKER_PATTERN = /hasNavigatorFeature\("serviceWorker"\)/;
const SVG_CSS_COLOR_FUNCTION_PATTERN = /oklch\(|lab\(|lch\(|color\(/i;
const DATACONNECT_ICON_PATTERN = /const DATACONNECT_ICON =/;
const DATACONNECT_ICON_GRADIENT_PATTERN = /stop-color="#304DC0"/;
const DATACONNECT_ICON_WORDMARK_PATTERN = /aria-label="DataConnect"/;
const ENABLE_CLEARS_TEST_STATUS_PATTERN = /async function enable\(\)[\s\S]*?setBusy\(true\);\s*setTestStatus\(null\);/;
const DISABLE_CLEARS_TEST_STATUS_PATTERN =
  /async function disable\(targetEndpoint: string\)[\s\S]*?setBusy\(true\);\s*setTestStatus\(null\);/;
const WEB_PUSH_SUMMARY_LIVE_REGION_PATTERN =
  /<p aria-live="polite"[^>]+role="status">Checking this device…/;
const WEB_PUSH_DETAIL_LIVE_REGION_PATTERN =
  /<div aria-atomic="true" aria-live="polite" role="status">[\s\S]*?Last check: \{status\}[\s\S]*?\{testStatus \? <p/;
const BANNED_VISIBLE_WORDS = /\b(verdict|coverage|fleet|projection|grant|bearer|manifest|run|stream|connector|instance|reference server|vapid|push api)\b/i;

function visibleNotificationText(config: { enabled: boolean; object: "web_push_config"; public_key: string | null; unavailable_reason: string | null }, subscriptions: WebPushSubscriptionSummary[]) {
  const markup = renderToStaticMarkup(createElement(WebPushSettings, { config, subscriptions }));
  const document = new JSDOM(markup).window.document;
  for (const details of document.querySelectorAll("details")) details.remove();
  return document.body.textContent ?? "";
}

test("WebPushSettings renders unsupported, denied-permission, insecure-context, VAPID, and iOS/PWA caveat states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  for (const expected of [
    "window.isSecureContext",
    "serviceWorker",
    "PushManager",
    "Notification",
    'Notification.permission === "denied"',
    "Server VAPID keys are not configured",
    "Mobile browsers may require opening the installed DataConnect app before notifications can arrive",
    "Installing the PWA only adds the app icon",
  ]) {
    assert.match(src, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("server-not-ready wording tells the owner what is missing and where to set it", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  const config = {
    enabled: false,
    object: "web_push_config" as const,
    public_key: null,
    unavailable_reason: "VAPID public/private keys are not configured",
  };
  const markup = renderToStaticMarkup(createElement(WebPushSettings, { config, subscriptions: [] }));
  const detailsStart = markup.indexOf("<details");

  // DIRECTION.md, “Few words”: a state is one plain sentence; round 4 item 6 names the server environment as its fix.
  assert.equal(unavailableSentence(config.unavailable_reason, true), "This server needs its notification keys set in its environment.");
  assert.ok(detailsStart >= 0);
  assert.doesNotMatch(src, /ask its administrator to set them up/);
  assert.match(markup.slice(detailsStart), /PDPP_WEB_PUSH_VAPID_PUBLIC_KEY/);
  assert.match(markup.slice(detailsStart), /PDPP_WEB_PUSH_VAPID_PRIVATE_KEY/);
  assert.match(src, /unavailableSentence\(unavailable, !\(config\.enabled && config\.public_key\)\)/);
});

test("dashboard service worker fails closed and click-through targets clean owner URLs", async () => {
  const src = await readFile(join(APP_ROOT, "public", "pdpp-dashboard-sw.js"), "utf8");
  assert.match(src, SERVICE_WORKER_KNOWN_TYPES_PATTERN);
  assert.match(src, SERVICE_WORKER_ASSISTANCE_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_ESCALATION_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_PENDING_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_TEST_TYPE_ALLOWED_PATTERN);
  assert.match(src, SERVICE_WORKER_SKIP_WAITING_PATTERN);
  assert.match(src, SERVICE_WORKER_CLIENTS_CLAIM_PATTERN);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_ALLOWLIST_PATTERN);
  assert.match(src, SERVICE_WORKER_ALLOWLIST_HAS_SOURCES);
  assert.match(src, SERVICE_WORKER_ALLOWLIST_HAS_SYNCS);
  assert.match(src, SERVICE_WORKER_ALLOWLIST_HAS_NOTIFICATIONS);
  assert.match(src, SERVICE_WORKER_DASHBOARD_URL_HELPER_USE_PATTERN);
  assert.match(src, SERVICE_WORKER_UNIQUE_TEST_TAG_PATTERN);
  assert.match(src, SERVICE_WORKER_TEST_RENOTIFY_PATTERN);
  // Reject the looser prefix check that would accept arbitrary rooted paths.
  assert.doesNotMatch(src, SERVICE_WORKER_DASHBOARD_PREFIX_TRAVERSAL_PATTERN);
  assert.match(src, SERVICE_WORKER_MATCH_CLIENTS_PATTERN);
  assert.match(src, SERVICE_WORKER_OPEN_WINDOW_PATTERN);
  assert.doesNotMatch(src, SENSITIVE_WORD_PATTERN);
});

test("dashboard launcher SVG icon uses Android-safe paint values", async () => {
  const src = await readFile(join(APP_ROOT, "src", "app", "icon.tsx"), "utf8");
  assert.doesNotMatch(src, SVG_CSS_COLOR_FUNCTION_PATTERN);
  assert.match(src, DATACONNECT_ICON_PATTERN);
  assert.match(src, DATACONNECT_ICON_GRADIENT_PATTERN);
  assert.match(src, DATACONNECT_ICON_WORDMARK_PATTERN);
});

test("dashboard notification setup registers, posts, reuses, and deletes browser subscriptions", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, SERVICE_WORKER_REGISTER_PATTERN);
  assert.match(src, SERVICE_WORKER_LOOKUP_PATTERN);
  assert.match(src, SERVICE_WORKER_UPDATE_PATTERN);
  assert.match(src, PUSH_EXISTING_SUBSCRIPTION_PATTERN);
  assert.match(src, PUSH_SUBSCRIBE_PATTERN);
  assert.match(src, WEB_PUSH_POST_PATTERN);
  assert.match(src, WEB_PUSH_DELETE_PATTERN);
  assert.doesNotMatch(src, FIRST_SAVED_ENDPOINT_PATTERN);
});

test("dashboard test notification button posts to /_ref/web-push/test and gates on subscription", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_TEST_PUSH_PATTERN);
  assert.match(src, DIAGNOSTICS_TEST_PUSH_METHOD_PATTERN);
  assert.match(src, DIAGNOSTICS_ENABLE_DEVICE_BUTTON_PATTERN);
  assert.equal(src.match(/>\s*Turn on notifications\s*</g)?.length, 1);
  assert.doesNotMatch(src, /Enable this device/);
  assert.match(src, DIAGNOSTICS_TURN_OFF_BUTTON_PATTERN);
  assert.match(src, TURN_OFF_CONFIRMATION_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_TEST_BUTTON_PATTERN);
  assert.match(src, DIAGNOSTICS_SEND_DISABLED_PATTERN);
  assert.match(src, DIAGNOSTICS_NO_SUBSCRIPTIONS_PATTERN);
});

// After a successful send-test, the status line would otherwise read
// "Test notification sent..." even after the owner disabled this device or
// re-enabled it. Clearing testStatus on those transitions prevents that
// stale, misleading message from outliving the subscription it describes.
test("dashboard Web Push enable and disable clear any stale test-notification status", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, ENABLE_CLEARS_TEST_STATUS_PATTERN);
  assert.match(src, DISABLE_CLEARS_TEST_STATUS_PATTERN);
});

test("successful notification enable and disable reread the server device list", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  const refresh = src.slice(src.indexOf("async function refreshSubscriptions"), src.indexOf("async function enable"));
  const enable = src.slice(src.indexOf("async function enable"), src.indexOf("async function sendTest"));
  const disable = src.slice(src.indexOf("async function disable"), src.indexOf("// Per-device install reminder"));
  // Brief item 4: after either successful action, use the same server list endpoint as page load.
  assert.match(refresh, /fetch\("\/_ref\/web-push\/subscriptions"[\s\S]*method:\s*"GET"/);
  assert.match(enable, /await refreshSubscriptions\(\)/);
  assert.match(disable, /await refreshSubscriptions\(\)/);
});

test("dashboard Web Push status changes are announced as live status regions", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, WEB_PUSH_SUMMARY_LIVE_REGION_PATTERN);
  assert.match(src, WEB_PUSH_DETAIL_LIVE_REGION_PATTERN);
});

test("notification availability uses plain words and explains the next step", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, /export function unavailableSentence/);
  assert.match(src, /This browser can't receive notifications\. Install DataConnect as an app on your phone or computer to get them\./);
  assert.match(src, /notifications are blocked in your browser or device settings; allow them there, then return here/i);
  // Round 4 item 6: the server provides its keys through environment settings.
  assert.match(src, /This server needs its notification keys set in its environment\./);
  // DIRECTION.md, Notifications: browser support details are folded under Details.
  assert.match(src, /<summary className="min-h-11 cursor-pointer py-3 text-\[13px\] text-muted-foreground">Details<\/summary>/);
});

test("notification list states keep visible words plain and show only receiving devices", () => {
  const config = { enabled: true, object: "web_push_config" as const, public_key: "key", unavailable_reason: null };
  const emptyText = visibleNotificationText(config, []);
  assert.match(emptyText, /Checking this device/);
  assert.doesNotMatch(emptyText, BANNED_VISIBLE_WORDS);

  const subscription: WebPushSubscriptionSummary = {
    created_at: "2026-01-01T00:00:00Z",
    device_label: "Desk computer",
    endpoint: "https://push.example/one",
    endpoint_redacted: null,
    id: "one",
    last_failure_at: null,
    last_failure_reason: null,
    last_success_at: null,
    last_used_at: null,
    owner_subject_id: "owner",
    platform: null,
    revoked_at: null,
    updated_at: "2026-01-01T00:00:00Z",
    user_agent: null,
  };
  const revoked = { ...subscription, endpoint: "https://push.example/revoked", id: "revoked", revoked_at: "2026-01-02T00:00:00Z" };
  const rowsMarkup = renderToStaticMarkup(createElement(WebPushSettings, { config, subscriptions: [subscription, revoked] }));
  const rowsDocument = new JSDOM(rowsMarkup).window.document;
  for (const details of rowsDocument.querySelectorAll("details")) details.remove();
  const rowsText = rowsDocument.body.textContent ?? "";
  assert.match(rowsText, /Desk computer/);
  assert.doesNotMatch(rowsText, /revoked/i);
  assert.doesNotMatch(rowsText, BANNED_VISIBLE_WORDS);

  // DIRECTION.md, Notifications: unavailable browsers get one plain explanation with a next step.
  const failedText = unavailableSentence("This browser does not support service workers.");
  assert.match(failedText, /This browser can't receive notifications/);
  assert.doesNotMatch(failedText, BANNED_VISIBLE_WORDS);
});

test("the server list controls notification state and local cleanup stays in Details", async () => {
  const endpoint = "https://push.example/local-only";
  const listed = { endpoint, revoked_at: null } as WebPushSubscriptionSummary;
  const revoked = { endpoint, revoked_at: "2026-01-02T00:00:00Z" } as WebPushSubscriptionSummary;
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");

  // history-repair brief P2: the server list is the truth when browser state disagrees.
  assert.equal(isCurrentBrowserSubscriptionRegistered(endpoint, []), false);
  assert.equal(isCurrentBrowserSubscriptionRegistered(endpoint, [revoked]), false);
  assert.equal(isCurrentBrowserSubscriptionRegistered(endpoint, [listed]), true);
  assert.match(src, SERVER_LIST_GATES_ENABLE_PATTERN);
  assert.doesNotMatch(src, OLD_SUBSCRIPTION_CONFLICT_COPY_PATTERN);
  const deviceStatus = src.slice(src.indexOf("function deviceStatus"), src.indexOf("export function unavailableSentence"));
  assert.doesNotMatch(deviceStatus, OUTSIDE_DETAILS_TITLE_SUBSCRIPTION_PATTERN);
  assert.ok(src.indexOf("Remove this browser&apos;s old subscription") > src.indexOf("<details"));
  assert.match(src, OLD_SUBSCRIPTION_REMOVE_ACTION_PATTERN);
  assert.match(src, LOCAL_SUBSCRIPTION_CLEANUP_HANDLER_PATTERN);
});

test("dashboard Web Push actions surface structured endpoint error details", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, WEB_PUSH_RESPONSE_ERROR_HELPER_PATTERN);
  assert.match(src, WEB_PUSH_RESPONSE_ERROR_MESSAGE_PATTERN);
  assert.match(src, WEB_PUSH_SUBSCRIBE_STRUCTURED_ERROR_PATTERN);
  assert.match(src, WEB_PUSH_TEST_STRUCTURED_ERROR_PATTERN);
  assert.match(src, WEB_PUSH_UNSUBSCRIBE_STRUCTURED_ERROR_PATTERN);
});

test("dashboard Web Push setup explains install, permission, subscription, and test as separate states", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_SETUP_STEP_DEVICE_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_PERMISSION_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_SUBSCRIBE_PATTERN);
  assert.match(src, DIAGNOSTICS_SETUP_STEP_TEST_PATTERN);
  assert.match(src, DIAGNOSTICS_INSTALL_DISTINCT_FROM_SUBSCRIBE_PATTERN);
  assert.match(src, DIAGNOSTICS_DEVICE_SUBSCRIBED_PATTERN);
  // history-repair brief P2: the server list is the truth for this browser's status.
  assert.match(src, DIAGNOSTICS_SERVER_UNRECOGNIZED_PATTERN);
  assert.match(src, DIAGNOSTICS_DEVICE_DISPLAY_CONFIRMATION_PATTERN);
});

test("dashboard exposes diagnostic checklist covering every web push precondition", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  assert.match(src, DIAGNOSTICS_TOGGLE_SHOW_PATTERN);
  assert.match(src, DIAGNOSTICS_TOGGLE_HIDE_PATTERN);
  assert.match(src, DIAGNOSTICS_ARIA_LABEL_PATTERN);
  for (const label of [
    "Secure context (HTTPS/localhost)",
    "Service Worker API available",
    "Push API (PushManager) available",
    "Notification API available",
    "Server VAPID keys configured",
    "Service worker registered",
    "Notification permission granted",
    "Browser push subscription active",
    "Server-tracked subscriptions for this owner",
    "Last delivery health",
  ]) {
    assert.ok(src.includes(label), `diagnostics missing label: ${label}`);
  }
  assert.match(src, DIAGNOSTICS_PWA_INSTALL_PATTERN);
  assert.match(src, DIAGNOSTICS_PER_DEVICE_ENABLE_PATTERN);
});

test("diagnostics feature probes are SSR-safe and called via typed helpers", async () => {
  const src = await readFile(join(HERE, "web-push-settings.tsx"), "utf8");
  // The render-time diagnostic builder must never touch window/navigator
  // directly — buildDiagnostics() runs during render and Next can pre-render
  // a client component on the server, where window/navigator are undefined.
  assert.match(src, SSR_SAFE_WINDOW_HELPER_DEF_PATTERN);
  assert.match(src, SSR_SAFE_NAVIGATOR_HELPER_DEF_PATTERN);
  assert.match(src, SSR_SAFE_WINDOW_HELPER_GUARD_PATTERN);
  assert.match(src, SSR_SAFE_NAVIGATOR_HELPER_GUARD_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_PUSHMANAGER_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_NOTIFICATION_PATTERN);
  assert.match(src, SSR_SAFE_DIAGNOSTIC_SERVICE_WORKER_PATTERN);
});
