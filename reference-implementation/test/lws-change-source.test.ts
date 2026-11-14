// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { createChangeSource } from "../server/lws/change-source.ts";
import { ingestRecord } from "../server/records.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const emittedAt = "2026-11-13T12:00:00.000Z";
const manifest = { connector_id: "lws-test", manifest_ref: "test-ref",
  streams: [{ name: "items", schema: { type: "object" } }] };

test("SQLite change source: ordered UTF-8 byte cut, tombstones, pruning and snapshot floor", async () => {
  const db = initDb(":memory:");
  try {
    db.prepare("INSERT INTO connectors (connector_id, manifest) VALUES (?, ?)").run("lws-test", JSON.stringify(manifest));
    db.prepare(`INSERT INTO connector_instances
      (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind,
       source_binding_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "lws-connection", "owner_local", "lws-test", "test", "manual", "lws-test", emittedAt, emittedAt
    );
    const target = { connectorId: "lws-test", connectorInstanceId: "lws-connection" };
    // Follow the existing ingest API rather than manufacturing current versions.
    await ingestRecord(target, { stream: "items", key: "a", data: { text: "é🙂" }, emitted_at: emittedAt });
    await ingestRecord(target, { stream: "items", key: "b", data: { text: "second" }, emitted_at: emittedAt });
    await ingestRecord(target, { stream: "items", key: "a", data: {}, op: "delete", emitted_at: emittedAt });
    const source = createChangeSource(db);
    assert.deepEqual(await source.listConnections(), [
      { connectionId: "lws-connection", connectorId: "lws-test", manifestRef: "test-ref" },
    ]);
    assert.deepEqual(await source.listStreams("lws-connection"), [
      { stream: "items", schema: { type: "object" } },
    ]);
    const all = await source.readChanges("lws-connection", "items", 0, 100000);
    assert.deepEqual(all.rows.map((row) => row.version), [1, 2, 3]);
    assert.equal(all.oldestAvailableVersion, 1);
    assert.equal(all.rows[2]?.op, "delete");
    assert.equal(all.rows[2]?.data, null);
    const firstBytes = Buffer.byteLength(JSON.stringify(all.rows[0]) + "\n", "utf8");
    assert.equal((await source.readChanges("lws-connection", "items", 0, firstBytes)).rows.length, 1);
    assert.equal((await source.readChanges("lws-connection", "items", 0, 1)).rows.length, 1);
    const twoBytes = firstBytes + Buffer.byteLength(JSON.stringify(all.rows[1]) + "\n", "utf8");
    assert.equal((await source.readChanges("lws-connection", "items", 0, twoBytes)).rows.length, 2);
    assert.deepEqual((await source.readChanges("lws-connection", "items", 2, 10000)).rows.map((row) => row.version), [3]);
    db.prepare("DELETE FROM record_changes WHERE version < 3 AND connector_instance_id = ?").run("lws-connection");
    assert.equal((await source.readChanges("lws-connection", "items", 99, 1000)).oldestAvailableVersion, 3);
    const snapshot = await source.readSnapshot("lws-connection", "items");
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.generation, 0);
    assert.deepEqual(snapshot.lines.map((row) => row.key), ["b"]);
    assert.equal("id" in snapshot.lines[0]!, false);
    db.prepare("UPDATE connector_instances SET record_reset_generation = 4 WHERE connector_instance_id = ?").run("lws-connection");
    assert.equal(await source.resetGeneration("lws-connection"), 4);
    assert.equal((await source.readSnapshot("lws-connection", "items")).generation, 4);
    db.prepare("DELETE FROM record_changes WHERE connector_instance_id = ?").run("lws-connection");
    assert.equal((await source.readChanges("lws-connection", "items", 0, 1)).oldestAvailableVersion, null);
    assert.equal((await source.readSnapshot("lws-connection", "items")).version, 3);
    await assert.rejects(source.readChanges("lws-connection", "items", -1, 1), /afterVersion/);
    await assert.rejects(source.readChanges("lws-connection", "items", 0, 0), /maxBytes/);
    await assert.rejects(source.readSnapshot("missing", "items"), /Connection not found/);
    await assert.rejects(source.listStreams("missing"), /Connection not found/);
    db.prepare("UPDATE records SET record_json = ? WHERE connector_instance_id = ? AND deleted = 0").run("{", "lws-connection");
    await assert.rejects(source.readSnapshot("lws-connection", "items"), SyntaxError);
    assert.equal(db.prepare("SELECT 1 AS ok").get<{ ok: number }>()?.ok, 1, "read failure leaves handle usable");
  } finally {
    closeDb();
  }
});

test("SQLite snapshot reads metadata and rows within one synchronous transaction", async () => {
  // Transaction-shape oracle: do not allow a metadata/data read outside the
  // boundary. Real SQLite ingest behavior is exercised in the preceding test.
  let inTransaction = false;
  let reads = 0;
  const fake = {
    prepare(sql: string) {
      assert.equal(inTransaction, true);
      reads += 1;
      return {
        all() {
          return sql.includes("connector_instances")
            ? [{ record_reset_generation: 7 }]
            : [{ record_key: "a", version: 9, emitted_at: emittedAt, record_json: '{"id":"a"}' }];
        },
        get() { return { version: 9 }; },
      };
    },
    transaction<T>(fn: () => T) {
      return () => {
        inTransaction = true;
        try { return fn(); } finally { inTransaction = false; }
      };
    },
  };
  const source = createChangeSource(fake as unknown as ReturnType<typeof initDb>);
  const result = await source.readSnapshot("connection", "items");
  assert.equal(reads, 3);
  assert.equal(inTransaction, false);
  assert.equal(result.version, 9);
  assert.equal(result.generation, 7);
  assert.equal(result.lines[0]?.version, 9);
});

const postgresUrl = process.env.PDPP_TEST_POSTGRES_URL;
test("Postgres snapshot and history use the same connection scope", { skip: !postgresUrl }, async () => {
  const id = `lws_pg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl! });
  try {
    await postgresQuery("INSERT INTO connectors (connector_id, manifest) VALUES ($1, $2)", [id, JSON.stringify(manifest)]);
    await postgresQuery(`INSERT INTO connector_instances
      (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind,
       source_binding_key, created_at, updated_at)
      VALUES ($1, $2, $1, $1, 'manual', $1, $3, $3)`, [id, "owner_local", emittedAt]);
    await ingestRecord({ connectorId: id, connectorInstanceId: id },
      { stream: "items", key: "a", data: { id: "a" }, emitted_at: emittedAt });
    const source = createChangeSource();
    const changes = await source.readChanges(id, "items", 0, 1);
    assert.equal(changes.rows.length, 1);
    assert.equal(changes.oldestAvailableVersion, 1);
    const snapshot = await source.readSnapshot(id, "items");
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.generation, 0);
    assert.deepEqual(snapshot.lines.map((row) => row.key), ["a"]);
  } finally {
    for (const table of ["record_changes", "records", "version_counter"]) {
      await postgresQuery(`DELETE FROM ${table} WHERE connector_instance_id = $1`, [id]);
    }
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [id]);
    await closePostgresStorage();
    closeDb();
  }
});
