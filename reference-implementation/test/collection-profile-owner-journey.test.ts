// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real HTTP/session + durable store boundary, beyond the route's fake adapter.
// Collection Profile 3.4 and 5.12: advertise support before any run, and keep
// diagnostic records on the owner surface, uncached and namespace-scoped.
import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { OWNER_SESSION_COOKIE_NAME } from "../server/owner-session.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { getDefaultConnectorObservationStore } from "../server/stores/connector-observation-store.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const OWNER_PASSWORD = "collection-profile-owner-fixture-password";

test("owner can discover profile support and read diagnostics through the real session gate", async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  }
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    ...(POSTGRES_URL ? { databaseUrl: POSTGRES_URL } : {}),
    dbPath: ":memory:",
    ownerAuthPassword: OWNER_PASSWORD,
    quiet: true,
    rsPort: 0,
    storageBackend: POSTGRES_URL ? "postgres" : "sqlite",
  });
  try {
    assert.equal(isPostgresStorageBackend(), Boolean(POSTGRES_URL), "the HTTP fixture must use the selected backend");
    const origin = `http://localhost:${server.asPort}`;
    const login = await fetch(`${origin}/owner/login`, {
      body: JSON.stringify({ password: OWNER_PASSWORD }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    const cookie = login.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`))
      ?.split(";")[0];
    assert.ok(cookie, "runtime-owned sign-in must issue a real owner session");
    const headers = { Accept: "application/json", Cookie: cookie };

    const supportResponse = await fetch(`${origin}/_ref/collection-profile`, { headers });
    assert.equal(supportResponse.status, 200);
    assert.deepEqual(
      await supportResponse.json(),
      {
        compatible_protocol_versions: ["0.1.0", "0.2.0"],
        conformance: { outstanding: ["binding_authority"], status: "partial" },
        object: "collection_profile_support",
        protocol_capabilities: ["OBSERVATION", "STREAM_EVIDENCE"],
        protocol_version: "0.2.0",
      },
      "profile support is discoverable before a connector starts"
    );

    const connectorId = "owner-observations-fixture";
    if (POSTGRES_URL) {
      await postgresQuery("INSERT INTO connectors(connector_id, manifest) VALUES ($1, '{}'::jsonb)", [connectorId]);
    } else {
      getDb()
        .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
        .run(connectorId, "2026-11-02T00:00:00.000Z");
    }
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: "owner_local",
    });
    const runId = "owner_diagnostic_run";
    await getDefaultConnectorObservationStore().put({
      connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      diagnosis: { attribution: "none", basis: [], category: "unknown", contributing: [] },
      runId,
      snapshot: { defects: [], facts: [], truncated: false },
    });
    const query = new URLSearchParams({
      connector_id: connectorId,
      connector_instance_id: namespace.connectorInstanceId,
    });
    const url = `${origin}/_ref/runs/${runId}/observations?${query}`;
    const denied = await fetch(url, { headers: { Accept: "application/json" }, redirect: "manual" });
    assert.equal(denied.status, 401, "anonymous callers cannot read diagnostics");
    const bearerDenied = await fetch(url, {
      headers: { Accept: "application/json", Authorization: "Bearer non-owner-test-token" },
      redirect: "manual",
    });
    assert.equal(bearerDenied.status, 401, "a bearer header does not replace the owner session");
    const read = await fetch(url, { headers });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    const body = (await read.json()) as { run_id: string; object: string; snapshot: unknown };
    assert.equal(body.object, "run_observations");
    assert.equal(body.run_id, runId);
    assert.deepEqual(body.snapshot, { defects: [], facts: [], truncated: false });
    query.set("connector_instance_id", "other-connection");
    const wrongInstance = await fetch(`${origin}/_ref/runs/${runId}/observations?${query}`, { headers });
    assert.equal(wrongInstance.status, 404, "a run id cannot cross the connection namespace");
  } finally {
    await closeTestServer(server);
    if (POSTGRES_URL) {
      await closePostgresStorage();
    } else {
      closeDb();
    }
  }
});
