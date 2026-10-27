// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every served record and tombstone carries instance_id, the grant's handle
 * for the source instance: client live list, client detail read and owner
 * read all carry the same value (the instance in the client's grant).
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
const OWNER_SUBJECT = "served_instance_id_owner";

interface WireRecord extends JsonObject {
  id: string;
  instance_id?: unknown;
}

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
    sourceBinding: { fixture: "served-instance-id-default-account" },
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
          purpose_description: "served-record instance_id test",
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

test("client live list, client detail read and owner read all carry the grant instance_id", async () => {
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

    // The instance in the client's grant: the default account instance
    // seeded for this owner/connector.
    const expectedInstanceId = makeDefaultAccountConnectorInstanceId(
      OWNER_SUBJECT,
      canonicalConnectorKey(CONNECTOR_ID) ?? CONNECTOR_ID
    );

    // Client live list: every served record carries instance_id.
    const clientList = await fetchJson(`${listPath}?limit=10`, clientAuth);
    assert.equal(clientList.status, 200, JSON.stringify(clientList.body));
    assert.equal(recordsOf(clientList.body).length, 2);
    for (const record of recordsOf(clientList.body)) {
      assert.equal(
        record.instance_id,
        expectedInstanceId,
        `client list record ${record.id} carries the grant instance_id: ${JSON.stringify(record)}`
      );
    }

    // Client detail read: the single record carries instance_id.
    const clientOne = await fetchJson(`${listPath}/repo-1`, clientAuth);
    assert.equal(clientOne.status, 200, JSON.stringify(clientOne.body));
    assert.equal(
      (clientOne.body as WireRecord).instance_id,
      expectedInstanceId,
      `client detail record carries the grant instance_id: ${JSON.stringify(clientOne.body)}`
    );

    // Owner read: owner responses get the same value.
    const ownerList = await fetchJson(`${listPath}?limit=10&${ownerScope}`, ownerAuth);
    assert.equal(ownerList.status, 200, JSON.stringify(ownerList.body));
    assert.equal(recordsOf(ownerList.body).length, 2);
    for (const record of recordsOf(ownerList.body)) {
      assert.equal(
        record.instance_id,
        expectedInstanceId,
        `owner list record ${record.id} carries the grant instance_id: ${JSON.stringify(record)}`
      );
    }
  } finally {
    await closeTestServer(server);
  }
});

async function loadGithubManifest(): Promise<JsonObject> {
  const path = new URL("../fixtures/seed-manifests/github.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}
