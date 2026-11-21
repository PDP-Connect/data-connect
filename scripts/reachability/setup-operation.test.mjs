// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createGozar, createServiceVerifier } from "@tnunamak/gozar"
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts"
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs"
import { setupApproval } from "./journey-support.mjs"
import { createSetupRegistry } from "./setup-registry.mjs"

async function fixture(t) {
  const root = await mkdtemp(
    join(process.env.TEST_TMPDIR ?? join(homedir(), ".tmp"), "setup-")
  )
  const clients = []
  const registry = await createSetupRegistry(join(root, "registry"))
  const backend = new FixtureSecretBackend()
  const identity = { instanceId: randomUUID(), bootId: randomUUID() }
  const hostCapabilities = { "runtime.attached": { known: true, value: true } }
  const create = () =>
    createGozar({
      manifest: registry.manifest,
      root: registry.root,
      secretBackend: backend,
      identity,
      hostCapabilities,
    })
  const serviceVerifier = createServiceVerifier()
  const appBytes = randomUUID()
  const app = createServer((req, res) => {
    if (!serviceVerifier(req, res)) res.end(appBytes)
  }).listen(0, "127.0.0.1")
  await once(app, "listening")
  t.after(async () => {
    const current = clients[0]
    if (current) {
      for (const route of current.service.state().routes) {
        if (route.cleanup.state !== "confirmed") {
          await current.service.stop(
            route.handle.id,
            route.handle.generation,
            true
          )
        }
      }
    }
    await Promise.all(clients.map(client => client.close()))
    await new Promise(resolve => app.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const query = {
    schemaVersion: 1,
    home: join(root, "gozar"),
    owner: "fixture-owner",
    target: `127.0.0.1:${app.address().port}`,
    requirements: {
      reach: "this-device",
      transport: "any",
      payloadAccess: "allow-provider",
      address: "any",
      setup: "allow",
      protocols: [],
    },
  }
  const secret = randomUUID()
  const open = async (owner = query.owner) => {
    const client = await createOwnerHttpFixture(
      create(),
      { ...query, owner },
      root,
      secret,
      identity,
      hostCapabilities
    )
    clients.push(client)
    return client
  }
  const api = await open()
  const [provider] = (await api.call("/catalog")).providers
  const draft = await api.call("/drafts", {
    providerId: registry.id,
    expectedRevision: provider.configuration.revision,
  })
  const path = `/setup-operations/${randomUUID()}`
  const reference = { providerId: registry.id, draftId: draft.draftId }
  const initial = {
    ...reference,
    actionId: draft.configuration.actions[0].id,
    expectedConfigurationRevision: draft.configuration.revision,
    expectedSetupRevision: 0,
  }
  return {
    api,
    registry,
    draft,
    path,
    reference,
    initial,
    open,
    backend,
    secret,
    appBytes,
    read: (client = api) => client.call(`${path}?providerId=${registry.id}`),
    start: () => api.call(path, initial),
    command: (view, extra = {}) => ({
      ...reference,
      actionId: view.nextAction.id,
      expectedConfigurationRevision: view.scope.configurationRevision,
      expectedSetupRevision: view.revision,
      approval: setupApproval(view.nextAction),
      ...extra,
    }),
  }
}

test("owner reserves setup without effects and returns a safe current offer", async t => {
  const f = await fixture(t)
  const [action] = f.draft.configuration.actions
  assert.equal(action.kind, "open-url")
  const reserved = await f.start()
  assert.equal(reserved.state, "pending")
  assert.equal(reserved.nextAction.step.actor, "owner")
  assert.equal(reserved.nextAction.href, undefined)
  assert.deepEqual(reserved.nextAction.consent.scope.operation, {
    id: reserved.operationId,
    revision: reserved.revision,
  })
  assert.ok(!JSON.stringify(reserved).includes("Inventory only"))
  assert.deepEqual(await f.start(), reserved)
  assert.deepEqual((await f.registry.readWorld()).effects, [])
})

test("browser return observes pending, and denial or expiry survives a new owner service", async t => {
  for (const state of ["denied", "expired"]) {
    await t.test(state, async t => {
      const f = await fixture(t)
      const pending = await f.start()
      const handoffPath = `${f.path}/handoff`
      const command = f.command(pending)
      const { handoff } = await f.registry.readWorld()
      assert.equal(
        (await f.api.request(handoffPath, command, { anonymous: true })).status,
        401
      )
      assert.equal(
        (await f.api.request(handoffPath, command, { noCsrf: true })).status,
        403
      )
      assert.equal(
        (
          await f.api.request(handoffPath, {
            ...command,
            expectedSetupRevision: pending.revision + 1,
          })
        ).error?.code,
        "setup_scope_mismatch"
      )
      assert.deepEqual(await f.api.call(handoffPath, command), {
        href: handoff,
      })
      const defaultRead = await f.api.call(
        `${f.path}?providerId=${f.registry.id}&includeBrowserHandoff=true`
      )
      assert.ok(!JSON.stringify(defaultRead).includes(handoff))
      assert.ok(!JSON.stringify(await f.api.call("/catalog")).includes(handoff))
      assert.ok(!JSON.stringify(await f.api.call("/state")).includes(handoff))
      assert.ok(!JSON.stringify(await f.api.call("/events")).includes(handoff))
      assert.ok(!f.api.logs.join("").includes(handoff))

      const restarted = await f.open()
      assert.equal((await f.read(restarted)).state, "pending")
      const otherOwner = await f.open("other-owner")
      const wrongOwner = await otherOwner.request(
        `${f.path}?providerId=${f.registry.id}`
      )
      assert.equal(wrongOwner.error?.code, "configuration_stale")

      await f.registry.updateWorld({ grant: state })
      assert.equal((await f.read(restarted)).state, state)
      assert.equal((await restarted.request(handoffPath, command)).status, 409)
      assert.deepEqual((await f.registry.readWorld()).effects, [])
    })
  }
})

test("a cancelled setup remains readable and rejects stale approval", async t => {
  const f = await fixture(t)
  await f.start()
  await f.registry.updateWorld({ grant: "verified" })
  const choice = await f.read()
  const cancelled = await f.api.call(`${f.path}/cancel`, {
    providerId: f.registry.id,
  })
  assert.equal(cancelled.state, "cancelled")
  assert.equal(cancelled.nextAction, null)
  const repeated = await f.api.call(`${f.path}/cancel`, {
    providerId: f.registry.id,
  })
  assert.equal(repeated.state, cancelled.state)
  assert.equal(repeated.revision, cancelled.revision)
  const failure = await f.api.request(
    f.path,
    f.command(choice, { value: "opaque-account" })
  )
  assert.equal(failure.error?.code, "setup_scope_mismatch")
  assert.deepEqual((await f.registry.readWorld()).effects, [])
})

test("fresh choice, secret, provisioning, real route proof and exact cleanup use separate authority", async t => {
  const f = await fixture(t)
  const pending = await f.start()
  await f.registry.updateWorld({ grant: "verified" })
  const choice = await f.read()
  assert.equal(choice.evidence.known, true)
  assert.equal(choice.nextAction.kind, "provide-value")
  assert.deepEqual((await f.registry.readWorld()).effects, [])

  const machine = f.command(choice)
  delete machine.approval
  assert.equal(
    (await f.api.call(f.path, machine)).state,
    "authorization-required"
  )
  assert.equal(
    (await f.api.request(f.path, f.command(choice, { value: "unoffered" })))
      .error?.code,
    "invalid_input"
  )
  assert.equal(
    (
      await f.api.request(
        f.path,
        f.command(choice, {
          value: "opaque-account",
          approval: setupApproval(pending.nextAction),
        })
      )
    ).error?.code,
    "consent_changed"
  )
  const option = choice.nextAction.step.options[0]
  const intake = await f.api.call(
    f.path,
    f.command(choice, { value: option.value })
  )
  assert.equal(intake.nextAction.kind, "provide-secret")
  const staleIntake = await f.api.request(
    f.path,
    f.command(intake, {
      draftId: randomUUID(),
      secret: f.secret,
    })
  )
  assert.equal(staleIntake.error?.code, "setup_scope_mismatch")
  assert.deepEqual(f.backend.handles(), [])
  assert.ok(!f.backend.trace.some(event => event === "put"))
  const provision = await f.api.call(
    f.path,
    f.command(intake, { secret: f.secret })
  )
  assert.equal(provision.nextAction.step.purpose, "provision")
  assert.equal((await f.registry.readWorld()).secretObserved, true)
  assert.equal((await f.registry.readWorld()).created, undefined)
  assert.deepEqual(f.backend.handles(), [])
  assert.equal(
    (
      await f.api.request(
        f.path,
        f.command(provision, { approval: setupApproval(intake.nextAction) })
      )
    ).error?.code,
    "consent_changed"
  )

  const allocation = f.command(provision)
  const complete = await f.api.call(f.path, allocation)
  assert.equal(complete.state, "complete")
  assert.equal(complete.resources[0].ownership, "owned")
  assert.equal(complete.nextAction, null)
  assert.equal(
    (await f.api.request(f.path, allocation)).error?.code,
    "setup_scope_mismatch"
  )
  const firstWorld = await f.registry.readWorld()
  assert.deepEqual(firstWorld.effects, ["account", "key", "create"])

  const fresh = await f.api.call(
    `/drafts/${f.draft.draftId}?providerId=${f.registry.id}`
  )
  await f.api.call(`/drafts/${f.draft.draftId}/commit`, {
    expectedRevision: fresh.configuration.revision,
  })
  const review = await f.api.call(`/drafts/${f.draft.draftId}/review`, {
    usage: "attached",
  })
  const result = await f.api.call("/operations", {
    kind: "route",
    reviewId: review.id,
    consentFactsDigest: review.candidate.consentFactsDigest,
  })
  const wait = async id => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const operation = await f.api.call(`/operations/${id}`)
      if (operation.stage !== "applying") return operation
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(
      `Route operation did not settle: ${JSON.stringify(f.api.diagnostics)}`
    )
  }
  const applied = await wait(result.operationId)
  assert.equal(applied.failureCode, null, JSON.stringify(f.api.diagnostics))
  const [route] = (await f.api.call("/state")).routes
  assert.equal(route.verification.status, "verified")
  assert.equal(
    route.verification.subject.target,
    route.hostConfiguration.target.value
  )
  assert.ok(route.verification.checks.includes("nonce"))
  assert.equal(await (await fetch(route.published)).text(), f.appBytes)

  const cleanup = await f.api.call(`${f.path}/cancel`, {
    providerId: f.registry.id,
  })
  assert.equal(cleanup.state, "cancelled")
  assert.equal(cleanup.nextAction.step.purpose, "stop-connector")
  assert.equal(cleanup.resources[0].removal, "required")
  assert.deepEqual((await f.registry.readWorld()).effects, firstWorld.effects)

  const stop = await f.api.call(`/routes/${route.handle.id}/stop`, {
    generation: route.handle.generation,
    acknowledgeDisconnect: true,
  })
  assert.equal((await wait(stop.operationId)).failureCode, null)
  await assert.rejects(fetch(route.published))
  await f.registry.updateWorld({ assisted: true })
  const retained = await f.read()
  assert.equal(retained.nextAction.kind, "instructions")
  assert.equal(retained.state, "cancelled")
  assert.equal(retained.resources[0].removal, "required")
  await f.registry.updateWorld({ assisted: false })
  const removable = await f.read()
  assert.equal(removable.nextAction.step.purpose, "remove-resource")
  const removed = await f.api.call(f.path, f.command(removable))
  assert.equal(removed.resources[0].removal, "confirmed")
  const finalWorld = await f.registry.readWorld()
  assert.equal(finalWorld.owned, undefined)
  assert.equal(finalWorld.foreign, firstWorld.foreign)
  assert.deepEqual(finalWorld.effects, ["account", "key", "create", "remove"])
})
