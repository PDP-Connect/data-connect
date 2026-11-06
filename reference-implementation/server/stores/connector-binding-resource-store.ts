// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import {
  bindingResourceReference,
  bindingResourceCleanupReceipt,
  type BindingResourceReference,
  type BindingResourceCleanupReceipt,
} from "../../runtime/binding-resource-reference.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "../postgres-storage.ts";
import { canonicalBindingJson } from "./binding-json.ts";

export interface BindingResourceIntent {
  readonly intentId: string;
  readonly reference: BindingResourceReference;
  readonly disposition: "unresolved" | "removed";
}
export class BindingResourceStoreError extends Error {
  readonly code: "conflict" | "invalid" | "storage_error";
  constructor(code: "conflict" | "invalid" | "storage_error") {
    super(`Binding resource store: ${code}`);
    this.code = code;
  }
}
interface Row {
  intent_id: string;
  reference_json: string;
  disposition: "unresolved" | "removed";
}
export function resourceIntent(input: BindingResourceReference): BindingResourceIntent {
  const reference = bindingResourceReference(input);
  return Object.freeze({
    reference,
    intentId: createHash("sha256").update(canonicalBindingJson(reference)).digest("hex"),
    disposition: "unresolved",
  });
}
function decode(row: Row): BindingResourceIntent {
  const intent = resourceIntent(JSON.parse(row.reference_json));
  if (intent.intentId !== row.intent_id || !["removed", "unresolved"].includes(row.disposition))
    throw new BindingResourceStoreError("invalid");
  return Object.freeze({ ...intent, disposition: row.disposition });
}
const SELECT = "SELECT intent_id, reference_json, disposition FROM connector_binding_resources WHERE intent_id = ?";
const INSERT =
  "INSERT INTO connector_binding_resources (intent_id, allocator_id, deployment_id, profile_identity, connection_id, run_id, reference_json, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, 'unresolved')";
export function bindingResourceSql(sql: string): string {
  let i = 0;
  return sql.replaceAll("?", () => `$${++i}`);
}
function values(intent: BindingResourceIntent): string[] {
  const r = intent.reference;
  return [
    intent.intentId,
    r.allocatorId,
    r.deploymentId,
    r.profileIdentity,
    r.connectionId,
    r.runId,
    canonicalBindingJson(r),
  ];
}
function replay(row: Row | undefined, intent: BindingResourceIntent): boolean {
  if (!row) return false;
  const current = decode(row);
  if (
    canonicalBindingJson(current.reference) !== canonicalBindingJson(intent.reference) ||
    current.disposition !== "unresolved"
  )
    throw new BindingResourceStoreError("conflict");
  return true;
}
/** Internal transaction participants. Caller holds connection -> policy -> authority locks.
 * Unique partial index is the cross-connection physical-profile arbiter; there is no owner in that key.
 */
export function insertBindingResourceIntentSqlite(intent: BindingResourceIntent): void {
  const [row] = [...iterateDynamicSqlAcknowledged<Row>(SELECT, [intent.intentId])];
  if (!replay(row, intent)) execDynamicSqlAcknowledged(INSERT, values(intent));
}
export async function insertBindingResourceIntentPostgres(
  client: PoolClient,
  intent: BindingResourceIntent
): Promise<void> {
  const scope = canonicalBindingJson([
    intent.reference.allocatorId,
    intent.reference.deploymentId,
    intent.reference.profileIdentity,
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  const { rows } = await client.query<Row>(bindingResourceSql(SELECT), [intent.intentId]);
  if (!replay(rows[0], intent)) await client.query(bindingResourceSql(INSERT), values(intent));
}
export interface ConnectorBindingResourceStore {
  listUnresolved(): Promise<readonly BindingResourceIntent[]>;
  retire(intentId: string, receipt: BindingResourceCleanupReceipt): Promise<void>;
}
export function createConnectorBindingResourceStore(): ConnectorBindingResourceStore {
  return {
    async listUnresolved() {
      try {
        // Legacy granted browser rows without exact durable proof hold startup; never guess references.
        const legacySql =
          "SELECT payload_json FROM connector_binding_authority_runs a WHERE NOT EXISTS (SELECT 1 FROM connector_binding_resources r WHERE r.connection_id = a.connection_id AND r.run_id = a.run_id)";
        const legacy = isPostgresStorageBackend()
          ? await withPostgresTransaction(
              async (client) => (await client.query<{ payload_json: string }>(legacySql)).rows
            )
          : [...iterateDynamicSqlAcknowledged<{ payload_json: string }>(legacySql, [])];
        for (const row of legacy) {
          const record = JSON.parse(row.payload_json) as { instances: { kind: string; lifecycle: string }[] };
          if (
            !Array.isArray(record.instances) ||
            record.instances.some((item) => item.kind === "browser" && item.lifecycle === "granted")
          )
            throw new BindingResourceStoreError("invalid");
        }
        const sql =
          "SELECT intent_id, reference_json, disposition FROM connector_binding_resources WHERE disposition = 'unresolved' ORDER BY intent_id";
        const rows = isPostgresStorageBackend()
          ? await withPostgresTransaction(async (client) => (await client.query<Row>(sql)).rows)
          : [...iterateDynamicSqlAcknowledged<Row>(sql, [])];
        return Object.freeze(rows.map(decode));
      } catch {
        throw new BindingResourceStoreError("storage_error");
      }
    },
    async retire(intentId, input) {
      try {
        const copied = bindingResourceCleanupReceipt(input, input.reference);
        const expected = resourceIntent(copied.reference);
        if (expected.intentId !== intentId) throw new BindingResourceStoreError("conflict");
        const update =
          "UPDATE connector_binding_resources SET disposition = 'removed' WHERE intent_id = ? AND reference_json = ?";
        const args = [intentId, canonicalBindingJson(copied.reference)];
        const verify = (row: Row | undefined) => {
          if (!row || canonicalBindingJson(decode(row).reference) !== args[1])
            throw new BindingResourceStoreError("conflict");
        };
        if (isPostgresStorageBackend()) {
          await withPostgresTransaction(async (client) => {
            const { rows } = await client.query<Row>(bindingResourceSql(SELECT) + " FOR UPDATE", [intentId]);
            verify(rows[0]);
            await client.query(bindingResourceSql(update), args);
          });
        } else
          writeTransaction(() => {
            verify([...iterateDynamicSqlAcknowledged<Row>(SELECT, [intentId])][0]);
            execDynamicSqlAcknowledged(update, args);
          });
      } catch (error) {
        if (error instanceof BindingResourceStoreError) throw error;
        throw new BindingResourceStoreError("storage_error");
      }
    },
  };
}
