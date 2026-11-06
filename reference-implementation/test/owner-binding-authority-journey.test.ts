// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, isPostgresStorageBackend } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { createConnectorBindingAuthorityStore } from "../server/stores/connector-binding-authority-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { bindingFixture, bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { approveClientGrant, issueOwnerToken } from "./helpers/binding-owner-auth.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const OWNER_SUBJECT_ID = "owner_local";
test("real owner bearer HTTP journey reads only the exact owned snapshot without caching", async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  }
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    storageBackend: POSTGRES_URL ? "postgres" : "sqlite",
    ...(POSTGRES_URL ? { databaseUrl: POSTGRES_URL } : {}),
  });
  try {
    assert.equal(isPostgresStorageBackend(), Boolean(POSTGRES_URL));
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    await seedBindingConnection("http-owned");
    await seedBindingConnection("http-sibling");
    await seedBindingConnection("http-foreign", "other-owner");
    const store = createConnectorBindingAuthorityStore();
    const input = bindingFixture("http-owned");
    await store.put(input);
    await store.put(bindingFixture("http-foreign", input.runId, "other-owner"));
    const token = await issueOwnerToken(asUrl);
    const otherToken = await issueOwnerToken(asUrl, "other-owner");
    const path = (connection = input.connectionId, run = input.runId) =>
      `/v1/owner/connections/${connection}/runs/${run}/binding-authority`;
    const read = (pathname: string, bearer?: string) =>
      fetch(`${rsUrl}${pathname}`, {
        headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      });
    const anonymous = await read(path());
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    const response = await read(path(), token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const stored = await store.get(input);
    assert.ok(stored);
    assert.deepEqual(await response.json(), {
      connection_id: input.connectionId,
      object: "binding_authority_record",
      policy_identity: input.policyIdentity,
      record: input.record,
      record_version: 1,
      recorded_at: stored.recordedAt,
      run_id: input.runId,
    });
    await Promise.all(
      [
        [path(), otherToken],
        [path("http-foreign"), token],
        [path("http-sibling"), token],
        [path(input.connectionId, "missing"), token],
        [path("missing"), token],
      ].map(async ([pathname, bearer]) => {
        assert.ok(pathname && bearer);
        const denied = await read(pathname, bearer);
        assert.equal(denied.status, 404);
        assert.equal(denied.headers.get("cache-control"), "no-store");
        assert.equal(JSON.stringify(await denied.json()).includes("fixture-nonsecret-resource-id"), false);
      })
    );
    // A real PAR/consent grant token reaches introspection, then fails the owner-kind gate.
    const manifest = JSON.parse(
      readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")
    ) as { connector_id: string; streams: { name: string }[] };
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    const connectorId = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorId);
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    const [stream] = manifest.streams;
    assert.ok(stream);
    const grantToken = await approveClientGrant(
      asUrl,
      manifest.connector_id,
      stream.name,
      namespace.connectorInstanceId
    );
    const grantDenied = await read(path(), grantToken);
    assert.equal(grantDenied.status, 403);
    assert.equal(grantDenied.headers.get("cache-control"), "no-store");
    // No public writer was mounted.
    const write = await fetch(`${rsUrl}${path()}`, { headers: { Authorization: `Bearer ${token}` }, method: "POST" });
    assert.equal(write.status, 404);
    await bindingQuery("UPDATE connector_binding_authority_runs SET payload_json = ? WHERE connection_id = ?", [
      "fixture-secret-marker{",
      input.connectionId,
    ]);
    const gated = await read(path(), otherToken);
    assert.equal(gated.status, 404, "foreign namespace is refused before corrupt payload decoding");
    const corrupt = await read(path(), token);
    assert.equal(corrupt.status, 500);
    assert.equal(corrupt.headers.get("cache-control"), "no-store");
    const message = JSON.stringify(await corrupt.json());
    assert.equal(message.includes("fixture-secret-marker"), false);
    assert.equal(message.includes(token), false);
  } finally {
    await closeTestServer(server);
    if (POSTGRES_URL) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});
