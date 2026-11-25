// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ClientEventSubscriptionSummary } from "../lib/ref-client.ts";

export function subscriptionFailureSentence(
  subscription: Pick<ClientEventSubscriptionSummary, "last_attempt_ok" | "status">,
): string | null {
  if (subscription.last_attempt_ok !== false) return null;
  return subscription.status === "pending_verification"
    ? "Not confirmed yet: the last delivery failed."
    : "The last delivery failed.";
}
