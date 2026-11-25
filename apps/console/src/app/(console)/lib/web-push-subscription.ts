// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Subscribe this browser to the server's Web Push key. A push service rejects
// a send signed with a different key than the one a subscription was created
// under, so an existing subscription made under another key is replaced.

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function sameBytes(buffer: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!buffer || buffer.byteLength !== expected.length) {
    return false;
  }
  const actual = new Uint8Array(buffer);
  return expected.every((byte, index) => byte === actual[index]);
}

interface PushManagerLike {
  getSubscription: () => Promise<PushSubscription | null>;
  subscribe: (options: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => Promise<PushSubscription>;
}

/** Whether `subscription` was created under `serverPublicKey`, so a send signed with it can reach the browser. */
export function isUnderServerKey(subscription: Pick<PushSubscription, "options">, serverPublicKey: string): boolean {
  return sameBytes(subscription.options.applicationServerKey, urlBase64ToUint8Array(serverPublicKey));
}

/** The browser's subscription under `serverPublicKey`, replacing one created under a different key. */
export async function subscribeWithServerKey(
  pushManager: PushManagerLike,
  serverPublicKey: string
): Promise<PushSubscription> {
  const existing = await pushManager.getSubscription();
  if (existing) {
    if (isUnderServerKey(existing, serverPublicKey)) {
      return existing;
    }
    await existing.unsubscribe();
  }
  return pushManager.subscribe({ applicationServerKey: urlBase64ToUint8Array(serverPublicKey), userVisibleOnly: true });
}
