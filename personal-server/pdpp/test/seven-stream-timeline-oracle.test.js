// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-boundary oracle for the DataConnect GitHub PDPP export contract.
 *
 * The fixture starts at the persisted export boundary rather than inserting
 * rows into SQLite: Rust's `build_export_data` writes its value as the
 * `content` of a DataConnect export and the Personal Server imports the
 * `pdpp.recordsByStream` snapshot from that value.
 *
 * Rust seam: `build_export_data` is private to the Tauri command module, so a
 * Node test cannot invoke it without adding a test-only command/file API.
 * This fixture is derived from that serializer's public persisted shape
 * (`platform`, `version`, `pdpp.recordsByStream`, `pdpp.snapshot`) and the
 * seven-stream assertion in its
 * `github_legacy_projections_preserve_all_selected_streams_losslessly` unit
 * test. The assertions below validate the
 * consuming boundary, including authoritative empty-stream entries; they do
 * not claim to execute the Rust serializer.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Hono } from "hono"

import { createGithubAuthorizationAdapter } from "../github-authorization/index.js"
import { registerGithubAuthorizationRoutes } from "../github-authorization/http-routes.js"
import { mountPdppResourceServer } from "../resource-server.js"

const EXPORT_VERSION = "0.5.0"
const DESKTOP_TOKEN = "seven-stream-oracle-desktop-token"
const SESSION_ID = "seven-stream-oracle-session"
const SUBJECT_ID = "seven-stream-oracle-subject"

// This one compact contract drives both the verified install and export. It
// prevents the test from maintaining separate lists of streams in each layer.
const STREAM_SPECS = [
  ["user", ["id", "login"], "updated_at", "created_at", "date-time"],
  [
    "user_stats",
    ["id", "user_id", "observed_on"],
    "observed_on",
    "observed_on",
    "date",
  ],
  ["repositories", ["id", "full_name"], "pushed_at", "created_at", "date-time"],
  ["starred", ["id", "full_name"], "starred_at", "starred_at", "date-time"],
  ["issues", ["id"], "updated_at", "created_at", "date-time"],
  ["pull_requests", ["id"], "updated_at", "created_at", "date-time"],
  ["gists", ["id"], "updated_at", "created_at", "date-time"],
]

function sha256(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

function manifestFromStreamSpecs() {
  return {
    protocol_version: "0.1.0",
    connector_id: "https://registry.pdpp.org/connectors/github",
    connector_key: "github",
    display_name: "GitHub",
    version: EXPORT_VERSION,
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: STREAM_SPECS.map(
      ([name, required, cursorField, consentTimeField, timingFormat]) => ({
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
                    ? { format: timingFormat }
                    : {}),
                },
              ]
            )
          ),
          required,
        },
      })
    ),
  }
}

function envelope(stream, id, data) {
  return {
    stream,
    key: id,
    data: { id, ...data },
    emitted_at: "2026-07-30T12:00:00Z",
  }
}

function recordsForManifest(manifest) {
  const records = Object.fromEntries(
    manifest.streams.map(stream => [stream.name, []])
  )
  records.user.push(
    envelope("user", "octocat", {
      login: "octocat",
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2026-07-30T09:00:00Z",
    })
  )
  // Date-only cursor and consent fields are valid production profile data.
  records.user_stats.push(
    envelope("user_stats", "octocat:2026-07-30", {
      user_id: "octocat",
      observed_on: "2026-07-30",
    })
  )
  // Two records make opaque cursor pagination an actual boundary assertion.
  records.repositories.push(
    envelope("repositories", "octocat/first", {
      full_name: "octocat/first",
      created_at: "2024-01-01T00:00:00Z",
      pushed_at: "2026-07-30T10:00:00Z",
    }),
    envelope("repositories", "octocat/second", {
      full_name: "octocat/second",
      created_at: "2024-01-02T00:00:00Z",
      pushed_at: "2026-07-30T11:00:00Z",
    })
  )
  records.starred.push(
    envelope("starred", "upstream/project", {
      full_name: "upstream/project",
      starred_at: "2026-07-30T08:00:00Z",
    })
  )
  records.pull_requests.push(
    envelope("pull_requests", "42", {
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-30T07:00:00Z",
    })
  )
  // `issues` and `gists` deliberately remain explicit empty full-refresh
  // streams. They must still be listed and remain grant-visible.
  return records
}

function writeVerifiedInstallAndExport() {
  const root = mkdtempSync(join(tmpdir(), "dataconnect-seven-stream-oracle-"))
  const installRoot = join(root, "install")
  const exportRoot = join(root, "exports")
  mkdirSync(join(installRoot, "profile"), { recursive: true })
  mkdirSync(join(installRoot, "dist"), { recursive: true })
  mkdirSync(exportRoot)

  const manifest = manifestFromStreamSpecs()
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const manifestDigest = sha256(manifestBytes)
  const entrypointBytes = Buffer.from("export default {}\n")
  const provenanceBytes = Buffer.from(
    JSON.stringify({ source: "seven-stream-oracle" })
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
          version: EXPORT_VERSION,
          rootPath: installRoot,
          artifactKind: "pdpp-collection-profile",
          manifestPath: "profile/collection-profile.json",
          entrypointPath: "dist/collection-profile.mjs",
          provenancePath: "provenance.json",
          manifestSha256: manifestDigest,
          entrypointSha256: sha256(entrypointBytes),
          provenanceSha256: sha256(provenanceBytes),
        },
      },
    })
  )

  const recordsByStream = recordsForManifest(manifest)
  assert.deepEqual(
    Object.keys(recordsByStream),
    manifest.streams.map(stream => stream.name),
    "the production-shaped export has a snapshot entry for every verified stream"
  )
  writeFileSync(
    join(exportRoot, "github-pdpp-export.json"),
    JSON.stringify({
      timestamp: "2026-07-30T12:00:00Z",
      content: {
        platform: "github",
        version: EXPORT_VERSION,
        // Matches the persisted Rust export's post-fb1d726 hand-off contract.
        // Current import code ignores it; the fixture is already valid once
        // provenance binding begins rejecting mismatched candidates.
        "pdpp.provenance": {
          connector_key: manifest.connector_key,
          connector_id: manifest.connector_id,
          manifest_version: manifest.version,
          manifest_sha256: manifestDigest,
          run_id: "seven-stream-oracle-run",
          connection_id: "default",
        },
        "pdpp.recordsByStream": recordsByStream,
        "pdpp.snapshot": {
          collection_mode: "full_refresh",
          reset_streams: manifest.streams.map(stream => stream.name),
          completed_at: "2026-07-30T12:00:00Z",
        },
        exportSummary: {
          count: Object.values(recordsByStream).flat().length,
          details: {
            pdppStorageProjection: "github-v1",
            pdppStreamRecords: Object.fromEntries(
              Object.entries(recordsByStream).map(([stream, records]) => [
                stream,
                records.length,
              ])
            ),
          },
        },
      },
    })
  )

  return {
    root,
    activeManifestPath,
    exportRoot,
    databasePath: join(root, "records.sqlite"),
    authorizationDatabasePath: join(root, "authorization.sqlite"),
    recordsByStream,
    streamNames: manifest.streams.map(stream => stream.name),
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.json()
  return { response, body }
}

test("seven-stream DataConnect export is Timeline-readable only through local consent and fails closed after revocation", async t => {
  const fixture = writeVerifiedInstallAndExport()
  const adapter = createGithubAuthorizationAdapter({
    activeManifestPath: fixture.activeManifestPath,
    databasePath: fixture.authorizationDatabasePath,
  })
  const app = new Hono()
  let server

  t.after(async () => {
    adapter.close()
    await new Promise(resolve => server?.close(resolve))
    await rm(fixture.root, { force: true, recursive: true })
  })

  registerGithubAuthorizationRoutes({
    app,
    devToken: DESKTOP_TOKEN,
    adapter,
  })
  await mountPdppResourceServer(app, {
    activeManifestPath: fixture.activeManifestPath,
    databasePath: fixture.databasePath,
    exportRoot: fixture.exportRoot,
    tokenIntrospector: {
      introspect: token => adapter.resolveForResourceServer(token),
    },
  })
  const { serve } = await import("@hono/node-server")
  server = serve({ fetch: app.fetch, port: 0 })
  await once(server, "listening")
  const address = server.address()
  assert.equal(typeof address, "object")
  assert.ok(address && "port" in address)
  const baseUrl = `http://127.0.0.1:${address.port}`

  const noGrant = await fetch(`${baseUrl}/v1/streams`)
  assert.equal(noGrant.status, 401)

  const consent = await requestJson(
    `${baseUrl}/v1/pdpp/local-timeline/consent-requests`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${DESKTOP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session_id: SESSION_ID, subject_id: SUBJECT_ID }),
    }
  )
  assert.equal(consent.response.status, 201)
  assert.deepEqual(
    consent.body.scopes,
    fixture.streamNames.map(name => `pdpp.local.github.${name}`),
    "Timeline consent is derived from the verified installed profile"
  )

  const approval = await requestJson(
    `${baseUrl}/v1/pdpp/local-timeline/consent-requests/${encodeURIComponent(consent.body.request_id)}/approve`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${DESKTOP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session_id: SESSION_ID, subject_id: SUBJECT_ID }),
    }
  )
  assert.equal(approval.response.status, 201)
  assert.equal(approval.body.grant.client_id, "dataconnect.timeline")
  const bearer = { authorization: `Bearer ${approval.body.access_token}` }

  const streams = await requestJson(`${baseUrl}/v1/streams`, {
    headers: bearer,
  })
  assert.equal(streams.response.status, 200)
  assert.deepEqual(
    streams.body.data.map(stream => stream.name),
    fixture.streamNames,
    "every verified stream, including empty streams, is grant-visible"
  )
  assert.deepEqual(
    Object.fromEntries(
      streams.body.data.map(stream => [stream.name, stream.record_count])
    ),
    Object.fromEntries(
      Object.entries(fixture.recordsByStream).map(([stream, records]) => [
        stream,
        records.length,
      ])
    )
  )

  const expectedIds = Object.fromEntries(
    Object.entries(fixture.recordsByStream).map(([stream, records]) => [
      stream,
      records.map(record => record.key),
    ])
  )
  for (const stream of fixture.streamNames) {
    const page = await requestJson(
      `${baseUrl}/v1/streams/${encodeURIComponent(stream)}/records?limit=100`,
      { headers: bearer }
    )
    assert.equal(page.response.status, 200, `${stream} must be readable`)
    assert.deepEqual(
      page.body.data.map(record => record.id).sort(),
      [...expectedIds[stream]].sort(),
      `${stream} records must survive the export-to-resource boundary`
    )
  }

  const firstRepositoryPage = await requestJson(
    `${baseUrl}/v1/streams/repositories/records?limit=1`,
    { headers: bearer }
  )
  assert.equal(firstRepositoryPage.response.status, 200)
  assert.equal(firstRepositoryPage.body.data.length, 1)
  assert.equal(firstRepositoryPage.body.has_more, true)
  assert.equal(typeof firstRepositoryPage.body.next_cursor, "string")
  const secondRepositoryPage = await requestJson(
    `${baseUrl}/v1/streams/repositories/records?limit=1&cursor=${encodeURIComponent(firstRepositoryPage.body.next_cursor)}`,
    { headers: bearer }
  )
  assert.equal(secondRepositoryPage.response.status, 200)
  assert.equal(secondRepositoryPage.body.data.length, 1)
  assert.equal(secondRepositoryPage.body.has_more, false)
  assert.notEqual(
    firstRepositoryPage.body.data[0].id,
    secondRepositoryPage.body.data[0].id,
    "the opaque next cursor advances through production-shaped records"
  )

  const revoked = await requestJson(
    `${baseUrl}/v1/pdpp/local-timeline/revoke`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${DESKTOP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ session_id: SESSION_ID, subject_id: SUBJECT_ID }),
    }
  )
  assert.equal(revoked.response.status, 200)
  assert.deepEqual(revoked.body, { revoked: true })

  const denied = await requestJson(`${baseUrl}/v1/streams`, { headers: bearer })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.body.error.code, "grant_revoked")
})
