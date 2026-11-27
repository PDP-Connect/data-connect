// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createGozar } from "@tnunamak/gozar"
import { fakeRegistry } from "@tnunamak/gozar/testing"
import { createReachabilityService } from "../server/reachability/factory.ts"
import { mountOwnerReachability } from "../server/routes/owner-reachability.ts"
import { FixtureSecretBackend } from "./fixtures/reachability/secret-backend.ts"

async function fixture(t: test.TestContext, journal = false) {
  const parent = join(homedir(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "reach-earlier-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "state")
  await mkdir(home, { mode: 0o700 })
  const a = await fakeRegistry({
    id: "provider-a",
    kinds: ["session"],
    reach: "this-device",
    setupActions: [
      {
        id: "input",
        kind: "provide-value",
        label: "Enter value",
        digest: "input-v1",
        disclosure: { revision: "v1", text: "Fixture input", links: [] },
      },
    ],
    dir: join(root, "registry"),
  })
  const b = await fakeRegistry({
    id: "provider-b",
    kinds: ["session"],
    reach: "this-device",
    dir: a.root,
  })
  assert.ok(typeof a.manifest !== "string" && typeof b.manifest !== "string")
  const manifest = {
    providers: [...a.manifest.providers, ...b.manifest.providers],
  }
  const options = {
    manifest,
    root: a.root,
    secretBackend: new FixtureSecretBackend(),
    hostCapabilities: {},
    identity: { instanceId: "fixture", bootId: randomUUID() },
  }
  const scope = { home, owner: "owner", providerId: "provider-a" }
  const earlier = createGozar(options)
  const inventory = await earlier.listProviders(scope)
  const config = inventory.providers[0]!.configuration
  assert.notEqual(config.known, false)
  if (config.known === false) throw new Error("fixture blocked")
  const draft = await earlier.beginConfigurationDraft({
    ...scope,
    expectedConfigurationRevision: config.revision,
  })
  // Read the registry identity from the SDK's public setup consent.
  const fromRegistryId =
    draft.configuration.actions[0]?.consent?.scope.registryId
  assert.ok(fromRegistryId)
  if (journal) {
    // Earlier SDK writers saved only the hashed journal key, without a public operation id.
    const path = join(home, "embedding-state.json")
    const state = JSON.parse(await readFile(path, "utf8"))
    const key = createHash("sha256")
      .update(JSON.stringify([fromRegistryId, "earlier-operation"]))
      .digest("hex")
    state.setupOperations = {
      [key]: {
        scopeId: draft.scopeId,
        draftId: draft.draftId,
        state: "pending",
      },
    }
    await writeFile(path, JSON.stringify(state), { mode: 0o600 })
  }
  const service = await createReachabilityService(
    {
      ...options,
      registryLineage: { id: "successor", replaces: [fromRegistryId] },
    },
    {
      query: {
        ...scope,
        schemaVersion: 1,
        target: "unused",
        requirements: {
          address: "any",
          payloadAccess: "allow-provider",
          protocols: [],
          reach: "this-device",
          setup: "allow",
          transport: "any",
        },
      },
      prepare: async () => {},
      acknowledgeDisconnect: async () => {},
    }
  )
  t.after(() => service.closeObservers())
  const routes = new Map<string, any[]>()
  const app = {
    get: (path: string, ...handlers: any[]) =>
      routes.set(`GET ${path}`, handlers),
    post: (path: string, ...handlers: any[]) =>
      routes.set(`POST ${path}`, handlers),
  }
  const pass = () => {}
  mountOwnerReachability(app as never, {
    service,
    requireToken: pass,
    requireOwner: pass,
    requireCsrf: pass,
    operations: {} as never,
    setups: {} as never,
    usage: () => ({ kind: "session", lifetimeMs: 1000 }),
  })
  async function request(
    method: string,
    path: string,
    body?: unknown,
    params: Record<string, string> = {}
  ) {
    const handlers = routes.get(`${method} /v1/owner/reachability${path}`)
    assert.ok(handlers, `missing ${path}`)
    assert.equal(handlers[0], pass)
    assert.equal(handlers[1], pass)
    if (method === "POST") assert.equal(handlers[2], pass)
    let status = 200
    let payload: any
    const response = {
      setHeader() {},
      status(code: number) {
        status = code
        return response
      },
      json(data: unknown) {
        payload = data
      },
    }
    await handlers.at(-1)({ body, params }, response)
    return { status, ...payload }
  }
  const discard = (draftId = draft.draftId, registry = fromRegistryId) =>
    request(
      "POST",
      "/providers/:providerId/earlier-drafts/:draftId/discard",
      { fromRegistryId: registry, home: "ignored", owner: "ignored" },
      { providerId: scope.providerId, draftId }
    )
  return { request, discard, draft, fromRegistryId, home, options }
}

test("catalog isolates an earlier draft to its provider without exposing saved inputs", async t => {
  const f = await fixture(t)
  const response = await f.request("GET", "/catalog")
  assert.equal(response.status, 200)
  const [a, b] = response.data.providers
  assert.equal(a.configuration.known, false)
  assert.equal(a.configuration.reason, "configuration_migration_required")
  assert.deepEqual(a.configuration.migration.candidates, [
    {
      fromRegistryId: f.fromRegistryId,
      draftIds: [f.draft.draftId],
      unaddressableSetupOperations: 0,
    },
  ])
  assert.equal("values" in a.configuration, false)
  assert.equal("credentials" in a.configuration, false)
  assert.notEqual(b.configuration.known, false)
})

test("owner discards the exact earlier draft and a repeat after adoption is harmless", async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.discard(), {
    status: 200,
    data: { discarded: true },
  })
  const response = await f.request("GET", "/catalog")
  assert.equal(response.status, 200)
  assert.notEqual(response.data.providers[0].configuration.known, false)
  const before = await readFile(join(f.home, "embedding-state.json"), "utf8")
  assert.deepEqual(await f.discard(), {
    status: 200,
    data: { discarded: false },
  })
  assert.equal(
    await readFile(join(f.home, "embedding-state.json"), "utf8"),
    before
  )
})

test("an unaddressable setup journal reports no supported recovery and survives discard", async t => {
  const f = await fixture(t, true)
  const response = await f.request("GET", "/catalog")
  assert.equal(response.status, 200)
  const migration = response.data.providers[0].configuration.migration
  assert.deepEqual(migration.recovery, {
    available: false,
    reason: "unaddressable_setup_operations",
  })
  assert.equal(migration.candidates[0].unaddressableSetupOperations, 1)
  const refusal = await f.discard()
  assert.equal(refusal.status, 409)
  assert.equal(refusal.error.code, "configuration_migration_required")
  assert.equal(refusal.error.reason, "inflight")
})

test("an unknown earlier draft gets a bounded error without discarding the open draft", async t => {
  const f = await fixture(t)
  const response = await f.discard("unknown-draft")
  assert.equal(response.status, 409)
  assert.equal(response.error.code, "draft_not_found")
  assert.deepEqual(await f.discard(), {
    status: 200,
    data: { discarded: true },
  })
})

test("another lineage's claim is refused with the bounded taken reason", async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.discard(), {
    status: 200,
    data: { discarded: true },
  })
  const rival = createGozar({
    ...f.options,
    registryLineage: { id: "rival", replaces: [f.fromRegistryId] },
  })
  await rival.listProviders({ home: f.home, owner: "owner" })
  const response = await f.discard()
  assert.equal(response.status, 409)
  assert.equal(response.error.code, "configuration_migration_required")
  assert.equal(response.error.reason, "taken")
})
