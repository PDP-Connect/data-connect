// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createServiceVerifier, type Usage } from "@tnunamak/gozar"
import { ReachabilityError } from "../server/reachability/approvals.ts"
import { createReachabilityService } from "../server/reachability/factory.ts"
import { mountServiceChallenge, SERVICE_CHALLENGE_PATH } from "../server/reachability/service-challenge.ts"
import type { ReachabilityService } from "../server/reachability/service.ts"
import { publicReachabilityError } from "../server/routes/owner-reachability.ts"
import { untrustedStatePathReason } from "./helpers/trusted-state-path.ts"
import { FixtureSecretBackend } from "./fixtures/reachability/secret-backend.ts"

// These tests run the real library and its real own-address adapter. The
// adapter's static definition says reach `unknown`; once an address is
// committed the adapter reports the reach of that address instead.
const PROVIDER = "own-address"
// The library checks ownership of every directory above its state home. Where
// the environment fails that check for any path (the repo test sandbox), these
// tests cannot run; run them outside the sandbox. The check itself stays as is.
const untrusted = untrustedStatePathReason(tmpdir())
const realLibrary = { skip: untrusted ? `the library refuses every state path here: ${untrusted}` : false }
const DURABLE: Usage = { kind: "durable", routeId: "owner-route" }
const ORIGIN = "https://fixture.invalid"
// The unspecified IPv6 address names no one host: the adapter reports its reach as unknown.
const UNKNOWN_REACH_ORIGIN = "https://[::]"

const hostCapabilities = Object.fromEntries(
  ["installer.execute", "privilege.elevate", "secrets.backend", "runtime.attached", "runtime.durable"].map((id) => [
    id,
    { known: true as const, value: id === "secrets.backend" || id.startsWith("runtime.") },
  ])
)

async function withService(run: (service: ReachabilityService) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "reachability-own-address-"))
  const service = await createReachabilityService(
    { hostCapabilities, identity: { bootId: "fixture-boot", instanceId: "fixture-instance" }, secretBackend: new FixtureSecretBackend() },
    {
      acknowledgeDisconnect: async () => undefined,
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
        target: "127.0.0.1:7663",
      },
    }
  )
  try {
    await run(service)
  } finally {
    service.closeObservers()
    rmSync(home, { force: true, recursive: true })
  }
}

// Draft, then set the address through the library's own setup action.
async function setUp(service: ReachabilityService, origin: string | null) {
  const inventory = await service.inventory()
  const provider = inventory.providers.find((item) => item.providerId === PROVIDER)
  assert.ok(provider)
  const draft = await service.begin(PROVIDER, provider.configuration.revision)
  if (origin === null) {
    return { draft, revision: draft.configuration.revision }
  }
  const action = draft.configuration.actions.find((item) => item.kind === "provide-value")
  assert.ok(action?.consent)
  const configuration = await service.setup(draft.draftId, {
    actionId: action.id,
    approval: {
      consentFactsDigest: action.consent.consentFactsDigest,
      digest: action.digest,
      disclosureRevision: action.disclosure.revision,
      kind: "setup",
    },
    expectedRevision: draft.configuration.revision,
    value: origin,
  })
  return { draft, revision: configuration.revision }
}

const refusal = (reason: string | null) => (error: unknown) =>
  error instanceof ReachabilityError && error.code === "unsupported" && error.reason === reason

test("a durable own-address route with a committed https address passes review with the reach the library reports", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, ORIGIN)
    await service.commit(draft.draftId, revision)
    const review = await service.review(draft.draftId, DURABLE)
    assert.equal(review.candidate.eligible, true)
    assert.ok(review.candidate.candidateToken)
    // The host asked for the reach the library reported and derived none itself.
    assert.equal(review.candidate.properties.reach, "internet")
    assert.equal(review.query.requirements.reach, review.candidate.properties.reach)
    assert.equal(service.state().lifecycle.phase, "review")
  })
})

test("an own-address route with no committed address fails review as unsupported, and the owner is told what to do", realLibrary, async () => {
  await withService(async (service) => {
    for (const origin of [null, ORIGIN]) {
      // The second case sets the address but leaves it uncommitted: the library
      // reads committed setup only, so its reach is still unknown.
      const { draft } = await setUp(service, origin)
      const refused: unknown = await service.review(draft.draftId, DURABLE).then(
        () => null,
        (caught: unknown) => caught
      )
      assert.ok(refusal("reach_unknown")(refused))
      const body = publicReachabilityError(refused)
      assert.equal(body.code, "unsupported")
      assert.match(body.message, /address/)
      assert.match(body.message, /commit/)
      await service.discard(draft.draftId)
    }
  })
})

test("a committed address whose reach the library cannot tell keeps failing closed", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, UNKNOWN_REACH_ORIGIN)
    await service.commit(draft.draftId, revision)
    await assert.rejects(service.review(draft.draftId, DURABLE), refusal("reach_unknown"))
    assert.notEqual(service.state().lifecycle.phase, "review")
  })
})

test("a declined committed-draft discard keeps the review", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, ORIGIN)
    await service.commit(draft.draftId, revision)
    await service.review(draft.draftId, DURABLE)
    assert.equal(service.state().lifecycle.phase, "review")
    assert.deepEqual(await service.discard(draft.draftId), { discarded: false })
    assert.equal(service.state().lifecycle.phase, "review")
    assert.equal(service.state().lifecycle.reason, null)
  })
})

// The real verifier and the real gate behind a bare listener, so the Host the
// verifier sees is the Host the request carries.
async function withChallenge(service: ReachabilityService, run: (ask: (host: string) => Promise<number>) => Promise<void>) {
  type Handler = Parameters<Parameters<typeof mountServiceChallenge>[0]["get"]>[1]
  let handler: Handler | undefined
  mountServiceChallenge({ get: (_path, h) => void (handler = h) }, createServiceVerifier(), (authority) =>
    service.approvesChallengeAuthority(authority)
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
  try {
    await run(ask)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("the ownership challenge is refused for a Host the owner did not approve", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, ORIGIN)
    await service.commit(draft.draftId, revision)
    await service.review(draft.draftId, DURABLE)
    await withChallenge(service, async (ask) => {
      assert.equal(await ask("other.invalid"), 404)
      assert.equal(await ask("fixture.invalid.evil.invalid"), 404)
      // Refusing the challenge leaves the review as it was: nothing was published.
      assert.equal(service.state().lifecycle.phase, "review")
    })
  })
})

test("the ownership challenge verifies for the approved Host, in the verifier's own canonical form", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, ORIGIN)
    await service.commit(draft.draftId, revision)
    await service.review(draft.draftId, DURABLE)
    await withChallenge(service, async (ask) => {
      assert.equal(await ask("fixture.invalid"), 200)
      // The verifier folds case and drops the default HTTPS port; the gate follows it.
      assert.equal(await ask("FIXTURE.Invalid"), 200)
      assert.equal(await ask("fixture.invalid:443"), 200)
      assert.equal(await ask("fixture.invalid:8443"), 404)
    })
  })
})

test("a declined discard preserves the review and its approved challenge origin", realLibrary, async () => {
  await withService(async (service) => {
    const { draft, revision } = await setUp(service, ORIGIN)
    await service.commit(draft.draftId, revision)
    await service.review(draft.draftId, DURABLE)
    assert.deepEqual(await service.discard(draft.draftId), { discarded: false })
    await withChallenge(service, async (ask) => {
      assert.equal(await ask("fixture.invalid"), 200)
    })
  })
})
