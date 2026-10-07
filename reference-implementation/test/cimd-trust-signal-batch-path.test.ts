// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The retained trust signal on a batch-issued child grant, on both backends.
 *
 * `spec-cimd-identity-oracle.test.ts` drives the single-grant path only. The
 * staged-batch path reaches the grant row through different code — the batch
 * review artifact (`buildBatchApprovalReviewArtifact`) and the child-grant
 * insert (`persistApprovedBatchRowsAtomically`) — so a CIMD client needs its
 * own coverage there: the batch completes, and a child grant's own token
 * reports `pdpp.trust_signal` through introspection.
 *
 * The Postgres leg is gated on `PDPP_TEST_POSTGRES_URL` like
 * `grant-package-postgres-path.test.ts`, because it is the only leg that
 * exercises the Postgres read of `grants.trust_signal_json`.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createCimdDocument, seedPreRegisteredClients } from "../server/auth.ts"
import { closeDb, getDb } from "../server/db.ts"
import { startServer } from "../server/index.ts"
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts"
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts"
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts"
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts"

const AS_PUBLIC_URL = "https://as.cimd-batch.test"
const SUBJECT_ID = "owner_local"
const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS)
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL

const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

// Core requires these on the retained trust signal
// (spec-core.md#trust-registry-queries); the oracle asserts the same set on the
// single-grant path.
const CORE_RELIANCE_TUPLE_FIELDS = ["status", "framework_uri", "valid_from", "valid_until"] as const

// See the note in spec-cimd-identity-oracle.test.ts: these are plain node:http
// servers at runtime despite the http2-shaped inferred type.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: {
    close: (cb: (err?: Error) => void) => void
    closeAllConnections: () => void
  }
  rsServer: {
    close: (cb: (err?: Error) => void) => void
    closeAllConnections: () => void
  }
}

interface ConnectorManifest {
  connector_id: string
  [key: string]: unknown
}

interface JsonResult {
  body: Record<string, unknown>
  status: number
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections()
  server.rsServer.closeAllConnections()
  await Promise.allSettled([
    new Promise<void>(r => server.asServer.close(() => r())),
    new Promise<void>(r => server.rsServer.close(() => r())),
  ])
}

async function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResult> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Non-JSON body — keep it verbatim for readable assertion failures.
  }
  return {
    body: (parsed ?? {}) as Record<string, unknown>,
    status: response.status,
  }
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${name}.json`), "utf8")
  ) as ConnectorManifest
}

function detail(sourceId: string, stream: string): Record<string, unknown> {
  return {
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/personalization",
    purpose_description: "CIMD batch reliance record",
    source: { id: sourceId },
    streams: [{ name: stream }],
    type: "https://pdpp.dev/data-access",
  }
}

/**
 * Read a child grant's own token. The approve response returns only the
 * package token, whose introspection is the `mcp_package` shape and carries no
 * reliance record; the per-child client tokens live on the member rows.
 */
async function childTokenIds(packageId: string, backend: "postgres" | "sqlite"): Promise<string[]> {
  if (backend === "postgres") {
    const result = await postgresQuery<{ token_id: string }>(
      "SELECT token_id FROM grant_package_members WHERE package_id = $1 ORDER BY grant_id",
      [packageId]
    )
    return result.rows.map(row => row.token_id)
  }
  const rows = getDb()
    .prepare("SELECT token_id FROM grant_package_members WHERE package_id = ? ORDER BY grant_id")
    .all(packageId) as { token_id: string }[]
  return rows.map(row => row.token_id)
}

/**
 * Boot an AS on the given backend, register two connectors with an eligible
 * instance each, and mint an unregistered CIMD document to stage the batch as.
 */
async function withCimdBatchHarness(
  backend: "postgres" | "sqlite",
  fn: (ctx: { asUrl: string; cimdClientId: string; sourceIds: string[] }) => Promise<void>
): Promise<void> {
  const postgresOptions =
    backend === "postgres" && POSTGRES_URL ? { databaseUrl: POSTGRES_URL, storageBackend: "postgres" as const } : {}
  const server = (await startServer({
    asPort: 0,
    asPublicUrl: AS_PUBLIC_URL,
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: true,
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    ownerAuthPassword: "",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
    ...postgresOptions,
  })) as TestServer
  const asUrl = `http://localhost:${server.asPort}`
  try {
    const store = createRequestConnectorInstanceStore()
    const sourceIds: string[] = []
    for (const name of ["spotify", "reddit"]) {
      const manifest = loadManifest(name)
      const registration = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
      assert.ok(registration.status < 400, `register the ${name} connector`)
      const connectorId = new URL(manifest.connector_id).pathname.split("/").filter(Boolean).at(-1)
      assert.ok(connectorId)
      const now = new Date().toISOString()
      await store.upsert({
        connectorId,
        connectorInstanceId: `cin_cimd_batch_${connectorId}`,
        createdAt: now,
        displayName: `${connectorId} cimd batch fixture`,
        ownerSubjectId: SUBJECT_ID,
        sourceBinding: { fixture: connectorId },
        sourceBindingKey: `cimd-batch:${connectorId}`,
        sourceKind: "manual",
        status: "active",
        updatedAt: now,
      })
      sourceIds.push(manifest.connector_id)
    }
    // No pre-registered clients: the only identity in play is the CIMD URL.
    await seedPreRegisteredClients([])
    const documentId = await createCimdDocument({
      clientName: "CIMD Batch Client",
      redirectUris: [`${AS_PUBLIC_URL}/callback`],
    })

    await fn({
      asUrl,
      cimdClientId: `${AS_PUBLIC_URL}/oauth/client-metadata/${documentId}`,
      sourceIds,
    })
  } finally {
    await closeServer(server)
  }
}

/**
 * Stage a two-source batch as a CIMD client, approve it, and assert the
 * reliance record on a child grant read back through introspection.
 */
async function assertBatchChildGrantRetainsTrustSignal(backend: "postgres" | "sqlite"): Promise<void> {
  await withCimdBatchHarness(backend, async ({ asUrl, cimdClientId, sourceIds }) => {
    const par = await jsonPost(`${asUrl}/oauth/par`, {
      authorization_details: [detail(sourceIds[0] as string, "top_artists"), detail(sourceIds[1] as string, "posts")],
      client_id: cimdClientId,
    })
    assert.equal(par.status, 201, `PAR for a staged batch: ${JSON.stringify(par.body)}`)

    // The regression this closes: with the reliance record on the pending
    // request's client, the batch review artifact carried a member
    // `ReviewClientSchema` forbids, and this returned 400.
    const review = await jsonPost(`${asUrl}/consent/review`, {
      confirm_approve_all: true,
      request_uri: par.body.request_uri,
      subject_id: SUBJECT_ID,
    })
    assert.equal(review.status, 200, `batch consent review for a CIMD client: ${JSON.stringify(review.body)}`)
    const reviewClient = (review.body.approval_review as Record<string, unknown> | undefined)?.client
    assert.deepEqual(
      Object.keys(reviewClient as Record<string, unknown>).sort(),
      ["client_display", "client_id", "registration_mode"],
      "the batch review artifact states only the terms the owner reviewed"
    )

    const approved = await jsonPost(`${asUrl}/consent/approve`, {
      approval_review_revision: review.body.approval_review_revision,
      confirm_reviewed_decision: "1",
      request_uri: par.body.request_uri,
    })
    assert.equal(approved.status, 200, `batch consent approve: ${JSON.stringify(approved.body)}`)
    const grant = approved.body.grant as { child_grants?: { grant_id: string }[] } | undefined
    assert.equal(grant?.child_grants?.length, 2, "the batch issues one child grant per approved source")

    const tokenIds = await childTokenIds(approved.body.package_id as string, backend)
    assert.equal(tokenIds.length, 2, "each child grant carries its own token")

    for (const tokenId of tokenIds) {
      const introspection = await jsonPost(
        `${asUrl}/introspect`,
        { token: tokenId },
        { Authorization: INTROSPECTION_AUTHORIZATION }
      )
      assert.equal(introspection.status, 200, "introspection succeeds for a child grant")
      assert.equal(introspection.body.active, true, "a child grant's token is active")
      const pdpp = introspection.body.pdpp as Record<string, unknown> | undefined
      const trustSignal = pdpp?.trust_signal as Record<string, unknown> | undefined
      assert.ok(trustSignal, `the batch-issued child grant retains the trust signal the AS relied on (${backend})`)
      for (const field of CORE_RELIANCE_TUPLE_FIELDS) {
        assert.ok(field in trustSignal, `the retained trust signal names ${field}`)
      }
      assert.ok(
        typeof trustSignal.looked_up_at === "string",
        "the retained trust signal records the time of lookup, because a status may be withdrawn later"
      )
    }
  })
}

test("cimd batch: a batch-issued child grant retains the trust signal (sqlite)", async () => {
  await assertBatchChildGrantRetainsTrustSignal("sqlite")
})

if (POSTGRES_URL) {
  // The Postgres read is the leg that matters here: the signal is written by
  // the child-grant insert on both backends, but only the Postgres
  // introspection query had to be taught to select it back.
  test("cimd batch: a batch-issued child grant retains the trust signal (postgres)", async () => {
    await assertBatchChildGrantRetainsTrustSignal("postgres")
  })

  test.after(async () => {
    await closePostgresStorage()
    closeDb()
  })
} else {
  test(
    "cimd batch child grant on postgres (skipped: PDPP_TEST_POSTGRES_URL unset)",
    {
      skip: true,
    },
    () => {
      /* intentionally empty */
    }
  )
}
