import assert from "node:assert/strict"
import { test } from "node:test"
import { buildWebhookPractice, webhookState } from "./webhook-model.ts"
test("webhooks cover empty and each state without protocol words", () => {
  assert.equal(buildWebhookPractice("none")?.length, 0)
  const rows = buildWebhookPractice("states")!
  assert.deepEqual(rows.map(webhookState), [
    "Working",
    "Waiting for the app to confirm its address",
    "The last message did not arrive",
    "Stopped",
  ])
})
