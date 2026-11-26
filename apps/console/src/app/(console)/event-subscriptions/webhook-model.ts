// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { ClientEventSubscriptionSummary } from "../lib/ref-client.ts"
export function webhookState(
  row: Pick<ClientEventSubscriptionSummary, "status" | "last_attempt_ok">
) {
  if (row.status === "pending_verification")
    return "Waiting for the app to confirm its address"
  if (
    row.status === "disabled_failure" ||
    (row.last_attempt_ok === false && row.status === "active")
  )
    return "The last message did not arrive"
  if (row.status !== "active") return "Stopped"
  return "Working"
}
export function buildWebhookPractice(
  state: string
): ClientEventSubscriptionSummary[] | null {
  if (state === "none") return []
  if (state !== "states") return null
  return (
    ["active", "pending_verification", "disabled_failure", "disabled"] as const
  ).map((status, index) => ({
    subscription_id: `practice-${index}`,
    client_id: `practice-app-${index}`,
    callback_host: "updates.example",
    status,
    last_attempt_ok: index === 2 ? false : null,
    created_at: "2026-11-24T10:00:00Z",
    updated_at: "2026-11-24T10:00:00Z",
    disabled_at: null,
    disabled_reason: null,
    final_failure_count: 0,
    grant_id: `practice-access-${index}`,
    last_attempt_status_code: null,
    last_attempted_at: null,
    pending_queue_count: 0,
  }))
}
