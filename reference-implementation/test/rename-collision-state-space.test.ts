// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumePendingCode } from "./helpers/rename-enrollment-fixture.ts";
import { closeDb, initDb } from "../server/db.ts";
import { bootstrapPostgresSchema, closePostgresStorage, getPostgresPool, initPostgresStorage } from "../server/postgres-storage.ts";
import { CONNECTOR_ID_RENAME_MIGRATION_ID } from "../server/connector-id-rename-migration.ts";
import { LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID } from "../server/postgres-migration-ledger.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { assertLegacyLocalDevice, bindingScenarios, collisionTables, key, legacyConnectors, observationScenarios, seedLegacyLocalDevice, seedBindingScenario, seedCollision, seedObservationScenario, seedTombstoneShape, type Query } from "./helpers/rename-collision-fixtures.ts";

// Fixed seed, bounded product: independent old/new/both masks for each table,
// with device pointers constrained to existing instances (or tombstoned sources).
let randomState = 0x7701128;
const next = () => (randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0);
// Tombstones under either spelling, next to a live connection under the other.
const tombstoneShapes = (["old", "current"] as const).flatMap(spelling => (["zero", "shared", "per-device"] as const).flatMap(tombstones => [1, 2].flatMap(devices => [false, true].map(occupied => ({ name: `tombstones-${spelling === "current" ? "current-" : ""}${tombstones}-devices-${devices}-occupied-${occupied}`, spelling, tombstones, devices, occupied, masks: null })))));
const shapes = [
  ...["claude_code", "claude-code"].flatMap(connector => ["shared", "distinct-old", "distinct-current", "suffix", "deleted", "deleted-orphan"].map(codeBinding => ({ name: `code-${connector}-${codeBinding}`, connector, codeBinding, masks: null }))),
  ...tombstoneShapes,
  ...legacyConnectors.map(legacy => ({ name: `legacy-local-device-${legacy}`, legacy, masks: null })),
  ...[...bindingScenarios, ...collisionTables, ...observationScenarios].map(name => ({ name, masks: null as number[] | null })),
  ...Array.from({ length: 12 }, (_, i) => ({ name: `seed-7701128-${i}`, masks: Array.from({ length: 10 }, () => next() % 3 + 1) })),
];
const json = (value: unknown): Record<string, unknown> => typeof value === "string" ? JSON.parse(value) : value as Record<string, unknown>;

async function seed(query: Query, shape: typeof shapes[number], postgres: boolean) {
  if ("codeBinding" in shape) {
    await seedBindingScenario(query, shape.codeBinding.startsWith("deleted") ? (shape.codeBinding === "deleted-orphan" ? "tombstone-without-source" : "deleted-null-pointer") : "null-pointer", postgres);
    if (shape.codeBinding.startsWith("distinct")) {
      await query(`UPDATE connector_instances SET source_binding_key = '${key("binding-b")}', source_binding_json = '{"kind":"local_device","local_binding_name":"binding-b"}' WHERE connector_instance_id = 'inst_new'`);
      await query("UPDATE device_source_instances SET local_binding_id = 'binding-b' WHERE source_instance_id = 'src_new'");
    }
    const binding = shape.codeBinding === "suffix" ? "binding-a#renamed-from:claude_code" : shape.codeBinding === "distinct-current" ? "binding-b" : "binding-a";
    await query(`INSERT INTO device_enrollment_codes (enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, created_at, expires_at) VALUES ('pending-code', 'fixture-code', 'owner_local', '${shape.connector}', '${binding}', '2026-11-14T00:00:00.000Z', '2999-01-01T00:00:00.000Z')`);
  } else if ("legacy" in shape) {
    await seedLegacyLocalDevice(query, shape.legacy, postgres);
  } else if ("tombstones" in shape) {
    await seedTombstoneShape(query, shape.tombstones, shape.devices, shape.occupied, postgres, shape.spelling);
  } else if (!shape.masks) {
    if ((collisionTables as readonly string[]).includes(shape.name)) {
      await seedCollision(query, shape.name);
      for (const id of ["old", "new"]) await query(`UPDATE connector_instances SET source_binding_json = '{"kind":"local_device","local_binding_name":"${id}"}' WHERE connector_instance_id = 'inst_${id}'`);
    } else if ((observationScenarios as readonly string[]).includes(shape.name)) {
      await seedObservationScenario(query, shape.name);
      for (const id of ["old", "new"]) await query(`UPDATE connector_instances SET source_binding_json = '{"kind":"local_device","local_binding_name":"${id}"}' WHERE connector_instance_id = 'inst_${id}'`);
    } else await seedBindingScenario(query, shape.name, postgres);
  } else {
    const m = shape.masks;
    await seedBindingScenario(query, m[6] === 1 ? "cross-device" : m[7] === 1 ? "occupied-instance-suffix" : "null-pointer", postgres);
    // Metadata tables vary independently. Existing instance IDs make all FKs valid.
    for (const [i, table] of collisionTables.entries()) {
      await seedCollision(async sql => /^INSERT INTO (connectors|connector_instances)\b/.test(sql) ? [] : query(sql), table);
      if (m[i] !== 3) await query(`DELETE FROM ${table} WHERE connector_id = '${m[i] === 1 ? "claude-code" : "claude_code"}'`);
    }
    if (m[8] === 1) await query("UPDATE connector_observation_runs SET connector_instance_id = 'inst_old', run_id = 'same-run'");
    if (m[8] === 2) await query("UPDATE connector_observation_runs SET payload_json = '{\"conflict\":true}' WHERE connector_id = 'claude_code'");
    if (m[4] !== 3) {
      const id = m[4] === 1 ? "new" : "old";
      await query(`DELETE FROM device_source_instances WHERE source_instance_id = 'src_${id}'`);
      // Source rows are independently absent; keep the instance as an orphan.
      if (m[5] === 1) {
        await query(`DELETE FROM records WHERE connector_instance_id = 'inst_${id}'`);
        await query(`DELETE FROM connector_instances WHERE connector_instance_id = 'inst_${id}'`);
      }
    }
    if (m[9] === 1) {
      await query("UPDATE device_source_instances SET connector_instance_id = NULL WHERE source_instance_id = 'src_old'");
      await query("DELETE FROM records WHERE connector_instance_id = 'inst_old'");
      await query("DELETE FROM connector_instances WHERE connector_instance_id = 'inst_old'");
      await query(`INSERT INTO connector_instance_tombstones VALUES ('deleted_old', 'owner_local', 'claude_code', 'local_device', '${key("binding-a")}', '2026-11-14T00:00:00.000Z')`);
    }
  }
  // Seed the complete JSON produced by the real device binding writer.
  await query("UPDATE device_source_instances SET display_name = 'device'");
  const sources = await query("SELECT * FROM device_source_instances");
  const instances = await query("SELECT * FROM connector_instances");
  const devices = await query("SELECT * FROM device_exporters");
  for (const source of sources) {
    const id = source.connector_instance_id ?? instances.find(instance => instance.connector_id === source.connector_id && instance.owner_subject_id === devices.find(device => device.device_id === source.device_id)?.owner_subject_id && instance.source_binding_key === key(String(source.local_binding_id)))?.connector_instance_id;
    if (!id) continue;
    await query(`UPDATE connector_instances SET source_binding_json = '${JSON.stringify({ device_id: source.device_id, kind: "local_device", local_binding_name: source.local_binding_id, source_instance_id: source.source_instance_id })}' WHERE connector_instance_id = '${id}'`);
  }
}

async function records(query: Query) {
  return query("SELECT connector_instance_id, stream, record_key, record_json FROM records ORDER BY connector_instance_id, stream, record_key");
}
async function deletedSources(query: Query) {
  const tombstones = await query("SELECT * FROM connector_instance_tombstones");
  const devices = await query("SELECT * FROM device_exporters");
  return (await query("SELECT * FROM device_source_instances")).filter(source => !source.connector_instance_id && tombstones.some(row => row.connector_id === source.connector_id && row.owner_subject_id === devices.find(device => device.device_id === source.device_id)?.owner_subject_id && row.source_binding_key === key(String(source.local_binding_id)))).map(source => source.source_instance_id);
}
async function assertDeletedSources(query: Query, deleted: unknown[]) {
  const sources = await query("SELECT * FROM device_source_instances");
  for (const id of deleted) assert.equal(sources.find(source => source.source_instance_id === id)?.connector_instance_id, null, `deleted source ${id} stays unlinked`);
}
async function state(query: Query) {
  const instances = await query("SELECT * FROM connector_instances ORDER BY connector_instance_id");
  for (const record of await records(query)) assert.ok(instances.some(instance => instance.connector_instance_id === record.connector_instance_id), "every record resolves to its original instance");
  const sources = await query("SELECT * FROM device_source_instances ORDER BY source_instance_id");
  const tombstones = await query("SELECT * FROM connector_instance_tombstones ORDER BY connector_instance_id");
  for (const instance of instances) {
    const binding = json(instance.source_binding_json);
    assert.equal(instance.source_binding_key, key(String(binding.local_binding_name)), "binding JSON and hash agree");
    const target = instances.filter(row => row.owner_subject_id === instance.owner_subject_id && row.connector_id === instance.connector_id && row.source_binding_key === key(String(binding.local_binding_name)));
    assert.deepEqual(target.map(row => row.connector_instance_id), [instance.connector_instance_id], "selected-connection enrollment resolves to itself");
  }
  for (const source of sources) {
    const instance = instances.find(row => row.connector_instance_id === source.connector_instance_id);
    if (instance) assert.equal(source.local_binding_id, json(instance.source_binding_json).local_binding_name);
    else {
      assert.equal(source.connector_instance_id, null);
      assert.ok(tombstones.some(row => row.source_binding_key === key(String(source.local_binding_id))), "unlinked source remains tombstoned");
    }
  }
  for (const tombstone of tombstones) assert.ok(!instances.some(row => row.owner_subject_id === tombstone.owner_subject_id && row.connector_id === tombstone.connector_id && row.source_binding_key === tombstone.source_binding_key), "deleted binding gains no live instance");
  if (instances.some(row => row.connector_instance_id === "inst_new" && row.source_binding_key === key("binding-a"))) {
    assert.equal(instances.find(row => row.source_binding_key === key("binding-a"))?.connector_instance_id, "inst_new", "fresh bare-name enrollment keeps current connection");
  }
  // Driver representation differs (JSON text/jsonb, numeric seq); normalize only representation.
  const normalized = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(Object.entries(row).sort().map(([k, v]) => [k, k.endsWith("_json") ? json(v) : typeof v === "string" && /revision|generation|epoch|sequence/.test(k) && /^-?[0-9]+$/.test(v) ? Number(v) : v])));
  return { instances: normalized(instances), sources: normalized(sources), tombstones: normalized(tombstones) };
}

test("bounded rename state space: two boots, binding invariants and backend parity", async t => {
  const failures: string[] = [];
  const expected = new Map<string, Awaited<ReturnType<typeof state>>>();
  for (const shape of shapes) {
    const dir = mkdtempSync(join(tmpdir(), "rename-state-space-"));
    const path = join(dir, "fixture.sqlite");
    let db = initDb(path);
    const query: Query = async sql => /^SELECT/.test(sql) ? db.prepare(sql).all() as Record<string, unknown>[] : (db.exec(sql), []);
    try {
      await seed(query, shape, false);
      const original = await records(query);
      const deleted = await deletedSources(query);
      closeDb();
      db = initDb(path);
      await assertDeletedSources(query, deleted);
      assert.deepEqual(await records(query), original, `${shape.name}: records unchanged`);
      expected.set(shape.name, await state(query));
      const all = async () => Promise.all([state(query), records(query), query("SELECT * FROM device_enrollment_codes ORDER BY enrollment_code_id"), ...collisionTables.map(table => query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`))]);
      const first = await all();
      closeDb(); db = initDb(path);
      assert.deepEqual(await all(), first, `${shape.name}: second SQLite boot is a no-op`);
      if ("codeBinding" in shape) await consumePendingCode(query, shape, false);
      if ("legacy" in shape) await assertLegacyLocalDevice(query, shape.legacy);
    } catch (error) { failures.push(`SQLite ${shape.name}: ${error instanceof Error ? error.message : error}`); }
    finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
  }
  t.diagnostic(`${shapes.length} SQLite shapes ran`);
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  if (!url) { t.diagnostic("Postgres parity skipped: PDPP_TEST_POSTGRES_URL unset"); assert.deepEqual(failures, []); return; }
  await withTemporaryPostgresDatabase({ connectionString: url, databaseName: `rename_shapes_${process.pid}`, closeConnections: closePostgresStorage }, async databaseUrl => {
    await initPostgresStorage({ backend: "postgres", databaseUrl });
    const pool = getPostgresPool();
    const query: Query = async sql => (await pool.query(sql)).rows;
    for (const complete of [false, true]) for (const shape of shapes) {
      // A completed canonicalization receipt means the sweep already consumed legacy ids.
      if (complete && "legacy" in shape) continue;
      try {
        await query("TRUNCATE device_enrollment_codes, device_ingest_credentials, records, connector_state, record_acquisition_provenance, record_changes, connectors, device_exporters, connector_instances, connector_instance_tombstones, connector_observation_runs, acquisition_batches, browser_surface_leases CASCADE");
        await seed(query, shape, true);
        const original = await records(query);
        const deleted = await deletedSources(query);
        await pool.query("DELETE FROM storage_migration_ledger WHERE migration_id = $1", [CONNECTOR_ID_RENAME_MIGRATION_ID]);
        if (!complete) await pool.query("DELETE FROM storage_migration_ledger WHERE migration_id = $1", [LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID]);
        await bootstrapPostgresSchema();
        await assertDeletedSources(query, deleted);
        assert.deepEqual(await records(query), original);
        const identityRows = (value: unknown) => JSON.parse(JSON.stringify(value, (k, v) => k === "source_revision" || k === "updated_at" ? undefined : v));
        assert.deepEqual(identityRows(await state(query)), identityRows(expected.get(shape.name)), "SQLite/Postgres identity and binding parity (driver revision counters and sweep timestamps excluded)");
        const all = async () => Promise.all([state(query), records(query), query("SELECT * FROM device_enrollment_codes ORDER BY enrollment_code_id"), ...collisionTables.map(table => query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`))]);
        const first = await all();
        await bootstrapPostgresSchema();
        assert.deepEqual(await all(), first, "second Postgres boot is a no-op");
        if ("codeBinding" in shape) await consumePendingCode(query, shape, true);
        if ("legacy" in shape) await assertLegacyLocalDevice(query, shape.legacy);
      } catch (error) { failures.push(`Postgres ${shape.name}, receipt complete=${complete}: ${error instanceof Error ? error.message : error}`); }
    }
  });
  t.diagnostic(`${shapes.length * 2 - legacyConnectors.length} Postgres shapes ran (pending/complete receipts)`);
  assert.deepEqual(failures, []);
});
