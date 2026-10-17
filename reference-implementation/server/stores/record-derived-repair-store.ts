// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Queue writes for `record_derived_repair_pending` (see
 * server/record-derived-repair.ts). Kept apart from the worker so that the
 * manifest publication in auth.ts can queue repairs without importing the
 * records modules.
 */

import { execDynamicSqlAcknowledged } from "../../lib/db.ts";
import type { PostgresTransactionClient } from "../postgres-storage.ts";

export interface RecordDerivedRepairScope {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly stream: string;
}

const MARK_SQL_POSTGRES = `INSERT INTO record_derived_repair_pending(connector_instance_id, connector_id, stream, revision, after_record_key, marked_at)
  VALUES ($1, $2, $3, 1, NULL, $4)
  ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
    connector_id = EXCLUDED.connector_id,
    revision = record_derived_repair_pending.revision + 1,
    after_record_key = NULL,
    marked_at = EXCLUDED.marked_at,
    attempts = 0,
    next_attempt_at = NULL,
    last_error = NULL`;

/** Queue a stream for re-derivation. Call inside the publication transaction. */
export async function markRecordDerivedRepairPendingPostgres(
  client: PostgresTransactionClient,
  scope: RecordDerivedRepairScope,
  nowIso: string
): Promise<void> {
  await client.query(MARK_SQL_POSTGRES, [scope.connectorInstanceId, scope.connectorId, scope.stream, nowIso]);
}

export function markRecordDerivedRepairPendingSqlite(scope: RecordDerivedRepairScope, nowIso: string): void {
  execDynamicSqlAcknowledged(
    `INSERT INTO record_derived_repair_pending(connector_instance_id, connector_id, stream, revision, after_record_key, marked_at)
     VALUES (?, ?, ?, 1, NULL, ?)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
       connector_id = excluded.connector_id,
       revision = record_derived_repair_pending.revision + 1,
       after_record_key = NULL,
       marked_at = excluded.marked_at,
       attempts = 0,
       next_attempt_at = NULL,
       last_error = NULL`,
    [scope.connectorInstanceId, scope.connectorId, scope.stream, nowIso]
  );
}
