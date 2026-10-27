// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `emitted_at` is an owner-token field on query and changes responses.
 *
 * Core "Response records": a client-token response MUST NOT include
 * `emitted_at`; an owner-token response includes it. Core Section 4: a client
 * tombstone is exactly {object, id, instance_id, stream, deleted: true}. An
 * owner-token tombstone adds `removal`, and `deleted_at` and `emitted_at` for a
 * deletion.
 *
 * The stored RECORD envelope keeps `emitted_at`. Only the wire shape differs by
 * token kind, so these tests read through HTTP with each token kind and inspect
 * the bodies, not the storage layer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

type JsonObject = Record<string, unknown>;

interface WireRecord extends JsonObject {
  deleted?: boolean;
  id: string;
}

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/github";
const STREAM = "repositories";
const OWNER_SUBJECT = "emitted_at_owner";

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
    sourceBinding: { fixture: "emitted-at-default-account" },
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
          purpose_description: "emitted_at wire-shape test",
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

function recordsOf(body: JsonObject): WireRecord[] {
  return (body.data ?? []) as WireRecord[];
}

function assertNoEmittedAt(record: WireRecord, where: string): void {
  assert.equal("emitted_at" in record, false, `${where} must not carry emitted_at: ${JSON.stringify(record)}`);
}

test("client-token query and changes responses omit emitted_at; owner-token responses keep it", async () => {
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

    // Live records, list and single-record reads.
    const clientList = await fetchJson(`${listPath}?limit=10`, clientAuth);
    assert.equal(clientList.status, 200, JSON.stringify(clientList.body));
    assert.equal(recordsOf(clientList.body).length, 2);
    for (const record of recordsOf(clientList.body)) {
      assertNoEmittedAt(record, `client list record ${record.id}`);
    }
    const clientOne = await fetchJson(`${listPath}/repo-1`, clientAuth);
    assert.equal(clientOne.status, 200, JSON.stringify(clientOne.body));
    assertNoEmittedAt(clientOne.body as WireRecord, "client single record");

    const ownerList = await fetchJson(`${listPath}?limit=10&${ownerScope}`, ownerAuth);
    assert.equal(ownerList.status, 200, JSON.stringify(ownerList.body));
    for (const record of recordsOf(ownerList.body)) {
      assert.equal(typeof record.emitted_at, "string", `owner list record ${record.id} keeps emitted_at`);
    }
    const ownerOne = await fetchJson(`${listPath}/repo-1?${ownerScope}`, ownerAuth);
    assert.equal(typeof ownerOne.body.emitted_at, "string", "owner single record keeps emitted_at");

    // Open a changes_since session on each token, then delete a record.
    const clientOpen = await fetchJson(`${listPath}?changes_since=beginning&limit=10`, clientAuth);
    const ownerOpen = await fetchJson(`${listPath}?changes_since=beginning&limit=10&${ownerScope}`, ownerAuth);
    const clientCursor = String(clientOpen.body.next_changes_since);
    const ownerCursor = String(ownerOpen.body.next_changes_since);
    assert.ok(clientCursor && ownerCursor, "both sessions reach a terminal page");

    await ingestNdjson(rsUrl, ownerToken, [{ key: "repo-1", op: "delete" }]);

    // Client tombstone: exactly the client shape, nothing time-stamped.
    const clientDelta = await fetchJson(`${listPath}?changes_since=${encodeURIComponent(clientCursor)}`, clientAuth);
    const clientTombstone = recordsOf(clientDelta.body).find((record) => record.id === "repo-1");
    assert.ok(
      clientTombstone?.deleted === true,
      `client delta reports the deletion: ${JSON.stringify(clientDelta.body)}`
    );
    assertNoEmittedAt(clientTombstone, "client tombstone");
    assert.equal("deleted_at" in clientTombstone, false, "client tombstone must not carry deleted_at");
    assert.equal("data" in clientTombstone, false, "client tombstone must not carry data");

    // Owner tombstone: keeps deleted_at and emitted_at for the deletion.
    const ownerDelta = await fetchJson(
      `${listPath}?changes_since=${encodeURIComponent(ownerCursor)}&${ownerScope}`,
      ownerAuth
    );
    const ownerTombstone = recordsOf(ownerDelta.body).find((record) => record.id === "repo-1");
    assert.ok(ownerTombstone?.deleted === true, `owner delta reports the deletion: ${JSON.stringify(ownerDelta.body)}`);
    assert.equal(typeof ownerTombstone.deleted_at, "string", "owner tombstone keeps deleted_at");
    assert.equal(typeof ownerTombstone.emitted_at, "string", "owner tombstone keeps emitted_at");
  } finally {
    await closeTestServer(server);
  }
});

async function loadGithubManifest(): Promise<JsonObject> {
  const { readFile } = await import("node:fs/promises");
  const path = new URL("../fixtures/seed-manifests/github.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}
