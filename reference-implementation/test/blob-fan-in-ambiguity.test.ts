// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level regression for `GET /v1/blobs/:blob_id` under multi-binding
 * (multi-connection) deployments. Pins the owner-review revision
 * (`tmp/workstreams/fan-in-branch-owner-review-report.md`) for:
 *
 *   P1: blob ambiguity must be reachable and emit typed `ambiguous_connection`
 *       (HTTP 409) with `available_connections` when the same blob_id is
 *       visible through more than one connection and the request did not
 *       specify `connection_id`.
 *
 *   P2: blob reads must respect grant-scope `streams[].instance_ids`. A
 *       grant pinned to connection A for stream S must not expose blob
 *       bytes reachable only from connection B for stream S.
 *
 * The tests drive the actual Fastify route through the public surface so a
 * regression at the route adapter (not just the helper) is caught.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exec, referenceQueries } from "../lib/db.ts";
import { registerConnector } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  buildPairwiseOwnerBindings,
  getPairwiseHandle,
  pairwiseInstanceIdentityEnabled,
} from "../server/pairwise-identity.ts";
import { ingestRecord } from "../server/records.ts";
import { mountRsRecordsDelete } from "../server/routes/rs-mutation.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

const CONNECTOR_ID = "spotify";
const SOURCE_ID = "https://registry.pdpp.dev/connectors/spotify";
const STREAM_A = "photos";
const STREAM_B = "videos";
const INSTANCE_A = "cin_blob_account_a";
const INSTANCE_B = "cin_blob_account_b";

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: SOURCE_ID,
  display_name: "Blob Fan-in Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM_A,
      primary_key: ["id"],
      query: { aggregations: { count: true } },
      schema: {
        properties: {
          blob_ref: {
            properties: {
              blob_id: { type: "string" },
              mime_type: { type: "string" },
              sha256: { type: "string" },
              size_bytes: { type: "integer" },
            },
            required: ["blob_id"],
            type: "object",
          },
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
        },
        required: ["id", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "mutable_state",
    },
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM_B,
      primary_key: ["id"],
      query: { aggregations: { count: true } },
      schema: {
        properties: {
          blob_ref: {
            properties: {
              blob_id: { type: "string" },
              mime_type: { type: "string" },
              sha256: { type: "string" },
              size_bytes: { type: "integer" },
            },
            required: ["blob_id"],
            type: "object",
          },
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
        },
        required: ["id", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

function target(instanceId: string) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

async function seedInstance(instanceId: string, displayName: string, sourceBindingKey: string) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

// Insert a blob row + binding directly into the SQLite tables so we
// fully control the (connector_id, connector_instance_id, stream, record_key)
// tuples each binding references. Mirrors the columns
// `persistContentAddressedBlob` writes.
interface SeedBlobParams {
  blobId: string;
  connectorInstanceId: string;
  data: Buffer;
  mimeType: string;
  recordKey: string;
  stream: string;
}

function seedBlob({ blobId, connectorInstanceId, stream, recordKey, mimeType, data }: SeedBlobParams) {
  exec(referenceQueries.blobsInsertBlob, [
    blobId,
    CONNECTOR_ID,
    connectorInstanceId,
    stream,
    recordKey,
    mimeType,
    data.length,
    "sha256_test",
    data,
  ]);
}

interface SeedBlobBindingParams {
  blobId: string;
  connectorInstanceId: string;
  recordKey: string;
  stream: string;
}

function seedBlobBinding({ blobId, connectorInstanceId, stream, recordKey }: SeedBlobBindingParams) {
  exec(referenceQueries.blobsInsertBinding, [blobId, CONNECTOR_ID, connectorInstanceId, stream, recordKey]);
}

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function issueOwnerOnlyHarness(
  testFn: (server: TestServer) => Promise<void>,
  options: { introspectionFetch?: typeof fetch } = {}
) {
  // For owner-mode blob reads the route resolves storage binding from
  // `req.query.connector_id` + optional `connector_instance_id`. For
  // grant-mode blob reads the route uses the grant's resolved storage
  // binding. We test both.
  const server = (await startServer({
    ...options,
    asPort: 0,
    dbPath: ":memory:",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(INSTANCE_B, "Account B", "b@example.com");
    await testFn(server);
  } finally {
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((r) => server.asServer.close(r)),
      new Promise((r) => server.rsServer.close(r)),
    ]);
  }
}

async function getOwnerToken(server: TestServer): Promise<string> {
  const asUrl = `http://localhost:${server.asPort}`;
  const clientId = "cli_longview";
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const deviceText = await deviceResp.text();
  if (!deviceResp.ok) {
    throw new Error(`device_authorization failed: ${deviceResp.status} ${deviceText}`);
  }
  const device = JSON.parse(deviceText);
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenText = await tokenResp.text();
  if (!tokenResp.ok) {
    throw new Error(`token failed: ${tokenResp.status} ${tokenText}`);
  }
  const tokenBody = JSON.parse(tokenText);
  if (!tokenBody.access_token) {
    throw new Error(`no access_token: ${JSON.stringify(tokenBody)}`);
  }
  return tokenBody.access_token;
}

// ─── P1: blob ambiguity is reachable + emits 409 ───────────────────────────

test("GET /v1/blobs/:blob_id emits 409 ambiguous_connection when blob visible via 2 connections (owner mode)", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = "blob_sha256_ambig_001";
    const sharedBytes = Buffer.from("shared-bytes");
    // Seed: the same blob_id is referenced by records under TWO different
    // connector_instance_ids, both under the same stream.
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      data: sharedBytes,
      mimeType: "text/plain",
      recordKey: "rec-a-1",
      stream: STREAM_A,
    });
    seedBlobBinding({
      blobId,
      connectorInstanceId: INSTANCE_B,
      recordKey: "rec-b-1",
      stream: STREAM_A,
    });
    // The records themselves must reference the blob via blob_ref.
    await ingestRecord(target(INSTANCE_A), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-a-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-a-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_B), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-b-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-b-1",
      stream: STREAM_A,
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(resp.status, 409, `expected 409 ambiguous_connection, got ${resp.status}`);
    const body = (await resp.json()) as {
      error?: { code?: string; retry_with?: string; available_connections?: { connection_id: string }[] };
    };
    assert.equal(
      body.error?.code,
      "ambiguous_connection",
      `expected ambiguous_connection, got ${JSON.stringify(body)}`
    );
    assert.equal(body.error?.retry_with, "connection_id");
    const ids = (body.error?.available_connections || []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

test("GET /v1/blobs/:blob_id?connection_id=X resolves ambiguity and returns bytes", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = "blob_sha256_ambig_002";
    const sharedBytes = Buffer.from("shared-bytes-2");
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      data: sharedBytes,
      mimeType: "text/plain",
      recordKey: "rec-a-1",
      stream: STREAM_A,
    });
    seedBlobBinding({
      blobId,
      connectorInstanceId: INSTANCE_B,
      recordKey: "rec-b-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_A), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-a-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-a-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_B), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-b-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-b-1",
      stream: STREAM_A,
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}&connection_id=${encodeURIComponent(INSTANCE_A)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(resp.status, 200, `narrowed read must succeed (got ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(buf, sharedBytes);
  });
});

// ─── P2: blob reads respect grant-scope per-stream instance_ids ───────────

test("blob route per-stream binding resolution narrows by grant instance_ids", async () => {
  // The blob route resolves the addressable set per (binding's) stream by
  // calling `resolveReadRequestBindings({ grant, streamName: binding.stream })`.
  // When the grant pins stream A → connection X, the resolver MUST return
  // only X for stream A (regardless of what active bindings exist under
  // the connector). This locks the P2 fix at the resolution layer the
  // blob route relies on.
  await issueOwnerOnlyHarness(async () => {
    const { resolveReadRequestBindings } = await import("../server/records.ts");
    const pinnedGrant = {
      streams: [
        { fields: ["id", "received_at"], instance_ids: [INSTANCE_A], name: STREAM_A },
        { fields: ["id", "received_at"], instance_ids: [INSTANCE_B], name: STREAM_B },
      ],
    };
    const { bindings: photosBindings } = await resolveReadRequestBindings({
      grant: pinnedGrant,
      ownerRead: false,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: CONNECTOR_ID },
      streamName: STREAM_A,
    });
    assert.equal(
      photosBindings.length,
      1,
      `stream A's bindings must collapse to its grant-pinned connection (got ${JSON.stringify(photosBindings)})`
    );
    const [photosBinding] = photosBindings;
    assert.ok(photosBinding, "stream A resolved at least one binding");
    assert.equal(photosBinding.connectorInstanceId, INSTANCE_A);

    const { bindings: videosBindings } = await resolveReadRequestBindings({
      grant: pinnedGrant,
      ownerRead: false,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      requestParams: {},
      storageBinding: { connector_id: CONNECTOR_ID },
      streamName: STREAM_B,
    });
    assert.equal(
      videosBindings.length,
      1,
      `stream B's bindings must collapse to its grant-pinned connection (got ${JSON.stringify(videosBindings)})`
    );
    const [videosBinding] = videosBindings;
    assert.ok(videosBinding, "stream B resolved at least one binding");
    assert.equal(videosBinding.connectorInstanceId, INSTANCE_B);
  });
});

test("GET /v1/blobs/:blob_id returns 200 when only one connection holds the blob (fan-in auto-select)", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = "blob_sha256_unique_003";
    const bytes = Buffer.from("unique-bytes");
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      data: bytes,
      mimeType: "application/octet-stream",
      recordKey: "rec-a-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_A), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-a-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-a-1",
      stream: STREAM_A,
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(resp.status, 200);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(buf, bytes);
  });
});

// ─── End-to-end client-mode grant-scope narrowing on the blob route ───────
//
// P3 follow-up from `tmp/workstreams/fan-in-revision-owner-review-report.md`:
// the prior tranche covered grant-scoped per-stream narrowing at the resolver
// layer only. This test exercises the full Fastify route under a real client
// access token: seed a blob whose ONLY visible binding for stream S is via
// connection B, issue a grant pinning stream S → connection A, and assert
// the route returns `blob_not_found` (404) instead of leaking B's bytes.

interface ApproveGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: {
    name: string;
    fields: string[];
    instance_ids: string[];
    resources?: string[];
    time_range?: { since?: string; until?: string };
  }[];
}

interface ApprovedGrant {
  token: string;
}

async function approveGrant(asUrl: string, subjectId: string, params: ApproveGrantParams): Promise<ApprovedGrant> {
  const streams = pairwiseInstanceIdentityEnabled()
    ? await Promise.all(
        params.streams.map(async (stream) => ({
          ...stream,
          instance_ids: await Promise.all(
            stream.instance_ids.map((internalId) =>
              getPairwiseHandle({
                clientId: params.client_id,
                internalId,
                kind: "instance",
                sourceId: SOURCE_ID,
                subjectId,
              })
            )
          ),
        }))
      )
    : params.streams;
  const parResp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: SOURCE_ID, kind: "connector" },
          streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const parBody = (await parResp.json()) as { request_uri?: string };
  if (!parBody.request_uri) {
    throw new Error(`PAR returned no request_uri: ${JSON.stringify(parBody)}`);
  }
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: parBody.request_uri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const review = (await reviewResp.json()) as { approval_review_revision?: unknown };
  if (!reviewResp.ok || typeof review.approval_review_revision !== "string") {
    throw new Error(`consent/review failed: ${JSON.stringify(review)}`);
  }
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: parBody.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const approved = (await approveResp.json()) as Partial<ApprovedGrant>;
  if (!approved.token) {
    throw new Error(`consent/approve returned no token: ${JSON.stringify(approved)}`);
  }
  return approved as ApprovedGrant;
}

test("GET /v1/blobs/:blob_id (client mode) 404s when grant pins stream to a connection that does not hold the blob", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    // The blob is reachable ONLY via connection B for stream A — connection
    // A has no record referencing this blob, and the only stored binding for
    // this blob_id is under (INSTANCE_B, STREAM_A).
    const blobId = "blob_sha256_grant_scope_004";
    const bytes = Buffer.from("only-b-can-see");
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_B,
      data: bytes,
      mimeType: "application/octet-stream",
      recordKey: "rec-b-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_B), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-b-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-b-1",
      stream: STREAM_A,
    });

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    // Grant pins stream A → connection A. The blob lives under connection B
    // for stream A, so the grant-scoped resolver MUST narrow stream A's
    // addressable set to {INSTANCE_A}, which filters out B's binding and
    // makes the blob unreachable.
    const approved = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: CONNECTOR_ID,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "blob route grant-scope narrowing test",
      streams: [{ fields: ["id", "received_at"], instance_ids: [INSTANCE_A], name: STREAM_A }],
    });

    const resp = await fetch(`${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(resp.status, 404, `grant pinned to non-holding connection must 404, got ${resp.status}`);
    const body = (await resp.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "blob_not_found", `expected blob_not_found, got ${JSON.stringify(body)}`);
    // Defensive: the connection that actually holds the blob must not leak
    // into the response envelope.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(INSTANCE_B), false, "non-granted connection_id leaked into blob 404 envelope");
  });
});

test("client blob reads fail closed for an ungranted stream and an inactive granted instance", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const ungrantedBlobId = "blob_sha256_ungranted_stream_006";
    const inactiveBlobId = "blob_sha256_inactive_instance_007";
    for (const [blobId, recordKey] of [
      [ungrantedBlobId, "rec-b-ungranted"],
      [inactiveBlobId, "rec-b-inactive"],
    ] as const) {
      seedBlob({
        blobId,
        connectorInstanceId: INSTANCE_B,
        data: Buffer.from(blobId),
        mimeType: "application/octet-stream",
        recordKey,
        stream: STREAM_A,
      });
      // These writes share one store and must complete in fixture order.
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup preserves deterministic state.
      await ingestRecord(target(INSTANCE_B), {
        data: { blob_ref: { blob_id: blobId }, id: recordKey, received_at: "2026-05-19T00:00:00.000Z" },
        emitted_at: "2026-05-19T00:00:00.000Z",
        key: recordKey,
        stream: STREAM_A,
      });
    }

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const otherStreamGrant = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: CONNECTOR_ID,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "ungranted stream blob test",
      streams: [{ fields: ["id", "received_at"], instance_ids: [INSTANCE_A], name: STREAM_B }],
    });
    const ungrantedResponse = await fetch(`${rsUrl}/v1/blobs/${ungrantedBlobId}`, {
      headers: { Authorization: `Bearer ${otherStreamGrant.token}` },
    });
    assert.equal(ungrantedResponse.status, 404);

    const inactiveInstanceGrant = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: CONNECTOR_ID,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "inactive instance blob test",
      streams: [{ fields: ["id", "received_at"], instance_ids: [INSTANCE_A], name: STREAM_A }],
    });
    await createSqliteConnectorInstanceStore().updateStatus(INSTANCE_A, {
      status: "paused",
      updatedAt: new Date().toISOString(),
    });
    const inactiveResponse = await fetch(`${rsUrl}/v1/blobs/${inactiveBlobId}`, {
      headers: { Authorization: `Bearer ${inactiveInstanceGrant.token}` },
    });
    assert.equal(inactiveResponse.status, 404);
  });
});

// ─── PDPP-Warning: deprecated_alias_used on the 200 success path ───────────
//
// P3 follow-up from `tmp/workstreams/fan-in-revision-owner-review-report.md`:
// the spec at `expose-connection-identity-on-public-read/spec.md:239-243`
// scopes the `PDPP-Warning: deprecated_alias_used: connector_instance_id`
// response header to the 200 OK blob path. This regression pins the header
// emission so a future refactor of `resolveReadRequestBindings` or the route
// adapter cannot silently drop the migration signal.

test("GET /v1/blobs/:blob_id sets PDPP-Warning header when caller used deprecated connector_instance_id alias", async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = "blob_sha256_alias_warning_005";
    const bytes = Buffer.from("alias-warning-bytes");
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      data: bytes,
      mimeType: "application/octet-stream",
      recordKey: "rec-a-1",
      stream: STREAM_A,
    });
    await ingestRecord(target(INSTANCE_A), {
      data: { blob_ref: { blob_id: blobId }, id: "rec-a-1", received_at: "2026-05-19T00:00:00.000Z" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "rec-a-1",
      stream: STREAM_A,
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    // Deliberately pass the deprecated alias `connector_instance_id` (rather
    // than `connection_id`) so the resolver emits a `deprecated_alias_used`
    // warning that the route must surface as a structured response header on
    // the 200 success envelope.
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}` +
        `?connector_id=${encodeURIComponent(CONNECTOR_ID)}` +
        `&connector_instance_id=${encodeURIComponent(INSTANCE_A)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(resp.status, 200, `alias-only narrowing must still serve bytes, got ${resp.status}`);
    const warning = resp.headers.get("pdpp-warning");
    assert.equal(
      warning,
      "deprecated_alias_used: connector_instance_id",
      `expected deprecated_alias_used header on 200, got ${JSON.stringify(warning)}`
    );
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(buf, bytes);
  });
});

test("pairwise owner blob reads require a selector, isolate the selected instance, and recheck deletion", async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    await issueOwnerOnlyHarness(async (server) => {
      await registerConnector({
        ...baseManifest,
        streams: baseManifest.streams.map((stream) => ({
          ...stream,
          schema: {
            ...stream.schema,
            properties: { ...stream.schema.properties, attachments: { items: { type: "object" }, type: "array" } },
          },
        })),
      });
      const blobId = "blob_pairwise_owner";
      const bytes = Buffer.from("owner-selected-bytes");
      seedBlob({
        blobId,
        connectorInstanceId: INSTANCE_A,
        data: bytes,
        mimeType: "text/plain",
        recordKey: "only-a",
        stream: STREAM_A,
      });
      await ingestRecord(target(INSTANCE_A), {
        data: { attachments: [{ blob_ref: { blob_id: blobId } }], id: "only-a", received_at: "2026-05-19T00:00:00Z" },
        emitted_at: "2026-05-19T00:00:00Z",
        key: "only-a",
        stream: STREAM_A,
      });
      const ownerToken = await getOwnerToken(server);
      const headers = { Authorization: `Bearer ${ownerToken}` };
      const ownerBindings = await buildPairwiseOwnerBindings(OWNER_AUTH_DEFAULT_SUBJECT_ID);
      const bindingA = ownerBindings.find(
        (binding) => binding.source_id === SOURCE_ID && binding.rs_instance === INSTANCE_A
      );
      const bindingB = ownerBindings.find(
        (binding) => binding.source_id === SOURCE_ID && binding.rs_instance === INSTANCE_B
      );
      assert.ok(bindingA);
      assert.ok(bindingB);
      const handleA = bindingA.instance_id;
      const handleB = bindingB.instance_id;
      assert.equal(
        ownerBindings.find((binding) => binding.source_id === CONNECTOR_ID && binding.rs_instance === INSTANCE_A)
          ?.instance_id,
        handleA
      );
      const url = `http://localhost:${server.rsPort}/v1/blobs/${blobId}?connector_id=${CONNECTOR_ID}`;
      assert.equal((await fetch(url, { headers })).status, 400);
      assert.equal((await fetch(`${url}&instance_id=${handleA}&instance_id=${handleB}`, { headers })).status, 400);
      assert.equal((await fetch(`${url}&instance_id=unknown`, { headers })).status, 404);
      assert.equal((await fetch(`${url}&instance_id=${handleB}`, { headers })).status, 404);
      const allowed = await fetch(`${url}&instance_id=${handleA}`, { headers });
      assert.equal(allowed.status, 200);
      assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), bytes);
      const deleteUrl = `http://localhost:${server.rsPort}/v1/streams/${STREAM_A}/records/only-a?connector_id=${CONNECTOR_ID}`;
      // The key exists only in A, but two owner instances still require selection.
      assert.equal((await fetch(deleteUrl, { headers, method: "DELETE" })).status, 400);
      assert.equal((await fetch(`${deleteUrl}&instance_id=unknown`, { headers, method: "DELETE" })).status, 404);
      assert.equal((await fetch(`${deleteUrl}&instance_id=${handleA}`, { headers, method: "DELETE" })).status, 204);
      assert.equal((await fetch(`${url}&instance_id=${handleA}`, { headers })).status, 404);
      await createSqliteConnectorInstanceStore().updateStatus(INSTANCE_B, {
        status: "paused",
        updatedAt: new Date().toISOString(),
      });
      // Even a one-instance blob context must carry a selector; delete may omit it.
      assert.equal((await fetch(url, { headers })).status, 400);
      assert.equal((await fetch(deleteUrl, { headers, method: "DELETE" })).status, 204);
    });
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});

test("pairwise client blob fetch rechecks field, resource, time and instance authorization on every request", async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    await issueOwnerOnlyHarness(async (server) => {
      await registerConnector({
        ...baseManifest,
        streams: baseManifest.streams.map((stream) => ({ ...stream, selection: { fields: true, resources: true } })),
      });
      const blobId = "blob_pairwise_client";
      const bytes = Buffer.from("client-selected-bytes");
      seedBlob({
        blobId,
        connectorInstanceId: INSTANCE_A,
        data: bytes,
        mimeType: "text/plain",
        recordKey: "only-a",
        stream: STREAM_A,
      });
      await ingestRecord(target(INSTANCE_A), {
        data: { blob_ref: { blob_id: blobId }, id: "only-a", received_at: "2026-05-19T00:00:00Z" },
        emitted_at: "2026-05-19T00:00:00Z",
        key: "only-a",
        stream: STREAM_A,
      });
      const handle = await getPairwiseHandle({
        clientId: "longview",
        internalId: INSTANCE_A,
        kind: "instance",
        sourceId: SOURCE_ID,
        subjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      const handleB = await getPairwiseHandle({
        clientId: "longview",
        internalId: INSTANCE_B,
        kind: "instance",
        sourceId: SOURCE_ID,
        subjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const url = `http://localhost:${server.rsPort}/v1/blobs/${blobId}`;
      const grantParams = {
        access_mode: "continuous",
        client_id: "longview",
        connector_id: CONNECTOR_ID,
        purpose_code: "https://pdpp.dev/purpose/analytics",
        purpose_description: "pairwise blob filters",
        streams: [{ fields: ["id", "received_at", "blob_ref"], instance_ids: [INSTANCE_A], name: STREAM_A }],
      };
      const [grantedStream] = grantParams.streams;
      assert.ok(grantedStream);
      const approved = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, grantParams);
      const headers = { Authorization: `Bearer ${approved.token}` };
      for (const selector of ["connection_id", "connector_instance_id"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Assert each rejected authorization gate separately.
        const response = await fetch(
          `http://localhost:${server.rsPort}/v1/streams/${STREAM_A}/records?${selector}=foreign-internal-id`,
          { headers }
        );
        assert.equal(response.status, 400, selector);
      }
      await Promise.all(
        ["connectors", "schema", "streams", `streams/${STREAM_A}`].map(async (endpoint) => {
          const response = await fetch(`http://localhost:${server.rsPort}/v1/${endpoint}`, { headers });
          assert.equal(response.status, 200, endpoint);
          const metadata = JSON.stringify(await response.json());
          assert.ok(!(metadata.includes(INSTANCE_A) || metadata.includes(INSTANCE_B)), metadata);
          assert.ok(
            ["connection_id", "connector_instance_id", "granted_connections"].every(
              (key) => !metadata.includes(`"${key}":`)
            ),
            metadata
          );
          if (endpoint === "schema" || endpoint === `streams/${STREAM_A}`) {
            assert.ok(metadata.includes(handle), metadata);
          }
        })
      );
      assert.equal((await fetch(url, { headers })).status, 400);
      assert.equal((await fetch(`${url}?instance_id=${handleB}`, { headers })).status, 404);
      const visible = await fetch(`${url}?instance_id=${handle}`, { headers });
      assert.equal(visible.status, 200);
      assert.deepEqual(Buffer.from(await visible.arrayBuffer()), bytes);
      const excludedField = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
        ...grantParams,
        streams: [{ fields: ["id", "received_at"], instance_ids: [INSTANCE_A], name: STREAM_A }],
      });
      assert.equal(
        (await fetch(`${url}?instance_id=${handle}`, { headers: { Authorization: `Bearer ${excludedField.token}` } }))
          .status,
        404
      );
      const excludedResource = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
        ...grantParams,
        streams: [{ ...grantedStream, resources: ["other-record"] }],
      });
      assert.equal(
        (
          await fetch(`${url}?instance_id=${handle}`, {
            headers: { Authorization: `Bearer ${excludedResource.token}` },
          })
        ).status,
        404
      );
      const excludedTime = await approveGrant(asUrl, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
        ...grantParams,
        streams: [{ ...grantedStream, time_range: { since: "2026-05-20T00:00:00Z" } }],
      });
      assert.equal(
        (await fetch(`${url}?instance_id=${handle}`, { headers: { Authorization: `Bearer ${excludedTime.token}` } }))
          .status,
        404
      );
      await ingestRecord(target(INSTANCE_A), {
        data: { blob_ref: { blob_id: "another-blob" }, id: "only-a", received_at: "2026-05-19T00:00:00Z" },
        emitted_at: "2026-05-19T00:00:01Z",
        key: "only-a",
        stream: STREAM_A,
      });
      assert.equal((await fetch(`${url}?instance_id=${handle}`, { headers })).status, 404);
    });
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});

test("pairwise HTTP resource references use retained keys and redact targets outside the same-instance grant", async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  let retainedKeys: unknown;
  const introspectionFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.pdpp_token_kind === "client") {
      retainedKeys = (body.pdpp as { source_primary_keys?: unknown } | undefined)?.source_primary_keys;
    }
    return new Response(JSON.stringify(body), { status: response.status });
  };
  try {
    await issueOwnerOnlyHarness(
      async (server) => {
        const manifest = {
          ...baseManifest,
          streams: baseManifest.streams.map((stream) => ({
            ...stream,
            schema: {
              ...stream.schema,
              properties: {
                ...stream.schema.properties,
                refs: { items: { type: "object" }, type: "array" },
              },
            },
          })),
        };
        await registerConnector(manifest);
        const references = [
          { record_id: "target-a", source_id: SOURCE_ID, stream: STREAM_A },
          { record_id: "target-a", source_id: "https://other.example/source", stream: STREAM_A },
          { record_id: "target-video", source_id: SOURCE_ID, stream: STREAM_B },
          { record_id: "target-only-b", source_id: SOURCE_ID, stream: STREAM_A },
        ];
        await Promise.all([
          ingestRecord(target(INSTANCE_A), {
            data: { id: "parent", received_at: "2026-05-19T00:00:00Z", refs: references },
            emitted_at: "2026-05-19T00:00:00Z",
            key: "parent",
            stream: STREAM_A,
          }),
          ingestRecord(target(INSTANCE_A), {
            data: { id: "target-a", received_at: "2026-05-19T00:00:00Z" },
            emitted_at: "2026-05-19T00:00:00Z",
            key: "target-a",
            stream: STREAM_A,
          }),
          ingestRecord(target(INSTANCE_A), {
            data: { id: "target-video", received_at: "2026-05-19T00:00:00Z" },
            emitted_at: "2026-05-19T00:00:00Z",
            key: "target-video",
            stream: STREAM_B,
          }),
          ingestRecord(target(INSTANCE_B), {
            data: { id: "target-only-b", received_at: "2026-05-19T00:00:00Z" },
            emitted_at: "2026-05-19T00:00:00Z",
            key: "target-only-b",
            stream: STREAM_A,
          }),
        ]);
        const approved = await approveGrant(`http://localhost:${server.asPort}`, OWNER_AUTH_DEFAULT_SUBJECT_ID, {
          access_mode: "continuous",
          client_id: "longview",
          connector_id: CONNECTOR_ID,
          purpose_code: "https://pdpp.dev/purpose/analytics",
          purpose_description: "reference authorization journey",
          streams: [{ fields: ["id", "refs"], instance_ids: [INSTANCE_A], name: STREAM_A }],
        });
        // Current key metadata now names an ungranted field. Resolution must use
        // the approved declaration's id key, not this later registry revision.
        await registerConnector({
          ...manifest,
          streams: manifest.streams.map((stream) => ({ ...stream, primary_key: ["received_at"] })),
          version: "1.0.1",
        });
        const response = await fetch(`http://localhost:${server.rsPort}/v1/streams/${STREAM_A}/records/parent`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { instance_id: string; data: { refs: unknown[] } };
        const handle = await getPairwiseHandle({
          clientId: "longview",
          internalId: INSTANCE_A,
          kind: "instance",
          sourceId: SOURCE_ID,
          subjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        });
        assert.deepEqual(body.data.refs, [
          { ...references[0], instance_id: handle },
          { redacted: true, source_id: "https://other.example/source", stream: STREAM_A },
          { redacted: true, source_id: SOURCE_ID, stream: STREAM_B },
          { redacted: true, source_id: SOURCE_ID, stream: STREAM_A },
        ]);
        assert.deepEqual(retainedKeys, { [STREAM_A]: ["id"], [STREAM_B]: ["id"] });
        assert.equal(body.instance_id, handle);
        assert.ok(!JSON.stringify(body).includes(INSTANCE_A));
      },
      { introspectionFetch }
    );
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});

test("pairwise delete counts only AS-covered instances and never reconstructs missing owner bindings", async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  try {
    await issueOwnerOnlyHarness(async () => {
      let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
      let selectedInstance: string | null = null;
      let status = 0;
      const app = {
        delete: (_path: string, ...args: unknown[]) => {
          handler = args.at(-1) as typeof handler;
          return app;
        },
      };
      const response = {
        end: () => null,
        status: (code: number) => {
          status = code;
          return response;
        },
      };
      const context = {
        buildMutationContext: () => ({}),
        deleteRecord: (storage: { connector_instance_id: string }) => {
          selectedInstance = storage.connector_instance_id;
          return Promise.resolve(1);
        },
        emitMutationEvent: () => Promise.resolve(),
        emitMutationRequested: () => Promise.resolve(),
        getOwnerTokenSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
        rejectMutation: (_res: unknown, _req: unknown, _mutation: unknown, error: { code: string }) => {
          status = error.code === "not_found" ? 404 : 400;
          return Promise.resolve();
        },
        requireOwner: () => null,
        requireToken: () => null,
        resolveOwnerConnectorNamespace: (_req: unknown, cid: string, opts: { connectorInstanceId: string }) =>
          Promise.resolve({ connectorId: cid, connectorInstanceId: opts.connectorInstanceId }),
        resolveRegisteredConnectorManifest: () => Promise.resolve({ streams: [{ name: STREAM_A }] }),
        resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
        setReferenceTraceId: () => null,
        storageTargetForConnectorNamespace: (namespace: { connectorInstanceId: string }) => ({
          connector_instance_id: namespace.connectorInstanceId,
        }),
      };
      mountRsRecordsDelete(
        app as unknown as Parameters<typeof mountRsRecordsDelete>[0],
        context as unknown as Parameters<typeof mountRsRecordsDelete>[1]
      );
      assert.ok(handler);
      const request = {
        headers: {},
        params: { id: "missing-key", stream: STREAM_A },
        query: { connector_id: CONNECTOR_ID },
        tokenInfo: { subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID },
      };
      await handler(request, response);
      assert.equal(status, 404);
      assert.equal(selectedInstance, null);
      const binding = { instance_id: "AS-issued-handle", rs_instance: INSTANCE_A, source_id: CONNECTOR_ID };
      // Two local accounts exist; the AS covers only A, so a selector is optional.
      await handler({ ...request, tokenInfo: { ...request.tokenInfo, pdpp_instance_bindings: [binding] } }, response);
      assert.equal(status, 204);
      assert.equal(selectedInstance, INSTANCE_A);
      selectedInstance = null;
      await handler(
        {
          ...request,
          query: { ...request.query, instance_id: "not-AS-issued" },
          tokenInfo: { ...request.tokenInfo, pdpp_instance_bindings: [binding] },
        },
        response
      );
      assert.equal(status, 404);
      assert.equal(selectedInstance, null);
    });
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});

test("pairwise owner HTTP reads and delete use only authenticated AS bindings and reject conflicts", async () => {
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  const bindingA = { instance_id: "inst_as_owner_a", rs_instance: INSTANCE_A, source_id: CONNECTOR_ID };
  let suppliedBindings: unknown = [bindingA];
  const introspectionFetch: typeof fetch = async (input, init) => {
    const original = await fetch(input, init);
    const body = (await original.json()) as Record<string, unknown>;
    if (suppliedBindings === undefined) {
      const { pdpp_instance_bindings: _bindings, ...withoutBindings } = body;
      return new Response(JSON.stringify(withoutBindings), { status: original.status });
    }
    return new Response(JSON.stringify({ ...body, pdpp_instance_bindings: suppliedBindings }), {
      status: original.status,
    });
  };
  try {
    await issueOwnerOnlyHarness(
      async (server) => {
        const blobId = "blob_as_owner_scope";
        seedBlob({
          blobId,
          connectorInstanceId: INSTANCE_A,
          data: Buffer.from("AS scope"),
          mimeType: "text/plain",
          recordKey: "only-a",
          stream: STREAM_A,
        });
        await ingestRecord(target(INSTANCE_A), {
          data: { blob_ref: { blob_id: blobId }, id: "only-a", received_at: "2026-05-19T00:00:00Z" },
          emitted_at: "2026-05-19T00:00:00Z",
          key: "only-a",
          stream: STREAM_A,
        });
        await ingestRecord(target(INSTANCE_B), {
          data: { id: "only-b", received_at: "2026-05-19T00:00:00Z" },
          emitted_at: "2026-05-19T00:00:00Z",
          key: "only-b",
          stream: STREAM_A,
        });
        const headers = { Authorization: `Bearer ${await getOwnerToken(server)}` };
        const rootUrl = `http://localhost:${server.rsPort}`;
        await Promise.all(
          ["connectors", "schema", "streams", `streams/${STREAM_A}`].map(async (endpoint) => {
            const response = await fetch(`${rootUrl}/v1/${endpoint}?connector_id=${CONNECTOR_ID}`, { headers });
            assert.equal(response.status, 200, endpoint);
            const metadata = JSON.stringify(await response.json());
            assert.ok(!(metadata.includes(INSTANCE_A) || metadata.includes(INSTANCE_B)), metadata);
            assert.ok(!metadata.includes('"record_count":2'), metadata);
            if (endpoint === "connectors" || endpoint === "streams") {
              assert.ok(metadata.includes('"record_count":1'), metadata);
            }
          })
        );
        const listUrl = `${rootUrl}/v1/streams/${STREAM_A}/records?connector_id=${CONNECTOR_ID}`;
        const aggregateResponse = await fetch(
          `${rootUrl}/v1/streams/${STREAM_A}/aggregate?connector_id=${CONNECTOR_ID}&metric=count`,
          { headers }
        );
        assert.equal(aggregateResponse.status, 200);
        const aggregate = (await aggregateResponse.json()) as { filtered_record_count: number; value: number };
        assert.equal(aggregate.value, 1);
        assert.equal(aggregate.filtered_record_count, 1);
        const listResponse = await fetch(listUrl, { headers });
        assert.equal(listResponse.status, 200);
        const list = (await listResponse.json()) as { data: { id: string; instance_id: string }[] };
        assert.deepEqual(
          list.data.map((record) => ({ id: record.id, instance_id: record.instance_id })),
          [{ id: "only-a", instance_id: bindingA.instance_id }]
        );
        const detailUrl = `${rootUrl}/v1/streams/${STREAM_A}/records/only-a?connector_id=${CONNECTOR_ID}`;
        const detailResponse = await fetch(detailUrl, { headers });
        assert.equal(detailResponse.status, 200);
        const detail = (await detailResponse.json()) as { data: { blob_ref: { fetch_url: string } } };
        assert.equal((await fetch(new URL(detail.data.blob_ref.fetch_url, rootUrl), { headers })).status, 200);
        const blobUrl = `${rootUrl}/v1/blobs/${blobId}?connector_id=${CONNECTOR_ID}&instance_id=${bindingA.instance_id}`;
        assert.equal((await fetch(blobUrl, { headers })).status, 200);
        // Missing member and conflicting targets are rejected by token intake.
        suppliedBindings = undefined;
        assert.equal((await fetch(detailUrl, { headers })).status, 403);
        assert.equal((await fetch(detailUrl, { headers, method: "DELETE" })).status, 403);
        suppliedBindings = [bindingA, { ...bindingA, rs_instance: INSTANCE_B }];
        assert.equal((await fetch(blobUrl, { headers })).status, 403);
        assert.equal((await fetch(detailUrl, { headers, method: "DELETE" })).status, 403);
        suppliedBindings = [];
        assert.equal((await fetch(blobUrl, { headers })).status, 404);
        assert.equal((await fetch(detailUrl, { headers, method: "DELETE" })).status, 404);
        suppliedBindings = [bindingA];
        // Two local instances, but AS covers one: DELETE may omit the selector.
        assert.equal((await fetch(detailUrl, { headers, method: "DELETE" })).status, 204);
      },
      { introspectionFetch }
    );
  } finally {
    delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  }
});
