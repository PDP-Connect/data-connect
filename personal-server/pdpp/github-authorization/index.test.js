import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createGithubAuthorizationAdapter,
  PDPP_DATA_ACCESS_TYPE,
} from "./index.js"
import { createLocalTimelineAuthorizationRequest } from "./policy.js"

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pdpp-github-auth-"))
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  const manifest = {
    connector_key: "github",
    version: "0.5.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
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
  assert.deepEqual(request.authorizationDetails[0].streams, names.map(name => ({ name })))
  assert.deepEqual(request.scopes, names.map(name => `pdpp.local.github.${name}`))
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
