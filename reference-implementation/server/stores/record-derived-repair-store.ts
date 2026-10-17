// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Queue writes for `record_derived_repair_pending` (see
 * server/record-derived-repair.ts). Kept apart from the worker so that the
 * manifest publication in auth.ts can queue repairs without importing the
 * records modules.
 */

import { randomUUID } from "node:crypto";
import { execDynamicSqlAcknowledged } from "../../lib/db.ts";
import type { PostgresTransactionClient } from "../postgres-storage.ts";

export interface RecordDerivedRepairScope {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly stream: string;
}

// Every queue write starts a new job with a fresh job_id, even when it
// replaces a row: a row that was deleted and queued again must not look like
// the job an older round still holds.
const MARK_SQL_POSTGRES = `INSERT INTO record_derived_repair_pending(connector_instance_id, connector_id, stream, job_id, after_record_key, marked_at)
  VALUES ($1, $2, $3, $5, NULL, $4)
  ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
    connector_id = EXCLUDED.connector_id,
    job_id = EXCLUDED.job_id,
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
  await client.query(MARK_SQL_POSTGRES, [
    scope.connectorInstanceId,
    scope.connectorId,
    scope.stream,
    nowIso,
    randomUUID(),
  ]);
}

export function markRecordDerivedRepairPendingSqlite(scope: RecordDerivedRepairScope, nowIso: string): void {
  execDynamicSqlAcknowledged(
    `INSERT INTO record_derived_repair_pending(connector_instance_id, connector_id, stream, job_id, after_record_key, marked_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
       connector_id = excluded.connector_id,
       job_id = excluded.job_id,
       after_record_key = NULL,
       marked_at = excluded.marked_at,
       attempts = 0,
       next_attempt_at = NULL,
       last_error = NULL`,
    [scope.connectorInstanceId, scope.connectorId, scope.stream, randomUUID(), nowIso]
  );
}
