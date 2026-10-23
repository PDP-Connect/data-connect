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
//
// The revision orders observations; it does not decide which proof is
// eligible. Run order does: the server issues each run a sequence at its start
// (`issueCollectionRunSequence`), and every observation also moves a run-order
// marker when its run sequence is at least the highest one observed. An
// observation that names no issued run is attributed to the newest issued
// sequence with no run id, so it can retire a proof but never establish one.
// A proof is eligible only while it is that marker, in the current storage
// epoch. See docs/261021-local-device-coverage-evidence.md, "Run order and
// commit order".

import { writeTransaction } from "../../lib/db.ts";
import { getDb } from "../db.ts";
import { COLLECTION_SCOPE_STATE_KEY, readStoredCollectionScope } from "../local-collection-scope.ts";
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
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown; run: (...params: unknown[]) => unknown };
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

// The schema does not keep the stored revision readable: both backends accept
// a negative value, and SQLite's INTEGER affinity also keeps text or a real.
// The advance therefore matches only a stored non-negative integer whose
// successor is still a safe integer. Any other stored value matches no row, so
// the event fails closed instead of incrementing a value it cannot order by
// (SQLite would turn 'abc' + 1 into 1, and -1 + 1 into 0).
const MAX_ADVANCEABLE_REVISION = Number.MAX_SAFE_INTEGER - 1;
const SQLITE_ADVANCEABLE = `typeof(collection_revision) = 'integer'
        AND collection_revision BETWEEN 0 AND ${MAX_ADVANCEABLE_REVISION}`;
const POSTGRES_ADVANCEABLE = `collection_revision BETWEEN 0 AND ${MAX_ADVANCEABLE_REVISION}`;

/** Parse a stored revision. Anything other than a non-negative safe integer is unreadable. */
export function readCollectionRevision(value: unknown): number | null {
  const revision = typeof value === "string" && DECIMAL_DIGITS.test(value) ? Number(value) : value;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

interface AdvancedRevision {
  readonly manifestGeneration: number;
  readonly revision: number;
  /** The issued sequence of the run the observation names, or null when it names no run issued in this epoch. */
  readonly runSequence: number | null;
  readonly storageEpoch: number;
}

// Move the run-order marker for an observation that has just taken `revision`.
// The observation's run sequence is its own run's issued sequence in the
// current storage epoch, else the newest issued sequence (with no run id). The
// marker moves when that sequence is at least the highest observed one. An
// explicit run id with no issued sequence is marked `unsequenced_attempt` and
// stays ineligible at that sequence, even if a run was already pending there.
// The caller's revision UPDATE already holds the connection row lock.
const RUN_ORDER_OBSERVATION = `SELECT COALESCE(rs.run_sequence, ci.run_sequence_issued) AS seq,
                rs.run_id AS run_id, rs.run_sequence AS run_sequence, ci.storage_epoch AS storage_epoch
           FROM connector_instances ci
           LEFT JOIN collection_run_sequences rs
             ON rs.connector_instance_id = ci.connector_instance_id
            AND rs.run_id = $RUN
            AND rs.storage_epoch = ci.storage_epoch
          WHERE ci.connector_instance_id = $CI`;

function readEpoch(value: unknown): number {
  const epoch = readCollectionRevision(value);
  // An unreadable epoch can never equal a proof's epoch, so the proof fails closed.
  return epoch ?? -1;
}

function readRunSequence(value: unknown): number | null {
  return value === null || value === undefined ? null : readCollectionRevision(value);
}

/**
 * Read the result of a guarded advance. No returned row means either no
 * connection row exists (`null`) or its stored revision is not advanceable,
 * which throws: an event must not commit against a revision the server cannot
 * order by.
 */
function advancedRevision(
  row: { collection_revision: unknown; manifest_generation: unknown } | undefined,
  connectionExists: () => boolean,
  connectorInstanceId: string,
  event: CollectionRevisionEvent
): Pick<AdvancedRevision, "manifestGeneration" | "revision"> | null {
  if (!row) {
    if (connectionExists()) {
      throw new CollectionRevisionUnavailableError(connectorInstanceId, event);
    }
    return null;
  }
  const revision = readCollectionRevision(row.collection_revision);
  if (revision === null) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, event);
  }
  return { manifestGeneration: Number(row.manifest_generation ?? 0), revision };
}

interface RunOrderObservationRow {
  run_id: string | null;
  run_sequence: unknown;
  seq: unknown;
  storage_epoch: unknown;
}

/** The marker values for an observation, or throws when its run sequence cannot be read. */
function runOrderObservation(
  row: RunOrderObservationRow | undefined,
  connectorInstanceId: string,
  event: CollectionRevisionEvent
): {
  readonly runId: string | null;
  readonly runSequence: number | null;
  readonly seq: number;
  readonly storageEpoch: number;
} {
  const seq = readCollectionRevision(row?.seq);
  if (!row || seq === null) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, event);
  }
  return {
    runId: typeof row.run_id === "string" ? row.run_id : null,
    runSequence: readRunSequence(row.run_sequence),
    seq,
    storageEpoch: readEpoch(row.storage_epoch),
  };
}

/**
 * Advance the revision on an open SQLite transaction. Returns the new revision
 * and the connection's manifest generation, or `null` when no connection row
 * exists. Throws when the stored revision is not advanceable.
 */
export function advanceSqliteCollectionRevisionInTransaction(
  db: SqliteHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): AdvancedRevision | null {
  const row = db
    .prepare(
      `UPDATE connector_instances SET ${ADVANCE_SET}
        WHERE connector_instance_id = ?
          AND ${SQLITE_ADVANCEABLE}
        RETURNING collection_revision, manifest_generation`
    )
    .get(input.event, input.runId ?? null, input.at, connectorInstanceId) as
    | { collection_revision: unknown; manifest_generation: unknown }
    | undefined;
  const advanced = advancedRevision(
    row,
    () =>
      db
        .prepare("SELECT 1 AS present FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectorInstanceId) !== undefined,
    connectorInstanceId,
    input.event
  );
  if (!advanced) {
    return null;
  }
  const observation = runOrderObservation(
    db
      .prepare(RUN_ORDER_OBSERVATION.replace("$RUN", "?").replace("$CI", "?"))
      .get(input.runId ?? null, connectorInstanceId) as RunOrderObservationRow | undefined,
    connectorInstanceId,
    input.event
  );
  const runOrderEvent =
    input.runId !== null && input.runId !== undefined && observation.runSequence === null
      ? "unsequenced_attempt"
      : input.event;
  db.prepare(
    `UPDATE connector_instances
        SET run_order_sequence = ?, run_order_event = ?, run_order_run_id = ?, run_order_revision = ?
      WHERE connector_instance_id = ? AND run_order_sequence <= ?
        AND NOT (run_order_sequence = ? AND run_order_event = 'unsequenced_attempt' AND ? IS NOT NULL)`
  ).run(
    observation.seq,
    runOrderEvent,
    observation.runId,
    advanced.revision,
    connectorInstanceId,
    observation.seq,
    observation.seq,
    observation.runSequence
  );
  return { ...advanced, runSequence: observation.runSequence, storageEpoch: observation.storageEpoch };
}

/**
 * Advance the revision on an open Postgres transaction. Returns `null` when no
 * connection row exists, and throws when the stored revision is not
 * advanceable. The UPDATE takes the connection row lock first, so a caller
 * that also needs the manifest generation reads it from here and never
 * upgrades a FOR SHARE lock.
 */
export async function advancePostgresCollectionRevisionInTransaction(
  client: PostgresHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<AdvancedRevision | null> {
  const result = await client.query(
    `UPDATE connector_instances
        SET collection_revision = collection_revision + 1,
            collection_revision_event = $1,
            collection_revision_run_id = $2,
            collection_revision_at = $3
      WHERE connector_instance_id = $4
        AND ${POSTGRES_ADVANCEABLE}
      RETURNING collection_revision::text AS collection_revision, manifest_generation`,
    [input.event, input.runId ?? null, input.at, connectorInstanceId]
  );
  const row = result.rows[0] as { collection_revision: unknown; manifest_generation: unknown } | undefined;
  const exists = row
    ? true
    : (
        await client.query("SELECT 1 AS present FROM connector_instances WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ])
      ).rows.length > 0;
  const advanced = advancedRevision(row, () => exists, connectorInstanceId, input.event);
  if (!advanced) {
    return null;
  }
  const observed = await client.query(RUN_ORDER_OBSERVATION.replace("$RUN", "$1").replace("$CI", "$2"), [
    input.runId ?? null,
    connectorInstanceId,
  ]);
  const observation = runOrderObservation(
    observed.rows[0] as RunOrderObservationRow | undefined,
    connectorInstanceId,
    input.event
  );
  const runOrderEvent =
    input.runId !== null && input.runId !== undefined && observation.runSequence === null
      ? "unsequenced_attempt"
      : input.event;
  await client.query(
    `UPDATE connector_instances
        SET run_order_sequence = $1, run_order_event = $2, run_order_run_id = $3, run_order_revision = $4
      WHERE connector_instance_id = $5 AND run_order_sequence <= $1
        AND NOT (run_order_sequence = $1 AND run_order_event = 'unsequenced_attempt' AND $6 IS NOT NULL)`,
    [observation.seq, runOrderEvent, observation.runId, advanced.revision, connectorInstanceId, observation.runSequence]
  );
  return { ...advanced, runSequence: observation.runSequence, storageEpoch: observation.storageEpoch };
}

/** Advance on an open SQLite transaction, or throw (also when no connection row exists) so the caller's event rolls back with it. */
export function requireSqliteCollectionObservationInTransaction(
  db: SqliteHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): AdvancedRevision {
  const advanced = advanceSqliteCollectionRevisionInTransaction(db, connectorInstanceId, input);
  if (!advanced) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, input.event);
  }
  return advanced;
}

/** `requireSqliteCollectionObservationInTransaction`, returning only the revision. */
export function requireSqliteCollectionRevisionInTransaction(
  db: SqliteHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): number {
  return requireSqliteCollectionObservationInTransaction(db, connectorInstanceId, input).revision;
}

/** Advance on an open Postgres transaction, or throw (also when no connection row exists) so the caller's event rolls back with it. */
export async function requirePostgresCollectionObservationInTransaction(
  client: PostgresHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<AdvancedRevision> {
  const advanced = await advancePostgresCollectionRevisionInTransaction(client, connectorInstanceId, input);
  if (!advanced) {
    throw new CollectionRevisionUnavailableError(connectorInstanceId, input.event);
  }
  return advanced;
}

/** `requirePostgresCollectionObservationInTransaction`, returning only the revision. */
export async function requirePostgresCollectionRevisionInTransaction(
  client: PostgresHandle,
  connectorInstanceId: string,
  input: CollectionRevisionEventInput
): Promise<number> {
  return (await requirePostgresCollectionObservationInTransaction(client, connectorInstanceId, input)).revision;
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
  // The revision and the run-order marker commit together.
  return writeTransaction(() => requireSqliteCollectionRevisionInTransaction(getDb(), connectorInstanceId, input));
}

/** The sequence the server issued to one run at its start. */
export interface IssuedRunSequence {
  readonly connectorInstanceId: string;
  readonly runId: string;
  readonly runSequence: number;
  readonly storageEpoch: number;
}

/** The run id is already registered to a different device or source. Nothing was written. */
export class RunStartConflictError extends Error {
  readonly code = "run_start_conflict";

  constructor() {
    super("Run id is already registered to a different device or source.");
    this.name = "RunStartConflictError";
  }
}

interface IssuedRow {
  device_id: string;
  run_sequence: unknown;
  source_instance_id: string;
  storage_epoch: unknown;
}

function issuedFromRow(
  input: {
    readonly connectorInstanceId: string;
    readonly deviceId: string;
    readonly runId: string;
    readonly sourceInstanceId: string;
  },
  row: IssuedRow
): IssuedRunSequence {
  const runSequence = readCollectionRevision(row.run_sequence);
  const storageEpoch = readCollectionRevision(row.storage_epoch);
  if (row.device_id !== input.deviceId || row.source_instance_id !== input.sourceInstanceId) {
    throw new RunStartConflictError();
  }
  if (runSequence === null || storageEpoch === null) {
    throw new Error(`collection run sequence unreadable connector_instance_id=${input.connectorInstanceId}`);
  }
  return { connectorInstanceId: input.connectorInstanceId, runId: input.runId, runSequence, storageEpoch };
}

/**
 * Issue the next run sequence for a connection at run start, or return the
 * one already issued to this run. The connection row lock serializes issuance,
 * so runs from several devices get distinct sequences in start order. A run id
 * registered to a different device or source is a conflict.
 */
export async function issueCollectionRunSequence(input: {
  readonly connectorInstanceId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly sourceInstanceId: string;
}): Promise<{ readonly issued: IssuedRunSequence; readonly replayed: boolean }> {
  const issuedAt = new Date().toISOString();
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(async (client) => {
      const handle = client as PostgresHandle;
      const locked = await handle.query(
        "SELECT 1 AS present FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
        [input.connectorInstanceId]
      );
      if (locked.rows.length === 0) {
        throw new Error(`no connection for run start connector_instance_id=${input.connectorInstanceId}`);
      }
      const existing = await handle.query(
        `SELECT device_id, source_instance_id, run_sequence, storage_epoch
           FROM collection_run_sequences WHERE connector_instance_id = $1 AND run_id = $2`,
        [input.connectorInstanceId, input.runId]
      );
      if (existing.rows[0]) {
        return { issued: issuedFromRow(input, existing.rows[0] as IssuedRow), replayed: true };
      }
      const advanced = await handle.query(
        `UPDATE connector_instances SET run_sequence_issued = run_sequence_issued + 1
          WHERE connector_instance_id = $1
          RETURNING run_sequence_issued AS run_sequence, storage_epoch`,
        [input.connectorInstanceId]
      );
      const row = advanced.rows[0] as { run_sequence: unknown; storage_epoch: unknown };
      await handle.query(
        `INSERT INTO collection_run_sequences
           (connector_instance_id, run_id, run_sequence, storage_epoch, device_id, source_instance_id, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.connectorInstanceId,
          input.runId,
          row.run_sequence,
          row.storage_epoch,
          input.deviceId,
          input.sourceInstanceId,
          issuedAt,
        ]
      );
      return {
        issued: issuedFromRow(input, { ...row, device_id: input.deviceId, source_instance_id: input.sourceInstanceId }),
        replayed: false,
      };
    });
  }
  return writeTransaction(() => {
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT device_id, source_instance_id, run_sequence, storage_epoch
           FROM collection_run_sequences WHERE connector_instance_id = ? AND run_id = ?`
      )
      .get(input.connectorInstanceId, input.runId) as IssuedRow | undefined;
    if (existing) {
      return { issued: issuedFromRow(input, existing), replayed: true };
    }
    const row = db
      .prepare(
        `UPDATE connector_instances SET run_sequence_issued = run_sequence_issued + 1
          WHERE connector_instance_id = ?
          RETURNING run_sequence_issued AS run_sequence, storage_epoch`
      )
      .get(input.connectorInstanceId) as { run_sequence: unknown; storage_epoch: unknown } | undefined;
    if (!row) {
      throw new Error(`no connection for run start connector_instance_id=${input.connectorInstanceId}`);
    }
    db.prepare(
      `INSERT INTO collection_run_sequences
         (connector_instance_id, run_id, run_sequence, storage_epoch, device_id, source_instance_id, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.connectorInstanceId,
      input.runId,
      row.run_sequence,
      row.storage_epoch,
      input.deviceId,
      input.sourceInstanceId,
      issuedAt
    );
    return {
      issued: issuedFromRow(input, { ...row, device_id: input.deviceId, source_instance_id: input.sourceInstanceId }),
      replayed: false,
    };
  });
}

/**
 * The restore step. A restore can regress the issued sequences, the run-order
 * marker and the proof tables, so it starts a new storage epoch: every
 * connection's epoch, and the config pointer's epoch documented for the same
 * event, increase by one in one transaction. Proofs and issued sequences from
 * before the step no longer match the current epoch, so no pre-restore proof
 * can be current until a run issued after the step commits one. Run it after
 * restoring the database and before the server serves requests
 * (scripts/mark-storage-restored.ts).
 */
export async function beginStorageEpochAfterRestore(): Promise<{ readonly connections: number }> {
  const statements = [
    "UPDATE connector_instances SET storage_epoch = storage_epoch + 1",
    "UPDATE connector_instance_config_current SET storage_epoch = storage_epoch + 1",
  ] as const;
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(async (client) => {
      const handle = client as unknown as {
        query: (sql: string, params: readonly unknown[]) => Promise<{ readonly rowCount: number | null }>;
      };
      const connections = await handle.query(statements[0], []);
      await handle.query(statements[1], []);
      return { connections: Number(connections.rowCount ?? 0) };
    });
  }
  return writeTransaction(() => {
    const db = getDb();
    const connections = db.prepare(statements[0]).run() as { changes: number | bigint };
    db.prepare(statements[1]).run();
    return { connections: Number(connections.changes) };
  });
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
 * The boundary a proof is judged against, read in the same statement as the
 * proof and its fence: the scope the connection declares, its manifest
 * generation, and (only when the newest event is a terminal run) the
 * connector manifest at that generation.
 */
export interface LocalCoverageProofBoundary {
  readonly declaredCollectionScope: string;
  readonly manifestGeneration: number | null;
  /** The stored manifest JSON text; `null` unless the high-water event is a terminal run. */
  readonly manifestJson: string | null;
}

/**
 * Everything the projection needs to decide whether a local coverage proof is
 * current, read in one snapshot. `highWater` is null when the connection has
 * no readable revision. `proofRun` is present only when the newest event is a
 * terminal run. `boundary` comes from the same statement, so a proof is never
 * judged against a scope or manifest from another moment.
 */
export interface LocalCoverageRevisionFence {
  readonly boundary: LocalCoverageProofBoundary;
  readonly highWater: CollectionRevisionHighWater | null;
  readonly proofRun: LocalCoverageProofRun | null;
  /** The newest observation of the highest observed run sequence; null when unreadable. */
  readonly runOrder: RunOrderMarker | null;
  /** The connection's current storage epoch; null when unreadable. */
  readonly storageEpoch: number | null;
}

/** The run-order marker: the newest observation of the highest observed run sequence. */
export interface RunOrderMarker {
  readonly event: string | null;
  readonly revision: number | null;
  readonly runId: string | null;
  readonly sequence: number;
}

let fenceReadHook: ((connectorInstanceIds: readonly string[]) => Promise<void> | void) | null = null;

/** Run `hook` just before each fence read, after the caller's own boundary reads. Tests only. */
export function __setLocalCoverageFenceReadHookForTest(
  hook: ((connectorInstanceIds: readonly string[]) => Promise<void> | void) | null
): void {
  fenceReadHook = hook;
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

/** The fingerprint of a stored `$collection_scope` row, as the coverage readers compute it. */
function declaredScopeFingerprint(stateJson: unknown): string {
  let parsed: unknown = stateJson;
  if (typeof stateJson === "string") {
    try {
      parsed = JSON.parse(stateJson) as unknown;
    } catch {
      parsed = null;
    }
  }
  return readStoredCollectionScope({ [COLLECTION_SCOPE_STATE_KEY]: parsed ?? null }).fingerprint;
}

function readRunOrderMarker(row: {
  run_order_event: string | null;
  run_order_revision: unknown;
  run_order_run_id: string | null;
  run_order_sequence: unknown;
}): RunOrderMarker | null {
  const sequence = readCollectionRevision(row.run_order_sequence);
  return sequence === null
    ? null
    : {
        event: row.run_order_event ?? null,
        revision: readRunSequence(row.run_order_revision),
        runId: row.run_order_run_id ?? null,
        sequence,
      };
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
    manifest_generation: unknown;
    proof_manifest: string | null;
    proof_completed_at: string | null;
    proof_facts_json: unknown;
    proof_run_id: string | null;
    proof_scheduler_managed: unknown;
    proof_status: string | null;
    run_order_event: string | null;
    run_order_revision: unknown;
    run_order_run_id: string | null;
    run_order_sequence: unknown;
    scope_state_json: unknown;
    storage_epoch: unknown;
  }
  const ids = [...new Set(connectorInstanceIds.filter((id) => typeof id === "string" && id.length > 0))];
  const rows: Row[] = [];
  if (ids.length === 0) {
    return new Map();
  }
  await fenceReadHook?.(ids);
  // One statement per backend, so the fence, the proof run, and the boundary
  // the proof is judged against come from one snapshot. The proof run is the
  // run the run-order marker names, and the manifest is read only when that
  // marker is a terminal run.
  const select = (casts: { readonly json: string; readonly revision: string }, runTerminal: string) =>
    `SELECT ci.connector_instance_id, ci.collection_revision${casts.revision} AS collection_revision,
            ci.collection_revision_event, ci.collection_revision_run_id, ci.collection_revision_at,
            ci.run_order_sequence${casts.revision} AS run_order_sequence, ci.run_order_event,
            ci.run_order_run_id, ci.run_order_revision${casts.revision} AS run_order_revision,
            ci.storage_epoch${casts.revision} AS storage_epoch,
            ci.manifest_generation, scope.state_json${casts.json} AS scope_state_json,
            CASE WHEN ci.run_order_event = ${runTerminal} THEN c.manifest${casts.json} END AS proof_manifest,
            rh.run_id AS proof_run_id, rh.status AS proof_status, rh.scheduler_managed AS proof_scheduler_managed,
            rh.completed_at AS proof_completed_at, rh.facts_json AS proof_facts_json
       FROM connector_instances ci
       LEFT JOIN connectors c ON c.connector_id = ci.connector_id
       LEFT JOIN connector_state scope
         ON scope.connector_instance_id = ci.connector_instance_id
        AND scope.stream = '${COLLECTION_SCOPE_STATE_KEY}'
       LEFT JOIN run_history rh
         ON rh.connector_instance_id = ci.connector_instance_id
        AND rh.run_id = ci.run_order_run_id
        AND ci.run_order_event = ${runTerminal}`;
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<Row>(
      `${select({ json: "::text", revision: "::text" }, "$2")}
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
            `${select({ json: "", revision: "" }, "?")}
              WHERE ci.connector_instance_id IN (${chunk.map(() => "?").join(", ")})`
          )
          .all("terminal_run", "terminal_run", ...chunk) as Row[])
      );
    }
  }
  const fences = new Map<string, LocalCoverageRevisionFence>();
  for (const row of rows) {
    const revision = readCollectionRevision(row.collection_revision);
    const generation = readCollectionRevision(row.manifest_generation);
    fences.set(row.connector_instance_id, {
      boundary: {
        declaredCollectionScope: declaredScopeFingerprint(row.scope_state_json),
        manifestGeneration: generation,
        manifestJson: typeof row.proof_manifest === "string" ? row.proof_manifest : null,
      },
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
      runOrder: readRunOrderMarker(row),
      storageEpoch: readCollectionRevision(row.storage_epoch),
    });
  }
  return fences;
}
