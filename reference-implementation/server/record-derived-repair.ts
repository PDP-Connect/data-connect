// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable re-derivation of manifest-derived record columns.
 *
 * A manifest publication can change how `cursor_value`, `primary_key_text`
 * and `semantic_time` derive from `record_json`. Re-deriving them walks every
 * record of the connector, so the publication only queues the work: one
 * `record_derived_repair_pending` row per (connection, stream), in the same
 * transaction as the manifest. A round then works through the queue in
 * bounded chunks. On Postgres each chunk advances the row's
 * `after_record_key` in the chunk's own transaction, so a crash, timeout or
 * deadline resumes after the last committed chunk. The row is deleted when
 * the stream is done. The post-install repair runs a round for its connector;
 * the maintenance sweep runs bounded rounds for whatever is left.
 */

import { withConnectorInstanceWrite } from "./connector-instance-write-coordinator.ts";
import { getDb } from "./db.ts";
import { postgresRepairRecordDerivedColumnsPage, recordDerivedColumnsStream } from "./postgres-records.ts";
import { type BulkChunkBudget, isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { backfillSqliteRecordSemanticTimesForManifest } from "./records.ts";

import type { RecordDerivedRepairScope } from "./stores/record-derived-repair-store.ts";

interface PendingRepair extends RecordDerivedRepairScope {
  readonly afterRecordKey: string | null;
  readonly attempts: number;
  readonly revision: number;
}

export interface RecordDerivedRepairRoundResult {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
  /** Work remained when the round stopped (deadline, contention, or another runner). */
  readonly incomplete: boolean;
}

const MAX_BACKOFF_MS = 60 * 60 * 1000;

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(attempts, 16));
}

type RepairHook = (point: "after-page", scope: RecordDerivedRepairScope) => Promise<void> | void;
let repairHookForTest: RepairHook | null = null;

export function __setRecordDerivedRepairHookForTest(hook: RepairHook | null): void {
  repairHookForTest = hook;
}

interface PendingRow {
  after_record_key: string | null;
  attempts: number | string;
  connector_id: string;
  connector_instance_id: string;
  revision: number | string;
  stream: string;
}

function toPending(row: PendingRow): PendingRepair {
  return {
    afterRecordKey: row.after_record_key,
    attempts: Number(row.attempts),
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    revision: Number(row.revision),
    stream: row.stream,
  };
}

const LIST_SQL = `SELECT connector_instance_id, connector_id, stream, revision, after_record_key, attempts
  FROM record_derived_repair_pending
  WHERE (next_attempt_at IS NULL OR next_attempt_at <= $1)
    AND ($2::text IS NULL OR connector_id = $2)
  ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
  LIMIT $3`;

/** Pending repairs that are not serving a failure backoff, oldest first. */
export async function listPendingRecordDerivedRepairs(
  filter: { readonly connectorId?: string; readonly limit?: number; readonly nowIso?: string } = {}
): Promise<PendingRepair[]> {
  const nowIso = filter.nowIso ?? new Date().toISOString();
  const limit = filter.limit ?? 1000;
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<PendingRow>(LIST_SQL, [nowIso, filter.connectorId ?? null, limit]);
    return result.rows.map(toPending);
  }
  const rows = getDb()
    .prepare(
      `SELECT connector_instance_id, connector_id, stream, revision, after_record_key, attempts
         FROM record_derived_repair_pending
        WHERE (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (? IS NULL OR connector_id = ?)
        ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
        LIMIT ?`
    )
    .all<PendingRow>(nowIso, filter.connectorId ?? null, filter.connectorId ?? null, limit);
  return rows.map(toPending);
}

async function registeredManifest(connectorId: string): Promise<Record<string, unknown> | null> {
  if (isPostgresStorageBackend()) {
    const row = (
      await postgresQuery<{ manifest: unknown }>("SELECT manifest FROM connectors WHERE connector_id = $1", [
        connectorId,
      ])
    ).rows[0];
    if (!row) return null;
    return (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest) as Record<string, unknown>;
  }
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id = ?")
    .get<{ manifest: string }>(connectorId);
  return row ? (JSON.parse(row.manifest) as Record<string, unknown>) : null;
}

function manifestStream(manifest: Record<string, unknown>, stream: string): Record<string, unknown> | null {
  const streams = Array.isArray(manifest.streams) ? (manifest.streams as Record<string, unknown>[]) : [];
  return streams.find((candidate) => candidate?.name === stream) ?? null;
}

class RepairRecontendedError extends Error {}

async function completeRepair(repair: PendingRepair): Promise<boolean> {
  const params = [repair.connectorInstanceId, repair.stream, repair.revision];
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      "DELETE FROM record_derived_repair_pending WHERE connector_instance_id = $1 AND stream = $2 AND revision = $3",
      params
    );
    return (result.rowCount ?? 0) > 0;
  }
  return (
    getDb()
      .prepare(
        "DELETE FROM record_derived_repair_pending WHERE connector_instance_id = ? AND stream = ? AND revision = ?"
      )
      .run(...params).changes > 0
  );
}

async function recordFailure(repair: PendingRepair, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const nextAttemptAt = new Date(Date.now() + backoffMs(repair.attempts)).toISOString();
  const params = [repair.connectorInstanceId, repair.stream, repair.revision, message, nextAttemptAt];
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE record_derived_repair_pending SET attempts = attempts + 1, last_error = $4, next_attempt_at = $5
        WHERE connector_instance_id = $1 AND stream = $2 AND revision = $3`,
      params
    );
    return;
  }
  getDb()
    .prepare(
      `UPDATE record_derived_repair_pending SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
        WHERE connector_instance_id = ? AND stream = ? AND revision = ?`
    )
    .run(message, nextAttemptAt, repair.connectorInstanceId, repair.stream, repair.revision);
}

type RepairOutcome = "completed" | "incomplete" | "recontended";

async function repairPostgresStream(repair: PendingRepair, deadline: number): Promise<RepairOutcome> {
  const manifest = await registeredManifest(repair.connectorId);
  if (!manifest) {
    throw new Error("registered connector manifest is missing; record column repair retained");
  }
  const streamDefinition = manifestStream(manifest, repair.stream);
  if (!streamDefinition) {
    // The stream left the manifest: there is nothing to derive against.
    return (await completeRepair(repair)) ? "completed" : "recontended";
  }
  const budget: BulkChunkBudget = { chunkSize: 256 };
  let afterRecordKey = repair.afterRecordKey;
  for (;;) {
    if (Date.now() >= deadline) {
      return "incomplete";
    }
    const page = await withConnectorInstanceWrite(repair.connectorInstanceId, () =>
      postgresRepairRecordDerivedColumnsPage({
        afterRecordKey,
        budget,
        connectorId: repair.connectorId,
        connectorInstanceId: repair.connectorInstanceId,
        manifest: { ...manifest, streams: [streamDefinition] },
        manifestStream: recordDerivedColumnsStream(streamDefinition),
        stream: repair.stream,
        withinChunk: async (client, lastRecordKey) => {
          const advanced = await client.query(
            `UPDATE record_derived_repair_pending SET after_record_key = $3
              WHERE connector_instance_id = $1 AND stream = $2 AND revision = $4`,
            [repair.connectorInstanceId, repair.stream, lastRecordKey, repair.revision]
          );
          if (!advanced.rowCount) {
            // A newer publication re-queued this stream from the start.
            throw new RepairRecontendedError();
          }
        },
      })
    );
    await repairHookForTest?.("after-page", repair);
    if (page.done) {
      return (await completeRepair(repair)) ? "completed" : "recontended";
    }
    afterRecordKey = page.lastRecordKey;
  }
}

async function repairSqliteConnector(repairs: readonly PendingRepair[]): Promise<RepairOutcome> {
  const connectorId = repairs[0]?.connectorId;
  if (!connectorId) return "completed";
  const manifest = await registeredManifest(connectorId);
  if (!manifest) {
    throw new Error("registered connector manifest is missing; record column repair retained");
  }
  // SQLite is single-process and repairs a connector in one pass; the queue
  // rows make that pass durable, not resumable mid-stream.
  await backfillSqliteRecordSemanticTimesForManifest(
    manifest as unknown as Parameters<typeof backfillSqliteRecordSemanticTimesForManifest>[0]
  );
  let recontended = false;
  for (const repair of repairs) {
    if (!(await completeRepair(repair))) recontended = true;
  }
  return recontended ? "recontended" : "completed";
}

const repairsInFlight = new Set<string>();

/**
 * Work through pending column repairs, oldest first, until done or until
 * `maxDurationMs` passes (checked between pages). A failure is recorded on
 * its row with a backoff; the row stays queued.
 */
export async function runRecordDerivedRepairRound(
  options: { readonly connectorId?: string; readonly maxDurationMs?: number; readonly nowIso?: string } = {}
): Promise<RecordDerivedRepairRoundResult> {
  const deadline = Date.now() + (options.maxDurationMs ?? Number.POSITIVE_INFINITY);
  const pending = await listPendingRecordDerivedRepairs(options);
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let incomplete = false;
  // Postgres resumes per stream; SQLite repairs a connector in one pass.
  const groups: PendingRepair[][] = [];
  for (const repair of pending) {
    const group = isPostgresStorageBackend()
      ? undefined
      : groups.find((candidate) => candidate[0]?.connectorId === repair.connectorId);
    if (group) group.push(repair);
    else groups.push([repair]);
  }
  for (const group of groups) {
    const keys = group.map((repair) => `${repair.connectorInstanceId}\u0000${repair.stream}`);
    if (Date.now() >= deadline || keys.some((key) => repairsInFlight.has(key))) {
      incomplete = true;
      continue;
    }
    for (const key of keys) repairsInFlight.add(key);
    attempted += group.length;
    try {
      const outcome = isPostgresStorageBackend()
        ? await repairPostgresStream(group[0] as PendingRepair, deadline)
        : await repairSqliteConnector(group);
      if (outcome === "completed") completed += group.length;
      else incomplete = true;
    } catch (error) {
      if (error instanceof RepairRecontendedError) {
        incomplete = true;
      } else {
        failed += group.length;
        for (const repair of group) {
          await recordFailure(repair, error).catch(() => undefined);
        }
      }
    } finally {
      for (const key of keys) repairsInFlight.delete(key);
    }
  }
  return { attempted, completed, failed, incomplete };
}
