// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Why Web Push cannot run on this device, and what the owner can do about it.
// Pure: the caller reports what it observed, so each cause is testable without
// a browser.

export interface WebPushCapabilities {
  hasNotificationApi: boolean;
  hasPushManager: boolean;
  hasServiceWorker: boolean;
  isSecureContext: boolean;
  permission: NotificationPermission | "unknown";
  serverEnabled: boolean;
}

export type WebPushUnavailableCause =
  | "insecure-context"
  | "no-service-worker"
  | "no-push-api"
  | "no-notification-api"
  | "server-not-configured"
  | "permission-denied";

export interface WebPushUnavailableCopy {
  detail: string;
  title: string;
}

/** The first failed check, in the order the browser needs them. Null when this device can be set up. */
export function webPushUnavailableCause(capabilities: WebPushCapabilities): WebPushUnavailableCause | null {
  if (!capabilities.isSecureContext) {
    return "insecure-context";
  }
  if (!capabilities.hasServiceWorker) {
    return "no-service-worker";
  }
  if (!capabilities.hasPushManager) {
    return "no-push-api";
  }
  if (!capabilities.hasNotificationApi) {
    return "no-notification-api";
  }
  if (!capabilities.serverEnabled) {
    return "server-not-configured";
  }
  if (capabilities.permission === "denied") {
    return "permission-denied";
  }
  return null;
}

// Every device cause points at the two paths that work: an installed app on
// this computer, or a phone. No copy implies that alerts are mobile-only.
const DEVICE_ALTERNATIVE =
  "Install DataConnect as an app in Chrome or Edge on this computer, or enable alerts on a phone.";

const COPY: Readonly<Record<WebPushUnavailableCause, WebPushUnavailableCopy>> = {
  "insecure-context": {
    detail:
      "This address is not secure, so browsers block alerts here. Open DataConnect at an HTTPS address or on localhost.",
    title: "Notifications need HTTPS or localhost.",
  },
  "no-service-worker": {
    detail: `It does not support the service workers that deliver alerts. ${DEVICE_ALTERNATIVE}`,
    title: "This browser cannot receive notifications.",
  },
  "no-push-api": {
    detail: `It does not support the Push API. ${DEVICE_ALTERNATIVE}`,
    title: "This browser cannot receive push notifications.",
  },
  "no-notification-api": {
    detail: `It does not support the Notification API. ${DEVICE_ALTERNATIVE}`,
    title: "This browser cannot show notifications.",
  },
  "server-not-configured": {
    detail:
      "The server has no VAPID keys, so it cannot send alerts to any device. Add them to the server configuration and restart the server.",
    title: "Alerts are not set up on this server.",
  },
  "permission-denied": {
    detail: "Allow notifications for this site in browser or system settings, then reload this page.",
    title: "Notifications are blocked for this browser.",
  },
};

export function describeWebPushUnavailable(cause: WebPushUnavailableCause): WebPushUnavailableCopy {
  return COPY[cause];
}
