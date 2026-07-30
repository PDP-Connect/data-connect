import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { Hono } from "hono"

import { registerProtectedRoutes } from "../protected-routes.js"
import {
  createGithubStreamMetadata,
  GrantScopedRecordsRepository,
} from "./grant-scoped-records-repository.js"
import {
  createGithubAuthorizationAdapter,
  PDPP_DATA_ACCESS_TYPE,
} from "./github-authorization/index.js"
import { registerGithubAuthorizationRoutes } from "./github-authorization/http-routes.js"
import { mountPdppResourceServer } from "./resource-server.js"

const tempRoots = []

function hash(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

function createInstalledGithubFixture({ allStreams = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dataconnect-pdpp-resource-server-"))
  tempRoots.push(root)
  const installRoot = join(root, "install")
  const exportRoot = join(root, "exports")
  mkdirSync(join(installRoot, "profile"), { recursive: true })
  mkdirSync(join(installRoot, "dist"), { recursive: true })
  mkdirSync(exportRoot)

  const manifest = {
    protocol_version: "0.1.0",
    connector_id: "https://registry.pdpp.org/connectors/github",
    connector_key: "github",
    version: "0.5.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: allStreams ? allGithubManifestStreams() : [
      {
        name: "repositories",
        primary_key: ["id"],
        cursor_field: "pushed_at",
        consent_time_field: "created_at",
        selection: { fields: true, resources: true },
        schema: {
          type: "object",
          required: ["id", "full_name"],
          properties: {
            id: { type: "string" },
            full_name: { type: "string" },
            name: { type: "string" },
            private: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
            pushed_at: { type: "string", format: "date-time" },
          },
        },
      },
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const manifestDigest = hash(manifestBytes)
  const entrypointBytes = Buffer.from("export default {};")
  const provenanceBytes = Buffer.from(
    JSON.stringify({ source: "fixture", version: "0.5.0" })
  )
  writeFileSync(
    join(installRoot, "profile/collection-profile.json"),
    manifestBytes
  )
  writeFileSync(
    join(installRoot, "dist/collection-profile.mjs"),
    entrypointBytes
  )
  writeFileSync(join(installRoot, "provenance.json"), provenanceBytes)
  const activeManifestPath = join(root, "connectors-active.json")
  writeFileSync(
    activeManifestPath,
    JSON.stringify({
      connectors: {
        "github-pdpp": {
          connectorId: "github-pdpp",
          version: "0.5.0",
          rootPath: installRoot,
          artifactKind: "pdpp-collection-profile",
          manifestPath: "profile/collection-profile.json",
          entrypointPath: "dist/collection-profile.mjs",
          provenancePath: "provenance.json",
          manifestSha256: manifestDigest,
          entrypointSha256: hash(entrypointBytes),
          provenanceSha256: hash(provenanceBytes),
        },
      },
    })
  )
  writeFileSync(
    join(exportRoot, "github.json"),
    JSON.stringify({
      timestamp: 1785456000000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({ manifestDigest }),
        "pdpp.recordsByStream": allStreams ? {
          user_stats: [
            {
              stream: "user_stats",
              key: "42:2026-07-30",
              data: { id: "42:2026-07-30", user_id: "42", observed_on: "2026-07-30" },
              emitted_at: "2026-07-30T00:00:00Z",
            },
          ],
        } : {
          repositories: [
            record("allowed", "2026-02-01T00:00:00Z"),
            record("resource-excluded", "2026-02-01T00:00:00Z"),
            record("time-excluded", "2025-02-01T00:00:00Z"),
          ],
        },
      },
    })
  )
  writeFileSync(
    join(exportRoot, "newer-invalid-github.json"),
    JSON.stringify({
      timestamp: 1785542400000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.recordsByStream": {
          repositories: [
            {
              stream: "repositories",
              key: "missing-required-field",
              data: { id: "missing-required-field" },
              emitted_at: "2026-07-30T00:00:00Z",
            },
          ],
        },
      },
    })
  )
  return {
    activeManifestPath,
    exportRoot,
    databasePath: join(root, "records.sqlite"),
    manifestDigest,
  }
}

function githubSnapshotProvenance({
  manifestDigest,
  connectionId = "default",
  runId = "github-run-1",
  overrides = {},
}) {
  return {
    connector_key: "github",
    connector_id: "https://registry.pdpp.org/connectors/github",
    manifest_version: "0.5.0",
    manifest_sha256: manifestDigest,
    run_id: runId,
    connection_id: connectionId,
    ...overrides,
  }
}

function allGithubManifestStreams() {
  return [
    ["user", ["id", "login"], "updated_at", "created_at", "date-time"],
    ["user_stats", ["id", "user_id", "observed_on"], "observed_on", "observed_on", "date"],
    ["repositories", ["id", "full_name"], "pushed_at", "created_at", "date-time"],
    ["starred", ["id", "full_name"], "starred_at", "starred_at", "date-time"],
    ["issues", ["id"], "updated_at", "created_at", "date-time"],
    ["pull_requests", ["id"], "updated_at", "created_at", "date-time"],
    ["gists", ["id"], "updated_at", "created_at", "date-time"],
  ].map(([name, required, cursorField, consentTimeField, format]) => ({
    name,
    primary_key: ["id"],
    cursor_field: cursorField,
    consent_time_field: consentTimeField,
    selection: { fields: true, resources: true },
    schema: {
      type: "object",
      properties: Object.fromEntries(
        [...new Set([...required, cursorField, consentTimeField])].map(field => [
          field,
          { type: "string", ...(field === cursorField || field === consentTimeField ? { format } : {}) },
        ])
      ),
      required,
    },
  }))
}

function record(id, createdAt) {
  return {
    stream: "repositories",
    key: id,
    data: {
      id,
      full_name: `octo/${id}`,
      name: id,
      private: false,
      extra: "must not leak",
      created_at: createdAt,
      pushed_at: createdAt,
    },
    emitted_at: "2026-07-30T00:00:00Z",
  }
}

function activeToken(overrides = {}) {
  return {
    active: true,
    pdpp_token_kind: "client",
    subject_id: "subject_123",
    grant: {
      source: {
        kind: "connector",
        id: "https://registry.pdpp.org/connectors/github",
      },
      streams: [
        {
          name: "repositories",
          fields: ["id", "full_name", "name", "created_at", "pushed_at"],
          resources: ["allowed", "time-excluded"],
          time_range: { since: "2026-01-01T00:00:00Z" },
        },
      ],
    },
    ...overrides,
  }
}

test("derives all installed GitHub streams and accepts date-only user_stats snapshots", () => {
  const streams = [
    ["user", ["id", "login"], "updated_at", "created_at", "date-time"],
    ["user_stats", ["id", "user_id", "observed_on"], "observed_on", "observed_on", "date"],
    ["repositories", ["id", "full_name"], "updated_at", "created_at", "date-time"],
    ["starred", ["id", "full_name"], "starred_at", "starred_at", "date-time"],
    ["issues", ["id"], "updated_at", "created_at", "date-time"],
    ["pull_requests", ["id"], "updated_at", "created_at", "date-time"],
    ["gists", ["id"], "updated_at", "created_at", "date-time"],
  ].map(([name, required, cursorField, consentTimeField, format]) => ({
    name,
    primary_key: ["id"],
    cursor_field: cursorField,
    consent_time_field: consentTimeField,
    schema: {
      properties: Object.fromEntries(
        [...new Set([...required, cursorField, consentTimeField])].map(field => [
          field,
          { type: "string", format: field === cursorField || field === consentTimeField ? format : undefined },
        ])
      ),
      required,
    },
  }))
  const metadata = createGithubStreamMetadata({ streams })
  assert.deepEqual(Object.keys(metadata), streams.map(stream => stream.name))
  const root = mkdtempSync(join(tmpdir(), "dataconnect-pdpp-all-streams-"))
  tempRoots.push(root)
  const repository = new GrantScopedRecordsRepository({
    databasePath: join(root, "records.sqlite"),
    streamMetadata: metadata,
  })
  repository.importSnapshot({
    connectionId: "default",
    recordsByStream: {
      user_stats: [
        {
          stream: "user_stats",
          key: "42:2026-07-30",
          data: {
            id: "42:2026-07-30",
            user_id: "42",
            observed_on: "2026-07-30",
          },
          emitted_at: "2026-07-30T12:00:00Z",
        },
      ],
    },
  })
  assert.equal(
    repository.listCurrent({ connectionId: "default", stream: "user_stats", grant: {} }).data.length,
    1
  )
  assert.deepEqual(
    repository.listCurrent({ connectionId: "default", stream: "issues", grant: {} }).data,
    []
  )
  assert.throws(
    () =>
      repository.importSnapshot({
        connectionId: "default",
        recordsByStream: { arbitrary: [] },
      }),
    /Unsupported GitHub stream/
  )
  repository.close()
})

test("serves every verified GitHub stream while omitted export streams are empty", async () => {
  const fixture = createInstalledGithubFixture({ allStreams: true })
  const app = new Hono()
  const streamNames = allGithubManifestStreams().map(stream => stream.name)
  await mountPdppResourceServer(app, {
    ...fixture,
    tokenIntrospector: {
      introspect: async () => ({
        active: true,
        pdpp_token_kind: "client",
        subject_id: "subject_123",
        grant: {
          source: { kind: "connector", id: "https://registry.pdpp.org/connectors/github" },
          streams: streamNames.map(name => ({ name })),
        },
      }),
    },
  })
  const headers = { authorization: "Bearer all-streams" }
  const listed = await app.request("http://personal.example/v1/streams", { headers })
  assert.equal(listed.status, 200, await listed.clone().text())
  assert.deepEqual((await listed.json()).data.map(stream => stream.name), streamNames)
  const stats = await app.request("http://personal.example/v1/streams/user_stats/records", { headers })
  assert.deepEqual((await stats.json()).data.map(record => record.id), ["42:2026-07-30"])
  const issues = await app.request("http://personal.example/v1/streams/issues/records", { headers })
  assert.deepEqual((await issues.json()).data, [])
})

test.afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  )
})

test("mounts installed GitHub PDPP streams beside legacy routes with opaque grant enforcement", async () => {
  const fixture = createInstalledGithubFixture()
  const opaqueTokens = []
  const app = new Hono()
  app.get("/v1/data", context => context.json({ legacy: true }))
  await mountPdppResourceServer(app, {
    ...fixture,
    requestId: () => "req_resource_server",
    tokenIntrospector: {
      introspect: async token => {
        opaqueTokens.push(token)
        if (token === "revoked")
          return { active: false, inactive_reason: "grant_revoked" }
        if (token === "expired")
          return { active: false, inactive_reason: "grant_expired" }
        if (token === "wrong-connector") {
          return activeToken({
            grant: {
              source: {
                kind: "connector",
                id: "https://registry.pdpp.org/connectors/slack",
              },
              streams: [],
            },
          })
        }
        if (token === "unrestricted-fields") {
          return activeToken({
            grant: {
              source: {
                kind: "connector",
                id: "https://registry.pdpp.org/connectors/github",
              },
              streams: [
                {
                  name: "repositories",
                  resources: ["allowed"],
                  time_range: { since: "2026-01-01T00:00:00Z" },
                },
              ],
            },
          })
        }
        if (token === "name-only") {
          return activeToken({
            grant: {
              source: {
                kind: "connector",
                id: "https://registry.pdpp.org/connectors/github",
              },
              streams: [
                {
                  name: "repositories",
                  fields: ["name"],
                  resources: ["allowed"],
                  time_range: { since: "2026-01-01T00:00:00Z" },
                },
              ],
            },
          })
        }
        return activeToken()
      },
    },
  })

  assert.deepEqual(
    await (await app.request("http://personal.example/v1/data")).json(),
    { legacy: true }
  )
  const streams = await app.request("http://personal.example/v1/streams", {
    headers: { authorization: "Bearer not-a-jwt" },
  })
  assert.equal(streams.status, 200)
  assert.deepEqual((await streams.json()).data, [
    {
      object: "stream",
      name: "repositories",
      record_count: 1,
      last_updated: "2026-02-01T00:00:00Z",
    },
  ])

  writeFileSync(
    join(fixture.exportRoot, "after-mount.json"),
    JSON.stringify({
      timestamp: 1785628800000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: fixture.manifestDigest,
          runId: "github-run-2",
        }),
        "pdpp.recordsByStream": {
          repositories: [record("allowed", "2026-03-01T00:00:00Z")],
        },
      },
    })
  )
  const refreshedStreams = await app.request(
    "http://personal.example/v1/streams",
    { headers: { authorization: "Bearer not-a-jwt" } }
  )
  assert.equal(
    (await refreshedStreams.json()).data[0].last_updated,
    "2026-03-01T00:00:00Z"
  )

  const records = await app.request(
    "http://personal.example/v1/streams/repositories/records",
    {
      headers: { authorization: "Bearer not-a-jwt" },
    }
  )
  assert.equal(records.status, 200)
  assert.deepEqual(
    (await records.json()).data.map(({ id }) => id),
    ["allowed"]
  )
  assert.deepEqual(opaqueTokens, ["not-a-jwt", "not-a-jwt", "not-a-jwt"])

  const unrestrictedFields = await app.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers: { authorization: "Bearer unrestricted-fields" } }
  )
  assert.equal(unrestrictedFields.status, 200)
  assert.equal((await unrestrictedFields.json()).data[0].data.extra, undefined)

  const requiredFields = await app.request(
    "http://personal.example/v1/streams/repositories/records/allowed",
    { headers: { authorization: "Bearer name-only" } }
  )
  assert.equal(requiredFields.status, 200)
  assert.deepEqual((await requiredFields.json()).data, {
    id: "allowed",
    full_name: "octo/allowed",
    name: "allowed",
  })
  const streamWithHiddenCursor = await app.request(
    "http://personal.example/v1/streams",
    { headers: { authorization: "Bearer name-only" } }
  )
  assert.equal(
    (await streamWithHiddenCursor.json()).data[0].last_updated,
    "2026-03-01T00:00:00Z"
  )

  const filteredChanges = await app.request(
    "http://personal.example/v1/streams/repositories/records?changes_since=beginning&filter%5Bname%5D=allowed",
    { headers: { authorization: "Bearer not-a-jwt" } }
  )
  assert.equal(filteredChanges.status, 400)
  assert.equal((await filteredChanges.json()).error.code, "invalid_request")

  for (const id of ["resource-excluded", "time-excluded"]) {
    const response = await app.request(
      `http://personal.example/v1/streams/repositories/records/${id}`,
      {
        headers: { authorization: "Bearer not-a-jwt" },
      }
    )
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, "not_found")
  }

  for (const [token, code] of [
    ["revoked", "grant_revoked"],
    ["expired", "grant_expired"],
    ["wrong-connector", "grant_invalid"],
  ]) {
    const response = await app.request("http://personal.example/v1/streams", {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, code)
  }

  const malformedPath = await app.request(
    "http://personal.example/v1/streams/%E0%A4%A/records",
    {
      headers: { authorization: "Bearer not-a-jwt" },
    }
  )
  assert.equal(malformedPath.status, 400)
  assert.equal((await malformedPath.json()).error.code, "invalid_request")

  for (const authorization of [undefined, "Basic nope", "Bearer"]) {
    const response = await app.request("http://personal.example/v1/streams", {
      headers: authorization ? { authorization } : undefined,
    })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, "authentication_error")
  }
})

test("a successful authoritative full refresh removes records absent from the next PDPP read", async () => {
  const fixture = createInstalledGithubFixture()
  const app = new Hono()
  await mountPdppResourceServer(app, {
    ...fixture,
    tokenIntrospector: { introspect: async () => activeToken() },
  })
  const headers = { authorization: "Bearer opaque" }
  const before = await app.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers }
  )
  assert.equal(before.status, 200)
  assert.deepEqual(
    (await before.json()).data.map(record => record.id),
    ["allowed"]
  )

  writeFileSync(
    join(fixture.exportRoot, "authoritative-empty-full-refresh.json"),
    JSON.stringify({
      timestamp: 1785715200000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: fixture.manifestDigest,
          runId: "github-run-full-refresh",
        }),
        "pdpp.recordsByStream": { repositories: [] },
        "pdpp.snapshot": {
          collection_mode: "full_refresh",
          reset_streams: ["repositories"],
          completed_at: "2026-07-31T00:00:00.000Z",
        },
      },
    })
  )

  const after = await app.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers }
  )
  assert.equal(after.status, 200)
  assert.deepEqual((await after.json()).data, [])
})

test("serves only the requested connection's verified installed snapshot", async () => {
  const fixture = createInstalledGithubFixture()
  writeFileSync(
    join(fixture.exportRoot, "newest-other-connection.json"),
    JSON.stringify({
      timestamp: 1785801600000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: fixture.manifestDigest,
          connectionId: "other-account",
          runId: "github-other-account",
        }),
        "pdpp.recordsByStream": {
          repositories: [record("other-account", "2026-04-01T00:00:00Z")],
        },
      },
    })
  )
  writeFileSync(
    join(fixture.exportRoot, "newest-wrong-manifest.json"),
    JSON.stringify({
      timestamp: 1785888000000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: "sha256:not-the-installed-artifact",
          runId: "github-wrong-manifest",
        }),
        "pdpp.recordsByStream": {
          repositories: [record("untrusted", "2026-05-01T00:00:00Z")],
        },
      },
    })
  )
  writeFileSync(
    join(fixture.exportRoot, "newest-missing-run-id.json"),
    JSON.stringify({
      timestamp: 1785974400000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: fixture.manifestDigest,
          overrides: { run_id: "" },
        }),
        "pdpp.recordsByStream": {
          repositories: [record("missing-run-id", "2026-06-01T00:00:00Z")],
        },
      },
    })
  )

  const defaultApp = new Hono()
  await mountPdppResourceServer(defaultApp, {
    ...fixture,
    tokenIntrospector: { introspect: async () => activeToken() },
  })
  const defaultRead = await defaultApp.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers: { authorization: "Bearer opaque" } }
  )
  assert.equal(defaultRead.status, 200)
  assert.deepEqual(
    (await defaultRead.json()).data.map(record => record.id),
    ["allowed"]
  )

  const otherApp = new Hono()
  await mountPdppResourceServer(otherApp, {
    ...fixture,
    databasePath: join(dirname(fixture.databasePath), "other-account.sqlite"),
    connectionId: "other-account",
    tokenIntrospector: {
      introspect: async () =>
        activeToken({
          grant: {
            ...activeToken().grant,
            streams: [
              {
                ...activeToken().grant.streams[0],
                resources: ["other-account"],
              },
            ],
          },
        }),
    },
  })
  const otherRead = await otherApp.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers: { authorization: "Bearer opaque" } }
  )
  assert.equal(otherRead.status, 200)
  assert.deepEqual(
    (await otherRead.json()).data.map(record => record.id),
    ["other-account"]
  )
})

test("composes local GitHub authorization with imported PDPP reads and legacy revocation", async () => {
  const fixture = createInstalledGithubFixture()
  const adapter = createGithubAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    databasePath: join(dirname(fixture.databasePath), "authorization.sqlite"),
  })
  const app = new Hono()
  const desktopToken = "desktop-token"
  const legacyRevocations = []

  app.get("/v1/data", context => context.json({ legacy: true }))
  registerProtectedRoutes({
    app,
    devToken: desktopToken,
    gatewayClient: {
      revokeGrant: async ({ grantId }) => legacyRevocations.push(grantId),
    },
    ownerAddress: "0xowner",
    port: 8080,
    send: () => {},
    serverSigner: {
      signGrantRevocation: async () => "signature",
    },
    onLegacyGrantRevoked: legacyGrantId =>
      adapter.revokeByLegacyGrantId(legacyGrantId),
  })
  registerGithubAuthorizationRoutes({ app, devToken: desktopToken, adapter })
  await mountPdppResourceServer(app, {
    ...fixture,
    tokenIntrospector: {
      introspect: token => adapter.resolveForResourceServer(token),
    },
  })

  assert.deepEqual(
    await (await app.request("http://personal.example/v1/data")).json(),
    { legacy: true }
  )

  const authorizationDetails = [
    {
      type: PDPP_DATA_ACCESS_TYPE,
      source: { kind: "connector", id: "github" },
      access_mode: "continuous",
      purpose_code: "https://example.test/purpose/research",
      streams: [{ name: "repositories", resources: ["allowed"] }],
    },
  ]
  const consent = await app.request(
    "http://personal.example/v1/pdpp/consent-requests",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${desktopToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "legacy-session",
        scopes: ["github.repositories"],
        authorization_details: authorizationDetails,
      }),
    }
  )
  assert.equal(consent.status, 201)
  const request = await consent.json()

  const approval = await app.request(
    `http://personal.example/v1/pdpp/consent-requests/${request.request_id}/approve`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${desktopToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        legacy_grant_id: "legacy-grant-1",
        subject_id: "subject-1",
        client_id: "client-1",
      }),
    }
  )
  assert.equal(approval.status, 201)
  const issued = await approval.json()
  const bearer = { authorization: `Bearer ${issued.access_token}` }
  const identity = adapter.resolveForResourceServer(issued.access_token)
  assert.equal(identity.active, true)
  assert.equal(Array.isArray(identity.grant.streams), true)

  const streams = await app.request("http://personal.example/v1/streams", {
    headers: bearer,
  })
  assert.equal(streams.status, 200, await streams.clone().text())
  assert.equal((await streams.json()).data[0].name, "repositories")
  const records = await app.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers: bearer }
  )
  assert.equal(records.status, 200)
  assert.deepEqual(
    (await records.json()).data.map(record => record.data.id),
    ["allowed"]
  )

  const revoke = await app.request(
    "http://personal.example/v1/grants/legacy-grant-1",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}` },
    }
  )
  assert.equal(revoke.status, 204)
  assert.deepEqual(legacyRevocations, ["legacy-grant-1"])

  const inactive = await app.request("http://personal.example/v1/streams", {
    headers: bearer,
  })
  assert.equal(inactive.status, 403)
  assert.equal((await inactive.json()).error.code, "grant_revoked")
  adapter.close()
})

test("serves Timeline only after local consent and fails closed after its bound session is revoked", async () => {
  const fixture = createInstalledGithubFixture()
  const adapter = createGithubAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    databasePath: join(
      dirname(fixture.databasePath),
      "timeline-authorization.sqlite"
    ),
  })
  const app = new Hono()
  const desktopToken = "desktop-token"
  try {
    registerGithubAuthorizationRoutes({ app, devToken: desktopToken, adapter })
    await mountPdppResourceServer(app, {
      ...fixture,
      tokenIntrospector: {
        introspect: token => adapter.resolveForResourceServer(token),
      },
    })

    const missingGrant = await app.request("http://personal.example/v1/streams")
    assert.equal(missingGrant.status, 401)

    const anonymousConsent = await app.request(
      "http://personal.example/v1/pdpp/local-timeline/consent-requests",
      {
        method: "POST",
        body: JSON.stringify({
          session_id: "timeline-session",
          subject_id: "timeline-subject",
        }),
      }
    )
    assert.equal(anonymousConsent.status, 401)

    const consent = await app.request(
      "http://personal.example/v1/pdpp/local-timeline/consent-requests",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: "timeline-session",
          subject_id: "timeline-subject",
        }),
      }
    )
    assert.equal(consent.status, 201)
    const request = await consent.json()
    assert.deepEqual(request.scopes, ["pdpp.local.github.repositories"])

    const approval = await app.request(
      `http://personal.example/v1/pdpp/local-timeline/consent-requests/${request.request_id}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: "timeline-session",
          subject_id: "timeline-subject",
        }),
      }
    )
    assert.equal(approval.status, 201)
    const issued = await approval.json()
    assert.equal(issued.grant.client_id, "dataconnect.timeline")
    assert.equal(issued.grant.subject_id, "timeline-subject")
    const bearer = { authorization: `Bearer ${issued.access_token}` }

    const streams = await app.request("http://personal.example/v1/streams", {
      headers: bearer,
    })
    assert.equal(streams.status, 200)
    const records = await app.request(
      "http://personal.example/v1/streams/repositories/records?limit=100",
      { headers: bearer }
    )
    assert.equal(records.status, 200)
    assert.equal(
      (await records.json()).data.some(record => record.id === "allowed"),
      true
    )

    const revoke = await app.request(
      "http://personal.example/v1/pdpp/local-timeline/revoke",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_id: "timeline-session",
          subject_id: "timeline-subject",
        }),
      }
    )
    assert.deepEqual(await revoke.json(), { revoked: true })
    const revoked = await app.request("http://personal.example/v1/streams", {
      headers: bearer,
    })
    assert.equal(revoked.status, 403)
    assert.equal((await revoked.json()).error.code, "grant_revoked")
  } finally {
    adapter.close()
  }
})

test("maps durable cursor errors to stable resource-server responses", async () => {
  const fixture = createInstalledGithubFixture()
  const repository = new GrantScopedRecordsRepository({
    databasePath: fixture.databasePath,
    changeHistoryLimit: 1,
  })
  const app = new Hono()
  await mountPdppResourceServer(app, {
    ...fixture,
    recordsRepository: repository,
    tokenIntrospector: { introspect: async () => activeToken() },
  })
  const headers = { authorization: "Bearer opaque" }
  const initial = await app.request(
    "http://personal.example/v1/streams/repositories/records?changes_since=beginning",
    { headers }
  )
  const staleCursor = (await initial.json()).next_changes_since
  repository.upsert({
    connectionId: "default",
    stream: "repositories",
    key: "allowed",
    data: record("allowed", "2026-04-01T00:00:00Z").data,
    emittedAt: "2026-07-30T00:00:01Z",
  })
  repository.upsert({
    connectionId: "default",
    stream: "repositories",
    key: "allowed",
    data: record("allowed", "2026-05-01T00:00:00Z").data,
    emittedAt: "2026-07-30T00:00:02Z",
  })
  const expired = await app.request(
    `http://personal.example/v1/streams/repositories/records?changes_since=${encodeURIComponent(staleCursor)}`,
    { headers }
  )
  assert.equal(expired.status, 410)
  assert.equal((await expired.json()).error.code, "cursor_expired")
  const malformed = await app.request(
    "http://personal.example/v1/streams/repositories/records?cursor=not-a-cursor",
    { headers }
  )
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, "invalid_cursor")
  repository.close()
})
