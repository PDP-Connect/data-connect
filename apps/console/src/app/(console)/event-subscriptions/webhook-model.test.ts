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

test("webhook notices describe the subscription scope rather than assuming every record", async () => {
  const { webhookNotice, webhookHost } = await import("./webhook-model.ts")
  assert.match(webhookNotice(undefined), /not known/)
  assert.match(webhookNotice({ streams: [] }), /No record changes/)
  assert.match(
    webhookNotice({ streams: [{ name: "*" }] }),
    /your records change/
  )
  assert.match(
    webhookNotice({ streams: [{ name: "messages" }] }),
    /selected records/
  )
  assert.equal(webhookHost("127.0.0.1:9"), "An address on this computer")
})

test("practice rows print a different notice when their scope is narrower", async () => {
  const { practiceWebhookScope, webhookNotice } = await import("./webhook-model.ts")
  const notices = [0, 1, 2, 3].map(index => webhookNotice(practiceWebhookScope(index)))
  assert.equal(notices[0], "Told when your records change")
  assert.equal(notices[1], "Told when the selected records change")
  assert.ok(new Set(notices).size > 1)
})
