import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Database from "better-sqlite3"
import {
  createGithubAuthorizationAdapter,
  PDPP_DATA_ACCESS_TYPE,
} from "./index.js"
import { createLocalTimelineAuthorizationRequest } from "./policy.js"

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function fixture(additionalStreams = []) {
  const root = mkdtempSync(join(tmpdir(), "pdpp-github-auth-"))
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  const manifest = {
    connector_id: "https://registry.pdpp.org/connectors/github",
    connector_key: "github",
    version: "0.5.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      ...additionalStreams,
      {
        name: "repositories",
        consent_time_field: "updated_at",
        selection: { fields: true, resources: true },
        schema: { properties: { id: {}, name: {}, full_name: {} } },
        views: [{ id: "basic", fields: ["id", "name"] }],
      },
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const entrypointBytes = Buffer.from("export default {}")
  const provenanceBytes = Buffer.from(JSON.stringify({ source: "test" }))
  writeFileSync(join(root, "profile/collection-profile.json"), manifestBytes)
  writeFileSync(join(root, "dist/collection-profile.mjs"), entrypointBytes)
  writeFileSync(join(root, "provenance.json"), provenanceBytes)
  const activePath = join(root, "connectors-active.json")
  writeFileSync(
    activePath,
    JSON.stringify({
      connectors: {
        "github-pdpp": {
          connectorId: "github-pdpp",
          version: "0.5.0",
          rootPath: root,
          artifactKind: "pdpp-collection-profile",
          manifestPath: "profile/collection-profile.json",
          entrypointPath: "dist/collection-profile.mjs",
          provenancePath: "provenance.json",
          manifestSha256: hash(manifestBytes),
          entrypointSha256: hash(entrypointBytes),
          provenanceSha256: hash(provenanceBytes),
        },
      },
    })
  )
  return { root, activePath, databasePath: join(root, "authorization.sqlite") }
}

function details(
  stream = {
    name: "repositories",
    view: "basic",
    resources: ["repo:octo/hello"],
  }
) {
  return [
    {
      type: PDPP_DATA_ACCESS_TYPE,
      source: { kind: "connector", id: "github" },
      access_mode: "continuous",
      purpose_code: "https://example.test/purpose/research",
      purpose_description: "Research",
      retention: { max_duration: "P30D", on_expiry: "delete" },
      streams: [stream],
    },
  ]
}

test("derives first-party Timeline consent from every verified manifest stream", () => {
  const names = [
    "user",
    "user_stats",
    "repositories",
    "starred",
    "issues",
    "pull_requests",
    "gists",
  ]
  const request = createLocalTimelineAuthorizationRequest({
    streams: names.map(name => ({ name })),
  })
  assert.deepEqual(
    request.authorizationDetails[0].streams,
    names.map(name => ({ name }))
  )
  assert.deepEqual(
    request.scopes,
    names.map(name => `pdpp.local.github.${name}`)
  )
})

test("persists an immutable verified-manifest grant and separates private from public resolution", () => {
  const fixtureData = fixture()
  const options = {
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
  }
  let token
  try {
    const adapter = createGithubAuthorizationAdapter(options)
    const request = adapter.createConsentRequest({
      sessionId: "session-1",
      scopes: ["github.repositories"],
      authorizationDetails: details(),
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "legacy-1",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    token = issued.access_token
    assert.equal(issued.grant.subject_id, "subject-1")
    assert.equal(issued.grant.client_id, "client-1")
    assert.deepEqual(adapter.resolveForResourceServer(token), {
      active: true,
      pdpp_token_kind: "client",
      subject_id: "subject-1",
      client_id: "client-1",
      grant: issued.grant,
    })
    const publicResult = adapter.introspectPublic(token)
    assert.deepEqual(publicResult, {
      active: true,
      pdpp_token_kind: "client",
      subject_id: "subject-1",
      client_id: "client-1",
    })
    assert.equal("grant" in publicResult, false)
    assert.equal("grant_id" in publicResult, false)
    adapter.close()

    const reopened = createGithubAuthorizationAdapter(options)
    assert.equal(reopened.resolveForResourceServer(token).active, true)
    assert.equal(reopened.revokeByLegacyGrantId("legacy-1"), true)
    assert.deepEqual(reopened.resolveForResourceServer(token), {
      active: false,
      inactive_reason: "grant_revoked",
    })
    reopened.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("redeems an external session credential once after restart without exposing it at approval", () => {
  const fixtureData = fixture()
  const options = {
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
  }
  try {
    const adapter = createGithubAuthorizationAdapter(options)
    const request = adapter.createConsentRequest({
      sessionId: "external-session-1",
      scopes: ["github.repositories"],
      authorizationDetails: details(),
    })
    const approval = adapter.issueApprovedGrantForRedemption({
      requestId: request.request_id,
      legacyGrantId: "external-legacy-1",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.equal("access_token" in approval, false)
    assert.equal("redemption_code" in approval, false)
    assert.deepEqual(approval, {
      grant_id: approval.grant_id,
      session_id: "external-session-1",
      token_type: "Bearer",
    })
    adapter.close()

    const reopened = createGithubAuthorizationAdapter(options)
    const redeemed = reopened.redeemSessionCredential({
      sessionId: "external-session-1",
      clientId: "client-1",
    })
    assert.equal(typeof redeemed.access_token, "string")
    assert.equal(redeemed.token_type, "Bearer")
    assert.equal(
      reopened.resolveForResourceServer(redeemed.access_token).active,
      true
    )
    assert.throws(
      () =>
        reopened.redeemSessionCredential({
          sessionId: "external-session-1",
          clientId: "client-1",
        }),
      /already redeemed/
    )
    reopened.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("expires external single-use grants across restart without exposing their grant", () => {
  const fixtureData = fixture()
  let time = new Date("2026-07-30T12:00:00Z")
  const options = {
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
    now: () => time,
  }
  try {
    const adapter = createGithubAuthorizationAdapter(options)
    const request = adapter.createConsentRequest({
      sessionId: "single-use-session",
      scopes: ["github.repositories"],
      authorizationDetails: [
        {
          ...details()[0],
          access_mode: "single_use",
        },
      ],
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "single-use-legacy-grant",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.equal(issued.grant.expires_at, "2026-07-30T20:00:00.000Z")
    assert.equal(
      adapter.resolveForResourceServer(issued.access_token).active,
      true
    )
    assert.deepEqual(adapter.introspectPublic(issued.access_token), {
      active: true,
      pdpp_token_kind: "client",
      subject_id: "subject-1",
      client_id: "client-1",
    })
    adapter.close()

    time = new Date("2026-07-30T20:00:00Z")
    const reopened = createGithubAuthorizationAdapter(options)
    assert.deepEqual(reopened.resolveForResourceServer(issued.access_token), {
      active: false,
      inactive_reason: "grant_expired",
    })
    assert.deepEqual(reopened.introspectPublic(issued.access_token), {
      active: false,
      inactive_reason: "grant_expired",
    })
    reopened.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("allows the Personal Server to configure the external single-use lifetime", () => {
  const fixtureData = fixture()
  const adapter = createGithubAuthorizationAdapter({
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
    now: () => new Date("2026-07-30T12:00:00Z"),
    singleUseAccessExpiresInSeconds: 60,
  })
  try {
    const request = adapter.createConsentRequest({
      sessionId: "configured-single-use-session",
      scopes: ["github.repositories"],
      authorizationDetails: [{ ...details()[0], access_mode: "single_use" }],
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "configured-single-use-legacy-grant",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.equal(issued.grant.expires_at, "2026-07-30T12:01:00.000Z")
  } finally {
    adapter.close()
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("keeps continuous external grants active until explicit revocation", () => {
  const fixtureData = fixture()
  let time = new Date("2026-07-30T12:00:00Z")
  const options = {
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
    now: () => time,
  }
  try {
    const adapter = createGithubAuthorizationAdapter(options)
    const request = adapter.createConsentRequest({
      sessionId: "continuous-session",
      scopes: ["github.repositories"],
      authorizationDetails: details(),
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "continuous-legacy-grant",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.equal("expires_at" in issued.grant, false)
    adapter.close()

    time = new Date("2026-08-30T12:00:00Z")
    const reopened = createGithubAuthorizationAdapter(options)
    assert.equal(
      reopened.resolveForResourceServer(issued.access_token).active,
      true
    )
    assert.equal(
      reopened.revokeByLegacyGrantId("continuous-legacy-grant"),
      true
    )
    assert.deepEqual(reopened.resolveForResourceServer(issued.access_token), {
      active: false,
      inactive_reason: "grant_revoked",
    })
    assert.deepEqual(reopened.introspectPublic(issued.access_token), {
      active: false,
      inactive_reason: "grant_revoked",
    })
    reopened.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("migrates existing authorization databases before persisting external expiry", () => {
  const fixtureData = fixture()
  const oldDatabase = new Database(fixtureData.databasePath)
  oldDatabase.exec(`
    CREATE TABLE pdpp_github_consent_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      manifest_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      subject_id TEXT,
      client_id TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE pdpp_github_grants (
      grant_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES pdpp_github_consent_requests(request_id),
      legacy_grant_id TEXT NOT NULL UNIQUE,
      grant_json TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE pdpp_github_tokens (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      grant_id TEXT NOT NULL REFERENCES pdpp_github_grants(grant_id),
      issued_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `)
  oldDatabase.close()
  try {
    const adapter = createGithubAuthorizationAdapter({
      databasePath: fixtureData.databasePath,
      activeManifestPath: fixtureData.activePath,
    })
    const database = new Database(fixtureData.databasePath, { readonly: true })
    assert.equal(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('pdpp_github_grants') WHERE name = 'expires_at'"
        )
        .get()?.name,
      "expires_at"
    )
    assert.equal(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('pdpp_github_tokens') WHERE name = 'expires_at'"
        )
        .get()?.name,
      "expires_at"
    )
    database.close()
    const request = adapter.createConsentRequest({
      sessionId: "migrated-single-use-session",
      scopes: ["github.repositories"],
      authorizationDetails: [{ ...details()[0], access_mode: "single_use" }],
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "migrated-single-use-legacy-grant",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.equal(typeof issued.grant.expires_at, "string")
    adapter.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("binds local Timeline grants to their session, subject, client, expiry, and revocation", () => {
  const fixtureData = fixture()
  let time = new Date("2026-07-30T12:00:00Z")
  const adapter = createGithubAuthorizationAdapter({
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
    now: () => time,
  })
  try {
    const consent = adapter.createLocalTimelineConsentRequest({
      sessionId: "timeline-session",
      subjectId: "timeline-subject",
    })
    assert.equal(consent.session_id, "timeline-session")
    assert.equal(consent.subject_id, "timeline-subject")
    assert.deepEqual(consent.scopes, ["pdpp.local.github.repositories"])
    assert.deepEqual(consent.authorization_details, {
      type: PDPP_DATA_ACCESS_TYPE,
      source: { kind: "connector", id: "github" },
      access_mode: "continuous",
      purpose_code: "https://dataconnect.app/purposes/timeline",
      purpose_description:
        "Show your connected records in DataConnect's local Timeline.",
      retention: undefined,
      streams: [{ name: "repositories" }],
    })
    assert.equal(consent.access_expires_in_seconds, 8 * 60 * 60)
    assert.throws(
      () =>
        adapter.issueLocalTimelineGrant({
          requestId: consent.request_id,
          sessionId: "other-session",
          subjectId: "timeline-subject",
        }),
      /session does not match/
    )
    const issued = adapter.issueLocalTimelineGrant({
      requestId: consent.request_id,
      sessionId: "timeline-session",
      subjectId: "timeline-subject",
    })
    assert.equal(issued.grant.client_id, "dataconnect.timeline")
    assert.equal(issued.grant.subject_id, "timeline-subject")
    assert.equal(
      adapter.resolveForResourceServer(issued.access_token).active,
      true
    )
    assert.equal(
      adapter.revokeLocalTimelineSession({
        sessionId: "timeline-session",
        subjectId: "timeline-subject",
      }),
      true
    )
    assert.deepEqual(adapter.resolveForResourceServer(issued.access_token), {
      active: false,
      inactive_reason: "grant_revoked",
    })

    const expiringConsent = adapter.createLocalTimelineConsentRequest({
      sessionId: "expiring-session",
      subjectId: "timeline-subject",
    })
    const expiring = adapter.issueLocalTimelineGrant({
      requestId: expiringConsent.request_id,
      sessionId: "expiring-session",
      subjectId: "timeline-subject",
    })
    time = new Date("2026-07-30T21:00:01Z")
    assert.deepEqual(adapter.resolveForResourceServer(expiring.access_token), {
      active: false,
      inactive_reason: "grant_expired",
    })
  } finally {
    adapter.close()
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("rejects widening and fails closed when the active verified manifest disappears", () => {
  const fixtureData = fixture()
  const options = {
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
  }
  try {
    const adapter = createGithubAuthorizationAdapter(options)
    assert.throws(
      () =>
        adapter.createConsentRequest({
          sessionId: "session-1",
          scopes: ["github.repositories"],
          authorizationDetails: details({
            name: "repositories",
            fields: ["private_token"],
          }),
        }),
      /Unknown fields/
    )
    const request = adapter.createConsentRequest({
      sessionId: "session-1",
      scopes: ["github.repositories"],
      authorizationDetails: details(),
    })
    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "legacy-1",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    rmSync(fixtureData.activePath)
    assert.deepEqual(adapter.resolveForResourceServer(issued.access_token), {
      active: false,
    })
    assert.deepEqual(adapter.introspectPublic(issued.access_token), {
      active: false,
    })
    adapter.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("persists exactly the explicit fields shown in consent", () => {
  const fixtureData = fixture([
    {
      name: "user",
      consent_time_field: "updated_at",
      selection: { fields: true, resources: true },
      schema: {
        required: ["id", "login"],
        properties: { id: {}, login: {}, email: {}, updated_at: {} },
      },
      views: [{ id: "contact", fields: ["email"] }],
    },
  ])
  const adapter = createGithubAuthorizationAdapter({
    databasePath: fixtureData.databasePath,
    activeManifestPath: fixtureData.activePath,
  })
  try {
    const request = adapter.createConsentRequest({
      sessionId: "session-1",
      scopes: ["github.profile"],
      authorizationDetails: details({
        name: "user",
        fields: ["email"],
      }),
    })
    assert.deepEqual(request.authorization_details.streams, [
      { name: "user", fields: ["id", "login", "email"] },
    ])

    const issued = adapter.issueApprovedGrant({
      requestId: request.request_id,
      legacyGrantId: "legacy-1",
      subjectId: "subject-1",
      clientId: "client-1",
    })
    assert.deepEqual(issued.grant.streams, [
      { name: "user", fields: ["id", "login", "email"] },
    ])

    const viewRequest = adapter.createConsentRequest({
      sessionId: "session-2",
      scopes: ["github.profile"],
      authorizationDetails: details({
        name: "user",
        view: "contact",
      }),
    })
    assert.deepEqual(viewRequest.authorization_details.streams, [
      {
        name: "user",
        view: "contact",
        fields: ["id", "login", "email"],
      },
    ])
  } finally {
    adapter.close()
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})

test("rejects authorization details whose streams do not exactly bind the claimed session scopes", () => {
  const fixtureData = fixture()
  try {
    const adapter = createGithubAuthorizationAdapter({
      databasePath: fixtureData.databasePath,
      activeManifestPath: fixtureData.activePath,
    })
    assert.throws(
      () =>
        adapter.createConsentRequest({
          sessionId: "session-1",
          scopes: ["github.profile"],
          authorizationDetails: details(),
        }),
      /exactly match the claimed session scopes/
    )
    adapter.close()
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true })
  }
})
