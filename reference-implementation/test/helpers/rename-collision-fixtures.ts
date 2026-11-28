// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { makeConnectorInstanceSourceBindingKey as bindingKey } from "../../server/connector-instance-utils.ts";

export const collisionTables = ["connector_instance_tombstones", "connector_observation_runs", "acquisition_batches", "browser_surface_leases"] as const;
export type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const now = "2026-11-14T00:00:00.000Z";
export const key = (name: string) => bindingKey({ kind: "local_device", local_binding_name: name });

export async function seedCollision(query: Query, table: string): Promise<void> {
  for (const [id, connector] of [["old", "claude_code"], ["new", "claude-code"]] as const) {
    await query(`INSERT INTO connectors (connector_id, manifest, created_at) VALUES ('${connector}', '{}', '${now}')`);
    await query(`INSERT INTO connector_instances
      (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
      VALUES ('inst_${id}', 'owner_local', '${connector}', 'device', 'local_device', '${key(id)}', '${now}', '${now}')`);
    if (table === "connector_instance_tombstones") {
      await query(`INSERT INTO connector_instance_tombstones VALUES ('gone_${id}', 'owner_local', '${connector}', 'local_device', 'deleted-binding', '${now}')`);
    } else if (table === "connector_observation_runs") {
      await query(`INSERT INTO connector_observation_runs VALUES ('${connector}', 'inst_${id}', 'run_${id}', 1, 1, '${now}', '{}')`);
    } else if (table === "acquisition_batches") {
      await query(`INSERT INTO acquisition_batches (batch_id, owner_subject_id, connector_id, connector_instance_id, acquisition_method, artifact_sha256, status, created_at, updated_at)
        VALUES ('batch_${id}', 'owner_local', '${connector}', 'inst_${id}', 'owner_artifact', 'same-digest', 'committed', '${now}', '${now}')`);
      await query(`INSERT INTO record_acquisition_provenance (connector_instance_id, stream, record_key, batch_id, acquisition_method, created_at) VALUES ('inst_${id}', 'sessions', 'record', 'batch_${id}', 'owner_artifact', '${now}')`);
    } else {
      await query(`INSERT INTO browser_surface_leases (lease_id, connector_id, profile_key, run_id, status, priority_class, requested_at, expires_at, fencing_token)
        VALUES ('lease_${id}', '${connector}', 'profile', 'run_${id}', 'waiting_for_browser_surface', 'interactive', '${now}', '${now}', 1)`);
    }
  }
}

export async function assertCollision(query: Query, table: string): Promise<void> {
  const rows = await query(`SELECT * FROM ${table} ORDER BY connector_id`);
  assert.equal(rows.length, table === "connector_observation_runs" || table === "acquisition_batches" ? 2 : 1);
  assert.ok(rows.every(row => row.connector_id === "claude-code"));
  if (table === "connector_observation_runs") {
    const ordered = await query(`SELECT run_id FROM ${table} ORDER BY recorded_seq`);
    assert.deepEqual(ordered.map(row => row.run_id), ["run_old", "run_new"]);
  } else if (table === "acquisition_batches") {
    assert.ok(rows.every(row => row.artifact_sha256 === "same-digest"));
    assert.equal(rows.find(row => row.batch_id === "batch_old")?.superseded_by_batch_id, "batch_new");
    assert.equal(rows.find(row => row.batch_id === "batch_new")?.superseded_by_batch_id, null);
    assert.deepEqual((await query("SELECT batch_id FROM record_acquisition_provenance ORDER BY batch_id")).map(row => row.batch_id), ["batch_new", "batch_old"]);
  } else {
    assert.equal(rows[0]![table === "browser_surface_leases" ? "lease_id" : "connector_instance_id"], table === "browser_surface_leases" ? "lease_new" : "gone_new");
  }
}

export const bindingScenarios = ["cross-device", "null-pointer", "occupied-suffix"] as const;
export async function seedBindingScenario(query: Query, scenario: string, postgres = false): Promise<void> {
  for (const device of ["d1", "d2"]) {
    await query(`INSERT INTO device_exporters (device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ('${device}', 'owner_local', '${device}', '${now}', '${now}')`);
  }
  for (const [id, connector] of [["old", "claude_code"], ["new", "claude-code"]] as const) {
    await query(`INSERT INTO connectors (connector_id, manifest, created_at) VALUES ('${connector}', '{}', '${now}')`);
    await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
      VALUES ('inst_${id}', 'owner_local', '${connector}', 'device', 'local_device', '${key("binding-a")}', '${now}', '${now}')`);
    await query(`INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at${postgres ? ", primary_key_text" : ""})
      VALUES ('${connector}', 'inst_${id}', 'sessions', 'record', '{}', '${now}'${postgres ? ", 'record'" : ""})`);
    const device = scenario === "cross-device" && id === "new" ? "d2" : "d1";
    const pointer = scenario === "null-pointer" && id === "old" ? "NULL" : `'inst_${id}'`;
    await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at)
      VALUES ('src_${id}', '${device}', '${connector}', ${pointer}, 'binding-a', '${now}', '${now}')`);
  }
  if (scenario === "occupied-suffix") {
    await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
      VALUES ('occupied', 'owner_local', 'claude-code', 'device', 'local_device', '${key("binding-a#renamed-from:claude_code")}', '${now}', '${now}')`);
    await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at)
      VALUES ('occupied', 'd1', 'claude-code', 'occupied', 'binding-a#renamed-from:claude_code', '${now}', '${now}')`);
  }
}

export async function assertBindingScenario(query: Query, scenario: string): Promise<void> {
  const rows = await query("SELECT * FROM device_source_instances WHERE source_instance_id IN ('src_old', 'src_new') ORDER BY source_instance_id");
  assert.deepEqual(rows.map(row => row.connector_instance_id), ["inst_new", "inst_old"]);
  const oldName = String(rows[1]!.local_binding_id);
  assert.equal(oldName, `binding-a#renamed-from:claude_code${scenario === "occupied-suffix" ? ":2" : ""}`);
  const instances = await query("SELECT * FROM connector_instances ORDER BY connector_instance_id");
  assert.equal(instances.length, scenario === "occupied-suffix" ? 3 : 2);
  assert.equal(instances.find(row => row.connector_instance_id === "inst_old")?.source_binding_key, key(oldName));
  assert.notEqual(key(oldName), key("binding-a"));
  assert.deepEqual((await query("SELECT connector_instance_id FROM records ORDER BY connector_instance_id")).map(row => row.connector_instance_id), ["inst_new", "inst_old"]);
}
