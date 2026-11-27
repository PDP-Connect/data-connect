// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  statfs,
} from "node:fs/promises"
import http from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { createServiceVerifier } from "@tnunamak/gozar"
import { fakeRegistry } from "@tnunamak/gozar/testing"
import { SecretBackend } from "./public-journey.mjs"
import { createEffectFixtures } from "../../../../../scripts/reachability/effect-fixtures.ts"
import { createEffectFixtureHost } from "../../../../../scripts/reachability/testing-effects.mjs"

export async function runConsent(usage) {
  const disk = await statfs(process.cwd())
  assert.ok(disk.bavail * disk.bsize > 105_000_000_000, "disk floor")
  const parent = join(homedir(), ".tmp", "ra")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, "consent-")),
    home = join(root, "h")
  const specification = JSON.parse(
    await readFile(new URL("../unknown-provider.json", import.meta.url), "utf8")
  )
  const { addedFact, secondId, ...definition } = specification
  const registry = await fakeRegistry({
    ...definition,
    kinds: ["attached", usage],
    dir: join(root, "registry"),
  })
  const providerDir = join(registry.root, "providers", definition.id)
  await writeFile(
    join(providerDir, "runtime.mjs"),
    await readFile(new URL("../runtime-provider.mjs", import.meta.url))
  )
  registry.manifest.providers[0].module = `providers/${definition.id}/runtime.mjs`
  const observations = join(root, "runtime-observations.json")
  await writeFile(observations, JSON.stringify({ costKind: "free" }))
  const effects = createEffectFixtures(),
    backend = new SecretBackend()
  const harness = await createEffectFixtureHost(
    {
      manifest: registry.manifest,
      root: registry.root,
      secretBackend: backend,
      identity: { instanceId: randomUUID(), bootId: randomUUID() },
      hostCapabilities: Object.fromEntries(
        [
          "installer.execute",
          "privilege.elevate",
          "secrets.backend",
          "runtime.attached",
          "runtime.durable",
        ].map(id => [id, { known: true, value: id !== "privilege.elevate" }])
      ),
    },
    effects.effects
  )
  const gozar = harness.gozar,
    canary = randomBytes(32).toString("hex"),
    secretHandles = []
  const verifier = createServiceVerifier()
  let gateRequests = 0
  const app = http.createServer((request, response) => {
    gateRequests++
    if (!verifier(request, response)) response.end("fixture application")
  })
  app.listen(0, "127.0.0.1")
  await once(app, "listening")
  const target = `127.0.0.1:${app.address().port}`
  const data = JSON.parse(
    await readFile(new URL("./consent-effects.json", import.meta.url), "utf8")
  )
  for (const origin of data["network/fetch"].proxyOrigins)
    effects.registerOwnedProxy(origin, target)
  const report = {
    usage,
    source: process.env.GOZAR_SOURCE_SHA,
    sha256: process.env.GOZAR_TARBALL_SHA256,
    calls: [],
    firstDivergence: null,
    cleanup: [],
    result: "not-completed",
  }
  let phase, failure
  async function call(method, input, invoke, project = value => value) {
    phase = method
    const row = { method, input }
    report.calls.push(row)
    try {
      const result = await invoke()
      row.observation = project(result)
      return result
    } catch (error) {
      row.error = {
        code: error.code,
        message: error.message,
        route: error.route,
      }
      throw error
    }
  }
  function expectProof(route, at) {
    phase = at
    if (
      route.verification.status !== "verified" ||
      !route.origin ||
      route.published !== route.origin
    ) {
      report.firstDivergence = {
        at,
        expected: { verification: "verified", published: "origin" },
        actual: route,
      }
    }
    assert.equal(
      route.verification.status,
      "verified",
      `${at}: current initial proof must verify`
    )
    assert.ok(route.origin)
    assert.equal(
      route.published,
      route.origin,
      `${at}: verified proof must publish`
    )
    assert.ok(route.verification.subject)
    assert.ok(route.verification.observedAt)
  }
  const configView = result => ({
    draftId: result.draftId,
    scopeId: result.scopeId,
    configurationRevision: result.configurationRevision,
    revision: (result.configuration ?? result).revision,
  })
  try {
    const owner = "fixture-owner",
      providerId = definition.id
    const inventory = await call(
      "listProviders",
      { home: "<owned test home>", owner },
      () => gozar.listProviders({ home, owner }),
      value => ({ providerIds: value.providers.map(p => p.providerId) })
    )
    const provider = inventory.providers.find(p => p.providerId === providerId)
    let draft = await call(
      "beginConfigurationDraft",
      {
        providerId,
        expectedConfigurationRevision: provider.configuration.revision,
      },
      () =>
        gozar.beginConfigurationDraft({
          home,
          owner,
          providerId,
          expectedConfigurationRevision: provider.configuration.revision,
        }),
      configView
    )
    const attempted = new Set()
    for (;;) {
      const configuration = draft.configuration
      const action = configuration.actions.find(
        a =>
          !attempted.has(a.id) &&
          ["provide-secret", "provide-value"].includes(a.kind)
      )
      if (!action) break
      attempted.add(action.id)
      const input = configuration.inputRequirements.find(
        f => f.actionId === action.id
      )
      let secretHandle
      if (input.secret) {
        const bytes = new Uint8Array(Buffer.from(canary))
        try {
          secretHandle = (
            await call(
              "storeSecret",
              {
                providerId,
                draftId: draft.draftId,
                expectedConfigurationRevision: configuration.revision,
                inputId: input.id,
                bytes: "<redacted>",
              },
              () =>
                gozar.storeSecret({
                  home,
                  owner,
                  providerId,
                  draftId: draft.draftId,
                  expectedConfigurationRevision: configuration.revision,
                  scopeId: draft.scopeId,
                  inputId: input.id,
                  bytes,
                }),
              () => ({ stored: true })
            )
          ).handle
          secretHandles.push(secretHandle)
        } finally {
          bytes.fill(0)
        }
      }
      const request = {
        home,
        owner,
        providerId,
        draftId: draft.draftId,
        expectedConfigurationRevision: configuration.revision,
        actionId: action.id,
        approval: {
          kind: "setup",
          digest: action.digest,
          disclosureRevision: action.disclosure.revision,
          consentFactsDigest: action.consent.consentFactsDigest,
        },
        ...(secretHandle ? { secretHandle } : { value: "fixture-label" }),
      }
      await call(
        "runSetupAction",
        {
          ...request,
          home: "<owned test home>",
          ...(secretHandle ? { secretHandle: "<redacted>" } : {}),
        },
        () => gozar.runSetupAction(request),
        configView
      )
      draft = await call(
        "readConfigurationDraft",
        { providerId, draftId: draft.draftId },
        () =>
          gozar.readConfigurationDraft({
            home,
            owner,
            providerId,
            draftId: draft.draftId,
          }),
        configView
      )
    }
    await call(
      "commitConfigurationDraft",
      {
        providerId,
        draftId: draft.draftId,
        expectedConfigurationRevision: draft.configuration.revision,
      },
      () =>
        gozar.commitConfigurationDraft({
          home,
          owner,
          providerId,
          draftId: draft.draftId,
          expectedConfigurationRevision: draft.configuration.revision,
        }),
      configView
    )
    const query = {
      schemaVersion: 1,
      home,
      owner,
      providerId,
      target,
      usage:
        usage === "durable"
          ? { kind: usage, routeId: "fixture-route" }
          : { kind: usage, lifetimeMs: 60000 },
      requirements: {
        reach: "this-device",
        transport: "any",
        payloadAccess: "allow-provider",
        address: "any",
        setup: "allow",
        protocols: [],
      },
    }
    const catalog = await call(
      "catalogRoutes",
      { ...query, home: "<owned test home>" },
      () => gozar.catalogRoutes(query),
      value => ({
        candidates: value.candidates.map(c => ({
          providerId: c.providerId,
          eligible: c.eligible,
          unmet: c.unmet,
          consent: c.consent,
          candidateToken: c.candidateToken,
        })),
      })
    )
    const candidate = catalog.candidates[0]
    assert.ok(candidate.candidateToken)
    const request = {
      ...query,
      operationId: randomUUID(),
      intent: "create",
      wait: "verified",
      approval: {
        kind: "route",
        candidateToken: candidate.candidateToken,
        disclosureRevision: candidate.disclosure.revision,
        consentFactsDigest: candidate.consentFactsDigest,
      },
    }
    const initial = await call(
      usage === "durable" ? "ensureRoute" : "expose",
      { ...request, home: "<owned test home>" },
      () =>
        usage === "durable" ? gozar.ensureRoute(request) : gozar.expose(request)
    )
    expectProof(initial, "initial allocation proof")
    const ref = { home, handle: initial.handle }
    const current = await call(
      "routeStatus",
      { ...ref, home: "<owned test home>" },
      () => gozar.routeStatus(ref)
    )
    expectProof(current, "current initial routeStatus proof")
    await writeFile(observations, JSON.stringify({ costKind: "paid" }))
    const changed = await call(
      "routeStatus",
      { ...ref, home: "<owned test home>" },
      () =>
        gozar.routeStatus(ref).catch(error => {
          if (error.code === "consent_changed" && error.route)
            return error.route
          throw error
        })
    )
    assert.equal(changed.published, null)
    assert.notEqual(changed.verification.status, "verified")
    const review = await call(
      "reviewRouteConsent",
      { ...ref, home: "<owned test home>" },
      () => gozar.reviewRouteConsent(ref)
    )
    assert.equal(review.scope.kind, "route")
    assert.ok(review.facts)
    assert.ok(review.disclosures)
    assert.notEqual(review.consentFactsDigest, candidate.consentFactsDigest)
    const approved = await call(
      "approveRouteConsent",
      {
        ...ref,
        home: "<owned test home>",
        approvalToken: review.approvalToken,
        consentFactsDigest: review.consentFactsDigest,
      },
      () =>
        gozar.approveRouteConsent({
          ...ref,
          approvalToken: review.approvalToken,
          consentFactsDigest: review.consentFactsDigest,
        })
    )
    assert.deepEqual(approved.handle, initial.handle)
    expectProof(approved, "same-generation re-consent")
    report.result = "verified"
  } catch (error) {
    failure = error
    report.firstDivergence ??= {
      at: phase,
      expected: ["expose", "ensureRoute"].includes(phase)
        ? { verification: "verified", published: "origin", wait: "verified" }
        : undefined,
      error: {
        code: error.code,
        message: error.message,
        expected: error.expected,
        actual: error.actual,
      },
    }
    report.result = "fail"
  } finally {
    try {
      const routes = (await gozar.listRoutes({ home, owner: "fixture-owner" }))
        .routes
      for (const route of routes) {
        try {
          const closed = await gozar.closeRoute({
            home,
            handle: route.handle,
            mode: "remove",
          })
          report.cleanup.push({ handle: route.handle, cleanup: closed.cleanup })
          if (closed.cleanup.state !== "confirmed")
            failure ??= new Error("Cleanup remains unconfirmed")
        } catch (error) {
          report.cleanup.push({
            handle: route.handle,
            error: { code: error.code, message: error.message },
          })
          failure ??= error
        }
      }
    } catch (error) {
      report.cleanup.push({
        error: { code: error.code, message: error.message },
      })
      failure ??= error
    }
    try {
      await harness.close()
    } catch (error) {
      report.cleanup.push({ harnessClose: error.code })
      failure ??= error
    }
    await effects.close()
    app.closeAllConnections()
    app.close()
    await once(app, "close")
    report.gateRequests = gateRequests
    report.effects = harness.events
    if (failure && !report.firstDivergence)
      report.firstDivergence = {
        at: "cleanup",
        code: failure.code,
        message: failure.message,
      }
    const serialized = JSON.stringify(report, null, 2)
    assert.ok(!serialized.includes(canary))
    for (const handle of secretHandles)
      assert.ok(
        !serialized.includes(handle),
        "A secret handle must never appear in the repro log"
      )
    await new Promise(resolve =>
      process.stdout.write(serialized + "\n", resolve)
    )
    if (!failure) {
      await registry.cleanup()
      await rm(root, { recursive: true, force: true })
    } else {
      console.error("Retained cleanup evidence:", root)
      process.exitCode = 1
    }
  }
}
