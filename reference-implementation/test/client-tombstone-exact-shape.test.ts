// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A client tombstone in a real changes response carries exactly the Core
 * members {object, id, instance_id, stream, deleted}, with instance_id equal
 * to the instance in the client's grant. The owner response for the same
 * deletion is unchanged.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

type JsonObject = Record<string, unknown>;

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/github";
const STREAM = "repositories";
const OWNER_SUBJECT = "exact_tombstone_owner";
const CLIENT_TOMBSTONE_FORBIDDEN = [
  "connection_id",
  "connector_instance_id",
  "display_name",
  "emitted_at",
  "deleted_at",
  "data",
];

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ body: JsonObject; status: number }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { body: (text ? JSON.parse(text) : {}) as JsonObject, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId: string): Promise<string> {
  const clientId = "longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(device.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: String(device.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return String(tokenBody.access_token);
}

async function seedDefaultGrantInstance(connectorId: string, ownerSubjectId: string): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorKey);
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: "GitHub",
    ownerSubjectId,
    sourceBinding: { fixture: "exact-tombstone-default-account" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function ingestNdjson(rsUrl: string, ownerToken: string, lines: JsonObject[]): Promise<void> {
  const resp = await fetch(`${rsUrl}/v1/ingest/${STREAM}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`, {
    body: lines.map((line) => JSON.stringify(line)).join("\n"),
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
    method: "POST",
  });
  assert.equal(resp.status, 200, `ingest ${STREAM} ok`);
}

async function issueClientToken(asUrl: string): Promise<string> {
  const { body: par } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/assist_export",
          purpose_description: "exact tombstone wire-shape test",
          source: { id: CONNECTOR_ID, kind: "connector" },
          streams: [{ fields: ["id", "name"], name: STREAM }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "longview",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const { body: review } = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const { body: approved, status } = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: par.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 200, JSON.stringify(approved));
  return String(approved.token);
}

async function loadGithubManifest(): Promise<JsonObject> {
  const path = new URL("../fixtures/seed-manifests/github.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

test("served client tombstone is exactly the Core members with the grant instance_id; owner tombstone is unchanged", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const regResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(await loadGithubManifest()),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(regResp.status, 201, "register github connector");

    const ownerToken = await issueOwnerToken(asUrl, OWNER_SUBJECT);
    await seedDefaultGrantInstance(CONNECTOR_ID, OWNER_SUBJECT);
    await ingestNdjson(rsUrl, ownerToken, [
      { data: { id: "repo-1", name: "one" }, emitted_at: "2026-01-01T00:00:00Z", key: "repo-1" },
      { data: { id: "repo-2", name: "two" }, emitted_at: "2026-01-01T00:00:00Z", key: "repo-2" },
    ]);
    const clientToken = await issueClientToken(asUrl);
    const listPath = `${rsUrl}/v1/streams/${STREAM}/records`;
    const clientAuth = { headers: { Authorization: `Bearer ${clientToken}` } };
    const ownerAuth = { headers: { Authorization: `Bearer ${ownerToken}` } };
    // Polyfill owner reads name their connector explicitly.
    const ownerScope = `connector_id=${encodeURIComponent(CONNECTOR_ID)}`;

    // Open a changes_since session on each token, then delete a record.
    const clientOpen = await fetchJson(`${listPath}?changes_since=beginning&limit=10`, clientAuth);
    const ownerOpen = await fetchJson(`${listPath}?changes_since=beginning&limit=10&${ownerScope}`, ownerAuth);
    const clientCursor = String(clientOpen.body.next_changes_since);
    const ownerCursor = String(ownerOpen.body.next_changes_since);
    assert.ok(clientCursor && ownerCursor, "both sessions reach a terminal page");

    await ingestNdjson(rsUrl, ownerToken, [{ key: "repo-1", op: "delete" }]);

    const clientDelta = await fetchJson(`${listPath}?changes_since=${encodeURIComponent(clientCursor)}`, clientAuth);
    const ownerDelta = await fetchJson(
      `${listPath}?changes_since=${encodeURIComponent(ownerCursor)}&${ownerScope}`,
      ownerAuth
    );
    assert.equal(clientDelta.status, 200, JSON.stringify(clientDelta.body));
    assert.equal(ownerDelta.status, 200, JSON.stringify(ownerDelta.body));
    const clientTombstone = (clientDelta.body.data as JsonObject[]).find((r) => r.id === "repo-1");
    const ownerTombstone = (ownerDelta.body.data as JsonObject[]).find((r) => r.id === "repo-1");
    assert.ok(clientTombstone, `client delta has repo-1: ${JSON.stringify(clientDelta.body)}`);
    assert.ok(ownerTombstone, `owner delta has repo-1: ${JSON.stringify(ownerDelta.body)}`);

    // (a) the client tombstone is exactly the Core member set, with
    // instance_id equal to the instance in the client's grant (the default
    // account instance seeded for this owner/connector).
    const expectedInstanceId = makeDefaultAccountConnectorInstanceId(
      OWNER_SUBJECT,
      canonicalConnectorKey(CONNECTOR_ID) ?? CONNECTOR_ID
    );
    assert.deepEqual(clientTombstone, {
      deleted: true,
      id: "repo-1",
      instance_id: expectedInstanceId,
      object: "record",
      stream: STREAM,
    });
    // (b) the client instance_id names the same binding the owner sees.
    assert.equal(clientTombstone.instance_id, ownerTombstone.connector_instance_id);
    // (c) the leaking members are absent.
    for (const key of CLIENT_TOMBSTONE_FORBIDDEN) {
      assert.equal(key in clientTombstone, false, `client tombstone must not carry "${key}"`);
    }

    // (d) the owner response for the same deletion keeps its fields.
    assert.equal(ownerTombstone.deleted, true);
    assert.equal(typeof ownerTombstone.emitted_at, "string", "owner tombstone keeps emitted_at");
    assert.equal(typeof ownerTombstone.deleted_at, "string", "owner tombstone keeps deleted_at");
    assert.equal(typeof ownerTombstone.connection_id, "string", "owner tombstone keeps connection_id");
    assert.equal(typeof ownerTombstone.connector_instance_id, "string", "owner tombstone keeps connector_instance_id");
  } finally {
    await closeTestServer(server);
  }
});
