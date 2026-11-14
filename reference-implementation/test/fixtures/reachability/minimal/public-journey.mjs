// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises"
import http from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { createServiceVerifier } from "@tnunamak/gozar"
import { createEffectFixtures } from "../../../../../scripts/reachability/effect-fixtures.ts"
import { createEffectFixtureHost } from "../../../../../scripts/reachability/testing-effects.mjs"

class SecretBackend {
  records = new Map()
  async put({ scopeId, bytes }) {
    const handle = randomUUID()
    this.records.set(handle, { scopeId, bytes: new Uint8Array(bytes) })
    return { handle }
  }
  async withSecret({ scopeId, handle }, use) {
    const record = this.records.get(handle)
    assert.equal(record?.scopeId, scopeId)
    const bytes = new Uint8Array(record.bytes)
    try {
      return await use(bytes)
    } finally {
      bytes.fill(0)
    }
  }
  async presence({ scopeId, handle }) {
    return { known: true, value: this.records.get(handle)?.scopeId === scopeId }
  }
  async delete({ scopeId, handle }) {
    const record = this.records.get(handle)
    if (record?.scopeId !== scopeId) return { deleted: false }
    record.bytes.fill(0)
    this.records.delete(handle)
    return { deleted: true }
  }
}
const approval = action => ({
  kind: "setup",
  digest: action.digest,
  disclosureRevision: action.disclosure.revision,
  consentFactsDigest: action.consent.consentFactsDigest,
})

export async function run({ providerId, usage }) {
  assert.ok(
    (await statfs(process.cwd())).bavail * (await statfs(process.cwd())).bsize >
      105_000_000_000,
    "disk floor"
  )
  const parent = join(homedir(), ".tmp", "ra")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, "b-")),
    home = join(root, "h"),
    owner = "fixture-owner",
    canary = randomBytes(32).toString("hex")
  const hostCapabilities = Object.fromEntries(
    [
      "installer.execute",
      "privilege.elevate",
      "secrets.backend",
      "runtime.attached",
      "runtime.durable",
    ].map(id => [id, { known: true, value: id !== "privilege.elevate" }])
  )
  const effects = createEffectFixtures(),
    network = []
  const fetchEffect = effects.effects.find(
      effect => effect.kind === "network" && effect.operation === "fetch"
    ),
    fetchHandler = fetchEffect.handle
  fetchEffect.handle = async (input, context) => {
    const result = await fetchHandler(input, context)
    let body
    try {
      body = JSON.parse(
        Buffer.from(
          result.chunks.map(c => c.data).join(""),
          "base64"
        ).toString()
      )
    } catch {}
    const url = new URL(input.url)
    network.push({
      url: url.origin + url.pathname,
      requestHost: input.headers.host ?? input.headers.Host ?? null,
      status: result.status,
      challenge: body?.schemaVersion === 2,
      authority: body?.authority ?? null,
      localPort: body?.localPort ?? null,
    })
    return result
  }
  const identity = { instanceId: randomUUID(), bootId: randomUUID() }
  const harness = await createEffectFixtureHost(
      { secretBackend: new SecretBackend(), hostCapabilities, identity },
      effects.effects
    ),
    gozar = harness.gozar
  const verify = createServiceVerifier()
  const app = http.createServer((request, response) => {
    if (!verify(request, response)) response.end("fixture application")
  })
  app.listen(0, "127.0.0.1")
  await once(app, "listening")
  effects.registerOwnedProxy(
    "https://fixture.invalid",
    `127.0.0.1:${app.address().port}`
  )
  const report = {
    providerId,
    usage,
    source: process.env.GOZAR_SOURCE_SHA,
    setup: [],
    call: null,
    result: null,
    cleanup: [],
    events: harness.events,
    network,
  }
  let failure
  const say = () =>
    new Promise(resolve =>
      process.stdout.write(JSON.stringify(report, null, 2) + "\n", resolve)
    )
  try {
    let provider = (await gozar.listProviders({ home, owner })).providers.find(
      p => p.providerId === providerId
    )
    assert.ok(provider)
    report.inputs = provider.configuration.inputRequirements.map(
      ({ id, actionId, required, secret, kind }) => ({
        id,
        actionId,
        required,
        secret,
        kind,
      })
    )
    let draft = await gozar.beginConfigurationDraft({
      home,
      owner,
      providerId,
      expectedConfigurationRevision: provider.configuration.revision,
    })
    const attempted = new Set()
    for (;;) {
      const config = draft.configuration
      const action = config.actions.find(
        a =>
          !attempted.has(a.id) &&
          [
            "provide-secret",
            "provide-value",
            "gozar-runs",
            "install-artifact",
          ].includes(a.kind)
      )
      if (!action) break
      attempted.add(action.id)
      const field = config.inputRequirements.find(f => f.actionId === action.id)
      const value =
        field?.kind === "https-origin"
          ? "https://fixture.invalid"
          : field?.kind === "domain"
            ? "fixture.invalid"
            : "8443"
      let secretHandle
      if (action.kind === "provide-secret") {
        const bytes = new Uint8Array(Buffer.from(canary))
        try {
          secretHandle = (
            await gozar.storeSecret({
              home,
              owner,
              providerId,
              draftId: draft.draftId,
              expectedConfigurationRevision: config.revision,
              scopeId: draft.scopeId,
              inputId: field.id,
              bytes,
            })
          ).handle
        } finally {
          bytes.fill(0)
        }
      }
      const result = await gozar.runSetupAction({
        home,
        owner,
        providerId,
        draftId: draft.draftId,
        expectedConfigurationRevision: config.revision,
        actionId: action.id,
        approval: approval(action),
        ...(secretHandle
          ? { secretHandle }
          : action.kind === "provide-value"
            ? { value }
            : {}),
      })
      report.setup.push({
        actionId: action.id,
        inputId: field?.id,
        kind: action.kind,
        state: result.state,
      })
      draft = await gozar.readConfigurationDraft({
        home,
        owner,
        providerId,
        draftId: draft.draftId,
      })
      assert.equal(result.configurationRevision, draft.configuration.revision)
    }
    const config = await gozar.commitConfigurationDraft({
      home,
      owner,
      providerId,
      draftId: draft.draftId,
      expectedConfigurationRevision: draft.configuration.revision,
    })
    report.remainingInputs = config.inputRequirements
      .filter(
        f =>
          f.required &&
          !(f.secret
            ? config.credentials[f.id]?.known && config.credentials[f.id].value
            : config.values[f.id])
      )
      .map(f => ({ id: f.id, actionId: f.actionId }))
    assert.deepEqual(
      report.remainingInputs,
      [],
      "Every required declared input must be configured"
    )
    provider = (await gozar.listProviders({ home, owner })).providers.find(
      p => p.providerId === providerId
    )
    const query = {
      schemaVersion: 1,
      home,
      owner,
      providerId,
      target: `127.0.0.1:${app.address().port}`,
      usage:
        usage === "session"
          ? { kind: usage, lifetimeMs: 120000 }
          : usage === "durable"
            ? { kind: usage, routeId: "fixture-route" }
            : { kind: usage },
      requirements: {
        reach: provider.reach,
        transport: provider.transport === "http" ? "any" : provider.transport,
        payloadAccess: "allow-provider",
        address: "any",
        setup: "allow",
        protocols: [],
      },
    }
    report.catalogCall = {
      method: "catalogRoutes",
      input: { ...query, home: "<owned test home>" },
    }
    const catalog = await gozar.catalogRoutes(query),
      candidate = catalog.candidates.find(c => c.providerId === providerId)
    report.candidate = {
      eligible: candidate?.eligible,
      unmet: candidate?.unmet,
      actions: candidate?.configuration.actions.map(a => ({
        id: a.id,
        kind: a.kind,
        required: a.required,
      })),
      detection: candidate?.setup?.state,
    }
    assert.ok(
      candidate?.candidateToken,
      "A fully configured admitted candidate must offer a token"
    )
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
    report.call = {
      method: usage === "durable" ? "ensureRoute" : "expose",
      input: {
        ...query,
        home: "<owned test home>",
        operationId: request.operationId,
        approval: {
          kind: "route",
          consentFactsDigest: candidate.consentFactsDigest,
        },
      },
    }
    const started = Date.now()
    const pending =
      usage === "durable" ? gozar.ensureRoute(request) : gozar.expose(request)
    let timer
    try {
      const route = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error("Public call exceeds 90-second repro bound"),
                  { code: "repro_timeout" }
                )
              ),
            90000
          )
        }),
      ])
      report.elapsedMs = Date.now() - started
      report.result = {
        handle: route.handle,
        origin: route.origin,
        published: route.published,
        verification: route.verification,
        binding: route.binding,
        operationId: route.operationId,
      }
      assert.equal(route.verification.status, "verified")
      assert.equal(route.published, route.origin)
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    failure = error
    report.failure = {
      code: error.code ?? "assertion_failed",
      message: error.message,
      expected: error.expected,
      actual: error.actual,
    }
  } finally {
    try {
      for (const route of (await gozar.listRoutes({ home, owner })).routes) {
        try {
          const closed = await gozar.closeRoute({
            home,
            handle: route.handle,
            mode: "remove",
          })
          report.cleanup.push({
            handle: route.handle,
            state: closed.cleanup.state,
          })
        } catch (error) {
          report.cleanup.push({ handle: route.handle, code: error.code })
        }
      }
    } catch (error) {
      report.cleanup.push({ code: error.code })
    }
    try {
      await harness.close()
    } catch (error) {
      report.harnessClose = error.code
    }
    await effects.close()
    app.closeAllConnections()
    app.close()
    await once(app, "close")
    assert.ok(!JSON.stringify(report).includes(canary))
    await say()
    if (
      report.cleanup.every(r => r.state === "confirmed") &&
      !report.harnessClose
    )
      await rm(root, { recursive: true, force: true })
    else console.error("Retained cleanup evidence:", root)
  }
  if (failure) process.exitCode = 1
}
