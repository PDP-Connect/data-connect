// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, rm, statfs } from "node:fs/promises"
import http from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts"
import { createEffectFixtures } from "./effect-fixtures.ts"
import { prepareDraft } from "./journey-support.mjs"
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs"
import { createEffectFixtureHost } from "./testing-effects.mjs"

async function assertNoSecretBytes(root, secret) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await assertNoSecretBytes(path, secret)
    else if (entry.isFile())
      assert.equal(
        (await readFile(path)).includes(Buffer.from(secret)),
        false,
        "Credential canary reached a Gozar file"
      )
  }
}

const hostCapabilities = Object.fromEntries(
  [
    "installer.execute",
    "privilege.elevate",
    "secrets.backend",
    "runtime.attached",
    "runtime.durable",
  ].map(id => [id, { known: true, value: id !== "privilege.elevate" }])
)

async function settle(api, operationId) {
  const deadline = Date.now() + 15000
  for (;;) {
    const operation = await api.call(`/operations/${operationId}`)
    if (operation.stage !== "applying") return operation
    if (Date.now() >= deadline)
      throw Object.assign(new Error("Owner operation did not settle"), {
        code: "operation_timeout",
      })
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test(
  "SDK safe refusal stays unpublished and retains unknown allocation cleanup debt",
  { timeout: 30000 },
  async () => {
    const disk = await statfs(process.cwd())
    assert.ok(
      disk.bavail * disk.bsize >= 105_000_000_000,
      "NOT RUN (disk): need 105 GB free"
    )
    const parent = join(homedir(), ".tmp", "ra")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const root = await mkdtemp(join(parent, "sdk-refusal-"))
    const home = join(root, "gozar"),
      owner = "fixture-owner"
    const backend = new FixtureSecretBackend(),
      canary = randomBytes(32).toString("hex"),
      identity = { instanceId: randomUUID(), bootId: randomUUID() }
    const effects = createEffectFixtures({ sdkOpenFailure: true })
    const harness = await createEffectFixtureHost(
      { secretBackend: backend, hostCapabilities, identity },
      effects.effects
    )
    const app = http.createServer((_request, response) =>
      response.end("fixture application")
    )
    app.listen(0, "127.0.0.1")
    await once(app, "listening")
    let api,
      primaryFailure,
      cleanupDebtExpected = false
    try {
      const inventory = await harness.gozar.listProviders({ home, owner })
      const matching = inventory.providers.filter(
        provider =>
          provider.transport === "https" &&
          provider.availability.attached.state === "action-required" &&
          provider.configuration.actions.some(
            action => action.kind === "provide-secret"
          ) &&
          provider.configuration.inputRequirements.some(
            field => field.kind === "domain"
          )
      )
      assert.equal(
        matching.length,
        1,
        "The installed inventory must declare one HTTPS adapter with a secret and domain input"
      )
      const provider = matching[0]
      const query = {
        schemaVersion: 1,
        home,
        owner,
        target: `127.0.0.1:${app.address().port}`,
        providerId: provider.providerId,
        usage: { kind: "attached" },
        requirements: {
          reach: provider.reach,
          transport: "https",
          payloadAccess: "allow-provider",
          address: "any",
          setup: "allow",
          protocols: [],
        },
      }
      api = await createOwnerHttpFixture(
        harness.gozar,
        query,
        root,
        canary,
        identity,
        hostCapabilities
      )
      const draft = await prepareDraft(
        api,
        provider,
        canary,
        harness.events,
        backend
      )
      await api.call(`/drafts/${draft.draftId}/commit`, {
        expectedRevision: draft.configuration.revision,
      })
      const review = await api.call(`/drafts/${draft.draftId}/review`, {
        usage: "attached",
      })
      assert.equal(review.candidate.consent.scope.kind, "route")
      const accepted = await api.call("/operations", {
        reviewId: review.id,
        kind: "route",
        consentFactsDigest: review.candidate.consent.consentFactsDigest,
        acknowledgeDisconnect: true,
      })
      const outcome = await settle(api, accepted.operationId)
      assert.equal(outcome.stage, "unknown-possibly-live")
      assert.equal(typeof outcome.failureCode, "string")
      assert.match(outcome.failureCode, /^[a-z][a-z0-9_]*$/)
      const state = await api.call("/state")
      const failed = state.routes.find(
        route => route.operationId === accepted.operationId
      )
      assert.ok(failed, "The partial route must remain enumerable")
      assert.equal(failed.published, null)
      assert.notEqual(failed.verification.status, "verified")
      assert.equal(failed.cleanup.state, "unconfirmed")
      assert.ok(
        failed.cleanup.nextAction,
        "Unknown allocation must retain a cleanup action"
      )
      cleanupDebtExpected = true
      const canaryReads = JSON.stringify({
        events: harness.events,
        responses: api.responses,
        logs: api.logs,
      }).includes(canary)
      assert.equal(canaryReads, false)
      for (const handle of backend.issuedHandles())
        assert.equal(
          JSON.stringify({
            events: harness.events,
            responses: api.responses,
            logs: api.logs,
          }).includes(handle),
          false,
          "Secret handle reached an owner response, event or log"
        )
      await assertNoSecretBytes(home, canary)
    } catch (error) {
      primaryFailure = error
    } finally {
      await api?.close().catch(error => {
        primaryFailure = primaryFailure
          ? new AggregateError(
              [primaryFailure, error],
              "Journey assertion and owner transport close both failed"
            )
          : error
      })
      app.closeAllConnections()
      app.close()
      await once(app, "close")
      let harnessFailure
      let closeTimer
      const closing = harness.close()
      closing.catch(() => {})
      try {
        await Promise.race([
          closing,
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () =>
                reject(
                  Object.assign(
                    new Error("Public Gozar cleanup did not settle"),
                    { code: "cleanup_timeout" }
                  )
                ),
              4000
            )
          }),
        ])
      } catch (error) {
        harnessFailure = error
      } finally {
        clearTimeout(closeTimer)
      }
      await effects.close()
      if (cleanupDebtExpected) {
        assert.ok(
          harnessFailure,
          "Harness close must not report success while allocation is unconfirmed"
        )
        assert.ok(
          ["cleanup_debt", "route_conflict", "cleanup_timeout"].includes(
            harnessFailure.code
          ),
          `Unexpected public cleanup result: ${harnessFailure.code ?? harnessFailure.message}`
        )
      }
      if (harnessFailure && primaryFailure) {
        primaryFailure = new AggregateError(
          [primaryFailure, harnessFailure],
          "Journey assertion and Gozar close both failed"
        )
      } else if (harnessFailure && !cleanupDebtExpected) {
        primaryFailure = harnessFailure
      }
      if (!harnessFailure) await rm(root, { recursive: true, force: true })
    }
    if (primaryFailure) throw primaryFailure
  }
)
