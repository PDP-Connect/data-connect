// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mountRefDeviceExporterEnroll } from "../../server/routes/ref-device-exporters.ts";
import { createSqliteDeviceExporterStore, createPostgresDeviceExporterStore } from "../../server/stores/device-exporter-store.ts";
import { createSqliteConnectorInstanceStore, createPostgresConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts";
import { createSqliteConnectorStateStore, createPostgresConnectorStateStore } from "../../server/stores/connector-state-store.ts";
import { key, type Query } from "./rename-collision-fixtures.ts";

// Real consume handler and backend stores; only host catalog/protocol services
// and HTTP response shaping are supplied by the fixture.
export async function consumePendingCode(query: Query, shape: { connector: string; codeBinding: string }, postgres: boolean) {
  const before = await query("SELECT connector_instance_id FROM connector_instances ORDER BY 1");
  const deleted = shape.connector === "claude_code" && shape.codeBinding.startsWith("deleted");
  const fresh = shape.codeBinding === "suffix" || (shape.connector === "claude-code" && shape.codeBinding === "distinct-old") || (shape.connector === "claude_code" && shape.codeBinding === "distinct-current");
  const code = (await query("SELECT * FROM device_enrollment_codes WHERE enrollment_code_id = 'pending-code'"))[0]!;
  const bindingKey = key(String(code.local_binding_id));
  if (deleted) {
    assert.equal((await query("SELECT source_binding_key FROM connector_instance_tombstones WHERE connector_instance_id = 'inst_old'"))[0]?.source_binding_key, bindingKey, "code follows deleted binding");
  } else if (!fresh) {
    const target = shape.connector === "claude_code" ? "inst_old" : "inst_new";
    assert.equal((await query(`SELECT source_binding_key FROM connector_instances WHERE connector_instance_id = '${target}'`))[0]?.source_binding_key, bindingKey, "code follows original connection binding");
  } else {
    assert.ok(!(await query("SELECT source_binding_key FROM connector_instances")).some(row => row.source_binding_key === bindingKey), "pending code reserves its unclaimed binding");
  }
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw new Error("handler missing"); };
  const app = { post: (_path: string, _opts: unknown, fn: typeof handler) => { handler = fn; } };
  const res = {
    statusCode: 200, body: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
    setHeader() {},
  };
  const store = postgres ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
  const stateStore = postgres ? createPostgresConnectorStateStore() : createSqliteConnectorStateStore();
  mountRefDeviceExporterEnroll(app as never, {
    canonicalConnectorKey: (id: string) => id,
    deviceExporterStore: postgres ? createPostgresDeviceExporterStore() : createSqliteDeviceExporterStore(),
    createRequestConnectorInstanceStore: () => store,
    putSyncState: async (target: { connector_id: string; connector_instance_id: string }, state: Record<string, unknown>) => {
      const scope = { connectorId: target.connector_id, connectorInstanceId: target.connector_instance_id, grantId: null };
      await stateStore.putState(scope, state);
      return stateStore.getState(scope);
    },
    enforceCollectorProtocolVersion: () => false,
    readCollectorProtocolHeader: () => "1",
    readReferenceLocalConnectorCatalogManifestResult: () => ({ kind: "not_local" }),
    getConnectorManifest: () => ({ runtime_requirements: { bindings: { filesystem: {} } } }),
    ensureReferenceConnectorCatalogEntry: async () => {},
    generateSpineId: (prefix: string) => `${prefix}_${randomUUID()}`,
    generateReferenceSecret: () => randomUUID(),
    hashDeviceSecret: (value: string) => value,
    makeConnectorInstanceSourceBindingKey: ({ local_binding_name }: { local_binding_name: string }) => key(local_binding_name),
    handleError: (_res: unknown, error: Error & { code?: string }) => res.status(409).json({ error: error.code ?? error.message }),
    pdppError: (_res: unknown, code: number) => res.status(code).json({ error: "rejected" }),
    emitSpineEvent: async () => {},
  } as never);
  await handler({ body: { enrollment_code: "fixture-code" }, headers: {} }, res);
  if (deleted) {
    assert.equal(res.body.error, "connection_tombstoned", "deleted binding rejects pending code at the tombstone guard");
    assert.deepEqual(await query("SELECT connector_instance_id FROM connector_instances ORDER BY 1"), before, "code cannot revive tombstoned binding");
    assert.equal((await query("SELECT status FROM device_enrollment_codes WHERE enrollment_code_id = 'pending-code'"))[0]?.status, "pending");
  } else {
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    if (!fresh) {
      assert.equal(res.body.connector_instance_id, shape.connector === "claude_code" ? "inst_old" : "inst_new", "pre-upgrade code enrolls into its original connection");
      assert.deepEqual(await query("SELECT connector_instance_id FROM connector_instances ORDER BY 1"), before, "code does not mint a replacement connection");
    } else {
      assert.ok(!before.some(row => row.connector_instance_id === res.body.connector_instance_id), "unclaimed code binding stays distinct from migrated connections");
    }
    assert.equal((await query("SELECT status FROM device_enrollment_codes WHERE enrollment_code_id = 'pending-code'"))[0]?.status, "consumed");
    assert.equal((await query(`SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id = '${res.body.source_instance_id}'`))[0]?.connector_instance_id, res.body.connector_instance_id);
  }
}
