// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Per-connection collection revision: a monotonic counter the server assigns,
// at commit, to every event it can observe that can establish or retire a
// local coverage proof. A proof binds to the revision it was committed at and
// is current only while no later event exists. Ordering is by this counter
// alone; the wall-clock `collection_revision_at` is display data.
//
// The high-water mark lives on `connector_instances`. A connection with no row
// gets no revision (`null`), and the reader treats that as unknown.
//
// A caller allocates the revision inside the transaction of the durable event
// it orders (a record write, a batch acceptance, a stored failure report, a
// terminal run), so the event and its revision commit or roll back together.
// A refusal has no other durable effect: its revision is its only write.

import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";

export type CollectionRevisionEvent =
  | "batch_accepted"
  | "batch_record"
  | "batch_rejected"
  | "failure_report"
  | "legacy_terminal"
  | "state_commit"
  | "terminal_run";

export interface CollectionRevisionEventInput {
  readonly at: string;
  readonly event: CollectionRevisionEvent;
  readonly runId?: string | null;
}

/** The newest observed collection event for one connection. */
export interface CollectionRevisionHighWater {
  readonly at: string | null;
  readonly event: string | null;
  readonly revision: number;
  readonly runId: string | null;
}

interface SqliteHandle {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
}

interface PostgresHandle {
  query: (sql: string, params: readonly unknown[]) => Promise<{ readonly rows: readonly unknown[] }>;
}

/**
 * The revision for an observed event could not be recorded, so the event
 * itself must not commit or be acknowledged. Device routes answer it with
 * their retryable 503, so the device retries instead of trusting an answer
 * the server cannot order.
 */
export class CollectionRevisionUnavailableError extends Error {
  readonly code = "collection_revision_unavailable";

  constructor(connectorInstanceId: string, event: CollectionRevisionEvent) {
    super(`collection revision not recorded connector_instance_id=${connectorInstanceId} event=${event}`);
    this.name = "CollectionRevisionUnavailableError";
  }
}

export function isCollectionRevisionUnavailable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "collection_revision_unavailable";
}

const ADVANCE_SET = `collection_revision = collection_revision + 1,
         collection_revision_event = ?,
         collection_revision_run_id = ?,
         collection_revision_at = ?`;

const DECIMAL_DIGITS = /^\d+$/;

/** Parse a stored revision. Anything other than a non-negative safe integer is unreadable. */
export function readCollectionRevision(value: unknown): number | null {
  const revision = typeof value === "string" && DECIMAL_DIGITS.test(value) ? Number(value) : value;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

/**
 * Advance the revision on an open SQLite transaction. Returns the new revision
 * and the connection's manifest generation, or `null` when no connection row
 * exists.
 */
export function advanceSqliteCollectionRevisionInTransaction(
  db: SqliteHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): { readonly manifestGeneration: number; readonly revision: number } | null {
  const row = db
    .prepare(
      `UPDATE connector_instances SET ${ADVANCE_SET}
        WHERE connector_instance_id = ?
        RETURNING collection_revision, manifest_generation`
    )
    .get(input.event, input.runId ?? null, input.at, connectorInstanceId) as
    | { collection_revision: unknown; manifest_generation: unknown }
    | undefined;
  const revision = readCollectionRevision(row?.collection_revision);
  return row && revision !== null ? { manifestGeneration: Number(row.manifest_generation ?? 0), revision } : null;
}

/**
 * Advance the revision on an open Postgres transaction. The UPDATE takes the
 * connection row lock first, so a caller that also needs the manifest
 * generation reads it from here and never upgrades a FOR SHARE lock.
 */
export async function advancePostgresCollectionRevisionInTransaction(
  client: PostgresHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<{
  readonly manifestGeneration: number;
  readonly revision: number;
} | null> {
  const result = await client.query(
    `UPDATE connector_instances
        SET collection_revision = collection_revision + 1,
            collection_revision_event = $1,
            collection_revision_run_id = $2,
            collection_revision_at = $3
      WHERE connector_instance_id = $4
      RETURNING collection_revision::text AS collection_revision, manifest_generation`,
    [input.event, input.runId ?? null, input.at, connectorInstanceId]
  );
  const row = result.rows[0] as { collection_revision: unknown; manifest_generation: unknown } | undefined;
  const revision = readCollectionRevision(row?.collection_revision);
  return row && revision !== null ? { manifestGeneration: Number(row.manifest_generation ?? 0), revision } : null;
}

/** Advance on an open SQLite transaction, or throw so the caller's event rolls back with it. */
export function requireSqliteCollectionRevisionInTransaction(
  db: SqliteHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): number {
  const advanced = advanceSqliteCollectionRevisionInTransaction(db, connectorInstanceId, input);
  if (!advanced) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, input.event);
  }
  return advanced.revision;
}

/** Advance on an open Postgres transaction, or throw so the caller's event rolls back with it. */
export async function requirePostgresCollectionRevisionInTransaction(
  client: PostgresHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<number> {
  const advanced = await advancePostgresCollectionRevisionInTransaction(client, connectorInstanceId, input);
  if (!advanced) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, input.event);
  }
  return advanced.revision;
}

/**
 * Record an observed event that has no other durable effect (a refused
 * batch). Throws when the revision is not recorded; the caller must then not
 * answer the event as if the server had observed it.
 */
export async function recordCollectionRevisionEvent(
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<number> {
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(
      async (client) =>
        await requirePostgresCollectionRevisionInTransaction(client as PostgresHandle, connectorInstanceId, input)
    );
  }
  return requireSqliteCollectionRevisionInTransaction(getDb(), connectorInstanceId, input);
}

/** The terminal run record the high-water mark names, read by run id rather than by completion time. */
export interface LocalCoverageProofRun {
  readonly completedAt: string | null;
  readonly facts: Record<string, unknown> | null;
  readonly runId: string;
  readonly schedulerManaged: boolean;
  readonly status: string;
}

/**
 * Everything the projection needs to decide whether a terminal coverage proof
 * is current. `highWater` is null when the connection has no readable revision.
 * `proofRun` is present only when the newest event is a terminal run.
 */
export interface LocalCoverageRevisionFence {
  readonly highWater: CollectionRevisionHighWater | null;
  readonly proofRun: LocalCoverageProofRun | null;
}

function parseFacts(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * Batched fence read for one page of connections, keyed by connector instance.
 * The proof run is joined only when the high-water event is a terminal run, and
 * only by the run id that event names. A `coverage_diagnostics` state row is not
 * a proof and grants nothing, so its revision is not read.
 */
export async function readLocalCoverageRevisionFences(
  connectorInstanceIds: readonly string[]
): Promise<Map<string, LocalCoverageRevisionFence>> {
  interface Row {
    collection_revision: unknown;
    collection_revision_at: string | null;
    collection_revision_event: string | null;
    collection_revision_run_id: string | null;
    connector_instance_id: string;
    proof_completed_at: string | null;
    proof_facts_json: unknown;
    proof_run_id: string | null;
    proof_scheduler_managed: unknown;
    proof_status: string | null;
  }
  const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
  const rows: Row[] = [];
  if (ids.length === 0) {
    return new Map();
  }
  const select = (revisionColumn: string) =>
    `SELECT ci.connector_instance_id, ${revisionColumn} AS collection_revision, ci.collection_revision_event,
            ci.collection_revision_run_id, ci.collection_revision_at,
            rh.run_id AS proof_run_id, rh.status AS proof_status, rh.scheduler_managed AS proof_scheduler_managed,
            rh.completed_at AS proof_completed_at, rh.facts_json AS proof_facts_json
       FROM connector_instances ci
       LEFT JOIN run_history rh
         ON rh.connector_instance_id = ci.connector_instance_id
        AND rh.run_id = ci.collection_revision_run_id
        AND ci.collection_revision_event = 'terminal_run'`;
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<Row>(
      `${select("ci.collection_revision::text")}
        WHERE ci.connector_instance_id = ANY($1::text[])`,
      [ids]
    );
    rows.push(...result.rows);
  } else {
    for (let start = 0; start < ids.length; start += 900) {
      const chunk = ids.slice(start, start + 900);
      rows.push(
        ...(getDb()
          .prepare(
            `${select("ci.collection_revision")}
              WHERE ci.connector_instance_id IN (${chunk.map(() => "?").join(", ")})`
          )
          .all(...chunk) as Row[])
      );
    }
  }
  const fences = new Map<string, LocalCoverageRevisionFence>();
  for (const row of rows) {
    const revision = readCollectionRevision(row.collection_revision);
    fences.set(row.connector_instance_id, {
      highWater:
        revision === null
          ? null
          : {
              at: row.collection_revision_at ?? null,
              event: row.collection_revision_event ?? null,
              revision,
              runId: row.collection_revision_run_id ?? null,
            },
      proofRun:
        typeof row.proof_run_id === "string" && typeof row.proof_status === "string"
          ? {
              completedAt: row.proof_completed_at ?? null,
              facts: parseFacts(row.proof_facts_json),
              runId: row.proof_run_id,
              schedulerManaged: row.proof_scheduler_managed === true || Number(row.proof_scheduler_managed) === 1,
              status: row.proof_status,
            }
          : null,
    });
  }
  return fences;
}
