// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createServiceVerifier } from "@tnunamak/gozar"
import { createTestingGozar, type TestingEffect } from "@tnunamak/gozar/testing"
import { mountServiceChallenge, SERVICE_CHALLENGE_PATH } from "../server/reachability/service-challenge.ts"
import { ReachabilityService } from "../server/reachability/service.ts"
import { FixtureSecretBackend } from "./fixtures/reachability/secret-backend.ts"
import { untrustedStatePathReason } from "./helpers/trusted-state-path.ts"

// The ownership challenge answers only for an origin the owner approved. These
// tests cover the three places approval lives: a review being shown, the origin
// an apply is starting, and a route the service holds. They run the real
// library and its own-address adapter against a real listener that mounts the
// real challenge route, so the library's proof fetch is answered or refused by
// the same gate a browser-facing request meets. The origin is never named in
// the host query: it lives only in the provider's committed configuration, as
// it does for a live own-address route.
const untrusted = untrustedStatePathReason(tmpdir())
const realLibrary = { skip: untrusted ? `the library refuses every state path here: ${untrusted}` : false, timeout: 60_000 }
// The repository's effect fixtures live outside this package's typecheck; load
// them by a computed path so their own strictness stays theirs.
const EFFECT_FIXTURES = "../../scripts/reachability/effect-fixtures.ts"
type EffectFixtures = {
  effects: TestingEffect[]
  registerOwnedProxy: (origin: string, target: string) => void
  close: () => Promise<void>
}
const ORIGIN = "https://fixture.invalid"
const PROVIDER = "own-address"


const hostCapabilities = Object.fromEntries(
  ["installer.execute", "privilege.elevate", "secrets.backend", "runtime.attached", "runtime.durable"].map((id) => [
    id,
    { known: true as const, value: id === "secrets.backend" || id.startsWith("runtime.") },
  ])
)

type Fixture = {
  ask: (host: string) => Promise<number>
  // Resolves when the library's proof fetch has reached the gate; `release` lets it go on.
  gate: { reached: Promise<void>; release: () => void }
  home: string
  newService: (bootId: string) => Promise<ReachabilityService>
  proofFetches: () => number
  use: (service: ReachabilityService) => void
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "reachability-challenge-approval-"))
  const { createEffectFixtures } = (await import(EFFECT_FIXTURES)) as { createEffectFixtures: () => EffectFixtures }
  const effects = createEffectFixtures()
  const secretBackend = new FixtureSecretBackend()
  const harnesses: { close(): Promise<unknown> }[] = []
  const services: ReachabilityService[] = []
  let current: ReachabilityService | undefined

  type Handler = Parameters<Parameters<typeof mountServiceChallenge>[0]["get"]>[1]
  let handler: Handler | undefined
  mountServiceChallenge({ get: (_path, h) => void (handler = h) }, createServiceVerifier(), (authority) =>
    current?.approvesChallengeAuthority(authority) ?? false
  )
  const server = createServer((req, res) => {
    const reply = {
      header: (name: string, value: string) => (res.setHeader(name, value), reply),
      send: (body?: string) => (res.end(body), reply),
      status: (code: number) => ((res.statusCode = code), reply),
    }
    handler?.({ raw: req }, reply)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const target = `127.0.0.1:${port}`
  effects.registerOwnedProxy(ORIGIN, target)

  // Hold the first proof fetch of the first start, so a test can ask while apply is in progress.
  let release = () => {}
  let reached = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const gate = { reached: new Promise<void>((resolve) => (reached = resolve)), release }
  let gated = false
  let fetches = 0
  const fetchEffect = effects.effects.find((effect) => effect.kind === "network" && effect.operation === "fetch")
  assert.ok(fetchEffect)
  const fetchHandler = fetchEffect.handle
  fetchEffect.handle = async (input: never, context: never) => {
    if (new URL((input as { url: string }).url).pathname === SERVICE_CHALLENGE_PATH) {
      fetches++
      if (!gated) {
        gated = true
        reached()
        await held
      }
    }
    return fetchHandler(input, context)
  }

  const ask = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const path = `${SERVICE_CHALLENGE_PATH}?nonce=${"ab".repeat(32)}`
      const req = request({ headers: { host }, host: "127.0.0.1", path, port }, (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      })
      req.on("error", reject)
      req.end()
    })

  // A new service over the same library home is what a restart leaves behind.
  const newService = async (bootId: string) => {
    const identity = { bootId, instanceId: "fixture-instance" }
    const harness = await createTestingGozar({ effects: effects.effects, hostCapabilities, identity, secretBackend })
    harnesses.push(harness)
    const service = new ReachabilityService(harness.gozar, {
      acknowledgeDisconnect: async () => undefined,
      hostCapabilities,
      identity,
      prepare: async () => undefined,
      query: {
        home,
        owner: "fixture-owner",
        requirements: {
          address: "any",
          payloadAccess: "allow-provider",
          protocols: [],
          reach: "internet",
          setup: "allow",
          transport: "https",
        },
        schemaVersion: 1,
        target,
      },
    })
    services.push(service)
    return service
  }
  try {
    await run({ ask, gate, home, newService, proofFetches: () => fetches, use: (service) => void (current = service) })
  } finally {
    release()
    for (const service of services) service.closeObservers()
    for (const harness of harnesses) await harness.close().catch(() => undefined)
    await effects.close()
    await new Promise((resolve) => (server.closeIdleConnections(), server.close(resolve)))
    rmSync(home, { force: true, recursive: true })
  }
}

// Draft, run every setup action the provider asks for, commit, then review: the
// state an owner is in right before consenting.
async function review(service: ReachabilityService, providerId = PROVIDER) {
  const provider = (await service.inventory()).providers.find((item) => item.providerId === providerId)
  assert.ok(provider)
  const draft = await service.begin(providerId, provider.configuration.revision)
  let revision = draft.configuration.revision
  for (const action of draft.configuration.actions.filter((item) => item.kind === "provide-value")) {
    assert.ok(action.consent)
    const configuration = await service.setup(draft.draftId, {
      actionId: action.id,
      approval: {
        consentFactsDigest: action.consent.consentFactsDigest,
        digest: action.digest,
        disclosureRevision: action.disclosure.revision,
        kind: "setup",
      },
      expectedRevision: revision,
      value: ORIGIN,
    })
    revision = configuration.revision
  }
  await service.commit(draft.draftId, revision)
  return service.review(draft.draftId, { kind: "durable", routeId: "owner-route" })
}

const consent = (shown: Awaited<ReturnType<typeof review>>) => ({
  acknowledgeDisconnect: false,
  consentFactsDigest: shown.candidate.consentFactsDigest,
  kind: "route" as const,
})

test("while apply starts the route, the challenge answers for the approved origin only, and apply publishes", realLibrary, async () => {
  await withFixture(async (fixture) => {
    const service = await fixture.newService("boot-1")
    fixture.use(service)
    const shown = await review(service)
    // Review reads the owner-kept address from the committed configuration, not from the host query.
    assert.equal(shown.query.origin, ORIGIN)
    const applying = service.apply("operation-1", shown.id, consent(shown))
    await fixture.gate.reached
    // The review is spent; only the origin being started approves now.
    assert.equal(await fixture.ask("fixture.invalid"), 200)
    assert.equal(await fixture.ask("other.invalid"), 404)
    fixture.gate.release()
    const route = await applying
    assert.equal(route.verification.status, "verified")
    assert.equal(route.published, ORIGIN)
    assert.equal(service.state().lifecycle.phase, "verified")
  })
})

// A provider that picks its own public address (a tunnel) has no origin to name
// at review time: the library allocates it while the route starts. For the
// length of that start the challenge answers any Host, and no longer.
test("a provider-chosen address: the challenge answers any Host while the route starts, then only the route's origin", realLibrary, async () => {
  await withFixture(async (fixture) => {
    const service = await fixture.newService("boot-1")
    fixture.use(service)
    const shown = await review(service, "tailscale-funnel")
    assert.equal(shown.query.origin, undefined)
    // Nothing is approved while the review is only shown: there is no origin to name.
    assert.equal(await fixture.ask("fixture.invalid"), 404)
    const applying = service.apply("operation-1", shown.id, consent(shown))
    await fixture.gate.reached
    assert.equal(await fixture.ask("anything.invalid"), 200)
    fixture.gate.release()
    const started = await applying
    assert.equal(started.verification.status, "verified")
    assert.equal(started.published, ORIGIN)
    assert.equal(await fixture.ask("other.invalid"), 404)
    assert.equal(await fixture.ask("fixture.invalid"), 200)
  })
})

test("a review being shown approves its origin and no other", realLibrary, async () => {
  await withFixture(async (fixture) => {
    const service = await fixture.newService("boot-1")
    fixture.use(service)
    assert.equal(await fixture.ask("fixture.invalid"), 404)
    await review(service)
    assert.equal(await fixture.ask("fixture.invalid"), 200)
    assert.equal(await fixture.ask("other.invalid"), 404)
  })
})

test("a route whose cleanup is confirmed no longer approves its origin", realLibrary, async () => {
  await withFixture(async (fixture) => {
    const service = await fixture.newService("boot-1")
    fixture.use(service)
    const shown = await review(service)
    const applying = service.apply("operation-1", shown.id, consent(shown))
    await fixture.gate.reached
    fixture.gate.release()
    const route = await applying
    assert.equal(await fixture.ask("fixture.invalid"), 200)
    const stopped = await service.stop(route.handle.id, route.handle.generation, true)
    assert.equal(stopped.cleanup.state, "confirmed")
    assert.equal(await fixture.ask("fixture.invalid"), 404)
  })
})

test("an own-address route: after a restart its origin is still approved and recovery leaves the route alone", realLibrary, async () => {
  await withFixture(async (fixture) => {
    const before = await fixture.newService("boot-1")
    fixture.use(before)
    const shown = await review(before)
    const applying = before.apply("operation-1", shown.id, consent(shown))
    await fixture.gate.reached
    fixture.gate.release()
    const started = await applying
    assert.equal(started.published, ORIGIN)

    const after = await fixture.newService("boot-2")
    fixture.use(after)
    assert.equal(await fixture.ask("fixture.invalid"), 404)
    assert.deepEqual(await after.recoverFromLibrary(), { closed: 0, failed: 0, reproved: 0 })
    assert.equal(await fixture.ask("fixture.invalid"), 200)
    assert.equal(await fixture.ask("other.invalid"), 404)
    // The service approves the origin but does not own the route: it holds nothing
    // to list, stop or clean up, and shutting it down leaves the route published.
    assert.equal(after.state().routes.length, 0)
    await after.shutdown(100, { requestStop: async () => {}, recordRecovered: async () => {}, recordCleanupUnconfirmed: async () => {} } as never)
    assert.equal(await fixture.ask("fixture.invalid"), 200)
  })
})
