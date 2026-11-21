// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { createLiveRevisions } from "./live-revisions.ts"

const topic = "desktop.app-config"

function deferred() {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => { resolve = done })
  return { promise, resolve }
}

test("an older read cannot emit after a later bump or overwrite the baseline", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const a = deferred(), b = deferred()
  const reads = [a.promise, b.promise]
  const seen: string[] = []
  const live = createLiveRevisions({ tickMs: 5 })
  live.register(topic, () => reads.shift() ?? Promise.resolve("new"))
  const stop = live.subscribe((_topic, revision) => seen.push(revision))
  t.after(stop)

  live.bump(topic)
  live.bump(topic)
  b.resolve("new")
  await setImmediate()
  a.resolve("old")
  await setImmediate()
  assert.deepEqual(seen, ["new"])

  t.mock.timers.tick(5)
  await setImmediate()
  assert.deepEqual(seen, ["new"], "unchanged tick must not repeat the latest revision")
})

test("last unsubscribe leaves no baseline from a previous subscriber epoch", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  const pending = deferred()
  const live = createLiveRevisions({ tickMs: 5 })
  const reads = [pending.promise]
  live.register(topic, () => reads.shift() ?? Promise.resolve("current"))
  const stop = live.subscribe(() => assert.fail("old subscriber should not be called"))
  live.bump(topic)
  stop()
  pending.resolve("current")
  await setImmediate()

  const seen: string[] = []
  t.after(live.subscribe((_topic, revision) => seen.push(revision)))
  t.mock.timers.tick(5)
  await setImmediate()
  assert.deepEqual(seen, ["current"])
})
