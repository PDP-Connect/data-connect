// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { buildPendingInteractionPushPayload } from "../server/web-push-notifications.ts"
for (const [kind, sentence] of [
  ["credentials", "Open DataConnect to finish signing in."],
  ["otp", "Open DataConnect to continue this sync."],
  ["manual_action", "Open DataConnect to continue this sync."],
  ["unknown", "Open DataConnect to continue this sync."],
]) {
  test(`lock-screen copy follows ${kind} without copying private interaction text`, () => {
    const payload = buildPendingInteractionPushPayload({
      connectorDisplayName: "Example",
      interaction: { kind, message: "private content", request_id: "practice" },
      runId: "practice",
    })
    assert.equal(payload.body, sentence)
    assert.doesNotMatch(JSON.stringify(payload), /private content/)
  })
}
test("the service-worker fallback uses the product name and a neutral next step", async () => {
  const text = await readFile(
    new URL("../../apps/console/public/pdpp-dashboard-sw.ts", import.meta.url),
    "utf8"
  )
  assert.match(text, /DataConnect needs you/)
  assert.match(text, /Open DataConnect to see what it needs/)
  assert.doesNotMatch(
    text,
    /PDPP action needed|A connector run needs owner attention/
  )
})
