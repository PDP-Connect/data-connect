// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

let asUrl = "";
mock.module("server-only", { exports: {} });
mock.module("../lib/verify-session.ts", { exports: { verifyDashboardSession: async () => undefined } });
mock.module("../lib/owner-token.ts", {
  exports: {
    getAsInternalUrl: () => asUrl,
    withOwnerSessionCookie: async (init = {}) => init,
    ReferenceServerUnreachableError: class extends Error {},
  },
});

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "catalog integration fixture key";

test("Add catalog helper and real ref-client exhaust the real HTTP owner feed beyond 100 catalog IDs", async (t) => {
  const { startServer } = await import("../../../../../../reference-implementation/server/index.ts");
  const { closeDb, getDb } = await import("../../../../../../reference-implementation/server/db.ts");
  const { createSqliteAcquisitionBatchStore } = await import(
    "../../../../../../reference-implementation/server/stores/acquisition-batch-store.ts"
  );
  const { reconcileConnectorSummaryEvidence } = await import(
    "../../../../../../reference-implementation/server/connector-summary-evidence-engine.ts"
  );
  const server = await startServer({ asPort: 0, rsPort: 0, dbPath: ":memory:", quiet: true });
  t.after(async () => {
    server.abortStartupBackfill("catalog integration shutdown");
    server.schedulerManager?.stop?.();
    server.stopBrowserSurfaceLeaseSweep();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
      server.controller.drainActiveRuns(5000),
      server.startupBackfillDone,
      server.startupSummaryEvidenceSweepDone,
      server.stopClientEventDeliveryWorker(),
    ]);
    closeDb();
  });
  await server.startupBackfillDone;
  asUrl = `http://localhost:${server.asPort}`;
  const db = getDb();
  const now = "2026-11-01T00:00:00.000Z";
  const catalogIds = Array.from({ length: 150 }, (_, i) => `catalog-${i}`);
  for (const id of [...catalogIds, "gmail", "goodreads", "off-catalog"]) {
    db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
      id,
      JSON.stringify({
        connector_id: id,
        display_name: id,
        protocol_version: "0.1.0",
        version: "1.0.0",
        capabilities: { public_listing: { tier: "supported" } },
        streams: [{ name: "books", primary_key: ["id"] }],
      }),
      now
    );
  }
  const insert = db.prepare(`INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id,
    display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
    VALUES(?, ?, ?, ?, ?, 'manual', ?, '{}', ?, ?, ?)`);
  for (let i = 0; i < 101; i += 1) {
    const id = `padding-${String(i).padStart(3, "0")}`;
    insert.run(id, "owner_local", "gmail", id, "active", id, now, now, null);
  }
  for (const [id, owner, connector, name, status] of [
    ["read-z", "owner_local", "goodreads", "Zed", "active"],
    ["read-a", "owner_local", "goodreads", "Amy", "active"],
    ["read-revoked", "owner_local", "goodreads", "Revoked", "revoked"],
    ["read-foreign", "foreign-owner", "goodreads", "Foreign", "active"],
    ["other", "owner_local", "off-catalog", "Other", "active"],
  ]) {
    insert.run(
      id,
      owner,
      connector,
      name,
      status,
      id,
      "2026-11-02T00:00:00.000Z",
      now,
      status === "revoked" ? now : null
    );
  }
  db.prepare(`INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at,
    semantic_time, version, deleted) VALUES('goodreads', 'read-a', 'books', 'book', '{}', ?, ?, 1, 0)`).run(now, now);
  createSqliteAcquisitionBatchStore().insertOwnerArtifactBatch({
    artifactSha256: "catalog-fixture-sha",
    connectorId: "goodreads",
    connectorInstanceId: "read-a",
    createdAt: now,
    updatedAt: now,
    ownerSubjectId: "owner_local",
    status: "committed",
    uploadedFileName: "books.csv",
  });
  await reconcileConnectorSummaryEvidence(null);
  const requests = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  });
  const { existingSourcesByConnectorCatalog } = await import("./existing-sources-by-connector.ts");
  const catalog = [...catalogIds, "goodreads", "goodreads"];
  const result = await existingSourcesByConnectorCatalog(catalog);
  assert.deepEqual(Object.keys(result), ["goodreads"]);
  assert.deepEqual(
    result.goodreads?.map((source) => [source.connectionId, source.displayName, source.totalRecords]),
    [
      ["read-a", "Amy", 1],
      ["read-z", "Zed", 0],
    ]
  );
  assert.equal(result.goodreads?.[0]?.totalRecordsState, "known");
  assert.equal(result.goodreads?.[0]?.latestImportFile, "books.csv");
  assert.equal(result.goodreads?.[0]?.latestImportStatus, "committed");
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(
      (url) => !url.searchParams.has("connector_id") && url.searchParams.get("profile") === "retained_count_summary"
    )
  );
  assert.ok(requests[1]?.searchParams.get("cursor"));
});
