import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { privateKeyToAccount } from "viem/accounts"

import { Hono } from "hono"

import {
  createPdppRevocationSink,
  pdppDefaultStorageRoots,
  pdppProfileDatabasePath,
  registerOptionalPdppSurfaces,
} from "../index.js"
import { registerProtectedRoutes } from "../protected-routes.js"
import {
  createGithubStreamMetadata,
  GrantScopedRecordsRepository,
} from "./grant-scoped-records-repository.js"
import {
  createGithubAuthorizationAdapter,
  createPdppAuthorizationAdapter,
  PDPP_DATA_ACCESS_TYPE,
} from "./github-authorization/index.js"
import {
  registerGithubAuthorizationRoutes,
  registerPdppAuthorizationRoutes,
} from "./github-authorization/http-routes.js"
import {
  createSnapshotRefresher,
  mountPdppResourceServer,
} from "./resource-server.js"
import { loadInstalledManifest } from "./installed-manifest.js"
import { canonicalChatgptManifestBytes } from "./test/fixtures/chatgpt.collection-profile.js"

const tempRoots = []

const TEST_BUILDER = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123"
)
const TEST_ATTACKER = privateKeyToAccount(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
)

function hash(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

async function redemptionAuthorization({
  account,
  origin,
  sessionId,
  iat,
  exp,
}) {
  const path = `/v1/pdpp/credentials/${encodeURIComponent(sessionId)}/redeem`
  const now = Math.floor(Date.now() / 1000)
  const payloadBase64 = Buffer.from(
    JSON.stringify({
      aud: origin,
      bodyHash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      exp: exp ?? now + 60,
      iat: iat ?? now,
      method: "POST",
      uri: path,
    })
  ).toString("base64url")
  const signature = await account.signMessage({ message: payloadBase64 })
  return `Web3Signed ${payloadBase64}.${signature}`
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
    streams: allStreams
      ? allGithubManifestStreams()
      : [
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
        "pdpp.recordsByStream": allStreams
          ? {
              user_stats: [
                {
                  stream: "user_stats",
                  key: "42:2026-07-30",
                  data: {
                    id: "42:2026-07-30",
                    user_id: "42",
                    observed_on: "2026-07-30",
                  },
                  emitted_at: "2026-07-30T00:00:00Z",
                },
              ],
            }
          : {
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
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest,
          runId: "github-newer-malformed-record",
        }),
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
    root,
    installRoot,
    activeManifestPath,
    exportRoot,
    databasePath: join(root, "records.sqlite"),
    manifest,
    manifestDigest,
  }
}

function createInstalledChatgptFixture() {
  const root = mkdtempSync(
    join(tmpdir(), "dataconnect-pdpp-chatgpt-resource-server-")
  )
  tempRoots.push(root)
  const installRoot = join(root, "install")
  const exportRoot = join(root, "exports")
  mkdirSync(join(installRoot, "profile"), { recursive: true })
  mkdirSync(join(installRoot, "dist"), { recursive: true })
  mkdirSync(exportRoot)

  const manifestBytes = canonicalChatgptManifestBytes
  const manifest = JSON.parse(manifestBytes)
  const manifestDigest = hash(manifestBytes)
  const entrypointBytes = Buffer.from("export default {};")
  const provenanceBytes = Buffer.from(
    JSON.stringify({ source: "canonical-chatgpt" })
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
        "chatgpt-pdpp": {
          connectorId: "chatgpt-pdpp",
          version: manifest.version,
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
  return {
    root,
    installRoot,
    activeManifestPath,
    exportRoot,
    databasePath: join(root, "records.sqlite"),
    manifest,
    manifestBytes,
    manifestDigest,
  }
}

function chatgptSnapshotProvenance({
  manifestDigest,
  connectionId = "chatgpt-account-a",
  runId = "chatgpt-run-1",
  overrides = {},
}) {
  return {
    connector_key: "chatgpt",
    connector_id: "https://registry.pdpp.org/connectors/chatgpt",
    manifest_version: "0.1.0",
    manifest_sha256: manifestDigest,
    run_id: runId,
    connection_id: connectionId,
    ...overrides,
  }
}

function chatgptConversation(id, createTime, updateTime = createTime) {
  return {
    stream: "conversations",
    key: id,
    data: {
      id,
      title: `title-${id}`,
      create_time: createTime,
      update_time: updateTime,
      is_archived: false,
    },
    emitted_at: "2026-07-31T00:00:00.000Z",
  }
}

function rewriteInstalledManifest(fixture, mutate) {
  const manifest = JSON.parse(JSON.stringify(fixture.manifest))
  mutate(manifest)
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  writeFileSync(
    join(fixture.installRoot, "profile/collection-profile.json"),
    manifestBytes
  )
  const active = JSON.parse(readFileSync(fixture.activeManifestPath))
  active.connectors["github-pdpp"].version = manifest.version
  active.connectors["github-pdpp"].manifestSha256 = hash(manifestBytes)
  writeFileSync(fixture.activeManifestPath, JSON.stringify(active))
  fixture.manifest = manifest
  fixture.manifestDigest = hash(manifestBytes)
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
    [
      "user_stats",
      ["id", "user_id", "observed_on"],
      "observed_on",
      "observed_on",
      "date",
    ],
    [
      "repositories",
      ["id", "full_name"],
      "pushed_at",
      "created_at",
      "date-time",
    ],
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
        [...new Set([...required, cursorField, consentTimeField])].map(
          field => [
            field,
            {
              type: "string",
              ...(field === cursorField || field === consentTimeField
                ? { format }
                : {}),
            },
          ]
        )
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

function activeToken({
  manifestDigest,
  grant: grantOverrides,
  ...overrides
} = {}) {
  return {
    active: true,
    pdpp_token_kind: "client",
    subject_id: "subject_123",
    grant: {
      source: {
        kind: "connector",
        id: "https://registry.pdpp.org/connectors/github",
      },
      manifest_version: "0.5.0",
      manifest_digest: manifestDigest,
      streams: [
        {
          name: "repositories",
          fields: ["id", "full_name", "name", "created_at", "pushed_at"],
          resources: ["allowed", "time-excluded"],
          time_range: { since: "2026-01-01T00:00:00Z" },
        },
      ],
      ...grantOverrides,
    },
    ...overrides,
  }
}

test("derives all installed GitHub streams and accepts date-only user_stats snapshots", () => {
  const streams = [
    ["user", ["id", "login"], "updated_at", "created_at", "date-time"],
    [
      "user_stats",
      ["id", "user_id", "observed_on"],
      "observed_on",
      "observed_on",
      "date",
    ],
    [
      "repositories",
      ["id", "full_name"],
      "updated_at",
      "created_at",
      "date-time",
    ],
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
        [...new Set([...required, cursorField, consentTimeField])].map(
          field => [
            field,
            {
              type: "string",
              format:
                field === cursorField || field === consentTimeField
                  ? format
                  : undefined,
            },
          ]
        )
      ),
      required,
    },
  }))
  const metadata = createGithubStreamMetadata({ streams })
  assert.deepEqual(
    Object.keys(metadata),
    streams.map(stream => stream.name)
  )
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
    repository.listCurrent({
      connectionId: "default",
      stream: "user_stats",
      grant: {},
    }).data.length,
    1
  )
  assert.deepEqual(
    repository.listCurrent({
      connectionId: "default",
      stream: "issues",
      grant: {},
    }).data,
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
          source: {
            kind: "connector",
            id: "https://registry.pdpp.org/connectors/github",
          },
          streams: streamNames.map(name => ({ name })),
          manifest_version: fixture.manifest.version,
          manifest_digest: fixture.manifestDigest,
        },
      }),
    },
  })
  const headers = { authorization: "Bearer all-streams" }
  const listed = await app.request("http://personal.example/v1/streams", {
    headers,
  })
  assert.equal(listed.status, 200, await listed.clone().text())
  assert.deepEqual(
    (await listed.json()).data.map(stream => stream.name),
    streamNames
  )
  const stats = await app.request(
    "http://personal.example/v1/streams/user_stats/records",
    { headers }
  )
  assert.deepEqual(
    (await stats.json()).data.map(record => record.id),
    ["42:2026-07-30"]
  )
  const issues = await app.request(
    "http://personal.example/v1/streams/issues/records",
    { headers }
  )
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
            manifestDigest: fixture.manifestDigest,
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
            manifestDigest: fixture.manifestDigest,
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
            manifestDigest: fixture.manifestDigest,
            grant: {
              source: {
                kind: "connector",
                id: "https://registry.pdpp.org/connectors/github",
              },
              streams: [
                {
                  name: "repositories",
                  fields: ["id", "full_name", "name"],
                  resources: ["allowed"],
                  time_range: { since: "2026-01-01T00:00:00Z" },
                },
              ],
            },
          })
        }
        return activeToken({ manifestDigest: fixture.manifestDigest })
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
      fields: [
        { name: "id", type: "string" },
        { name: "full_name", type: "string" },
        { name: "name", type: "string" },
        { name: "private", type: "boolean" },
        { name: "created_at", type: "string", format: "date-time" },
        { name: "pushed_at", type: "string", format: "date-time" },
      ],
      primary_key: ["id"],
      timestamp_fields: ["created_at", "pushed_at"],
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
    tokenIntrospector: {
      introspect: async () =>
        activeToken({ manifestDigest: fixture.manifestDigest }),
    },
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
    tokenIntrospector: {
      introspect: async () =>
        activeToken({ manifestDigest: fixture.manifestDigest }),
    },
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
          manifestDigest: fixture.manifestDigest,
          grant: {
            ...activeToken({ manifestDigest: fixture.manifestDigest }).grant,
            streams: [
              {
                ...activeToken({ manifestDigest: fixture.manifestDigest }).grant
                  .streams[0],
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

test("snapshot refresh caches scans and parses while promptly importing a new generation once", async () => {
  const fixture = createInstalledGithubFixture()
  const nestedExportRoot = join(fixture.exportRoot, "GitHub", "github", "runs")
  mkdirSync(nestedExportRoot, { recursive: true })
  let scanCalls = 0
  let parseCalls = 0
  const imports = []
  const refresh = createSnapshotRefresher({
    exportRoot: fixture.exportRoot,
    manifest: fixture.manifest,
    manifestDigest: fixture.manifestDigest,
    connectionId: "default",
    repository: {
      importSnapshot: snapshot => imports.push(snapshot),
    },
    fileOperations: {
      readdir: (...args) => {
        scanCalls += 1
        return readdir(...args)
      },
      readFile: (...args) => {
        parseCalls += 1
        return readFile(...args)
      },
      stat,
    },
  })

  await refresh()
  const initialScanCalls = scanCalls
  const initialParseCalls = parseCalls
  assert.equal(imports.length, 1)

  await refresh()
  assert.equal(scanCalls, initialScanCalls)
  assert.equal(parseCalls, initialParseCalls)
  assert.equal(imports.length, 1)

  writeFileSync(
    join(nestedExportRoot, "new-authoritative-generation.json"),
    JSON.stringify({
      timestamp: 1786060800000,
      content: {
        platform: "github",
        version: "0.5.0",
        "pdpp.provenance": githubSnapshotProvenance({
          manifestDigest: fixture.manifestDigest,
          runId: "github-new-generation",
        }),
        "pdpp.recordsByStream": {
          repositories: [record("new-generation", "2026-07-01T00:00:00Z")],
        },
      },
    })
  )
  writeFileSync(
    join(nestedExportRoot, "newer-malformed-generation.json"),
    "{ definitely not JSON"
  )

  await refresh()
  assert.ok(scanCalls > initialScanCalls)
  assert.ok(parseCalls > initialParseCalls)
  assert.equal(imports.length, 2)
  assert.equal(
    imports[1].recordsByStream.repositories[0].data.id,
    "new-generation"
  )
  const refreshedParseCalls = parseCalls
  const refreshedScanCalls = scanCalls

  await refresh()
  assert.equal(scanCalls, refreshedScanCalls)
  assert.equal(parseCalls, refreshedParseCalls)
  assert.equal(imports.length, 2)
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
      streams: [
        {
          name: "repositories",
          fields: ["name"],
          resources: ["allowed"],
        },
      ],
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
  assert.deepEqual(request.authorization_details.streams[0].fields, [
    "id",
    "full_name",
    "name",
  ])

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
        client_id: TEST_BUILDER.address,
      }),
    }
  )
  assert.equal(approval.status, 201)
  const issued = await approval.json()
  assert.equal("access_token" in issued, false)
  assert.equal("redemption_code" in issued, false)

  adapter.close()
  const restartedAdapter = createGithubAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    databasePath: join(dirname(fixture.databasePath), "authorization.sqlite"),
  })
  const restartedApp = new Hono()
  registerProtectedRoutes({
    app: restartedApp,
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
      restartedAdapter.revokeByLegacyGrantId(legacyGrantId),
  })
  registerGithubAuthorizationRoutes({
    app: restartedApp,
    devToken: desktopToken,
    adapter: restartedAdapter,
  })
  await mountPdppResourceServer(restartedApp, {
    ...fixture,
    tokenIntrospector: {
      introspect: token => restartedAdapter.resolveForResourceServer(token),
    },
  })

  const redeemPath = "/v1/pdpp/credentials/legacy-session/redeem"
  const rejected = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST" }
  )
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.text()).includes("pdpp_at_"), false)

  const forgedAuthorization = await redemptionAuthorization({
    account: TEST_ATTACKER,
    origin: "http://personal.example",
    sessionId: "legacy-session",
  })
  const forged = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST", headers: { authorization: forgedAuthorization } }
  )
  assert.equal(forged.status, 403)
  assert.equal((await forged.text()).includes("pdpp_at_"), false)

  const staleAuthorization = await redemptionAuthorization({
    account: TEST_BUILDER,
    origin: "http://personal.example",
    sessionId: "legacy-session",
    iat: Math.floor(Date.now() / 1000) - 61,
    exp: Math.floor(Date.now() / 1000) + 1,
  })
  const stale = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST", headers: { authorization: staleAuthorization } }
  )
  assert.equal(stale.status, 403)
  assert.equal((await stale.text()).includes("pdpp_at_"), false)

  const longLivedAuthorization = await redemptionAuthorization({
    account: TEST_BUILDER,
    origin: "http://personal.example",
    sessionId: "legacy-session",
    exp: Math.floor(Date.now() / 1000) + 301,
  })
  const longLived = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST", headers: { authorization: longLivedAuthorization } }
  )
  assert.equal(longLived.status, 403)
  assert.equal((await longLived.text()).includes("pdpp_at_"), false)

  const authorization = await redemptionAuthorization({
    account: TEST_BUILDER,
    origin: "http://personal.example",
    sessionId: "legacy-session",
  })
  const credential = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST", headers: { authorization } }
  )
  assert.equal(credential.status, 200)
  const redeemed = await credential.json()
  assert.equal(typeof redeemed.access_token, "string")
  const bearer = { authorization: `Bearer ${redeemed.access_token}` }
  const identity = restartedAdapter.resolveForResourceServer(
    redeemed.access_token
  )
  assert.equal(identity.active, true)
  assert.deepEqual(identity.grant.streams[0].fields, [
    "id",
    "full_name",
    "name",
  ])

  const replay = await restartedApp.request(
    `http://personal.example${redeemPath}`,
    { method: "POST", headers: { authorization } }
  )
  assert.equal(replay.status, 403)
  assert.equal((await replay.text()).includes("pdpp_at_"), false)

  const streams = await restartedApp.request(
    "http://personal.example/v1/streams",
    {
      headers: bearer,
    }
  )
  assert.equal(streams.status, 200, await streams.clone().text())
  assert.equal((await streams.json()).data[0].name, "repositories")
  const records = await restartedApp.request(
    "http://personal.example/v1/streams/repositories/records",
    { headers: bearer }
  )
  assert.equal(records.status, 200)
  assert.deepEqual((await records.json()).data[0].data, {
    id: "allowed",
    full_name: "octo/allowed",
    name: "allowed",
  })

  const revoke = await restartedApp.request(
    "http://personal.example/v1/grants/legacy-grant-1",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}` },
    }
  )
  assert.equal(revoke.status, 204)
  assert.deepEqual(legacyRevocations, ["legacy-grant-1"])

  const inactive = await restartedApp.request(
    "http://personal.example/v1/streams",
    {
      headers: bearer,
    }
  )
  assert.equal(inactive.status, 403)
  assert.equal((await inactive.json()).error.code, "grant_revoked")
  restartedAdapter.close()
})

test("rejects a local PDPP bearer after owner revoke intent even when Gateway revoke fails", async () => {
  const fixture = createInstalledGithubFixture()
  const adapter = createGithubAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    databasePath: join(dirname(fixture.databasePath), "authorization.sqlite"),
  })
  const app = new Hono()
  const desktopToken = "desktop-token"
  const remoteAttempts = []

  registerProtectedRoutes({
    app,
    devToken: desktopToken,
    gatewayClient: {
      revokeGrant: async ({ grantId }) => {
        remoteAttempts.push(grantId)
        throw new Error("gateway unavailable")
      },
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

  async function issueBearer({ sessionId, legacyGrantId }) {
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
          session_id: sessionId,
          scopes: ["github.repositories"],
          authorization_details: authorizationDetails,
        }),
      }
    )
    assert.equal(consent.status, 201, await consent.clone().text())
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
          legacy_grant_id: legacyGrantId,
          subject_id: "subject-1",
          client_id: TEST_BUILDER.address,
        }),
      }
    )
    assert.equal(approval.status, 201, await approval.clone().text())
    const authorization = await redemptionAuthorization({
      account: TEST_BUILDER,
      origin: "http://personal.example",
      sessionId,
    })
    const credential = await app.request(
      `http://personal.example/v1/pdpp/credentials/${sessionId}/redeem`,
      { method: "POST", headers: { authorization } }
    )
    assert.equal(credential.status, 200, await credential.clone().text())
    return `Bearer ${(await credential.json()).access_token}`
  }

  const revokedBearer = await issueBearer({
    sessionId: "revoke-failure-session",
    legacyGrantId: "legacy-grant-fail-closed",
  })
  const otherBearer = await issueBearer({
    sessionId: "other-session",
    legacyGrantId: "legacy-grant-other",
  })

  const before = await app.request("http://personal.example/v1/streams", {
    headers: { authorization: revokedBearer },
  })
  assert.equal(before.status, 200, await before.clone().text())

  const revoke = await app.request(
    "http://personal.example/v1/grants/legacy-grant-fail-closed",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}` },
    }
  )
  assert.equal(revoke.status, 500)
  assert.equal((await revoke.json()).error, "gateway unavailable")
  assert.deepEqual(remoteAttempts, ["legacy-grant-fail-closed"])

  const after = await app.request("http://personal.example/v1/streams", {
    headers: { authorization: revokedBearer },
  })
  assert.equal(after.status, 403)
  assert.equal((await after.json()).error.code, "grant_revoked")

  const other = await app.request("http://personal.example/v1/streams", {
    headers: { authorization: otherBearer },
  })
  assert.equal(other.status, 200, await other.clone().text())
  adapter.close()
})

test("default GitHub serving retains legacy authorization and record database paths on upgrade", async () => {
  const fixture = createInstalledGithubFixture()
  const desktopToken = "desktop-token"
  assert.equal(
    pdppProfileDatabasePath(fixture.root, "github-pdpp", "authorization"),
    join(fixture.root, "pdpp-github-authorization.sqlite")
  )
  assert.equal(
    pdppProfileDatabasePath(fixture.root, "github-pdpp", "records"),
    join(fixture.root, "pdpp-github-records.sqlite")
  )

  const seededAdapter = createPdppAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    connectorId: "github-pdpp",
    expectedConnector: {
      key: "github",
      id: "https://registry.pdpp.org/connectors/github",
    },
    databasePath: pdppProfileDatabasePath(
      fixture.root,
      "github-pdpp",
      "authorization"
    ),
    scopeForStream: stream =>
      ({
        user: "github.profile",
        repositories: "github.repositories",
        starred: "github.starred",
      })[stream],
  })
  const consent = seededAdapter.createConsentRequest({
    sessionId: "legacy-upgrade-session",
    scopes: ["github.repositories"],
    authorizationDetails: [
      {
        type: PDPP_DATA_ACCESS_TYPE,
        source: { kind: "connector", id: "github" },
        access_mode: "continuous",
        purpose_code: "https://example.test/purpose/research",
        streams: [{ name: "repositories", resources: ["allowed"] }],
      },
    ],
  })
  const issued = seededAdapter.issueApprovedGrant({
    requestId: consent.request_id,
    legacyGrantId: "legacy-upgrade-grant",
    subjectId: "subject-1",
    clientId: TEST_BUILDER.address,
  })
  seededAdapter.close()

  const app = new Hono()
  app.get("/health", context => context.json({ ok: true }))
  const adapter = await registerOptionalPdppSurfaces({
    app,
    devToken: desktopToken,
    storageRoot: fixture.root,
    recordsRoot: fixture.root,
    activeManifestPath: fixture.activeManifestPath,
    exportRoot: fixture.exportRoot,
    connectionId: "default",
    selectedPdppProfile: {
      connectorId: "github-pdpp",
      connector: {
        key: "github",
        id: "https://registry.pdpp.org/connectors/github",
      },
      scopeForStream: stream =>
        ({
          user: "github.profile",
          repositories: "github.repositories",
          starred: "github.starred",
        })[stream],
      enableLocalTimeline: true,
    },
  })
  assert.notEqual(adapter, null)
  registerProtectedRoutes({
    app,
    devToken: desktopToken,
    gatewayClient: { revokeGrant: async () => {} },
    ownerAddress: "0xowner",
    port: 8080,
    send: () => {},
    serverSigner: { signGrantRevocation: async () => "signature" },
    onLegacyGrantRevoked: grantId => adapter.revokeByLegacyGrantId(grantId),
  })

  const headers = { authorization: `Bearer ${issued.access_token}` }
  const streams = await app.request("http://personal.example/v1/streams", {
    headers,
  })
  assert.equal(streams.status, 200, await streams.clone().text())
  assert.deepEqual(
    (await streams.json()).data.map(stream => stream.name),
    ["repositories"]
  )

  const revoke = await app.request(
    "http://personal.example/v1/grants/legacy-upgrade-grant",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}` },
    }
  )
  assert.equal(revoke.status, 204)
  const revoked = await app.request("http://personal.example/v1/streams", {
    headers,
  })
  assert.equal(revoked.status, 403)
  assert.equal((await revoked.json()).error.code, "grant_revoked")
  adapter.close()
})

test("invalid selected install leaves legacy routes alive and PDPP routes absent", async () => {
  const fixture = createInstalledGithubFixture()
  const app = new Hono()
  app.get("/health", context => context.json({ ok: true }))
  const logs = []
  const adapter = await registerOptionalPdppSurfaces({
    app,
    devToken: "desktop-token",
    storageRoot: fixture.root,
    recordsRoot: fixture.root,
    activeManifestPath: join(fixture.root, "missing-active.json"),
    exportRoot: fixture.exportRoot,
    selectedPdppProfile: {
      connectorId: "github-pdpp",
      connector: {
        key: "github",
        id: "https://registry.pdpp.org/connectors/github",
      },
      scopeForStream: stream =>
        ({
          user: "github.profile",
          repositories: "github.repositories",
          starred: "github.starred",
        })[stream],
      enableLocalTimeline: true,
    },
    send: message => logs.push(message),
  })

  assert.equal(adapter, null)
  assert.equal(
    (await app.request("http://personal.example/health")).status,
    200
  )
  assert.equal(
    (await app.request("http://personal.example/v1/streams")).status,
    404
  )
  assert.equal(
    (
      await app.request("http://personal.example/v1/pdpp/consent-requests", {
        method: "POST",
      })
    ).status,
    404
  )
  assert.match(logs.at(-1).message, /routes unavailable/)
})

test("unsupported selected install atomically leaves all PDPP routes absent", async () => {
  const fixture = createInstalledGithubFixture()
  rewriteInstalledManifest(fixture, manifest => {
    manifest.streams[0].primary_key = ["id", "full_name"]
  })
  const app = new Hono()
  app.get("/health", context => context.json({ ok: true }))
  const logs = []
  const adapter = await registerOptionalPdppSurfaces({
    app,
    devToken: "desktop-token",
    storageRoot: fixture.root,
    recordsRoot: fixture.root,
    activeManifestPath: fixture.activeManifestPath,
    exportRoot: fixture.exportRoot,
    selectedPdppProfile: {
      connectorId: "github-pdpp",
      connector: {
        key: "github",
        id: "https://registry.pdpp.org/connectors/github",
      },
      scopeForStream: stream =>
        ({
          user: "github.profile",
          repositories: "github.repositories",
          starred: "github.starred",
        })[stream],
      enableLocalTimeline: true,
    },
    send: message => logs.push(message),
  })

  assert.equal(adapter, null)
  assert.equal(
    (await app.request("http://personal.example/health")).status,
    200
  )
  for (const [url, options] of [
    ["http://personal.example/v1/streams"],
    [
      "http://personal.example/v1/pdpp/consent-requests",
      { method: "POST", headers: { authorization: "Bearer desktop-token" } },
    ],
    [
      "http://personal.example/v1/pdpp/consent-requests/request/approve",
      { method: "POST", headers: { authorization: "Bearer desktop-token" } },
    ],
    [
      "http://personal.example/v1/pdpp/credentials/session/redeem",
      { method: "POST" },
    ],
    [
      "http://personal.example/v1/pdpp/local-timeline/consent-requests",
      { method: "POST", headers: { authorization: "Bearer desktop-token" } },
    ],
    ["http://personal.example/v1/pdpp/introspect", { method: "POST" }],
  ]) {
    assert.equal((await app.request(url, options)).status, 404, url)
  }
  assert.match(logs.at(-1).message, /unsupported record contract/)
})

test("revocation during optional PDPP outage persists through recovery and Gateway failure", async () => {
  const fixture = createInstalledGithubFixture()
  const desktopToken = "desktop-token"
  const selectedPdppProfile = {
    connectorId: "github-pdpp",
    connector: {
      key: "github",
      id: "https://registry.pdpp.org/connectors/github",
    },
    scopeForStream: stream =>
      ({
        user: "github.profile",
        repositories: "github.repositories",
        starred: "github.starred",
      })[stream],
    enableLocalTimeline: true,
  }
  const seededAdapter = createPdppAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    connectorId: "github-pdpp",
    expectedConnector: selectedPdppProfile.connector,
    databasePath: pdppProfileDatabasePath(
      fixture.root,
      "github-pdpp",
      "authorization"
    ),
    scopeForStream: selectedPdppProfile.scopeForStream,
  })
  const consent = seededAdapter.createConsentRequest({
    sessionId: "outage-session",
    scopes: ["github.repositories"],
    authorizationDetails: [
      {
        type: PDPP_DATA_ACCESS_TYPE,
        source: { kind: "connector", id: "github" },
        access_mode: "continuous",
        purpose_code: "https://example.test/purpose/research",
        streams: [{ name: "repositories" }],
      },
    ],
  })
  const issued = seededAdapter.issueApprovedGrant({
    requestId: consent.request_id,
    legacyGrantId: "outage-grant",
    subjectId: "subject-1",
    clientId: TEST_BUILDER.address,
  })
  seededAdapter.close()

  const outageApp = new Hono()
  outageApp.get("/health", context => context.json({ ok: true }))
  const outageAdapter = await registerOptionalPdppSurfaces({
    app: outageApp,
    devToken: desktopToken,
    storageRoot: fixture.root,
    recordsRoot: fixture.root,
    activeManifestPath: join(fixture.root, "missing-active.json"),
    exportRoot: fixture.exportRoot,
    selectedPdppProfile,
  })
  assert.equal(outageAdapter, null)
  const revocationSink = createPdppRevocationSink({
    storageRoot: fixture.root,
    activeManifestPath: join(fixture.root, "missing-active.json"),
    selectedPdppProfile,
  })
  registerProtectedRoutes({
    app: outageApp,
    devToken: desktopToken,
    gatewayClient: {
      revokeGrant: async () => {
        throw new Error("gateway unavailable")
      },
    },
    ownerAddress: "0xowner",
    port: 8080,
    send: () => {},
    serverSigner: { signGrantRevocation: async () => "signature" },
    onLegacyGrantRevoked: grantId =>
      revocationSink.revokeByLegacyGrantId(grantId),
  })
  const revoke = await outageApp.request(
    "http://personal.example/v1/grants/outage-grant",
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}` },
    }
  )
  assert.equal(revoke.status, 500)
  revocationSink.close()

  const recoveredApp = new Hono()
  const recoveredAdapter = await registerOptionalPdppSurfaces({
    app: recoveredApp,
    devToken: desktopToken,
    storageRoot: fixture.root,
    recordsRoot: fixture.root,
    activeManifestPath: fixture.activeManifestPath,
    exportRoot: fixture.exportRoot,
    selectedPdppProfile,
  })
  assert.notEqual(recoveredAdapter, null)
  const revoked = await recoveredApp.request(
    "http://personal.example/v1/streams",
    { headers: { authorization: `Bearer ${issued.access_token}` } }
  )
  assert.equal(revoked.status, 403)
  assert.equal((await revoked.json()).error.code, "grant_revoked")
  recoveredAdapter.close()
})

test("default records root preserves the legacy standalone fallback path", () => {
  const roots = pdppDefaultStorageRoots({ homeDir: "/tmp/fake-home" })
  assert.equal(
    roots.authorizationRoot,
    "/tmp/fake-home/.data-connect/personal-server"
  )
  assert.equal(
    roots.recordsRoot,
    "/tmp/fake-home/.dataconnect/personal-server"
  )
  assert.equal(
    pdppDefaultStorageRoots({
      homeDir: "/tmp/fake-home",
      configDir: "/tmp/config",
    }).recordsRoot,
    "/tmp/config"
  )
  assert.equal(
    pdppDefaultStorageRoots({
      homeDir: "/tmp/fake-home",
      pdppStorageDir: "/tmp/pdpp-storage",
    }).recordsRoot,
    "/tmp/pdpp-storage"
  )
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
    tokenIntrospector: {
      introspect: async () =>
        activeToken({ manifestDigest: fixture.manifestDigest }),
    },
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

test("fails closed when the active manifest diverges from the composed selection", async () => {
  const fixture = createInstalledGithubFixture()
  const divergent = createInstalledGithubFixture()
  const selectedInstall = loadInstalledManifest({
    activeManifestPath: fixture.activeManifestPath,
    connectorId: "github-pdpp",
    expectedConnector: {
      key: "github",
      id: "https://registry.pdpp.org/connectors/github",
    },
  })
  const divergentManifest = { ...divergent.manifest, version: "0.5.1" }
  const divergentBytes = Buffer.from(JSON.stringify(divergentManifest))
  writeFileSync(
    join(
      dirname(divergent.activeManifestPath),
      "install/profile/collection-profile.json"
    ),
    divergentBytes
  )
  const divergentActive = JSON.parse(readFileSync(divergent.activeManifestPath))
  divergentActive.connectors["github-pdpp"].version = "0.5.1"
  divergentActive.connectors["github-pdpp"].manifestSha256 =
    hash(divergentBytes)
  writeFileSync(divergent.activeManifestPath, JSON.stringify(divergentActive))

  const adapter = createPdppAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    connectorId: "github-pdpp",
    expectedConnector: {
      key: "github",
      id: "https://registry.pdpp.org/connectors/github",
    },
    selectedInstall,
    databasePath: join(
      dirname(fixture.activeManifestPath),
      "authorization.sqlite"
    ),
    scopeForStream: stream => ({ repositories: "github.repositories" })[stream],
  })
  const app = new Hono()
  try {
    await mountPdppResourceServer(app, {
      ...fixture,
      selectedInstall,
      tokenIntrospector: {
        introspect: token => adapter.resolveForResourceServer(token),
      },
    })
    const consent = adapter.createConsentRequest({
      sessionId: "selection-bound-session",
      scopes: ["github.repositories"],
      authorizationDetails: [
        {
          type: PDPP_DATA_ACCESS_TYPE,
          source: { kind: "connector", id: "github" },
          access_mode: "continuous",
          purpose_code: "https://example.test/purpose/research",
          streams: [{ name: "repositories" }],
        },
      ],
    })
    const issued = adapter.issueApprovedGrant({
      requestId: consent.request_id,
      legacyGrantId: "selection-bound-grant",
      subjectId: "selection-bound-subject",
      clientId: "selection-bound-client",
    })
    const beforeDivergence = await app.request(
      "http://personal.example/v1/streams",
      { headers: { authorization: `Bearer ${issued.access_token}` } }
    )
    assert.equal(beforeDivergence.status, 200)

    writeFileSync(
      fixture.activeManifestPath,
      readFileSync(divergent.activeManifestPath)
    )
    assert.throws(
      () =>
        adapter.createConsentRequest({
          sessionId: "divergent-selection-session",
          scopes: ["github.repositories"],
          authorizationDetails: [
            {
              type: PDPP_DATA_ACCESS_TYPE,
              source: { kind: "connector", id: "github" },
              access_mode: "continuous",
              purpose_code: "https://example.test/purpose/research",
              streams: [{ name: "repositories" }],
            },
          ],
        }),
      /active install no longer matches the composed serving selection/
    )
    const afterDivergence = await app.request(
      "http://personal.example/v1/streams",
      { headers: { authorization: `Bearer ${issued.access_token}` } }
    )
    assert.equal(afterDivergence.status, 401)

    await assert.rejects(
      mountPdppResourceServer(new Hono(), {
        ...fixture,
        activeManifestPath: divergent.activeManifestPath,
        selectedInstall,
        tokenIntrospector: {
          introspect: token => adapter.resolveForResourceServer(token),
        },
      }),
      /active install no longer matches the composed serving selection/
    )
  } finally {
    adapter.close()
  }
})

test("serves the selected canonical ChatGPT profile through grant-scoped routes", async () => {
  const fixture = createInstalledChatgptFixture()
  const desktopToken = "desktop-token"
  let now = new Date("2026-07-31T12:00:00.000Z")
  const adapter = createPdppAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    connectorId: "chatgpt-pdpp",
    expectedConnector: {
      key: "chatgpt",
      id: "https://registry.pdpp.org/connectors/chatgpt",
    },
    databasePath: join(fixture.root, "authorization.sqlite"),
    now: () => now,
    scopeForStream: stream => `chatgpt.${stream}`,
    singleUseAccessExpiresInSeconds: 60,
  })
  const app = new Hono()
  registerProtectedRoutes({
    app,
    devToken: desktopToken,
    gatewayClient: { revokeGrant: async () => {} },
    ownerAddress: "0xowner",
    port: 8080,
    send: () => {},
    serverSigner: { signGrantRevocation: async () => "signature" },
    onLegacyGrantRevoked: grantId => adapter.revokeByLegacyGrantId(grantId),
  })
  registerPdppAuthorizationRoutes({
    app,
    devToken: desktopToken,
    adapter,
    enableLocalTimeline: false,
  })

  const writeExport = (name, timestamp, content) =>
    writeFileSync(
      join(fixture.exportRoot, name),
      JSON.stringify({ timestamp, content })
    )
  const exportContent = ({ provenance, recordsByStream, snapshot } = {}) => ({
    platform: "chatgpt",
    version: fixture.manifest.version,
    "pdpp.provenance":
      provenance ??
      chatgptSnapshotProvenance({
        manifestDigest: fixture.manifestDigest,
      }),
    "pdpp.recordsByStream": recordsByStream ?? {
      conversations: [
        chatgptConversation("conversation-a", "2026-02-01T00:00:00.000Z"),
        chatgptConversation("conversation-b", "2026-03-01T00:00:00.000Z"),
        chatgptConversation("resource-excluded", "2026-04-01T00:00:00.000Z"),
        chatgptConversation("time-excluded", "2025-01-01T00:00:00.000Z"),
      ],
    },
    ...(snapshot ? { "pdpp.snapshot": snapshot } : {}),
  })
  writeExport("initial.json", 1785456000000, exportContent())
  await mountPdppResourceServer(app, {
    ...fixture,
    connectorId: "chatgpt-pdpp",
    expectedConnector: {
      key: "chatgpt",
      id: "https://registry.pdpp.org/connectors/chatgpt",
    },
    connectionId: "chatgpt-account-a",
    tokenIntrospector: {
      introspect: token => adapter.resolveForResourceServer(token),
    },
  })

  const details = ({ source = "chatgpt", accessMode = "continuous" } = {}) => [
    {
      type: PDPP_DATA_ACCESS_TYPE,
      source: { kind: "connector", id: source },
      access_mode: accessMode,
      purpose_code: "https://example.test/purpose/research",
      streams: [
        {
          name: "conversations",
          fields: ["title"],
          resources: ["conversation-a", "conversation-b", "time-excluded"],
          time_range: { since: "2026-01-01T00:00:00.000Z" },
        },
      ],
    },
  ]
  const createConsent = async ({ sessionId, scopes, authorizationDetails }) =>
    app.request("http://personal.example/v1/pdpp/consent-requests", {
      method: "POST",
      headers: {
        authorization: `Bearer ${desktopToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        scopes,
        authorization_details: authorizationDetails,
      }),
    })
  const issueBearer = async ({
    sessionId,
    legacyGrantId,
    accessMode = "continuous",
  }) => {
    const consent = await createConsent({
      sessionId,
      scopes: ["chatgpt.conversations"],
      authorizationDetails: details({ accessMode }),
    })
    assert.equal(consent.status, 201, await consent.clone().text())
    const request = await consent.json()
    assert.deepEqual(request.authorization_details.streams[0].fields, [
      "id",
      "title",
    ])
    const approval = await app.request(
      `http://personal.example/v1/pdpp/consent-requests/${request.request_id}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          legacy_grant_id: legacyGrantId,
          subject_id: "chatgpt-subject",
          client_id: TEST_BUILDER.address,
        }),
      }
    )
    assert.equal(approval.status, 201, await approval.clone().text())
    const authorization = await redemptionAuthorization({
      account: TEST_BUILDER,
      origin: "http://personal.example",
      sessionId,
    })
    const credential = await app.request(
      `http://personal.example/v1/pdpp/credentials/${sessionId}/redeem`,
      { method: "POST", headers: { authorization } }
    )
    assert.equal(credential.status, 200, await credential.clone().text())
    return `Bearer ${(await credential.json()).access_token}`
  }

  try {
    const timeline = await app.request(
      "http://personal.example/v1/pdpp/local-timeline/consent-requests",
      {
        method: "POST",
        headers: { authorization: `Bearer ${desktopToken}` },
      }
    )
    assert.equal(timeline.status, 404)

    for (const [index, invalid] of [
      {
        scopes: ["chatgpt.conversations"],
        authorizationDetails: details({ source: "github" }),
      },
      { scopes: [], authorizationDetails: details() },
      {
        scopes: ["chatgpt.conversations", "chatgpt.messages"],
        authorizationDetails: details(),
      },
    ].entries()) {
      const response = await createConsent({
        sessionId: `invalid-${index}`,
        ...invalid,
      })
      assert.equal(response.status, 400)
    }

    const uriSourceConsent = await createConsent({
      sessionId: "chatgpt-uri-source",
      scopes: ["chatgpt.conversations"],
      authorizationDetails: details({
        source: "https://registry.pdpp.org/connectors/chatgpt",
      }),
    })
    assert.equal(uriSourceConsent.status, 201)
    assert.equal(
      (await uriSourceConsent.json()).authorization_details.source.id,
      "chatgpt"
    )

    const bearer = await issueBearer({
      sessionId: "chatgpt-session",
      legacyGrantId: "chatgpt-legacy-grant",
    })
    const headers = { authorization: bearer }
    const streams = await app.request("http://personal.example/v1/streams", {
      headers,
    })
    assert.equal(streams.status, 200)
    assert.deepEqual(
      (await streams.json()).data.map(stream => stream.name),
      ["conversations"]
    )

    const firstPage = await app.request(
      "http://personal.example/v1/streams/conversations/records?limit=1",
      { headers }
    )
    assert.equal(firstPage.status, 200)
    const first = await firstPage.json()
    assert.deepEqual(
      first.data.map(record => record.id),
      ["conversation-a"]
    )
    assert.deepEqual(first.data[0].data, {
      id: "conversation-a",
      title: "title-conversation-a",
    })
    assert.equal(typeof first.next_cursor, "string")
    const secondPage = await app.request(
      `http://personal.example/v1/streams/conversations/records?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
      { headers }
    )
    assert.equal(secondPage.status, 200)
    assert.deepEqual(
      (await secondPage.json()).data.map(record => record.id),
      ["conversation-b"]
    )
    const detail = await app.request(
      "http://personal.example/v1/streams/conversations/records/conversation-a",
      { headers }
    )
    assert.equal(detail.status, 200)
    assert.deepEqual((await detail.json()).data, {
      id: "conversation-a",
      title: "title-conversation-a",
    })

    writeExport(
      "newer-malformed.json",
      1785542400000,
      exportContent({
        recordsByStream: {
          conversations: [{ stream: "conversations", key: "bad" }],
        },
      })
    )
    writeExport("wrong-source.json", 1785628800000, {
      ...exportContent(),
      platform: "github",
    })
    writeExport("wrong-version.json", 1785672000000, {
      ...exportContent(),
      version: "0.1.1",
    })
    writeExport(
      "wrong-provenance.json",
      1785715200000,
      exportContent({
        provenance: chatgptSnapshotProvenance({
          manifestDigest: "sha256:wrong",
          connectionId: "wrong-connection",
        }),
      })
    )
    const retained = await app.request(
      "http://personal.example/v1/streams/conversations/records?limit=100",
      { headers }
    )
    assert.equal(retained.status, 200)
    assert.deepEqual(
      (await retained.json()).data.map(record => record.id),
      ["conversation-a", "conversation-b"]
    )

    const revoke = await app.request(
      "http://personal.example/v1/grants/chatgpt-legacy-grant",
      { method: "DELETE", headers: { authorization: `Bearer ${desktopToken}` } }
    )
    assert.equal(revoke.status, 204)
    const revoked = await app.request("http://personal.example/v1/streams", {
      headers,
    })
    assert.equal(revoked.status, 403)
    assert.equal((await revoked.json()).error.code, "grant_revoked")

    const expiringBearer = await issueBearer({
      sessionId: "chatgpt-expiring-session",
      legacyGrantId: "chatgpt-expiring-grant",
      accessMode: "single_use",
    })
    now = new Date("2026-07-31T12:02:00.000Z")
    const expired = await app.request("http://personal.example/v1/streams", {
      headers: { authorization: expiringBearer },
    })
    assert.equal(expired.status, 403)
    assert.equal((await expired.json()).error.code, "grant_expired")

    now = new Date("2026-07-31T12:00:00.000Z")
    const refreshBearer = await issueBearer({
      sessionId: "chatgpt-refresh-session",
      legacyGrantId: "chatgpt-refresh-grant",
    })
    writeExport(
      "authoritative-empty.json",
      1785801600000,
      exportContent({
        recordsByStream: { conversations: [] },
        snapshot: {
          collection_mode: "full_refresh",
          reset_streams: ["conversations"],
          completed_at: "2026-07-31T12:00:00.000Z",
        },
      })
    )
    const empty = await app.request(
      "http://personal.example/v1/streams/conversations/records",
      { headers: { authorization: refreshBearer } }
    )
    assert.equal(empty.status, 200)
    assert.deepEqual((await empty.json()).data, [])

    const bindingConsent = await createConsent({
      sessionId: "chatgpt-manifest-mismatch",
      scopes: ["chatgpt.conversations"],
      authorizationDetails: details(),
    })
    assert.equal(bindingConsent.status, 201)
    const bindingRequest = await bindingConsent.json()
    const changedManifest = { ...fixture.manifest, version: "0.1.1" }
    const changedBytes = Buffer.from(JSON.stringify(changedManifest))
    writeFileSync(
      join(fixture.installRoot, "profile/collection-profile.json"),
      changedBytes
    )
    const active = JSON.parse(readFileSync(fixture.activeManifestPath))
    active.connectors["chatgpt-pdpp"].version = "0.1.1"
    active.connectors["chatgpt-pdpp"].manifestSha256 = hash(changedBytes)
    writeFileSync(fixture.activeManifestPath, JSON.stringify(active))
    const mismatchedApproval = await app.request(
      `http://personal.example/v1/pdpp/consent-requests/${bindingRequest.request_id}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${desktopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          legacy_grant_id: "chatgpt-mismatched-grant",
          subject_id: "chatgpt-subject",
          client_id: TEST_BUILDER.address,
        }),
      }
    )
    assert.equal(mismatchedApproval.status, 400)
  } finally {
    adapter.close()
  }
})
