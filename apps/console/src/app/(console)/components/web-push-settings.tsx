"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect, useReducer, useState } from "react";
import type { WebPushConfig, WebPushSubscriptionSummary } from "../lib/ref-client.ts";

type SwState = "registered" | "absent" | "unknown" | "unsupported";

// The runtime state for *this* browser/device: whether Web Push is usable, the
// notification permission, the service-worker registration, and the active push
// endpoint, plus the human-readable status line. These all change together as
// the async inspection settles and as the owner enables/disables this device,
// so they live in one reducer (atomic transitions, no cascading re-renders).
interface DeviceState {
  endpoint: string | null;
  permission: NotificationPermission | "unknown";
  status: string;
  swState: SwState;
  unavailable: string | null;
}

type DeviceAction =
  | {
      type: "supportDetected";
      permission: NotificationPermission | "unknown";
      status: string;
      unavailable: string | null;
    }
  | { type: "swState"; swState: SwState; status?: string }
  | { type: "subscribed"; endpoint: string; status: string }
  | { type: "disabled"; status: string }
  | { type: "endpoint"; endpoint: string | null }
  | { type: "permission"; permission: NotificationPermission | "unknown" }
  | { type: "status"; status: string };

function deviceReducer(state: DeviceState, action: DeviceAction): DeviceState {
  switch (action.type) {
    case "supportDetected":
      return { ...state, permission: action.permission, status: action.status, unavailable: action.unavailable };
    case "swState":
      return action.status === undefined
        ? { ...state, swState: action.swState }
        : { ...state, status: action.status, swState: action.swState };
    case "subscribed":
      return { ...state, endpoint: action.endpoint, status: action.status };
    case "disabled":
      return { ...state, endpoint: null, status: action.status };
    case "endpoint":
      return { ...state, endpoint: action.endpoint };
    case "permission":
      return { ...state, permission: action.permission };
    case "status":
      return { ...state, status: action.status };
    default:
      return state;
  }
}

const INITIAL_DEVICE_STATE: DeviceState = {
  endpoint: null,
  permission: "unknown",
  status: "Checking this browser…",
  swState: "unknown",
  unavailable: null,
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Each row in the diagnostic checklist. Unknown state means indeterminate,
// so the owner can distinguish "checked and fine" from "could not tell here".
type DiagnosticState = "ok" | "warn" | "fail" | "unknown";
interface DiagnosticRow {
  detail: string;
  label: string;
  state: DiagnosticState;
}

interface DeviceStatus {
  detail: string;
  title: string;
}

interface SetupStep {
  detail: string;
  label: string;
  state: DiagnosticState;
}

function detectSupport(config: WebPushConfig) {
  if (!window.isSecureContext) {
    return "Web Push needs HTTPS or localhost.";
  }
  if (!("serviceWorker" in navigator)) {
    return "This browser does not support service workers.";
  }
  if (!("PushManager" in window)) {
    return "This browser does not support the Push API.";
  }
  if (!("Notification" in window)) {
    return "This browser does not support browser notifications.";
  }
  if (!(config.enabled && config.public_key)) {
    return config.unavailable_reason || "Server VAPID keys are not configured.";
  }
  if (Notification.permission === "denied") {
    return "Notifications are denied. Change browser or OS notification settings to opt in.";
  }
  return null;
}

/**
 * Effect-mount subscription probe: registers the service worker, updates it
 * (best-effort), and surfaces the existing push subscription if one exists.
 * `isCancelled` is checked after every await so a fast unmount (config
 * change, navigation) never dispatches into a stale effect.
 */
async function detectExistingSubscription(dispatch: (action: DeviceAction) => void, isCancelled: () => boolean) {
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (isCancelled()) {
      return;
    }
    dispatch({ swState: registration ? "registered" : "absent", type: "swState" });
    try {
      await registration?.update();
    } catch {
      // Update check failing is not fatal to inspecting the existing subscription.
    }
    const existing = await registration?.pushManager.getSubscription();
    if (isCancelled()) {
      return;
    }
    if (existing) {
      dispatch({ endpoint: existing.endpoint, status: "Web Push is enabled for this browser.", type: "subscribed" });
    }
  } catch {
    if (!isCancelled()) {
      dispatch({
        status: "Could not inspect this browser's Web Push subscription.",
        swState: "unknown",
        type: "swState",
      });
    }
  }
}

function diagnosticMarker(state: DiagnosticState) {
  if (state === "ok") {
    return "[ok]";
  }
  if (state === "warn") {
    return "[!]";
  }
  if (state === "fail") {
    return "[x]";
  }
  return "[?]";
}

function hasWindowFeature(feature: string) {
  return typeof window !== "undefined" && feature in window;
}

function hasNavigatorFeature(feature: string) {
  return typeof navigator !== "undefined" && feature in navigator;
}

async function webPushResponseError(response: Response, fallbackAction: string) {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string }; message?: string };
    detail = body.error?.message || body.message || body.error?.code || null;
  } catch {
    detail = null;
  }
  return new Error(detail ? `${fallbackAction}: ${detail}` : `${fallbackAction} (${response.status})`);
}

function diagnosticToneClass(state: DiagnosticState) {
  if (state === "ok") {
    return "text-muted-foreground";
  }
  if (state === "warn") {
    return "text-attention";
  }
  if (state === "fail") {
    return "text-destructive";
  }
  return "text-muted-foreground";
}

function setupStepToneClass(state: DiagnosticState) {
  if (state === "ok") {
    return "border-border bg-muted/40 text-foreground";
  }
  if (state === "fail") {
    return "border-destructive bg-muted/40 text-foreground";
  }
  if (state === "warn") {
    return "border-border bg-muted/40 text-foreground";
  }
  return "border-border bg-muted/40 text-foreground";
}

function secureContextRow(): DiagnosticRow {
  if (typeof window === "undefined") {
    return { detail: "Server-rendered", label: "Secure context (HTTPS/localhost)", state: "unknown" };
  }
  if (window.isSecureContext) {
    return { detail: window.location.origin, label: "Secure context (HTTPS/localhost)", state: "ok" };
  }
  return {
    detail: "Page is not served over a secure origin.",
    label: "Secure context (HTTPS/localhost)",
    state: "fail",
  };
}

function featureRow(label: string, present: boolean, presentDetail: string, missingDetail: string): DiagnosticRow {
  return present ? { detail: presentDetail, label, state: "ok" } : { detail: missingDetail, label, state: "fail" };
}

function vapidRow(config: WebPushConfig): DiagnosticRow {
  if (config.enabled && config.public_key) {
    return {
      detail: "/_ref/web-push/config reports enabled",
      label: "Server VAPID keys configured",
      state: "ok",
    };
  }
  return {
    detail: config.unavailable_reason || "Server VAPID keys are not configured.",
    label: "Server VAPID keys configured",
    state: "fail",
  };
}

function swRow(swState: "registered" | "absent" | "unknown" | "unsupported"): DiagnosticRow {
  const label = "Service worker registered";
  if (swState === "registered") {
    return { detail: "The DataConnect service worker controls /.", label, state: "ok" };
  }
  if (swState === "absent") {
    return { detail: "Not registered yet - use Turn on notifications.", label, state: "warn" };
  }
  if (swState === "unsupported") {
    return { detail: "Browser lacks serviceWorker.", label, state: "fail" };
  }
  return { detail: "Could not inspect registration.", label, state: "unknown" };
}

function permissionRow(permission: NotificationPermission | "unknown"): DiagnosticRow {
  const label = "Notification permission granted";
  if (permission === "granted") {
    return { detail: 'Notification.permission === "granted"', label, state: "ok" };
  }
  if (permission === "denied") {
    return {
      detail: 'Notification.permission === "denied" - change browser/OS notification settings to opt in.',
      label,
      state: "fail",
    };
  }
  if (permission === "default") {
    return {
      detail: "Permission has not been requested on this device - use Turn on notifications.",
      label,
      state: "warn",
    };
  }
  return { detail: "Notification API not available.", label, state: "unknown" };
}

function browserSubscriptionRow(endpoint: string | null, matchesThisBrowser: boolean): DiagnosticRow {
  const label = "Browser push subscription active";
  if (!endpoint) {
    return {
      detail:
        "No active subscription on this device - use Turn on notifications to create one (installing the PWA alone does not subscribe).",
      label,
      state: "warn",
    };
  }
  if (matchesThisBrowser) {
    return { detail: "Browser endpoint is registered for this owner on the server.", label, state: "ok" };
  }
  return {
    detail:
      "Browser has a subscription but the server does not list it for this owner - use Turn on notifications to re-register.",
    label,
    state: "warn",
  };
}

function deliveryHealthRow(lastSubscription: WebPushSubscriptionSummary | undefined): DiagnosticRow {
  const label = "Last delivery health";
  if (lastSubscription?.last_failure_reason) {
    return {
      detail: `Most recent failure: ${lastSubscription.last_failure_reason} (${lastSubscription.last_failure_at ?? "unknown time"}). Use Turn on notifications on the affected device to re-subscribe.`,
      label,
      state: "warn",
    };
  }
  if (lastSubscription?.last_success_at) {
    return { detail: `Last success: ${lastSubscription.last_success_at}.`, label, state: "ok" };
  }
  return { detail: "No delivery attempt recorded yet.", label, state: "unknown" };
}

function deviceStatus({
  unavailable,
  permission,
  endpoint,
  matchesThisBrowser,
  swState,
}: {
  unavailable: string | null;
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  swState: "registered" | "absent" | "unknown" | "unsupported";
}): DeviceStatus {
  if (unavailable) {
    return {
      detail: unavailable,
      title: "This browser cannot receive DataConnect notifications.",
    };
  }
  if (permission === "unknown" && swState === "unknown") {
    return {
      detail: "Inspecting browser permission and subscription state.",
      title: "Checking this device…",
    };
  }
  if (permission === "denied") {
    return {
      detail: "Change browser or OS notification settings, then return here and enable this device.",
      title: "Notifications are blocked for this browser.",
    };
  }
  if (matchesThisBrowser) {
    return {
      detail: "Pending connector interactions can send browser notifications to this browser or installed app.",
      title: "This device is subscribed.",
    };
  }
  if (endpoint) {
    return {
      detail: "Turn on notifications again to repair the server-side subscription.",
      title: "Notifications are not on for this browser.",
    };
  }
  if (permission === "granted") {
    return {
      detail: "Turn on notifications once so DataConnect can send alerts here.",
      title: "Notifications are allowed, but this device is not subscribed.",
    };
  }
  return {
    detail: "Installing the PWA only adds the app icon. You still need to enable notifications from this device.",
    title: "This device is not subscribed yet.",
  };
}

export function unavailableSentence(reason: string, serverNotReady = false): string {
  if (serverNotReady) {
    return "This server needs its notification keys set in its environment.";
  }
  const normalized = reason.toLowerCase();
  if (normalized.includes("denied")) {
    return "Notifications are blocked in your browser or device settings; allow them there, then return here.";
  }
  if (normalized.includes("vapid") || normalized.includes("key") || normalized.includes("server")) {
    return "This server needs its notification keys set in its environment.";
  }
  return "This browser can't receive notifications. Install DataConnect as an app on your phone or computer to get them.";
}

export function receivingDeviceLabel(subscription: WebPushSubscriptionSummary, currentEndpoint: string | null): string {
  if (subscription.endpoint === currentEndpoint) return "This device";
  return subscription.device_label?.trim() || "Another device";
}

export function isCurrentBrowserSubscriptionRegistered(
  endpoint: string | null,
  subscriptions: WebPushSubscriptionSummary[]
): boolean {
  return endpoint ? subscriptions.some((subscription) => subscription.endpoint === endpoint && !subscription.revoked_at) : false;
}

function buildSetupSteps({
  unavailable,
  permission,
  endpoint,
  matchesThisBrowser,
  testStatus,
}: {
  unavailable: string | null;
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  testStatus: string | null;
}): SetupStep[] {
  const testNotificationAccepted = isTestNotificationAccepted(testStatus);

  return [
    {
      detail: "This page configures notifications only for the browser or installed app you are using right now.",
      label: "Open the right device",
      state: "ok",
    },
    {
      detail: setupPermissionDetail(permission),
      label: "Allow notifications",
      state: setupPermissionState(permission, unavailable),
    },
    {
      detail: setupSubscriptionDetail({ endpoint, matchesThisBrowser }),
      label: "Subscribe this device",
      state: setupSubscriptionState({ matchesThisBrowser, unavailable }),
    },
    {
      detail: testNotificationAccepted
        ? "The push provider accepted the test. Only the device can confirm whether it displayed."
        : "Use Send test notification after this device is subscribed.",
      label: "Send a test",
      state: setupTestState({ matchesThisBrowser, testNotificationAccepted }),
    },
  ];
}

function setupPermissionState(
  permission: NotificationPermission | "unknown",
  unavailable: string | null
): DiagnosticState {
  if (permission === "granted") {
    return "ok";
  }
  if (permission === "denied" || unavailable) {
    return "fail";
  }
  return "warn";
}

function setupPermissionDetail(permission: NotificationPermission | "unknown"): string {
  if (permission === "granted") {
    return "Browser permission is granted.";
  }
  if (permission === "denied") {
    return "Browser or OS settings currently block notifications.";
  }
  return "Tap Turn on notifications and approve the browser prompt.";
}

function setupSubscriptionState({
  matchesThisBrowser,
  unavailable,
}: {
  matchesThisBrowser: boolean;
  unavailable: string | null;
}): DiagnosticState {
  if (matchesThisBrowser) {
    return "ok";
  }
  if (unavailable) {
    return "fail";
  }
  return "warn";
}

function setupSubscriptionDetail({
  endpoint,
  matchesThisBrowser,
}: {
  endpoint: string | null;
  matchesThisBrowser: boolean;
}): string {
  if (matchesThisBrowser) {
    return "The server recognizes this browser's push subscription.";
  }
  if (endpoint) {
    return "The browser has a local subscription, but the server needs it re-registered.";
  }
  return "A PWA install is not enough; this step creates the push subscription.";
}

function setupTestState({
  matchesThisBrowser,
  testNotificationAccepted,
}: {
  matchesThisBrowser: boolean;
  testNotificationAccepted: boolean;
}): DiagnosticState {
  if (testNotificationAccepted || matchesThisBrowser) {
    return "unknown";
  }
  return "warn";
}

function isTestNotificationAccepted(testStatus: string | null): boolean {
  return (
    testStatus?.startsWith("Test notification sent") === true ||
    testStatus?.startsWith("Test notification delivered") === true
  );
}

function buildDiagnostics({
  config,
  swState,
  permission,
  endpoint,
  matchesThisBrowser,
  subscriptions,
  lastSubscription,
}: {
  config: WebPushConfig;
  swState: "registered" | "absent" | "unknown" | "unsupported";
  permission: NotificationPermission | "unknown";
  endpoint: string | null;
  matchesThisBrowser: boolean;
  subscriptions: WebPushSubscriptionSummary[];
  lastSubscription: WebPushSubscriptionSummary | undefined;
}): DiagnosticRow[] {
  return [
    secureContextRow(),
    featureRow(
      "Service Worker API available",
      hasNavigatorFeature("serviceWorker"),
      "navigator.serviceWorker present",
      "Browser does not expose serviceWorker."
    ),
    featureRow(
      "Push API (PushManager) available",
      hasWindowFeature("PushManager"),
      "window.PushManager present",
      "Browser does not expose PushManager."
    ),
    featureRow(
      "Notification API available",
      hasWindowFeature("Notification"),
      "window.Notification present",
      "Browser does not expose Notification."
    ),
    vapidRow(config),
    swRow(swState),
    permissionRow(permission),
    browserSubscriptionRow(endpoint, matchesThisBrowser),
    {
      detail:
        subscriptions.length > 0
          ? `${subscriptions.length} saved across all of this owner's devices.`
          : "Server has no saved subscriptions yet for this owner.",
      label: "Server-tracked subscriptions for this owner",
      state: subscriptions.length > 0 ? "ok" : "warn",
    },
    deliveryHealthRow(lastSubscription),
  ];
}

// Collapsible per-precondition checklist. Presentational: the parent owns the
// device state and re-inspection, this only renders the rows and the toggle.
function DiagnosticsDisclosure({
  diagnostics,
  expanded,
  onToggle,
}: {
  diagnostics: DiagnosticRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-4 border-border/60 border-t pt-3">
      <button
        aria-controls="web-push-diagnostics"
        aria-expanded={expanded}
        className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={onToggle}
        type="button"
      >
        {expanded ? "Hide diagnostics" : "Show diagnostics"}
      </button>
      {expanded ? (
        <ul aria-label="Web Push diagnostics" className="mt-3 space-y-1.5" id="web-push-diagnostics">
          {diagnostics.map((row) => (
            <li className="pdpp-caption flex items-start gap-2" key={row.label}>
              <span
                aria-hidden="true"
                className={`inline-block w-10 shrink-0 font-mono ${diagnosticToneClass(row.state)}`}
              >
                {diagnosticMarker(row.state)}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-foreground">{row.label}</span>
                <span className="ml-2 text-muted-foreground">{row.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WebPushSettings({
  config,
  subscriptions,
}: {
  config: WebPushConfig;
  subscriptions: WebPushSubscriptionSummary[];
}) {
  const [currentSubscriptions, setCurrentSubscriptions] = useState(subscriptions);
  const [device, dispatch] = useReducer(deviceReducer, INITIAL_DEVICE_STATE);
  const { status, endpoint, unavailable, permission, swState } = device;
  const [busy, setBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmingEndpoint, setConfirmingEndpoint] = useState<string | null>(null);
  const [removedEndpoints, setRemovedEndpoints] = useState<string[]>([]);

  async function refreshSubscriptions() {
    try {
      const response = await fetch("/_ref/web-push/subscriptions", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "GET",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Refresh device list failed");
      }
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) {
        throw new Error("Device list response was not valid.");
      }
      setCurrentSubscriptions(body.data as WebPushSubscriptionSummary[]);
    } catch {
      dispatch({ status: "The device list could not be refreshed.", type: "status" });
    }
  }

  async function refreshSubscriptionState() {
    if (!hasNavigatorFeature("serviceWorker")) {
      dispatch({ swState: "unsupported", type: "swState" });
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      await registration?.update().catch(() => undefined);
      dispatch({ swState: registration ? "registered" : "absent", type: "swState" });
      const existing = await registration?.pushManager.getSubscription();
      dispatch({ endpoint: existing?.endpoint ?? null, type: "endpoint" });
    } catch {
      dispatch({ swState: "unknown", type: "swState" });
    }
  }

  useEffect(() => {
    const reason = detectSupport(config);
    dispatch({
      permission: "Notification" in window ? Notification.permission : "unknown",
      status: reason ? "Unavailable in this browser" : `Permission: ${Notification.permission}`,
      type: "supportDetected",
      unavailable: reason,
    });
    if (reason) {
      return;
    }
    let cancelled = false;
    detectExistingSubscription(dispatch, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [config]);

  async function enable() {
    if (!config.public_key) {
      return;
    }
    setBusy(true);
    setTestStatus(null);
    try {
      const registration = await navigator.serviceWorker.register("/pdpp-dashboard-sw.js");
      dispatch({ swState: "registered", type: "swState" });
      const result = await Notification.requestPermission();
      dispatch({ permission: result, type: "permission" });
      if (result !== "granted") {
        dispatch({
          status:
            result === "denied"
              ? "Permission denied. Enable notifications in browser settings."
              : "Permission was not granted.",
          type: "status",
        });
        return;
      }
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          applicationServerKey: urlBase64ToUint8Array(config.public_key),
          userVisibleOnly: true,
        }));
      const response = await fetch("/_ref/web-push/subscriptions", {
        body: JSON.stringify({
          device_label: "DataConnect browser",
          platform: navigator.platform || null,
          subscription: subscription.toJSON(),
        }),
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Subscription failed");
      }
      dispatch({
        endpoint: subscription.endpoint,
        status: "Web Push is enabled for this browser.",
        type: "subscribed",
      });
      await refreshSubscriptions();
    } catch (err) {
      dispatch({ status: err instanceof Error ? err.message : "Failed to enable Web Push.", type: "status" });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setTestStatus("Sending test notification…");
    try {
      const response = await fetch("/_ref/web-push/test", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Test notification failed");
      }
      const body = (await response.json()) as {
        attempted?: number;
        sent?: number;
        unavailable?: boolean;
      };
      if (body.unavailable) {
        setTestStatus("Web Push is unavailable on the server.");
      } else if ((body.sent ?? 0) > 0) {
        setTestStatus(`Test notification sent to ${body.sent} subscription${body.sent === 1 ? "" : "s"}.`);
      } else if ((body.attempted ?? 0) === 0) {
        setTestStatus("No active subscriptions for this owner. Turn on notifications first.");
      } else {
        setTestStatus("Push provider did not accept the test notification. Re-enable Web Push for this browser.");
      }
    } catch (err) {
      setTestStatus(err instanceof Error ? err.message : "Failed to send test notification.");
    } finally {
      setBusy(false);
    }
  }

  async function disable(targetEndpoint: string) {
    setBusy(true);
    setTestStatus(null);
    try {
      if (targetEndpoint === endpoint && hasNavigatorFeature("serviceWorker")) {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription?.endpoint === targetEndpoint) {
        await subscription.unsubscribe();
        }
      }
      const response = await fetch("/_ref/web-push/subscriptions", {
        body: JSON.stringify({ endpoint: targetEndpoint }),
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "DELETE",
      });
      if (!response.ok) {
        throw await webPushResponseError(response, "Unsubscribe failed");
      }
      setRemovedEndpoints((current) => [...current, targetEndpoint]);
      setConfirmingEndpoint(null);
      if (targetEndpoint === endpoint) {
        dispatch({ status: "Web Push is disabled for this browser.", type: "disabled" });
      }
      await refreshSubscriptions();
    } catch (err) {
      dispatch({ status: err instanceof Error ? err.message : "Failed to disable Web Push.", type: "status" });
    } finally {
      setBusy(false);
    }
  }

  // Per-device install reminder. Each browser/PWA install needs its own
  // pushManager.subscribe() — installing the PWA does not create a push
  // subscription on its own.
  const caveat =
    "Mobile browsers may require opening the installed DataConnect app before notifications can arrive. Each phone, tablet, and browser profile must be enabled separately.";

  const [lastSubscription] = currentSubscriptions;
  const matchesThisBrowser = isCurrentBrowserSubscriptionRegistered(endpoint, currentSubscriptions);
  const currentDeviceStatus = deviceStatus({ endpoint, matchesThisBrowser, permission, swState, unavailable });
  const setupSteps = buildSetupSteps({ endpoint, matchesThisBrowser, permission, testStatus, unavailable });

  const diagnostics = buildDiagnostics({
    config,
    endpoint,
    lastSubscription,
    matchesThisBrowser,
    permission,
    subscriptions: currentSubscriptions,
    swState,
  });

  const enabled = matchesThisBrowser && !unavailable;
  const checking = status === "Checking this browser…";
  const receivingDevices = currentSubscriptions.filter(
    (subscription) => !subscription.revoked_at && !removedEndpoints.includes(subscription.endpoint)
  );

  return (
    <section aria-label="Notification settings" className="grid gap-4">
      {unavailable ? (
        <p className="text-[15px] text-muted-foreground">
          {unavailableSentence(unavailable, !(config.enabled && config.public_key))}
        </p>
      ) : checking ? (
        <p aria-live="polite" className="text-[15px] text-muted-foreground" role="status">Checking this device…</p>
      ) : null}

      {!unavailable && !checking && !enabled ? (
        <button
          className={`${buttonVariants({ size: "sm", variant: "default" })} min-h-11 w-fit`}
          disabled={busy}
          onClick={enable}
          type="button"
        >
          Turn on notifications
        </button>
      ) : null}

      {receivingDevices.length > 0 ? (
        <ul aria-label="Devices receiving notifications" className="divide-y divide-border/70 border-y border-border/70">
          {receivingDevices.map((subscription) => {
            const label = receivingDeviceLabel(subscription, endpoint);
            const confirming = confirmingEndpoint === subscription.endpoint;
            return (
              <li className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={subscription.endpoint}>
                <p className="text-[15px] text-foreground">{label}</p>
                {confirming ? (
                  <div aria-label={`Turn off notifications for ${label}`} className="grid gap-2 sm:col-span-2" role="alertdialog">
                    <p className="text-[13px] text-muted-foreground">Turn off notifications for {label}? This device will stop receiving them.</p>
                    <div className="flex flex-wrap gap-2">
                      <button className="min-h-11 px-3 text-[13px] text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => void disable(subscription.endpoint)} type="button">Turn off</button>
                      <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirmingEndpoint(null)} type="button">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="min-h-11 w-fit px-3 text-[13px] text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => setConfirmingEndpoint(subscription.endpoint)} type="button">Turn off</button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <details
        className="border-t border-border/70"
        onToggle={(event) => {
          if (event.currentTarget.open) void refreshSubscriptionState();
        }}
      >
        <summary className="min-h-11 cursor-pointer py-3 text-[13px] text-muted-foreground">Details</summary>
        <WebPushSetupDetails
          busy={busy}
          caveat={caveat}
          detail={currentDeviceStatus.detail}
          diagnostics={diagnostics}
          endpoint={endpoint}
          confirmingEndpoint={confirmingEndpoint}
          lastSubscription={lastSubscription}
          onCancelRemoval={() => setConfirmingEndpoint(null)}
          onDisable={disable}
          onRemoveOldSubscription={() => endpoint && setConfirmingEndpoint(endpoint)}
          matchesThisBrowser={matchesThisBrowser}
          onTest={sendTest}
          onToggleDetails={async () => {
            const next = !showDetails;
            setShowDetails(next);
            if (next) await refreshSubscriptionState();
          }}
          setupSteps={setupSteps}
          showDetails={showDetails}
          serverNotReady={!(config.enabled && config.public_key)}
          status={status}
          subscriptionsCount={currentSubscriptions.length}
          testStatus={testStatus}
          unavailable={unavailable}
        />
      </details>
    </section>
  );
}

// The full, on-demand setup surface for a single browser/device: the buttons,
// the four-step checklist, the live status lines, and the diagnostics
// disclosure. Kept presentational (the parent owns device state, the async
// flows, and the disclosure toggles) so WebPushSettings stays a lean
// orchestrator and this dense block only mounts when the owner opens it.
function WebPushSetupDetails({
  detail,
  caveat,
  busy,
  unavailable,
  endpoint,
  matchesThisBrowser,
  confirmingEndpoint,
  onCancelRemoval,
  onDisable,
  onRemoveOldSubscription,
  onTest,
  setupSteps,
  status,
  testStatus,
  subscriptionsCount,
  lastSubscription,
  diagnostics,
  serverNotReady,
  showDetails,
  onToggleDetails,
}: {
  detail: string;
  caveat: string;
  busy: boolean;
  unavailable: string | null;
  endpoint: string | null;
  matchesThisBrowser: boolean;
  confirmingEndpoint: string | null;
  onCancelRemoval: () => void;
  onDisable: (endpoint: string) => void;
  onRemoveOldSubscription: () => void;
  onTest: () => void;
  setupSteps: SetupStep[];
  status: string;
  testStatus: string | null;
  subscriptionsCount: number;
  lastSubscription: WebPushSubscriptionSummary | undefined;
  diagnostics: DiagnosticRow[];
  serverNotReady: boolean;
  showDetails: boolean;
  onToggleDetails: () => void;
}) {
  return (
    <div className="mt-4 border-border/60 border-t pt-4" id="web-push-setup">
      <p className="pdpp-caption max-w-3xl text-muted-foreground">{detail}</p>
      <p className="pdpp-caption mt-1 max-w-3xl text-muted-foreground">{caveat}</p>
      {serverNotReady ? (
        <p className="pdpp-caption mt-1 max-w-3xl text-muted-foreground">
          Server environment: <code>PDPP_WEB_PUSH_VAPID_PUBLIC_KEY</code> and <code>PDPP_WEB_PUSH_VAPID_PRIVATE_KEY</code>.
        </p>
      ) : null}
      <div className="mt-4 grid gap-3 text-[13px] text-muted-foreground md:grid-cols-3">
        <p><strong className="text-foreground">Only owner-action alerts.</strong> Notifications are for sign-ins and syncs that need your attention.</p>
        <p><strong className="text-foreground">Headline only.</strong> The message does not contain private data and brings you back to the console for details.</p>
        <p><strong className="text-foreground">Per device.</strong> Each phone, computer, and app must be enabled separately.</p>
      </div>
      {endpoint && !matchesThisBrowser ? (
        <div className="mt-4 grid gap-2 border-border/60 border-t pt-3">
          {confirmingEndpoint === endpoint ? (
            <div aria-label="Remove this browser's old subscription" className="grid gap-2" role="alertdialog">
              <p className="text-[13px] text-muted-foreground">Remove this browser&apos;s old subscription?</p>
              <div className="flex gap-2">
                <button className="min-h-11 px-3 text-[13px] text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={() => onDisable(endpoint)} type="button">Remove subscription</button>
                <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onCancelRemoval} type="button">Cancel</button>
              </div>
            </div>
          ) : (
            <button className="min-h-11 w-fit px-1 text-[13px] text-muted-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={onRemoveOldSubscription} type="button">
              Remove this browser&apos;s old subscription
            </button>
          )}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy || !endpoint || Boolean(unavailable)}
          onClick={onTest}
          type="button"
        >
          Send test notification
        </button>
      </div>
      <ol className="mt-4 grid gap-2 md:grid-cols-4">
        {setupSteps.map((step) => (
          <li className={`rounded-md border px-3 py-2 ${setupStepToneClass(step.state)}`} key={step.label}>
            <div className="pdpp-caption flex items-center gap-2 font-medium">
              <span aria-hidden="true" className={`font-mono ${diagnosticToneClass(step.state)}`}>
                {diagnosticMarker(step.state)}
              </span>
              {step.label}
            </div>
            <p className="pdpp-caption mt-1 text-muted-foreground">{step.detail}</p>
          </li>
        ))}
      </ol>
      <div aria-atomic="true" aria-live="polite" role="status">
        <p className="pdpp-caption mt-3 text-muted-foreground">Last check: {status}</p>
        {testStatus ? <p className="pdpp-caption mt-3 text-muted-foreground">{testStatus}</p> : null}
      </div>
      {subscriptionsCount > 0 ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          {subscriptionsCount} saved browser subscription{subscriptionsCount === 1 ? "" : "s"}. Last status:{" "}
          {lastSubscription?.last_failure_reason || lastSubscription?.last_success_at || "not used yet"}.
        </p>
      ) : null}

      <DiagnosticsDisclosure diagnostics={diagnostics} expanded={showDetails} onToggle={onToggleDetails} />
    </div>
  );
}
