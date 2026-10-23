// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Filtered `changes_since` on both storage backends.
 *
 * spec-core §8: `changes_since` returns the full current state of each record
 * whose authorized projection changed, plus tombstones for deletions. Filters
 * are owner-token-only. A client that applies each filtered delta to the
 * previous filtered result must end up with what a full filtered read returns
 * at the new watermark, so a record that ENTERS the filtered set is emitted
 * even when its projected bytes did not change (sparse `fields` that omit the
 * filtered field make that the common case).
 *
 * Exit is a known limitation: a record that leaves the filtered set is not
 * reported. A tombstone means deletion and the record still exists, and the
 * wire format has no membership-exit entry. The test pins that behaviour so a
 * future wire-format decision has to change it deliberately.
 *
 * The SQLite and PostgreSQL paths implement eligibility separately
 * (server/records.ts resolveChangeGroupRecord, server/postgres-records.ts
 * visiblePostgresChange), so the same scenario runs over HTTP against both.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
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
const OWNER_ID = "rs_changes_filter_owner";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function notesStream(): JsonObject {
  return {
    name: "notes",
    primary_key: ["id"],
    schema: {
      properties: {
        id: { type: "string" },
        secret: { type: "string" },
        status: { type: "string" },
        title: { type: "string" },
      },
      required: ["id"],
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
    display_name: "Filtered changes_since",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: [notesStream()],
    version: "1.0.0",
  };
}

function localFulfillment(sourceId: string, connectorKey: string): JsonObject {
  return {
    source_declaration: {
      declaration_version: "rs-changes-since-filter-entry-v1",
      display: { name: "Filtered changes_since" },
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
          purpose_code: "https://pdpp.dev/purpose/rs-changes-since-filter-entry-test",
          source: { id: sourceId, kind: "provider_native" },
          streams: [{ fields: ["id", "status", "title"], name: "notes" }],
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


async function changedIds(rsUrl: string, token: string, query: string): Promise<string[]> {
  const page = await fetchJson(`${rsUrl}/v1/streams/notes/records?${query}`, bearer(token));
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.has_more, false);
  return (page.body.data as JsonObject[]).map((record) => String(record.id)).sort();
}

async function watermark(rsUrl: string, token: string, query: string): Promise<string> {
  const page = await fetchJson(`${rsUrl}/v1/streams/notes/records?${query}`, bearer(token));
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.ok(page.body.next_changes_since, "terminal page must carry next_changes_since");
  return String(page.body.next_changes_since);
}

async function runScenario(backend: Backend): Promise<void> {
  const suffix = `${backend.name}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const connectorKey = `rs_changes_filter_${suffix}`;
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
      displayName: "Filtered changes_since",
      ownerSubjectId: OWNER_ID,
      sourceBinding: { fixture: suffix },
      sourceBindingKey: suffix,
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });
    const storageTarget = { connector_id: connectorKey, connector_instance_id: connectorInstanceId };
    const write = (id: string, status: string, title: string, secret = "s") =>
      ingestRecord(storageTarget, { data: { id, secret, status, title }, key: id, stream: "notes" });

    await write("item", "inactive", "T0");
    await write("stay", "inactive", "T0");
    await write("inside", "active", "T0");
    await write("leaver", "active", "T0");

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerToken = await issueOwnerToken(asUrl);
    const clientToken = await approveClientGrant(asUrl, sourceId);

    const filtered = "fields=id&filter[status]=active";
    const label = backend.name;

    const baselineIds = await changedIds(rsUrl, ownerToken, `${filtered}&changes_since=beginning`);
    assert.deepEqual(baselineIds, ["inside", "leaver"], `${label}: filtered baseline`);
    const ownerMark = await watermark(rsUrl, ownerToken, `${filtered}&changes_since=beginning`);
    const clientMark = await watermark(rsUrl, clientToken, "changes_since=beginning");

    await write("item", "active", "T0"); // enters the filter; fields=id projection unchanged
    await write("stay", "inactive", "T1"); // stays outside the filter
    await write("inside", "active", "T1"); // stays inside; fields=id projection unchanged
    await write("leaver", "inactive", "T0"); // leaves the filter

    const delta = await changedIds(rsUrl, ownerToken, `${filtered}&changes_since=${encodeURIComponent(ownerMark)}`);
    assert.deepEqual(delta, ["item"], `${label}: only the record entering the filter is emitted`);

    // Applying the delta to the previous filtered result matches a full read, except for the
    // documented exit limitation: `leaver` stays in the mirror because no exit entry exists.
    const full = await changedIds(rsUrl, ownerToken, filtered);
    assert.deepEqual(full, ["inside", "item"], `${label}: full filtered read`);
    const mirror = new Set([...baselineIds, ...delta]);
    assert.deepEqual([...mirror].sort(), ["inside", "item", "leaver"], `${label}: known exit limitation`);

    // A hidden-field-only change on an unfiltered client read is still not emitted.
    // The earlier writes changed `title`, which the grant authorizes, so re-baseline first.
    const clientMark2 = await watermark(rsUrl, clientToken, `changes_since=${encodeURIComponent(clientMark)}`);
    await write("inside", "active", "T1", "rotated-secret");
    assert.deepEqual(
      await changedIds(rsUrl, clientToken, `changes_since=${encodeURIComponent(clientMark2)}`),
      [],
      `${label}: hidden-field-only change must not be emitted to a client`
    );
    await write("inside", "active", "T2", "rotated-secret");
    assert.deepEqual(
      await changedIds(rsUrl, clientToken, `changes_since=${encodeURIComponent(clientMark2)}`),
      ["inside"],
      `${label}: an authorized-field change is emitted to a client`
    );
  } finally {
    await closeServer(server);
    configureNativeManifest(null);
    await closePostgresStorage();
    closeDb();
  }
}

test("filtered changes_since emits records entering the filter on SQLite", () => runScenario({ name: "sqlite" }));

test(
  "filtered changes_since emits records entering the filter on PostgreSQL",
  { skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required" },
  () => {
    assert.ok(POSTGRES_URL);
    return runScenario({ databaseUrl: POSTGRES_URL, name: "postgres" });
  }
);
