// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getConnectorManifest, registerConnector, revokeGrant } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { buildPairwiseOwnerBindings } from "../server/pairwise-identity.ts";
import {
  capturePairwiseQueryScopes,
  preparePairwiseQueryScopes,
  savePairwiseQueryState,
} from "../server/pairwise-query-sessions.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import {
  deleteAllRecords,
  deleteAllRecordsForConnector,
  deleteConnectionRecordRowsPostgres,
  deleteConnectionRecordRowsSqlite,
  deleteRecord,
  drainConnectorInstanceIndexWork,
  enumerateConnectionStreams,
  ingestRecord,
  queryRecordsAcrossBindings,
  teardownConnectionSearchProjection,
} from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { bearer, startPr89OAuthHarness } from "./seam-spike/pr89-oauth-harness.ts";

const marker = "lifecycle-retained-private-payload";
const eventInsertSql = /INSERT.*spine_events/s;
async function retainedRows() {
  return isPostgresStorageBackend()
    ? (await postgresQuery<{ state_json: string }>("SELECT state_json FROM pairwise_query_sessions")).rows
    : getDb().prepare("SELECT state_json FROM pairwise_query_sessions").all<{ state_json: string }>();
}
async function assertNoRetainedPayload() {
  const rows = await retainedRows();
  assert.ok(
    rows.every((row) => !row.state_json.includes(marker)),
    "deleted or revoked record data must leave retained snapshots without a later query"
  );
}
async function checkExpandedChildDeletion() {
  const connectorId = "lifecycle-expansion";
  const instanceId = "lifecycle-expansion-account";
  const manifest = {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Lifecycle expansion",
    manifest_uri: "https://example.test/lifecycle-expansion",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "parents",
        primary_key: ["id"],
        query: { expand: [{ name: "children" }] },
        relationships: [{ cardinality: "has_many", foreign_key: "parent_id", name: "children", stream: "children" }],
        schema: { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "children",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, name: { type: "string" }, parent_id: { type: "string" } },
          required: ["id", "parent_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
  await registerConnector(manifest);
  const now = new Date().toISOString();
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName: instanceId,
    ownerSubjectId: "owner_local",
    sourceBinding: { account: instanceId },
    sourceBindingKey: instanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  const storage = { connector_id: connectorId, connector_instance_id: instanceId };
  await Promise.all(
    ["p1", "p2"].flatMap((id) => [
      ingestRecord(storage, { data: { id, name: "retained-parent" }, emitted_at: now, key: id, stream: "parents" }),
      ingestRecord(storage, {
        data: { id: `c-${id}`, name: marker, parent_id: id },
        emitted_at: now,
        key: `c-${id}`,
        stream: "children",
      }),
    ])
  );
  await drainConnectorInstanceIndexWork();
  const grant = {
    streams: [
      { fields: ["id", "name"], instance_ids: [instanceId], name: "parents" },
      { fields: ["id", "name", "parent_id"], instance_ids: [instanceId], name: "children" },
    ],
  };
  const bindings = [{ connectorId, connectorInstanceId: instanceId, instanceId: "inst_expansion" }];
  const first = await queryRecordsAcrossBindings(
    bindings,
    "parents",
    grant,
    { expand: ["children"], limit: "1" },
    manifest
  );
  assert.ok(first.next_cursor);
  assert.ok(
    (await retainedRows()).some((row) => row.state_json.includes(marker)),
    "fixture retains expanded child payload in its parent page"
  );
  await deleteRecord(storage, "children", "c-p2");
  await assertNoRetainedPayload();
  const parents = await queryRecordsAcrossBindings(bindings, "parents", grant, { limit: "10" }, manifest);
  assert.equal(parents.data.length, 2, "child deletion preserves live parent records");
}
type Operation =
  | "record deletion"
  | "expired record deletion"
  | "connection deletion"
  | "grant revocation"
  | "legacy grant revocation"
  | "connector record reset"
  | "flag-off record deletion"
  | "flag-off fresh deletion"
  | "isolated grant revocation"
  | "failed cleanup grant revocation"
  | "failed event grant revocation"
  | "expanded child deletion"
  | "pre-snapshot revoked grant"
  | "post-snapshot revoked grant"
  | "instance record reset";
async function runLifecycle(operation: Operation, databaseUrl: string | null, t: TestContext) {
  const previousFlag = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
  process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "1";
  const h = await startPr89OAuthHarness({ databaseUrl, lexical: true });
  try {
    const store = createRequestConnectorInstanceStore();
    const instance = await store.get(h.instanceId);
    assert.ok(instance);
    if (operation === "expanded child deletion") {
      await checkExpandedChildDeletion();
      return;
    }
    await Promise.all(
      ["artist:42", "artist:43"].map((key) =>
        h.ingest({
          data: { id: key, name: marker, observed_at: "2026-03-01T00:00:00Z" },
          emitted_at: "2026-03-01T00:00:00Z",
          key,
          stream: "top_artists",
        })
      )
    );
    await drainConnectorInstanceIndexWork();
    if (operation === "pre-snapshot revoked grant" || operation === "post-snapshot revoked grant") {
      const manifest = await getConnectorManifest(instance.connectorId);
      assert.ok(manifest);
      const grantRows = isPostgresStorageBackend()
        ? (
            await postgresQuery<{ grant_json: string }>(
              "SELECT grant_json::text AS grant_json FROM grants WHERE grant_id=$1",
              [h.grantId]
            )
          ).rows
        : getDb().prepare("SELECT grant_json FROM grants WHERE grant_id=?").all<{ grant_json: string }>(h.grantId);
      assert.ok(grantRows[0]);
      const grant = JSON.parse(grantRows[0].grant_json) as {
        streams: { name: string; fields: string[]; instance_ids: string[] }[];
      };
      const binding = (await buildPairwiseOwnerBindings("owner_local")).find(
        (candidate) => candidate.rs_instance === h.instanceId
      );
      assert.ok(binding);
      const bindings = [
        { connectorId: instance.connectorId, connectorInstanceId: h.instanceId, instanceId: binding.instance_id },
      ];
      const query = () =>
        queryRecordsAcrossBindings(
          bindings,
          "top_artists",
          { ...grant, grant_id: h.grantId },
          { changes_since: "beginning", limit: "1" },
          manifest
        );
      let fired = false;
      if (operation === "pre-snapshot revoked grant") {
        await revokeGrant(h.grantId);
      } else {
        assert.ok(isPostgresStorageBackend());
        const pool = getPostgresPool();
        const original = pool.query.bind(pool);
        t.mock.method(pool, "query", async (...args: Parameters<typeof pool.query>) => {
          if (args[0] === "SELECT key FROM pairwise_query_issuer_key WHERE id=1" && !fired) {
            fired = true;
            await revokeGrant(h.grantId);
          }
          return Reflect.apply(original, pool, args);
        });
      }
      await assert.rejects(query(), { code: "grant_revoked" });
      if (operation === "post-snapshot revoked grant") {
        assert.equal(fired, true);
      }
      t.mock.restoreAll();
      await assertNoRetainedPayload();
      return;
    }
    if (operation === "flag-off fresh deletion") {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "0";
      await h.ingest({ emitted_at: new Date().toISOString(), key: "artist:42", op: "delete", stream: "top_artists" });
      await drainConnectorInstanceIndexWork();
      const rows = isPostgresStorageBackend()
        ? (await postgresQuery("SELECT id FROM pairwise_query_issuer_key")).rows
        : getDb().prepare("SELECT id FROM pairwise_query_issuer_key").all();
      assert.equal(rows.length, 0, "flag-off deletion without retained sessions does not create pairwise issuer state");
      return;
    }
    if (operation.endsWith("grant revocation")) {
      h.setIntrospectionInterceptor(async (input, init) => {
        const response = await fetch(input, init);
        const wire = (await response.json()) as {
          authorization_details: { grant: { streams: { resources?: string[] }[] } }[];
        };
        for (const detail of wire.authorization_details) {
          for (const stream of detail.grant.streams) {
            Reflect.deleteProperty(stream, "resources");
          }
        }
        return new Response(JSON.stringify(wire), {
          headers: { "Content-Type": "application/json" },
          status: response.status,
        });
      });
      const response = await fetch(`${h.rsUrl}/v1/streams/top_artists/records?limit=1`, { headers: bearer(h.token) });
      const page = (await response.json()) as { next_cursor?: string };
      assert.equal(response.status, 200, JSON.stringify(page));
      assert.ok(page.next_cursor);
    } else {
      const manifest = await getConnectorManifest(instance.connectorId);
      assert.ok(manifest);
      const ownerBinding = (await buildPairwiseOwnerBindings("owner_local")).find(
        (binding) => binding.rs_instance === h.instanceId
      );
      assert.ok(ownerBinding);
      const result = await queryRecordsAcrossBindings(
        [
          {
            connectorId: instance.connectorId,
            connectorInstanceId: h.instanceId,
            instanceId: ownerBinding.instance_id,
          },
        ],
        "top_artists",
        { streams: [{ fields: ["id", "name", "observed_at"], instance_ids: [h.instanceId], name: "top_artists" }] },
        { limit: "1" },
        manifest
      );
      assert.ok(result.next_cursor);
    }
    assert.ok(
      (await retainedRows()).some((row) => row.state_json.includes(marker)),
      "fixture retains actual record data before lifecycle mutation"
    );
    let unrelatedPage: { next_cursor?: string } | undefined;
    const manifest = await getConnectorManifest(instance.connectorId);
    assert.ok(manifest);
    const ownerBinding = (await buildPairwiseOwnerBindings("owner_local")).find(
      (binding) => binding.rs_instance === h.instanceId
    );
    assert.ok(ownerBinding);
    const unrelatedBindings = [
      { connectorId: instance.connectorId, connectorInstanceId: h.instanceId, instanceId: ownerBinding.instance_id },
    ];
    const unrelatedGrant = {
      grant_id: "unrelated-live-grant",
      streams: [{ fields: ["id", "name", "observed_at"], instance_ids: [h.instanceId], name: "top_artists" }],
    };
    if (operation === "isolated grant revocation") {
      const columns = "grant_id,subject_id,client_id,storage_binding_json,grant_json,access_mode,status,issued_at";
      if (isPostgresStorageBackend()) {
        await postgresQuery(
          `INSERT INTO grants(${columns}) SELECT $1,subject_id,client_id,storage_binding_json,jsonb_set(grant_json,'{grant_id}',to_jsonb($1::text)),access_mode,status,issued_at FROM grants WHERE grant_id=$2`,
          [unrelatedGrant.grant_id, h.grantId]
        );
      } else {
        getDb()
          .prepare(
            `INSERT INTO grants(${columns}) SELECT ?,subject_id,client_id,storage_binding_json,json_set(grant_json,'$.grant_id',?),access_mode,status,issued_at FROM grants WHERE grant_id=?`
          )
          .run(unrelatedGrant.grant_id, unrelatedGrant.grant_id, h.grantId);
      }
      unrelatedPage = await queryRecordsAcrossBindings(
        unrelatedBindings,
        "top_artists",
        unrelatedGrant,
        { limit: "1" },
        manifest
      );
      assert.ok(unrelatedPage.next_cursor);
      const replay = await queryRecordsAcrossBindings(
        unrelatedBindings,
        "top_artists",
        unrelatedGrant,
        { cursor: unrelatedPage.next_cursor, limit: "1" },
        manifest
      );
      assert.equal(replay.data.length, 1, "unrelated grant cursor is valid before revocation");
    }
    if (operation === "flag-off record deletion") {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "0";
    }
    if (operation === "expired record deletion") {
      const now = Date.now();
      t.mock.method(Date, "now", () => now + 24 * 60 * 60 * 1000);
    }
    if (operation.endsWith("grant revocation")) {
      if (operation === "failed cleanup grant revocation" || operation === "failed event grant revocation") {
        const failedEvent = operation === "failed event grant revocation";
        const injectedMessage = failedEvent
          ? "injected revocation event failure"
          : "injected retained-page cleanup failure";
        const fails = (sql: string) => (failedEvent ? eventInsertSql.test(sql) : sql.includes("pairwise_query"));
        if (isPostgresStorageBackend()) {
          const client = await getPostgresPool().connect();
          const prototype = Object.getPrototypeOf(client) as { query: (...args: unknown[]) => unknown };
          const original = prototype.query;
          client.release();
          t.mock.method(prototype, "query", function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === "string" && fails(args[0])) {
              throw new Error(injectedMessage);
            }
            return Reflect.apply(original, this, args);
          });
        } else {
          const db = getDb();
          const prototype = Object.getPrototypeOf(db.prepare("SELECT 1")) as { run: (...args: unknown[]) => unknown };
          const original = prototype.run;
          t.mock.method(prototype, "run", function (this: { source: string }, ...args: unknown[]) {
            if (fails(this.source)) {
              throw new Error(injectedMessage);
            }
            return Reflect.apply(original, this, args);
          });
        }
        await assert.rejects(revokeGrant(h.grantId), new RegExp(injectedMessage));
        t.mock.restoreAll();
        const grantRows = isPostgresStorageBackend()
          ? (await postgresQuery<{ status: string }>("SELECT status FROM grants WHERE grant_id=$1", [h.grantId])).rows
          : getDb().prepare("SELECT status FROM grants WHERE grant_id=?").all<{ status: string }>(h.grantId);
        const tokenRows = isPostgresStorageBackend()
          ? (await postgresQuery<{ revoked: boolean }>("SELECT revoked FROM tokens WHERE grant_id=$1", [h.grantId]))
              .rows
          : getDb().prepare("SELECT revoked FROM tokens WHERE grant_id=?").all<{ revoked: number }>(h.grantId);
        if (failedEvent) {
          assert.equal(grantRows[0]?.status, "revoked", "event failure occurs after the atomic revocation commits");
          assert.ok(tokenRows.length > 0);
          assert.ok(tokenRows.every((row) => Boolean(row.revoked)));
          await assertNoRetainedPayload();
          return;
        }
        assert.equal(grantRows[0]?.status, "active", "failed retained-page cleanup rolls back the grant revocation");
        assert.ok(tokenRows.length > 0);
        assert.ok(
          tokenRows.every((row) => !row.revoked),
          "failed retained-page cleanup leaves grant tokens active"
        );
        assert.ok(
          (await retainedRows()).some((row) => row.state_json.includes(marker)),
          "failed revocation preserves its retained page"
        );
        const events = isPostgresStorageBackend()
          ? (
              await postgresQuery(
                "SELECT event_type FROM spine_events WHERE grant_id=$1 AND event_type='grant.revoked'",
                [h.grantId]
              )
            ).rows
          : getDb()
              .prepare("SELECT event_type FROM spine_events WHERE grant_id=? AND event_type='grant.revoked'")
              .all(h.grantId);
        assert.equal(events.length, 0, "rolled-back revocation emits no success event");
        return;
      }
      if (operation === "legacy grant revocation") {
        const row = isPostgresStorageBackend()
          ? (
              await postgresQuery<{ grant_json: string }>(
                "SELECT grant_json::text AS grant_json FROM grants WHERE grant_id=$1",
                [h.grantId]
              )
            ).rows[0]
          : getDb().prepare("SELECT grant_json FROM grants WHERE grant_id=?").get<{ grant_json: string }>(h.grantId);
        assert.ok(row);
        const legacy = JSON.parse(row.grant_json) as { streams: Record<string, unknown>[] };
        for (const stream of legacy.streams) {
          Reflect.deleteProperty(stream, "instance_ids");
        }
        if (isPostgresStorageBackend()) {
          await postgresQuery("UPDATE grants SET grant_json=$1::jsonb WHERE grant_id=$2", [
            JSON.stringify(legacy),
            h.grantId,
          ]);
        } else {
          getDb().prepare("UPDATE grants SET grant_json=? WHERE grant_id=?").run(JSON.stringify(legacy), h.grantId);
        }
        await assert.rejects(revokeGrant(h.grantId), { code: "grant_invalid" });
        assert.ok(
          (await retainedRows()).some((sessionRow) => sessionRow.state_json.includes(marker)),
          "a failed revocation leaves the valid snapshot intact"
        );
        if (isPostgresStorageBackend()) {
          await postgresQuery("UPDATE grants SET grant_json=$1::jsonb WHERE grant_id=$2", [row.grant_json, h.grantId]);
        } else {
          getDb().prepare("UPDATE grants SET grant_json=? WHERE grant_id=?").run(row.grant_json, h.grantId);
        }
      }
      await revokeGrant(h.grantId);
    } else if (operation === "connection deletion") {
      await store.deleteConnection(h.instanceId, {
        ownerSubjectId: "owner_local",
        purge: {
          deleteRecordRejectionsPostgres: async () => 0,
          deleteRecordRejectionsSqlite: () => 0,
          deleteRecordRowsPostgres: (client, id) =>
            deleteConnectionRecordRowsPostgres(client as Parameters<typeof deleteConnectionRecordRowsPostgres>[0], id),
          deleteRecordRowsSqlite: deleteConnectionRecordRowsSqlite,
          enumerateStreams: enumerateConnectionStreams,
          teardownProjection: teardownConnectionSearchProjection,
        },
      });
    } else if (operation === "connector record reset") {
      await deleteAllRecordsForConnector(instance.connectorId);
    } else if (operation === "instance record reset") {
      await deleteAllRecords(
        { connector_id: instance.connectorId, connector_instance_id: h.instanceId },
        "top_artists"
      );
    } else {
      await deleteRecord(
        { connector_id: instance.connectorId, connector_instance_id: h.instanceId },
        "top_artists",
        "artist:42"
      );
    }
    if (unrelatedPage) {
      const replay = await queryRecordsAcrossBindings(
        unrelatedBindings,
        "top_artists",
        unrelatedGrant,
        { cursor: unrelatedPage.next_cursor, limit: "1" },
        manifest
      );
      assert.equal(replay.data.length, 1, "revoking one grant preserves another grant's retained page");
      assert.ok((await retainedRows()).some((row) => row.state_json.includes(marker)));
    } else {
      await assertNoRetainedPayload();
    }
  } finally {
    t.mock.restoreAll();
    await h.close();
    if (previousFlag === undefined) {
      delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    } else {
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = previousFlag;
    }
  }
}
for (const operation of [
  "record deletion",
  "expired record deletion",
  "connection deletion",
  "grant revocation",
  "legacy grant revocation",
  "instance record reset",
  "connector record reset",
  "flag-off record deletion",
  "flag-off fresh deletion",
  "isolated grant revocation",
  "failed cleanup grant revocation",
  "failed event grant revocation",
  "expanded child deletion",
  "pre-snapshot revoked grant",
] as const) {
  test(`pairwise retained snapshots purge payload on ${operation} without another pairwise read (SQLite)`, (t) =>
    runLifecycle(operation, null, t));
  test(`pairwise retained snapshots purge payload on ${operation} without another pairwise read (PostgreSQL)`, {
    skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  }, async (t) => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: process.env.PDPP_TEST_POSTGRES_URL ?? "",
        databaseName: `pdpp_lifecycle_${randomUUID().replaceAll("-", "")}`,
        templateName: null,
      },
      (databaseUrl) => runLifecycle(operation, databaseUrl, t)
    );
  });
}

test("pairwise admission rejects an actual grant revoked after snapshot capture (PostgreSQL)", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: process.env.PDPP_TEST_POSTGRES_URL ?? "",
      databaseName: `pdpp_lifecycle_revoke_${randomUUID().replaceAll("-", "")}`,
      templateName: null,
    },
    (databaseUrl) => runLifecycle("post-snapshot revoked grant", databaseUrl, t)
  );
});

for (const flag of ["1", "0"]) {
  test(`startup reclaims an expired retained snapshot with the serving flag ${flag}`, async (t) => {
    const base = join(homedir(), ".tmp");
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, "pdpp-session-startup-"));
    const path = join(directory, "retained.sqlite");
    const priorDatabaseUrl = process.env.PDPP_DATABASE_URL;
    const priorFlag = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
    delete process.env.PDPP_DATABASE_URL;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      initDb(path);
      const retention = {
        generations: {},
        grantDigest: "startup-owner",
        grantId: "",
        scopes: [{ connectorInstanceId: "account", stream: "items" }],
      };
      await preparePairwiseQueryScopes(retention);
      await capturePairwiseQueryScopes(retention);
      await savePairwiseQueryState({
        checkpoints: {},
        context: JSON.stringify({ bindings: [["account", "inst_account"]], stream: "items" }),
        data: [{ data: { name: marker } }],
        kind: "page",
        offset: 1,
        retention,
      });
      assert.ok((await retainedRows()).some((row) => row.state_json.includes(marker)));
      closeDb();
      const now = Date.now();
      t.mock.method(Date, "now", () => now + 24 * 60 * 60 * 1000);
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = flag;
      server = await startServer({
        asPort: 0,
        dbPath: path,
        ownerAuthPassword: "",
        quiet: true,
        reconcilePolyfillManifests: false,
        rsPort: 0,
      });
      await assertNoRetainedPayload();
    } finally {
      t.mock.restoreAll();
      if (server) {
        server.stopConnectorMaintenanceSweep();
        server.stopPostgresDerivedIndexMaintenance();
        await Promise.all(
          [server.asServer, server.rsServer].map(async (listener) => {
            listener.closeAllConnections?.();
            await new Promise<void>((resolve) => listener.close(() => resolve()));
          })
        );
      }
      closeDb();
      if (priorDatabaseUrl === undefined) {
        delete process.env.PDPP_DATABASE_URL;
      } else {
        process.env.PDPP_DATABASE_URL = priorDatabaseUrl;
      }
      if (priorFlag === undefined) {
        delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
      } else {
        process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = priorFlag;
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });
}

test("flag-off PostgreSQL deletion does not hold a pairwise global lock or block another instance", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: process.env.PDPP_TEST_POSTGRES_URL ?? "",
      databaseName: `pdpp_lifecycle_lock_${randomUUID().replaceAll("-", "")}`,
      templateName: null,
    },
    async (databaseUrl) => {
      const previousFlag = process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
      process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = "0";
      const h = await startPr89OAuthHarness({ databaseUrl, lexical: true });
      const store = createRequestConnectorInstanceStore();
      const instance = await store.get(h.instanceId);
      assert.ok(instance);
      const otherInstanceId = `${h.instanceId}_other`;
      await store.upsert({
        ...instance,
        connectorInstanceId: otherInstanceId,
        sourceBinding: { account: otherInstanceId },
        sourceBindingKey: otherInstanceId,
      });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (() => void) | undefined;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = withPostgresTransaction(async (client) => {
        await deleteConnectionRecordRowsPostgres(client, h.instanceId);
        entered?.();
        await held;
      });
      try {
        await Promise.race([inside, first]);
        await withPostgresTransaction(async (client) => {
          await client.query("SET LOCAL lock_timeout = '500ms'");
          const lock = await client.query<{ free: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('pairwise-query-admission',0)) AS free"
          );
          assert.equal(lock.rows[0]?.free, true, "flag-off deletion holds no pairwise admission lock");
          await deleteConnectionRecordRowsPostgres(client, otherInstanceId);
        });
      } finally {
        release?.();
        try {
          await first;
        } finally {
          await h.close();
          if (previousFlag === undefined) {
            delete process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY;
          } else {
            process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY = previousFlag;
          }
        }
      }
    }
  );
});
