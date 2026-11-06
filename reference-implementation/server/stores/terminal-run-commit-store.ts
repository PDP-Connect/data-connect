// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getOneOn, referenceQueries } from "../../lib/db.ts";
import { appendPostgresSpineEventInTransaction, type PostgresSpineEventInput } from "../../lib/postgres-spine.ts";
import { appendSqliteSpineEventInTransaction, type SpineDatabase, type SpineEventInput } from "../../lib/spine.ts";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import {
  requirePostgresCollectionObservationInTransaction,
  requirePostgresCollectionRevisionInTransaction,
  requireSqliteCollectionObservationInTransaction,
  requireSqliteCollectionRevisionInTransaction,
} from "./collection-revision-store.ts";
import {
  putPostgresConnectorStateDeltaInTransaction,
  putSqliteConnectorStateDeltaInTransaction,
} from "./connector-state-store.ts";

export interface ResolvedTerminalRunCommit {
  readonly collectionBoundary: string;
  readonly commitId: string;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  /** Stored with the terminal receipt when assertions are retained as unknown for placement. */
  readonly coverageEligibilityReason?: string;
  readonly deviceId: string;
  readonly envelopeHash: string;
  readonly normalizedFacts: readonly Record<string, unknown>[];
  readonly runId: string;
  readonly sourceInstanceId: string;
  readonly stateDelta: Readonly<Record<string, unknown>>;
  readonly version?: 1 | 2;
}

export interface TerminalRunCommitResponse {
  /** The commit revision the run was recorded at. Absent from receipts stored before run order. */
  readonly collection_revision?: number;
  readonly commit_id: string;
  readonly envelope_hash: string;
  readonly object: "device_terminal_run_commit";
  readonly run_id: string;
  /** The sequence issued at run start, or null for a run with none. Absent from receipts stored before run order. */
  readonly run_sequence?: number | null;
  /** The storage epoch the run was recorded in. Absent from receipts stored before run order. */
  readonly storage_epoch?: number;
  readonly terminal_event_id: string;
}

/** Where a terminal record sits in commit order and run order. */
interface TerminalRunOrder {
  readonly collectionRevision: number;
  readonly runSequence: number | null;
  readonly storageEpoch: number;
}

export interface TerminalRunCommitResult {
  readonly replayed: boolean;
  readonly response: TerminalRunCommitResponse;
}

export class TerminalRunCommitConflictError extends Error {
  readonly code = "terminal_run_commit_conflict";

  constructor() {
    super("Terminal run commit identity is already bound to a different request.");
    this.name = "TerminalRunCommitConflictError";
  }
}

type TerminalFaultPoint = "after_event_insert" | "after_run_history_write" | `after_state_write:${string}`;
let terminalRunCommitFaultHook: ((point: TerminalFaultPoint) => void) | null = null;

export function __setTerminalRunCommitFaultHookForTest(hook: ((point: TerminalFaultPoint) => void) | null): void {
  terminalRunCommitFaultHook = hook;
}

function maybeFault(point: TerminalFaultPoint): void {
  terminalRunCommitFaultHook?.(point);
}

/** The fields that identify a terminal record and its exact receipt, known before inventory validation. */
export type TerminalRunReceiptLookup = Pick<
  ResolvedTerminalRunCommit,
  | "commitId"
  | "connectorId"
  | "connectorInstanceId"
  | "deviceId"
  | "envelopeHash"
  | "runId"
  | "sourceInstanceId"
  | "version"
>;

function terminalRunBindingIdentity(input: TerminalRunReceiptLookup): string {
  return JSON.stringify([
    input.deviceId,
    input.sourceInstanceId,
    input.connectorId,
    input.connectorInstanceId,
    input.runId,
  ]);
}

function terminalEventId(input: TerminalRunReceiptLookup): string {
  return `evt_local_terminal_commit_${createHash("sha256").update(terminalRunBindingIdentity(input)).digest("hex")}`;
}

function responseFor(
  input: ResolvedTerminalRunCommit,
  eventId: string,
  order: TerminalRunOrder
): TerminalRunCommitResponse {
  return {
    collection_revision: order.collectionRevision,
    commit_id: input.commitId,
    envelope_hash: input.envelopeHash,
    object: "device_terminal_run_commit",
    run_id: input.runId,
    run_sequence: order.runSequence,
    storage_epoch: order.storageEpoch,
    terminal_event_id: eventId,
  };
}

function eventInputFor(
  input: ResolvedTerminalRunCommit,
  eventId: string,
  response: TerminalRunCommitResponse,
  occurredAt: string,
  order: TerminalRunOrder
): SpineEventInput & PostgresSpineEventInput {
  return {
    actor_id: input.deviceId,
    actor_type: "local_device",
    data: {
      collection_facts: {
        collection_scope: input.collectionBoundary,
        ...(input.coverageEligibilityReason ? { coverage_eligibility_reason: input.coverageEligibilityReason } : {}),
        reference_only: true,
        schema_version: input.version ?? 1,
        streams: input.normalizedFacts,
      },
      // The connection revision this run, and the state it wrote, were
      // committed at. It orders the record among observations and dates it.
      collection_revision: order.collectionRevision,
      connector_instance_id: input.connectorInstanceId,
      // The run's place in run order: the sequence issued at its start (null
      // for a run without one) and the storage epoch it was recorded in. A
      // proof is eligible only while it is the run-order marker in the
      // current epoch.
      run_sequence: order.runSequence,
      storage_epoch: order.storageEpoch,
      terminal_run_commit_receipt: {
        bindings: {
          connector_id: input.connectorId,
          connector_instance_id: input.connectorInstanceId,
          device_id: input.deviceId,
          run_id: input.runId,
          source_instance_id: input.sourceInstanceId,
        },
        ...(input.coverageEligibilityReason ? { coverage_eligibility_reason: input.coverageEligibilityReason } : {}),
        commit_id: input.commitId,
        envelope_hash: input.envelopeHash,
        response,
        version: input.version ?? 1,
      },
    },
    event_id: eventId,
    event_type: "run.completed",
    object_id: input.runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: input.runId,
    source_id: input.connectorId,
    source_kind: "connector",
    status: "succeeded",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseStoredResponse(dataJson: unknown, input: TerminalRunReceiptLookup): TerminalRunCommitResponse | null {
  let data: unknown = dataJson;
  if (typeof dataJson === "string") {
    try {
      data = JSON.parse(dataJson) as unknown;
    } catch {
      return null;
    }
  }
  const receipt = asRecord(asRecord(data)?.terminal_run_commit_receipt);
  const bindings = asRecord(receipt?.bindings);
  const response = asRecord(receipt?.response);
  const exactReceiptFields = [
    receipt?.version === (input.version ?? 1),
    receipt?.commit_id === input.commitId,
    receipt?.envelope_hash === input.envelopeHash,
    bindings?.device_id === input.deviceId,
    bindings?.source_instance_id === input.sourceInstanceId,
    bindings?.connector_id === input.connectorId,
    bindings?.connector_instance_id === input.connectorInstanceId,
    bindings?.run_id === input.runId,
    response?.object === "device_terminal_run_commit",
    response?.commit_id === input.commitId,
    response?.envelope_hash === input.envelopeHash,
    response?.run_id === input.runId,
    typeof response?.terminal_event_id === "string",
  ];
  if (!exactReceiptFields.every(Boolean)) {
    return null;
  }
  return response as unknown as TerminalRunCommitResponse;
}

function rollbackSqlite(db: ReturnType<typeof getDb>): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original transactional failure.
  }
}

function commitSqlite(input: ResolvedTerminalRunCommit): TerminalRunCommitResult {
  const db = getDb();
  const eventId = terminalEventId(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getOneOn<{ data_json: string }>(db, referenceQueries.spineGetTerminalRunCommitReceipt, [eventId]);
    if (existing) {
      const stored = parseStoredResponse(existing.data_json, input);
      if (!stored) {
        throw new TerminalRunCommitConflictError();
      }
      db.exec("COMMIT");
      return { replayed: true, response: stored };
    }

    const occurredAt = new Date().toISOString();
    // Required: a terminal run without its revision rolls back whole.
    const observed = requireSqliteCollectionObservationInTransaction(db, input.connectorInstanceId, {
      at: occurredAt,
      event: "terminal_run",
      runId: input.runId,
    });
    const order = {
      collectionRevision: observed.revision,
      runSequence: observed.runSequence,
      storageEpoch: observed.storageEpoch,
    };
    const collectionRevision = observed.revision;
    const response = responseFor(input, eventId, order);
    putSqliteConnectorStateDeltaInTransaction(
      db,
      { connectorId: input.connectorId, connectorInstanceId: input.connectorInstanceId },
      input.stateDelta,
      occurredAt,
      {
        afterStateWrite: (stream) => maybeFault(`after_state_write:${stream}`),
        collectionRevision,
      }
    );
    appendSqliteSpineEventInTransaction(
      eventInputFor(input, eventId, response, occurredAt, order),
      db as unknown as SpineDatabase,
      {
        afterEventInsert: () => maybeFault("after_event_insert"),
        afterRunHistoryWrite: () => maybeFault("after_run_history_write"),
      }
    );
    db.exec("COMMIT");
    return { replayed: false, response };
  } catch (error) {
    rollbackSqlite(db);
    throw error;
  }
}

async function commitPostgres(input: ResolvedTerminalRunCommit): Promise<TerminalRunCommitResult> {
  const eventId = terminalEventId(input);
  return await withPostgresTransaction(
    async (client) => {
      // Serialize equal authorized run bindings before lookup/insert. This avoids a
      // 23505-aborted transaction on concurrent divergent bodies while exposing
      // no incumbent receipt fields to the losing caller. This lock is taken
      // SECOND, after the connector-instance lock `withPostgresTransaction`
      // already acquired via `lockConnectorInstanceId` below (right after
      // BEGIN, per `withPostgresTransaction`'s own option-application order
      // in postgres-storage.ts). The two locks occupy different Postgres
      // advisory-lock key spaces that cannot collide by construction:
      // `connectorInstanceAdvisoryLockKey` (connector-instance-write-coordinator.ts)
      // hashes a `"pdpp:connector-instance-write:v1:\0" + connectorInstanceId`
      // domain-separated string with SHA-256 and reads the first 8 bytes as a
      // signed bigint; this call hashes an unrelated JSON tuple
      // (`terminalRunBindingIdentity`) through Postgres's `hashtextextended`.
      // Even if the two 64-bit keys ever coincided, `pg_advisory_xact_lock`
      // is reentrant within one backend/transaction (a second acquisition of
      // the same key by the same transaction is a no-op), and every caller
      // of this function applies the same order, so no AB/BA cross-transaction
      // cycle can form. Global lock order for this module: connector-instance
      // lock (via `lockConnectorInstanceId`, acquired first inside
      // `withPostgresTransaction`) THEN the terminal-run-binding lock
      // (acquired second, here) — matching how
      // `coalesceExactPostgresLocalDeviceBindingDuplicates` always acquires
      // its class of connector-instance locks before doing any further work
      // in the same transaction (postgres-storage.ts:6529-6531).
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [terminalRunBindingIdentity(input)]);
      const existing = await client.query<{ data_json: unknown }>(
        "SELECT data_json FROM spine_events WHERE event_id = $1",
        [eventId]
      );
      if (existing.rows[0]) {
        const stored = parseStoredResponse(existing.rows[0].data_json, input);
        if (!stored) {
          throw new TerminalRunCommitConflictError();
        }
        return { replayed: true, response: stored };
      }

      const occurredAt = new Date().toISOString();
      // Required: a terminal run without its revision rolls back whole.
      const observed = await requirePostgresCollectionObservationInTransaction(client, input.connectorInstanceId, {
        at: occurredAt,
        event: "terminal_run",
        runId: input.runId,
      });
      const order = {
        collectionRevision: observed.revision,
        runSequence: observed.runSequence,
        storageEpoch: observed.storageEpoch,
      };
      const collectionRevision = observed.revision;
      const response = responseFor(input, eventId, order);
      await putPostgresConnectorStateDeltaInTransaction(
        client,
        { connectorId: input.connectorId, connectorInstanceId: input.connectorInstanceId },
        input.stateDelta,
        occurredAt,
        {
          afterStateWrite: (stream) => maybeFault(`after_state_write:${stream}`),
          collectionRevision,
        }
      );
      const event = eventInputFor(input, eventId, response, occurredAt, order);
      await appendPostgresSpineEventInTransaction(client, event, {
        afterEventInsert: () => maybeFault("after_event_insert"),
        afterRunHistoryWrite: () => maybeFault("after_run_history_write"),
      });
      return { replayed: false, response };
    },
    // Fence this write with the SAME connector-instance advisory lock
    // `coalesceExactPostgresLocalDeviceBindingDuplicates` takes via
    // `acquireConnectorInstanceXactLocks` (postgres-storage.ts:6531) before
    // it revalidates and merges a duplicate class. Without this, a terminal
    // commit could write a different-stream canonical row for a connector
    // instance the coalescer is mid-merge on, combining two independently
    // owned state histories instead of failing closed. See
    // PR238-POSTGRES-D9-INDEPENDENT-R3-0831.md.
    { lockConnectorInstanceId: input.connectorInstanceId }
  );
}

export async function commitTerminalRun(input: ResolvedTerminalRunCommit): Promise<TerminalRunCommitResult> {
  return isPostgresStorageBackend() ? await commitPostgres(input) : commitSqlite(input);
}

/**
 * The stored receipt for an exact replay, `null` when no record exists for the
 * run binding, or a `TerminalRunCommitConflictError` when the stored record is
 * a different request. Reads only: a record that commits after this lookup is
 * still caught by the commit, which repeats the check under its lock.
 */
export async function findTerminalRunReceipt(input: TerminalRunReceiptLookup): Promise<TerminalRunCommitResult | null> {
  const eventId = terminalEventId(input);
  const existing = isPostgresStorageBackend()
    ? (await postgresQuery<{ data_json: unknown }>("SELECT data_json FROM spine_events WHERE event_id = $1", [eventId]))
        .rows[0]
    : getOneOn<{ data_json: string }>(getDb(), referenceQueries.spineGetTerminalRunCommitReceipt, [eventId]);
  if (!existing) {
    return null;
  }
  const stored = parseStoredResponse(existing.data_json, input);
  if (!stored) {
    throw new TerminalRunCommitConflictError();
  }
  return { replayed: true, response: stored };
}

/** JSON with sorted keys and without undefined members, as stored JSON reads back. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member && typeof member === "object" && !Array.isArray(member)
      ? Object.fromEntries(
          Object.keys(member)
            .sort()
            .map((key) => [key, (member as Record<string, unknown>)[key]])
        )
      : member
  );
}

/**
 * What identifies a legacy report: the connection and the facts it reported.
 * The spine adds its own fields to stored data (`source`), so a retry is
 * compared on these alone.
 */
function legacyReportIdentity(data: unknown): string | null {
  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  const record = asRecord(parsed);
  return record
    ? canonicalJson({
        collection_facts: record.collection_facts,
        connector_instance_id: record.connector_instance_id,
      })
    : null;
}

/**
 * Commit a legacy split `terminal-collection` report. It is an observed
 * collection event of its own (`legacy_terminal`): its run record takes the
 * next revision in the same transaction, so a report that arrives after a
 * newer proof retires that proof instead of copying its revision. It is never
 * a v2 proof.
 *
 * The event id is the run's, so a retried report finds the stored one under
 * the same lock, before any revision is allocated. An identical retry is a
 * replay: it allocates no revision and so retires nothing. A different report
 * for the same run is a conflict. Neither writes anything.
 */
export async function commitLegacyTerminalCollection(input: {
  readonly connectorInstanceId: string;
  /** The run event, without `data.collection_revision`; the store adds the allocated revision. */
  readonly event: SpineEventInput &
    PostgresSpineEventInput & { readonly data: Readonly<Record<string, unknown>>; readonly event_id: string };
  readonly runId: string;
}): Promise<{ readonly replayed: boolean }> {
  const revisionEvent = {
    at: new Date().toISOString(),
    event: "legacy_terminal",
    runId: input.runId,
  } as const;
  const report = legacyReportIdentity(input.event.data);
  const withRevision = (collectionRevision: number) => ({
    ...input.event,
    data: { ...input.event.data, collection_revision: collectionRevision },
  });
  const replayed = (existing: { data_json: unknown } | undefined): boolean => {
    if (!existing) {
      return false;
    }
    if (report === null || legacyReportIdentity(existing.data_json) !== report) {
      throw new TerminalRunCommitConflictError();
    }
    return true;
  };
  if (isPostgresStorageBackend()) {
    return await withPostgresTransaction(
      async (client) => {
        const existing = await client.query<{ data_json: unknown }>(
          "SELECT data_json FROM spine_events WHERE event_id = $1",
          [input.event.event_id]
        );
        if (replayed(existing.rows[0])) {
          return { replayed: true };
        }
        const revision = await requirePostgresCollectionRevisionInTransaction(
          client,
          input.connectorInstanceId,
          revisionEvent
        );
        await appendPostgresSpineEventInTransaction(client, withRevision(revision));
        return { replayed: false };
      },
      { lockConnectorInstanceId: input.connectorInstanceId }
    );
  }
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT data_json FROM spine_events WHERE event_id = ?").get(input.event.event_id) as
      | { data_json: unknown }
      | undefined;
    if (replayed(existing)) {
      db.exec("COMMIT");
      return { replayed: true };
    }
    const revision = requireSqliteCollectionRevisionInTransaction(db, input.connectorInstanceId, revisionEvent);
    appendSqliteSpineEventInTransaction(withRevision(revision), db as unknown as SpineDatabase);
    db.exec("COMMIT");
    return { replayed: false };
  } catch (error) {
    rollbackSqlite(db);
    throw error;
  }
}
