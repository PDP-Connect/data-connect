// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ClientEventSubscriptionSummary } from "../lib/ref-client.ts";
import { subscriptionFailureSentence } from "./row-copy.ts";

function subscription(overrides: Partial<ClientEventSubscriptionSummary> = {}): ClientEventSubscriptionSummary {
  return {
    callback_host: "example.com",
    client_id: "client-1",
    created_at: "2026-11-25T12:00:00.000Z",
    disabled_at: null,
    disabled_reason: null,
    final_failure_count: 0,
    grant_id: "grant-1",
    last_attempt_ok: false,
    last_attempt_status_code: null,
    last_attempted_at: "2026-11-25T12:00:00.000Z",
    pending_queue_count: 0,
    status: "pending_verification",
    subscription_id: "subscription-1",
    updated_at: "2026-11-25T12:00:00.000Z",
    ...overrides,
  };
}

test("webhook row states a failed verification or latest delivery plainly", () => {
  // round5 item 3: the page has a boolean result, but no evidence for timeout versus rejection.
  assert.equal(
    subscriptionFailureSentence(subscription()),
    "Not confirmed yet: the last delivery failed.",
  );
  assert.equal(
    subscriptionFailureSentence(subscription({ status: "active" })),
    "The last delivery failed.",
  );
  assert.equal(subscriptionFailureSentence(subscription({ last_attempt_ok: true })), null);
  assert.equal(subscriptionFailureSentence(subscription({ last_attempt_ok: null })), null);
});
