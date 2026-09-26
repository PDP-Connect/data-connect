// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { LIVE_TOPICS } from "pdpp-reference-implementation/live-topics"
import {
  changedTopics,
  isSilent,
  LIVE_STALE_AFTER_MS,
  liveStatusMessage,
  reconnectDelayMs,
} from "./live-status.ts"

test("hello invalidates topics never seen and topics whose revision moved, nothing else", () => {
  const lastSeen = new Map([
    ["desktop.autostart", "a1"],
    ["remote-access", "r1"],
  ])
  assert.deepEqual(
    changedTopics(lastSeen, { "desktop.app-config": "c1", "desktop.autostart": "a2", "remote-access": "r1" }).sort(),
    ["desktop.app-config", "desktop.autostart"]
  )
})

test("the channel counts as silent only after the stale window", () => {
  assert.equal(isSilent(1000, 1000 + LIVE_STALE_AFTER_MS), false)
  assert.equal(isSilent(1000, 1001 + LIVE_STALE_AFTER_MS), true)
})

test("the degraded states say so explicitly; live and connecting say nothing", () => {
  assert.equal(liveStatusMessage("live", "10:42"), null)
  assert.equal(liveStatusMessage("connecting", "10:42"), null)
  assert.equal(
    liveStatusMessage("paused", "10:42"),
    "Live updates paused. Settings on this page were last read at 10:42. Reconnecting…"
  )
  assert.equal(
    liveStatusMessage("unsupported", "10:42"),
    "This connection does not support live updates. Values refresh when you return to this tab."
  )
})

test("reconnect backs off and a buffering proxy is retried rarely", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map(attempt => reconnectDelayMs("paused", attempt)),
    [1000, 2000, 5000, 10_000, 30_000, 30_000]
  )
  assert.equal(reconnectDelayMs("unsupported", 0), 60_000)
})

test("the settings surfaces subscribe only to topics the server registers", async () => {
  const { readFile } = await import("node:fs/promises")
  const here = new URL("../settings/", import.meta.url)
  for (const file of ["desktop-settings-setting.tsx", "remote-access-setting.tsx"]) {
    const source = await readFile(new URL(file, here), "utf8")
    const topics = [...source.matchAll(/useLive(?:Query|Mutation)\("([^"]+)"/g)].map(match => match[1])
    assert.ok(topics.length > 0, `${file} subscribes to a live topic`)
    for (const topic of topics) {
      assert.ok((LIVE_TOPICS as readonly string[]).includes(topic ?? ""), `${file}: ${topic} is not registered`)
    }
  }
})
