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

export const bindingScenarios = ["cross-device", "null-pointer", "occupied-suffix", "deleted-null-pointer", "owned-binding-json", "orphan", "occupied-instance-suffix", "tombstone-without-source", "deleted-cross-device", "deleted-occupied-instance", "deleted-shared-two-devices", "deleted-occupied-tombstone-suffix", "deleted-current-cross-device"] as const;
export async function seedBindingScenario(query: Query, scenario: string, postgres = false): Promise<void> {
  if (scenario === "deleted-shared-two-devices" || scenario === "deleted-occupied-tombstone-suffix") {
    await seedTombstoneShape(query, "shared", scenario === "deleted-shared-two-devices" ? 2 : 1, scenario === "deleted-occupied-tombstone-suffix", postgres);
    return;
  }
  for (const device of ["d1", "d2"]) {
    await query(`INSERT INTO device_exporters (device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ('${device}', 'owner_local', '${device}', '${now}', '${now}')`);
  }
  for (const [id, connector] of [["old", "claude_code"], ["new", "claude-code"]] as const) {
    await query(`INSERT INTO connectors (connector_id, manifest, created_at) VALUES ('${connector}', '{}', '${now}')`);
    await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
      VALUES ('inst_${id}', 'owner_local', '${connector}', 'device', 'local_device', '${key("binding-a")}', '${now}', '${now}')`);
    await query(`INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at${postgres ? ", primary_key_text" : ""})
      VALUES ('${connector}', 'inst_${id}', 'sessions', 'record', '{}', '${now}'${postgres ? ", 'record'" : ""})`);
    const device = scenario.includes("cross-device") && id === "new" ? "d2" : "d1";
    const pointer = scenario === "null-pointer" && id === "old" ? "NULL" : `'inst_${id}'`;
    await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at)
      VALUES ('src_${id}', '${device}', '${connector}', ${pointer}, 'binding-a', '${now}', '${now}')`);
  }
  await query(`UPDATE connector_instances SET source_binding_json = '{"kind":"local_device","local_binding_name":"binding-a"}'`);
  if (scenario === "orphan") await query("DELETE FROM device_source_instances WHERE source_instance_id = 'src_old'");
  if (["deleted-null-pointer", "tombstone-without-source", "deleted-cross-device", "deleted-occupied-instance"].includes(scenario)) {
    await query("UPDATE device_source_instances SET connector_instance_id = NULL WHERE source_instance_id = 'src_old'");
    await query("DELETE FROM records WHERE connector_instance_id = 'inst_old'");
    await query("DELETE FROM connector_instances WHERE connector_instance_id = 'inst_old'");
    await query(`INSERT INTO connector_instance_tombstones VALUES ('inst_old', 'owner_local', 'claude_code', 'local_device', '${key("binding-a")}', '${now}')`);
  }
  if (scenario === "tombstone-without-source") await query("DELETE FROM device_source_instances WHERE source_instance_id = 'src_old'");
  // The owner deleted the current-spelling duplicate; the old connection lives on.
  if (scenario === "deleted-current-cross-device") {
    await query("UPDATE device_source_instances SET connector_instance_id = NULL WHERE source_instance_id = 'src_new'");
    await query("DELETE FROM records WHERE connector_instance_id = 'inst_new'");
    await query("DELETE FROM connector_instances WHERE connector_instance_id = 'inst_new'");
    await query(`INSERT INTO connector_instance_tombstones VALUES ('inst_new', 'owner_local', 'claude-code', 'local_device', '${key("binding-a")}', '${now}')`);
  }
  if (scenario === "owned-binding-json") {
    await query(`UPDATE connector_instances SET source_binding_json = '{"kind":"local_device","local_binding_name":"binding-a"}'`);
    for (const id of ["old", "new"]) await query(`INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at) VALUES ('${id === "old" ? "claude_code" : "claude-code"}', 'inst_${id}', 'sessions', '{}', '${now}')`);
  }

  if (scenario.includes("occupied")) {
    await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
      VALUES ('occupied', 'owner_local', 'claude-code', 'device', 'local_device', '${key("binding-a#renamed-from:claude_code")}', '${now}', '${now}')`);
    await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at)
      VALUES ('occupied', 'd1', 'claude-code', 'occupied', 'binding-a#renamed-from:claude_code', '${now}', '${now}')`);
    await query(`UPDATE connector_instances SET source_binding_json = '{"kind":"local_device","local_binding_name":"binding-a#renamed-from:claude_code"}' WHERE connector_instance_id = 'occupied'`);
    if (scenario === "occupied-instance-suffix" || scenario === "deleted-occupied-instance") await query("DELETE FROM device_source_instances WHERE source_instance_id = 'occupied'");
  }
}

export async function assertBindingScenario(query: Query, scenario: string): Promise<void> {
  if (scenario === "deleted-shared-two-devices" || scenario === "deleted-occupied-tombstone-suffix") {
    const sources = await query("SELECT * FROM device_source_instances WHERE connector_instance_id IS NULL ORDER BY source_instance_id");
    assert.equal(sources.length, scenario === "deleted-shared-two-devices" ? 2 : 1);
    assert.ok(sources.every(row => row.local_binding_id === `binding-a#renamed-from:claude_code${scenario === "deleted-occupied-tombstone-suffix" ? ":2" : ""}`));
    assert.equal((await query("SELECT * FROM connector_instances")).length, 1);
    const tombstones = await query("SELECT * FROM connector_instance_tombstones");
    assert.ok(sources.every(source => tombstones.some(row => row.source_binding_key === key(String(source.local_binding_id)))));
    return;
  }
  const rows = await query("SELECT * FROM device_source_instances WHERE source_instance_id IN ('src_old', 'src_new') ORDER BY source_instance_id");
  if (scenario === "tombstone-without-source") {
    assert.equal((await query("SELECT * FROM connector_instances")).length, 1);
    assert.equal((await query("SELECT * FROM connector_instance_tombstones"))[0]!.source_binding_key, key("binding-a#renamed-from:claude_code"));
    return;
  }
  if (scenario === "deleted-current-cross-device") {
    assert.deepEqual(rows.map(row => [row.connector_instance_id, row.local_binding_id]), [[null, "binding-a"], ["inst_old", "binding-a#renamed-from:claude_code"]], "deleted source stays unlinked; the live old binding moves aside");
    const instances = await query("SELECT * FROM connector_instances");
    assert.deepEqual(instances.map(row => [row.connector_instance_id, row.source_binding_key]), [["inst_old", key("binding-a#renamed-from:claude_code")]]);
    assert.deepEqual((await query("SELECT * FROM connector_instance_tombstones")).map(row => [row.connector_instance_id, row.connector_id, row.source_binding_key]), [["inst_new", "claude-code", key("binding-a")]]);
    assert.deepEqual((await query("SELECT connector_instance_id FROM records")).map(row => row.connector_instance_id), ["inst_old"]);
    return;
  }
  if (scenario === "orphan") {
    const instance = (await query("SELECT * FROM connector_instances WHERE connector_instance_id = 'inst_old'"))[0]!;
    const binding = typeof instance.source_binding_json === "string" ? JSON.parse(instance.source_binding_json) : instance.source_binding_json as Record<string, unknown>;
    assert.equal(binding.local_binding_name, "binding-a#renamed-from:claude_code");
    assert.equal(instance.source_binding_key, key(binding.local_binding_name));
    return;
  }
  if (scenario === "deleted-null-pointer" || scenario === "deleted-cross-device" || scenario === "deleted-occupied-instance") {
    assert.equal(rows[1]!.connector_instance_id, null, "deleted source stays unlinked");
    const tombstone = (await query("SELECT * FROM connector_instance_tombstones"))[0]!;
    assert.equal(tombstone.source_binding_key, key(String(rows[1]!.local_binding_id)));
    assert.equal((await query("SELECT * FROM connector_instances")).length, scenario === "deleted-occupied-instance" ? 2 : 1);
    return;
  }

  assert.deepEqual(rows.map(row => row.connector_instance_id), ["inst_new", "inst_old"]);
  const oldName = String(rows[1]!.local_binding_id);
  assert.equal(oldName, `binding-a#renamed-from:claude_code${scenario.startsWith("occupied-") ? ":2" : ""}`);
  const instances = await query("SELECT * FROM connector_instances ORDER BY connector_instance_id");
  assert.equal(instances.length, scenario.startsWith("occupied-") ? 3 : 2);
  assert.equal(instances.find(row => row.connector_instance_id === "inst_old")?.source_binding_key, key(oldName));
  assert.notEqual(key(oldName), key("binding-a"));
  assert.deepEqual((await query("SELECT connector_instance_id FROM records ORDER BY connector_instance_id")).map(row => row.connector_instance_id), ["inst_new", "inst_old"]);
}

// A tombstone is owner/binding scoped, not device scoped. Distinct per-device
// tombstones therefore require distinct owners; shared exercises one owner's devices.
// `spelling` picks which connector id the owner deleted; the other spelling stays live.
export async function seedTombstoneShape(query: Query, tombstones: "zero" | "shared" | "per-device", devices: number, occupied: boolean, postgres: boolean, spelling: "old" | "current" = "old") {
  const [gone, deleted, live] = spelling === "old" ? ["old", "claude_code", "claude-code"] : ["new", "claude-code", "claude_code"];
  await seedBindingScenario(query, "null-pointer", postgres);
  await query("UPDATE device_source_instances SET device_id = 'd2' WHERE source_instance_id = 'src_new'");
  if (tombstones !== "zero") {
    await query(`UPDATE device_source_instances SET connector_instance_id = NULL WHERE source_instance_id = 'src_${gone}'`);
    await query(`DELETE FROM records WHERE connector_instance_id = 'inst_${gone}'`);
    await query(`DELETE FROM connector_instances WHERE connector_instance_id = 'inst_${gone}'`);
    await query(`INSERT INTO connector_instance_tombstones VALUES ('deleted_${gone}', 'owner_local', '${deleted}', 'local_device', '${key("binding-a")}', '${now}')`);
  }
  if (devices === 2) {
    const owner = tombstones === "shared" ? "owner_local" : "owner_second";
    await query(`INSERT INTO device_exporters (device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ('d3', '${owner}', 'd3', '${now}', '${now}')`);
    await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at) VALUES ('src_second', 'd3', '${deleted}', NULL, 'binding-a', '${now}', '${now}')`);
    if (tombstones === "per-device") {
      await query(`INSERT INTO connector_instance_tombstones VALUES ('deleted_second', '${owner}', '${deleted}', 'local_device', '${key("binding-a")}', '${now}')`);
    }
    if (tombstones !== "shared") {
      await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, source_binding_json, created_at, updated_at) VALUES ('inst_second', '${owner}', '${live}', 'device', 'local_device', '${key("binding-a")}', '{"kind":"local_device","local_binding_name":"binding-a"}', '${now}', '${now}')`);
      if (tombstones === "zero") await query(`INSERT INTO connector_instances (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, source_binding_json, created_at, updated_at) VALUES ('inst_second_${gone}', '${owner}', '${deleted}', 'device', 'local_device', '${key("binding-a")}', '{"kind":"local_device","local_binding_name":"binding-a"}', '${now}', '${now}')`);
      // Nothing was deleted: a NULL pointer only recovers under the retired spelling.
      if (tombstones === "zero" && spelling === "current") await query("UPDATE device_source_instances SET connector_instance_id = 'inst_second_new' WHERE source_instance_id = 'src_second'");
    }
  }
  if (occupied) await query(`INSERT INTO connector_instance_tombstones VALUES ('occupied_tombstone', 'owner_local', '${deleted}', 'local_device', '${key("binding-a#renamed-from:claude_code")}', '${now}')`);
}

// Rows from before connection ids exist only under local-device:<connector>:<source>;
// the boot sweep recovers them into the instance they name. codex is the unrenamed control.
export const legacyConnectors = ["claude_code", "codex"] as const;
const legacyId = (connector: string) => `local-device:${connector}:src_old`;
export async function seedLegacyLocalDevice(query: Query, connector: string, postgres: boolean): Promise<void> {
  await query(`INSERT INTO device_exporters (device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ('d1', 'owner_local', 'd1', '${now}', '${now}')`);
  for (const id of [connector, legacyId(connector)]) await query(`INSERT INTO connectors (connector_id, manifest, created_at) VALUES ('${id}', '{}', '${now}')`);
  await query(`INSERT INTO device_source_instances (source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, created_at, updated_at) VALUES ('src_old', 'd1', '${connector}', NULL, 'binding-a', '${now}', '${now}')`);
  await query(`INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at${postgres ? ", primary_key_text" : ""})
    VALUES ('${legacyId(connector)}', 'legacy_inst', 'sessions', 'record', '{}', '${now}'${postgres ? ", 'record'" : ""})`);
}
export async function assertLegacyLocalDevice(query: Query, connector: string): Promise<void> {
  const current = connector === "claude_code" ? "claude-code" : connector;
  assert.deepEqual((await query("SELECT connector_id, connector_instance_id FROM device_source_instances")).map(row => ({ ...row })), [{ connector_id: current, connector_instance_id: "legacy_inst" }], "source recovers its legacy instance");
  assert.deepEqual((await query("SELECT connector_id, connector_instance_id FROM records")).map(row => ({ ...row })), [{ connector_id: current, connector_instance_id: "legacy_inst" }], "legacy record joins that instance");
  assert.deepEqual((await query("SELECT connector_instance_id, connector_id FROM connector_instances")).map(row => ({ ...row })), [{ connector_instance_id: "legacy_inst", connector_id: current }]);
}

export const observationScenarios = ["observation-replay", "observation-conflict"] as const;
export async function seedObservationScenario(query: Query, scenario: string): Promise<void> {
  await seedCollision(query, "connector_observation_runs");
  await query("UPDATE connector_observation_runs SET connector_instance_id = 'inst_old', run_id = 'same-run'");
  if (scenario === "observation-conflict") await query("UPDATE connector_observation_runs SET payload_json = '{\"different\":true}' WHERE connector_id = 'claude_code'");
}
export async function assertObservationScenario(query: Query, scenario: string): Promise<void> {
  const rows = await query("SELECT * FROM connector_observation_runs ORDER BY connector_id");
  assert.equal(rows.length, scenario === "observation-replay" ? 1 : 2);
  if (scenario === "observation-conflict") {
    assert.equal(rows[1]!.connector_id, "claude_code");
    assert.equal(rows[1]!.run_id, "same-run");
    assert.equal(rows[1]!.payload_json, '{"different":true}');
  }
}
