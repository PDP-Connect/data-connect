// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fakeRouteScenarios } from "@tnunamak/gozar/testing"
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs"

for (const known of [true, false]) {
  test(`reconcile authorizes new stop before writing or closing (${known ? "known" : "unknown"} handle)`, async t => {
    const root = await mkdtemp(
      join(process.env.TEST_TMPDIR ?? join(homedir(), ".tmp"), "rs-")
    )
    const scenario = fakeRouteScenarios()[0]
    let closes = 0
    let operationId
    const auth = []
    const api = await createOwnerHttpFixture(
      {
        async listRoutes() {
          return {
            routes: [{ ...scenario, operationId, ownership: "gozar-owned" }],
          }
        },
        async closeRoute() {
          closes++
          return {
            ...scenario,
            cleanup: { ...scenario.cleanup, state: "confirmed" },
          }
        },
      },
      { home: root, owner: "test" },
      root,
      randomUUID(),
      { instanceId: randomUUID(), bootId: randomUUID() },
      {},
      {
        acknowledgeDisconnect: async acknowledged => {
          auth.push(acknowledged)
          if (!acknowledged)
            throw Object.assign(new Error("Fixture refuses stop"), {
              code: "remote_disconnect_acknowledgment_required",
            })
        },
      }
    )
    t.after(async () => {
      await api.close()
      await rm(root, { recursive: true, force: true })
    })
    const created = await api.operations.start(
      "start",
      known ? scenario.handle : null,
      async () => {
        if (!known) throw new Error("Lost application response")
        return scenario
      }
    )
    operationId = created.operationId
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await api.operations.read(operationId)).stage !== "applying") break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const path = `/operations/${operationId}/reconcile`
    let requests = 0
    const original = api.operations.requestStop.bind(api.operations)
    api.operations.requestStop = async id => {
      requests++
      await original(id)
    }
    const refused = await api.request(path, {
      action: "stop",
      acknowledgeDisconnect: false,
    })
    assert.equal(
      refused.error?.code,
      "remote_disconnect_acknowledgment_required"
    )
    assert.deepEqual(auth, [false])
    assert.equal(requests, 0)
    assert.equal(closes, 0)
    assert.equal((await api.operations.read(operationId)).stopTombstone, false)

    assert.equal(
      (await api.request(path, { action: "stop", acknowledgeDisconnect: true }))
        .status,
      202
    )
    assert.equal(requests, 1)
    assert.equal(closes, 1)
    assert.equal((await api.operations.read(operationId)).stopTombstone, true)
    const replay = await api.request(path, { action: "check" })
    assert.equal(replay.status, 202)
    assert.equal(requests, 1)
    assert.equal(closes, 2)
    assert.ok(auth.slice(1).every(Boolean))
  })
}
