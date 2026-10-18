// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Records-list projection and `limit` oracles on both storage backends.
 *
 * The SQLite and PostgreSQL record paths build tombstones and parse `limit`
 * separately (server/records.ts, server/postgres-records.ts), so each oracle
 * runs over HTTP against both:
 *
 *   - spec-core §4 "Tombstones": a sparse `fields` read keeps the whole
 *     tombstone envelope (object, id, stream, deleted, deleted_at,
 *     emitted_at) and adds no `data`.
 *   - spec-core §8 `fields`: an owner sparse read always includes the
 *     schema-required fields; a client sparse read stays inside the request.
 *   - spec-core §8 query parameters: a malformed `limit` is rejected with
 *     400 `invalid_request`; an over-max integer is clamped with a
 *     `limit_clamped` warning.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { deleteRecord, ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

interface Backend {
  databaseUrl?: string;
  name: "postgres" | "sqlite";
}

interface JsonObject {
  // biome-ignore lint/suspicious/noExplicitAny: HTTP JSON test boundary.
  [key: string]: any;
}

interface TestServer {
  asPort: number;
  asServer: import("node:http").Server;
  rsPort: number;
  rsServer: import("node:http").Server;
}

const CLIENT_ID = "concert_recommendation_app";
const OWNER_CLIENT_ID = "cli_longview";
const OWNER_ID = "rs_projection_limit_owner";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const TOMBSTONE_KEYS = ["deleted", "deleted_at", "emitted_at", "id", "object", "stream"];

function notesStream(): JsonObject {
  return {
    name: "notes",
    primary_key: ["id"],
    schema: {
      properties: {
        id: { type: "string" },
        kind: { type: "string" },
        secret: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "kind"],
      type: "object",
    },
    selection: { fields: true, resources: true },
    semantics: "mutable_state",
  };
}

function runtimeManifest(connectorKey: string): JsonObject {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: "Records projection and limit",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: [notesStream()],
    version: "1.0.0",
  };
}

function localFulfillment(sourceId: string, connectorKey: string): JsonObject {
  return {
    source_declaration: {
      declaration_version: "rs-records-projection-limit-v1",
      display: { name: "Records projection and limit" },
      extensions: {},
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example/pdpp-test" },
      source: { id: sourceId, kind: "provider_native" },
      streams: [notesStream()],
    },
    storage_binding: { connector_id: connectorKey },
    streams: [notesStream()],
  };
}

async function fetchJson(
  url: string,
  options: RequestInit = {}
): Promise<{ body: JsonObject; headers: Headers; status: number }> {
  const response = await fetch(url, options);
  const text = await response.text();
  return { body: text ? (JSON.parse(text) as JsonObject) : {}, headers: response.headers, status: response.status };
}

async function closeServer(server: TestServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const device = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(device.status, 200, JSON.stringify(device.body));
  const approve = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: OWNER_ID, user_code: String(device.body.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approve.status, 200);
  const token = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: OWNER_CLIENT_ID,
      device_code: String(device.body.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return String(token.body.access_token);
}

async function approveClientGrant(asUrl: string, sourceId: string): Promise<string> {
  const initiated = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/rs-records-projection-limit-test",
          source: { id: sourceId, kind: "provider_native" },
          streams: [{ fields: ["id", "kind", "title"], name: "notes" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  const review = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: initiated.body.request_uri, subject_id: OWNER_ID }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: initiated.body.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.token, "approval must issue a client token");
  return String(approved.body.token);
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function assertSparseTombstone(rsUrl: string, clientToken: string, cursor: string, label: string) {
  const full = await fetchJson(
    `${rsUrl}/v1/streams/notes/records?changes_since=${encodeURIComponent(cursor)}`,
    bearer(clientToken)
  );
  assert.equal(full.status, 200, `${label}: ${JSON.stringify(full.body)}`);
  const [fullTombstone] = full.body.data;
  assert.ok(fullTombstone, `${label}: the delete must produce a tombstone`);
  assert.deepEqual(Object.keys(fullTombstone).filter((key) => TOMBSTONE_KEYS.includes(key)).sort(), TOMBSTONE_KEYS);

  for (const fields of ["title", "id", "kind,title"]) {
    const sparse = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?changes_since=${encodeURIComponent(cursor)}&fields=${fields}`,
      bearer(clientToken)
    );
    assert.equal(sparse.status, 200, `${label} fields=${fields}: ${JSON.stringify(sparse.body)}`);
    assert.equal(sparse.body.data.length, 1, `${label} fields=${fields}`);
    const [tombstone] = sparse.body.data;
    assert.deepEqual(tombstone, fullTombstone, `${label} fields=${fields} must keep the tombstone envelope`);
    assert.equal(tombstone.object, "record");
    assert.equal(tombstone.id, "n2");
    assert.equal(tombstone.stream, "notes");
    assert.equal(tombstone.deleted, true);
    assert.ok(typeof tombstone.deleted_at === "string" && tombstone.deleted_at.length > 0);
    assert.ok(typeof tombstone.emitted_at === "string" && tombstone.emitted_at.length > 0);
    assert.equal(Object.hasOwn(tombstone, "data"), false);
    assert.equal(sparse.body.has_more, false);
    assert.equal(sparse.body.next_changes_since, full.body.next_changes_since);
  }
}

async function assertLimitContract(rsUrl: string, token: string, label: string) {
  for (const query of ["limit=1junk", "limit=abc", "limit=1.5", "limit=0", "limit=", "limit=1&limit=2", "limit[]=1"]) {
    const rejected = await fetchJson(`${rsUrl}/v1/streams/notes/records?${query}`, bearer(token));
    assert.equal(rejected.status, 400, `${label} ${query}: ${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.error?.code, "invalid_request", `${label} ${query}`);
    assert.equal(rejected.body.error?.type, "invalid_request_error", `${label} ${query}`);
    assert.equal(rejected.body.error?.param, "limit", `${label} ${query}`);
    assert.equal(Object.hasOwn(rejected.body, "data"), false, `${label} ${query}`);
  }
  const accepted = await fetchJson(`${rsUrl}/v1/streams/notes/records?limit=1`, bearer(token));
  assert.equal(accepted.status, 200, `${label} limit=1: ${JSON.stringify(accepted.body)}`);
  assert.equal(accepted.body.data.length, 1);
  for (const limit of ["101", "9007199254740992", "1".padEnd(30, "0")]) {
    const clamped = await fetchJson(`${rsUrl}/v1/streams/notes/records?limit=${limit}`, bearer(token));
    assert.equal(clamped.status, 200, `${label} limit=${limit}: ${JSON.stringify(clamped.body)}`);
    assert.ok(
      (clamped.body.meta?.warnings ?? []).some((warning: JsonObject) => warning.code === "limit_clamped"),
      `${label} limit=${limit} must carry limit_clamped`
    );
  }
}

async function runScenario(backend: Backend): Promise<void> {
  const suffix = `${backend.name}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const connectorKey = `rs_projection_limit_${suffix}`;
  const connectorInstanceId = `cin_${suffix}`;
  const sourceId = `https://sources.example/${suffix}`;
  let server: TestServer | null = null;

  try {
    server = (await startServer({
      asPort: 0,
      ...(backend.databaseUrl ? { databaseUrl: backend.databaseUrl, storageBackend: "postgres" as const } : {}),
      dbPath: ":memory:",
      nativeManifest: localFulfillment(sourceId, connectorKey),
      preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      startClientEventDeliveryWorker: false,
    })) as TestServer;

    await registerConnector(runtimeManifest(connectorKey));
    const now = new Date().toISOString();
    await createRequestConnectorInstanceStore().upsert({
      connectorId: connectorKey,
      connectorInstanceId,
      createdAt: now,
      displayName: "Records projection and limit",
      ownerSubjectId: OWNER_ID,
      sourceBinding: { fixture: suffix },
      sourceBindingKey: suffix,
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });
    const storageTarget = { connector_id: connectorKey, connector_instance_id: connectorInstanceId };
    for (const id of ["n1", "n2"]) {
      await ingestRecord(storageTarget, {
        data: { id, kind: "note", secret: `hidden-${id}`, title: `Title ${id}` },
        key: id,
        stream: "notes",
      });
    }

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerToken = await issueOwnerToken(asUrl);
    const clientToken = await approveClientGrant(asUrl, sourceId);

    // Owner sparse reads keep schema-required fields; full reads stay whole.
    const ownerSparse = await fetchJson(`${rsUrl}/v1/streams/notes/records?fields=title`, bearer(ownerToken));
    assert.equal(ownerSparse.status, 200, `${backend.name}: ${JSON.stringify(ownerSparse.body)}`);
    assert.equal(ownerSparse.body.data.length, 2);
    for (const record of ownerSparse.body.data) {
      assert.deepEqual(Object.keys(record.data).sort(), ["id", "kind", "title"], backend.name);
    }
    const ownerFull = await fetchJson(`${rsUrl}/v1/streams/notes/records`, bearer(ownerToken));
    assert.equal(ownerFull.status, 200);
    assert.deepEqual(Object.keys(ownerFull.body.data[0].data).sort(), ["id", "kind", "secret", "title"]);

    // Client sparse reads stay inside the request and the frozen grant.
    const clientSparse = await fetchJson(`${rsUrl}/v1/streams/notes/records?fields=title`, bearer(clientToken));
    assert.equal(clientSparse.status, 200, `${backend.name}: ${JSON.stringify(clientSparse.body)}`);
    for (const record of clientSparse.body.data) {
      assert.deepEqual(Object.keys(record.data), ["title"], backend.name);
    }

    await assertLimitContract(rsUrl, ownerToken, `${backend.name} owner`);
    await assertLimitContract(rsUrl, clientToken, `${backend.name} client`);

    const baseline = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?changes_since=beginning&limit=100`,
      bearer(clientToken)
    );
    assert.equal(baseline.status, 200, `${backend.name}: ${JSON.stringify(baseline.body)}`);
    assert.equal(baseline.body.data.length, 2);
    assert.ok(baseline.body.next_changes_since, "the terminal baseline page must carry next_changes_since");

    await deleteRecord(storageTarget, "notes", "n2");
    await assertSparseTombstone(rsUrl, clientToken, String(baseline.body.next_changes_since), backend.name);
  } finally {
    await closeServer(server);
    configureNativeManifest(null);
    await closePostgresStorage();
    closeDb();
  }
}

test("records-list projection and limit contract on SQLite", () => runScenario({ name: "sqlite" }));

test(
  "records-list projection and limit contract on PostgreSQL",
  { skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required" },
  () => {
    assert.ok(POSTGRES_URL);
    return runScenario({ databaseUrl: POSTGRES_URL, name: "postgres" });
  }
);
