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

import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";

export type CollectionRevisionEvent =
  | "batch_accepted"
  | "batch_rejected"
  | "failure_report"
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

/** Record one observed event in its own transaction. */
export async function recordCollectionRevisionEvent(
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<number | null> {
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(
      async (client) =>
        (await advancePostgresCollectionRevisionInTransaction(client as PostgresHandle, connectorInstanceId, input))
          ?.revision ?? null
    );
  }
  return advanceSqliteCollectionRevisionInTransaction(getDb(), connectorInstanceId, input)?.revision ?? null;
}

/** Batched high-water read, keyed by connector instance. Missing connections are absent from the map. */
export async function readCollectionRevisionHighWaters(
  connectorInstanceIds: readonly string[]
): Promise<Map<string, CollectionRevisionHighWater>> {
  interface Row {
    collection_revision: unknown;
    collection_revision_at: string | null;
    collection_revision_event: string | null;
    collection_revision_run_id: string | null;
    connector_instance_id: string;
  }
  const rows: Row[] = [];
  const ids = [...new Set(connectorInstanceIds)];
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<Row>(
      `SELECT connector_instance_id, collection_revision::text AS collection_revision, collection_revision_event,
              collection_revision_run_id, collection_revision_at
         FROM connector_instances WHERE connector_instance_id = ANY($1::text[])`,
      [ids]
    );
    rows.push(...result.rows);
  } else {
    for (let start = 0; start < ids.length; start += 900) {
      const chunk = ids.slice(start, start + 900);
      rows.push(
        ...(getDb()
          .prepare(
            `SELECT connector_instance_id, collection_revision, collection_revision_event,
                    collection_revision_run_id, collection_revision_at
               FROM connector_instances WHERE connector_instance_id IN (${chunk.map(() => "?").join(", ")})`
          )
          .all(...chunk) as Row[])
      );
    }
  }
  const byId = new Map<string, CollectionRevisionHighWater>();
  for (const row of rows) {
    const revision = readCollectionRevision(row.collection_revision);
    if (revision === null) {
      continue;
    }
    byId.set(row.connector_instance_id, {
      at: row.collection_revision_at ?? null,
      event: row.collection_revision_event ?? null,
      revision,
      runId: row.collection_revision_run_id ?? null,
    });
  }
  return byId;
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
 * Everything the projection needs to decide whether a local coverage proof is
 * current, read in one snapshot. `highWater` is null when the connection has
 * no readable revision. `proofRun` is present only when the newest event is a
 * terminal run.
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

/** Batched fence read for one page of connections, keyed by connector instance. */
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
  const select = (revisionColumn: string, runTerminal: string) =>
    `SELECT ci.connector_instance_id, ${revisionColumn} AS collection_revision, ci.collection_revision_event,
            ci.collection_revision_run_id, ci.collection_revision_at,
            rh.run_id AS proof_run_id, rh.status AS proof_status, rh.scheduler_managed AS proof_scheduler_managed,
            rh.completed_at AS proof_completed_at, rh.facts_json AS proof_facts_json
       FROM connector_instances ci
       LEFT JOIN run_history rh
         ON rh.connector_instance_id = ci.connector_instance_id
        AND rh.run_id = ci.collection_revision_run_id
        AND ci.collection_revision_event = ${runTerminal}`;
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<Row>(
      `${select("ci.collection_revision::text", "$2")}
        WHERE ci.connector_instance_id = ANY($1::text[])`,
      [ids, "terminal_run"]
    );
    rows.push(...result.rows);
  } else {
    for (let start = 0; start < ids.length; start += 900) {
      const chunk = ids.slice(start, start + 900);
      rows.push(
        ...(getDb()
          .prepare(
            `${select("ci.collection_revision", "?")}
              WHERE ci.connector_instance_id IN (${chunk.map(() => "?").join(", ")})`
          )
          .all("terminal_run", ...chunk) as Row[])
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
