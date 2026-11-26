import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCollectorPractice, collectorGroups } from "./collector-model.ts"
test("real-shaped collectors omit removed devices and bound the never-sent group", () => {
  const groups = collectorGroups(buildCollectorPractice("real")!)
  assert.deepEqual(
    groups.map(group => group.devices.length),
    [4, 5, 17]
  )
  assert.equal(groups[2]!.devices.slice(0, 5).length, 5)
})
test("empty collectors practice has no rows", () =>
  assert.equal(buildCollectorPractice("none")!.length, 0))
