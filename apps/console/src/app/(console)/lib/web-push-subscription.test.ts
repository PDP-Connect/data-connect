// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { subscribeWithServerKey } from "./web-push-subscription.ts";

// base64url of bytes 1, 2, 3 and of bytes 9, 9, 9.
const SERVER_KEY = "AQID";
const OTHER_KEY = "CQkJ";

function bufferOf(...bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function fakeSubscription(applicationServerKey: ArrayBuffer | null, onUnsubscribe: () => void) {
  return {
    options: { applicationServerKey },
    unsubscribe: () => {
      onUnsubscribe();
      return Promise.resolve(true);
    },
  } as unknown as PushSubscription;
}

function fakePushManager(existing: PushSubscription | null) {
  const created = { endpoint: "https://push.example.test/new" } as unknown as PushSubscription;
  const calls: { subscribedWith: Uint8Array | null } = { subscribedWith: null };
  return {
    calls,
    created,
    manager: {
      getSubscription: () => Promise.resolve(existing),
      subscribe: (options: { applicationServerKey: Uint8Array }) => {
        calls.subscribedWith = options.applicationServerKey;
        return Promise.resolve(created);
      },
    },
  };
}

test("a browser with no subscription subscribes under the server key", async () => {
  const push = fakePushManager(null);
  assert.equal(await subscribeWithServerKey(push.manager, SERVER_KEY), push.created);
  assert.deepEqual([...(push.calls.subscribedWith ?? [])], [1, 2, 3]);
});

test("an existing subscription under the server key is reused", async () => {
  let unsubscribed = false;
  const existing = fakeSubscription(bufferOf(1, 2, 3), () => {
    unsubscribed = true;
  });
  const push = fakePushManager(existing);
  assert.equal(await subscribeWithServerKey(push.manager, SERVER_KEY), existing);
  assert.equal(unsubscribed, false);
  assert.equal(push.calls.subscribedWith, null);
});

test("an existing subscription under a different key is replaced", async () => {
  let unsubscribed = false;
  const existing = fakeSubscription(bufferOf(1, 2, 3), () => {
    unsubscribed = true;
  });
  const push = fakePushManager(existing);
  assert.equal(await subscribeWithServerKey(push.manager, OTHER_KEY), push.created);
  assert.equal(unsubscribed, true);
  assert.deepEqual([...(push.calls.subscribedWith ?? [])], [9, 9, 9]);
});

test("an existing subscription with no recorded key is replaced", async () => {
  let unsubscribed = false;
  const existing = fakeSubscription(null, () => {
    unsubscribed = true;
  });
  const push = fakePushManager(existing);
  assert.equal(await subscribeWithServerKey(push.manager, SERVER_KEY), push.created);
  assert.equal(unsubscribed, true);
});
