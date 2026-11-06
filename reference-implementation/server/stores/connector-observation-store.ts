// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnostic records for completed connector runs (Collection Profile v0.2.0,
 * data-connectors docs spec sections 5.10.3 and 5.10.4).
 *
 * A record holds one run's ObservationSnapshot and Diagnosis, the typed values
 * `runtime/observations.ts` produces, with the run and connection identity.
 * The store writes no other field: no raw connector line, provider prose,
 * free-form DONE text or credential. Retirement flags and runtime defects are
 * stored as the typed runtime supplied them.
 *
 * Bounds:
 * - At most CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR records per connector_id,
 *   counted across all of its connector_instance_id values. Surplus records are
 *   pruned in the same transaction as the write that creates them.
 * - A record's serialized payload is at most CONNECTOR_OBSERVATION_RECORD_MAX_BYTES.
 *   A larger record is rejected before any database access. Total payload per
 *   connector is therefore at most 8 MiB plus fixed row overhead.
 *
 * Ordering is `recorded_seq`, a per-connector sequence this store assigns inside
 * the write transaction. Connector-provided timestamps are never used.
 *
 * Concurrency: SQLite writes run under BEGIN IMMEDIATE. PostgreSQL writes take a
 * transaction-scoped advisory lock keyed by connector_id, which serializes
 * writers in every process that shares the database.
 */

import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import { RECOVERY_ACTIONS } from "../../runtime/connector-gap-bounding.ts";
import type { Diagnosis, ObservationSnapshot } from "../../runtime/observations.ts";
import {
  getStorageBackendKind,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../postgres-storage.ts";

export const CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR = 8;
export const CONNECTOR_OBSERVATION_RECORD_MAX_BYTES = 1024 * 1024;

const RECORD_VERSION = 1;
const MAX_IDENTITY_LENGTH = 256;
const DIAGNOSIS_CATEGORIES: ReadonlySet<string> = new Set(["auth_rejected", "expectation_mismatch", "unknown"]);
const DIAGNOSIS_ATTRIBUTIONS: ReadonlySet<string> = new Set(["connector", "none"]);
const LOCK_NAMESPACE = "connector_observation_runs:";

export type ConnectorObservationStoreErrorCode = "record_invalid" | "record_oversize" | "record_conflict";

/** Bounded error. The message names a rule, never the rejected record's content. */
export class ConnectorObservationStoreError extends Error {
  readonly code: ConnectorObservationStoreErrorCode;

  constructor(code: ConnectorObservationStoreErrorCode, message: string) {
    super(message);
    this.name = "ConnectorObservationStoreError";
    this.code = code;
  }
}

export interface ConnectorObservationRunKey {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly runId: string;
}

export interface ConnectorObservationRunInput extends ConnectorObservationRunKey {
  readonly diagnosis: Diagnosis;
  readonly snapshot: ObservationSnapshot;
}

export interface ConnectorObservationRunRecord extends ConnectorObservationRunInput {
  /** Runtime clock at write time. Ordering uses the store's recorded sequence, not this value. */
  readonly recordedAt: string;
}

export interface ListConnectorObservationRunsInput {
  readonly connectorId: string;
  /** Omitted: every instance of the connector. */
  readonly connectorInstanceId?: string;
  /** Clamped to CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR. */
  readonly limit?: number;
}

export interface ConnectorObservationRunStore {
  get: (key: ConnectorObservationRunKey) => Promise<ConnectorObservationRunRecord | null>;
  /** Newest first, by recorded sequence. */
  list: (input: ListConnectorObservationRunsInput) => Promise<ConnectorObservationRunRecord[]>;
  /**
   * Writes one completed run. A repeat of the same key with the same payload
   * is a no-op. The same key with a different payload rejects with
   * `record_conflict`.
   */
  put: (record: ConnectorObservationRunInput) => Promise<void>;
}

interface RunRow {
  connector_id: string;
  connector_instance_id: string;
  payload_json: string;
  recorded_at: string;
  run_id: string;
}

interface PayloadRow {
  payload_json: string;
}

interface NextSequenceRow {
  next_seq: number | string;
}

// Static SQL per backend. Both statements bind every value; the only literal
// is the fixed record version, which is a column constant.
const SQLITE_SQL = {
  existing:
    "SELECT payload_json FROM connector_observation_runs WHERE connector_id = ? AND connector_instance_id = ? AND run_id = ?",
  get: "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = ? AND connector_instance_id = ? AND run_id = ?",
  insert:
    "INSERT INTO connector_observation_runs (connector_id, connector_instance_id, run_id, recorded_seq, record_version, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  listAllInstances:
    "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = ? ORDER BY recorded_seq DESC LIMIT ?",
  listOneInstance:
    "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = ? AND connector_instance_id = ? ORDER BY recorded_seq DESC LIMIT ?",
  nextSequence:
    "SELECT COALESCE(MAX(recorded_seq), 0) + 1 AS next_seq FROM connector_observation_runs WHERE connector_id = ?",
  prune:
    "DELETE FROM connector_observation_runs WHERE connector_id = ? AND recorded_seq NOT IN (SELECT recorded_seq FROM connector_observation_runs WHERE connector_id = ? ORDER BY recorded_seq DESC LIMIT ?)",
} as const;

const POSTGRES_SQL = {
  existing:
    "SELECT payload_json FROM connector_observation_runs WHERE connector_id = $1 AND connector_instance_id = $2 AND run_id = $3",
  get: "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = $1 AND connector_instance_id = $2 AND run_id = $3",
  insert:
    "INSERT INTO connector_observation_runs (connector_id, connector_instance_id, run_id, recorded_seq, record_version, recorded_at, payload_json) VALUES ($1, $2, $3, $4, $5, $6, $7)",
  listAllInstances:
    "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = $1 ORDER BY recorded_seq DESC LIMIT $2",
  listOneInstance:
    "SELECT connector_id, connector_instance_id, run_id, recorded_at, payload_json FROM connector_observation_runs WHERE connector_id = $1 AND connector_instance_id = $2 ORDER BY recorded_seq DESC LIMIT $3",
  nextSequence:
    "SELECT COALESCE(MAX(recorded_seq), 0) + 1 AS next_seq FROM connector_observation_runs WHERE connector_id = $1",
  prune:
    "DELETE FROM connector_observation_runs WHERE connector_id = $1 AND recorded_seq NOT IN (SELECT recorded_seq FROM connector_observation_runs WHERE connector_id = $2 ORDER BY recorded_seq DESC LIMIT $3)",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSnapshot(value: unknown): value is ObservationSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.facts) &&
    Array.isArray(value.defects) &&
    typeof value.truncated === "boolean" &&
    (value.connector_suggestions === undefined || isConnectorSuggestions(value.connector_suggestions))
  );
}

function isConnectorSuggestions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (suggestion: unknown) =>
        isRecord(suggestion) &&
        Object.keys(suggestion).every((key) => key === "attribution" || key === "action" || key === "origin") &&
        suggestion.attribution === "connector" &&
        typeof suggestion.action === "string" &&
        RECOVERY_ACTIONS.has(suggestion.action) &&
        (suggestion.origin === "skip_result" || suggestion.origin === "done_error")
    )
  );
}

function isDiagnosis(value: unknown): value is Diagnosis {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    DIAGNOSIS_CATEGORIES.has(value.category) &&
    typeof value.attribution === "string" &&
    DIAGNOSIS_ATTRIBUTIONS.has(value.attribution) &&
    isStringArray(value.basis) &&
    isStringArray(value.contributing)
  );
}

function invalid(message: string): ConnectorObservationStoreError {
  return new ConnectorObservationStoreError("record_invalid", message);
}

function requireIdentity(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    throw invalid(
      `connector observation ${field} must be a non-blank string of at most ${MAX_IDENTITY_LENGTH} characters`
    );
  }
  return value;
}

function requireKey(key: ConnectorObservationRunKey): ConnectorObservationRunKey {
  return {
    connectorId: requireIdentity("connectorId", key.connectorId),
    connectorInstanceId: requireIdentity("connectorInstanceId", key.connectorInstanceId),
    runId: requireIdentity("runId", key.runId),
  };
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR;
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw invalid("connector observation limit must be a positive integer");
  }
  return Math.min(limit, CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR);
}

/**
 * Validates a record and serializes exactly the persisted fields. Every check
 * runs here, before any database access, so a rejected record mutates nothing.
 */
function encodeRecord(input: ConnectorObservationRunInput): {
  key: ConnectorObservationRunKey;
  payload: string;
} {
  const key = requireKey(input);
  if (!(isSnapshot(input.snapshot) && isDiagnosis(input.diagnosis))) {
    throw invalid("connector observation snapshot and diagnosis must match the runtime shapes");
  }
  const { facts, defects, truncated, connector_suggestions } = input.snapshot;
  const { category, attribution, basis, contributing } = input.diagnosis;
  const payload = JSON.stringify({
    diagnosis: { attribution, basis, category, contributing },
    snapshot: { defects, facts, truncated, ...(connector_suggestions === undefined ? {} : { connector_suggestions }) },
  });
  if (Buffer.byteLength(payload, "utf8") > CONNECTOR_OBSERVATION_RECORD_MAX_BYTES) {
    throw new ConnectorObservationStoreError(
      "record_oversize",
      `connector observation record exceeds ${CONNECTOR_OBSERVATION_RECORD_MAX_BYTES} bytes`
    );
  }
  return { key, payload };
}

function decodeRow(row: RunRow): ConnectorObservationRunRecord {
  const parsed: unknown = JSON.parse(row.payload_json);
  if (!(isRecord(parsed) && isSnapshot(parsed.snapshot) && isDiagnosis(parsed.diagnosis))) {
    throw invalid("stored connector observation record is malformed");
  }
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    diagnosis: parsed.diagnosis,
    recordedAt: row.recorded_at,
    runId: row.run_id,
    snapshot: parsed.snapshot,
  };
}

function assertSamePayload(stored: string, incoming: string): void {
  if (stored !== incoming) {
    throw new ConnectorObservationStoreError(
      "record_conflict",
      "connector observation run is already recorded with different content"
    );
  }
}

/**
 * The SQLite store runs synchronously. A throw still reaches the caller as a
 * rejected promise, the same contract the Postgres methods have.
 */
function settle<T>(step: () => T): Promise<T> {
  try {
    return Promise.resolve(step());
  } catch (error) {
    return Promise.reject(error);
  }
}

function createSqliteConnectorObservationRunStore(): ConnectorObservationRunStore {
  return {
    get(input: ConnectorObservationRunKey): Promise<ConnectorObservationRunRecord | null> {
      return settle(() => {
        const key = requireKey(input);
        const [row] = [
          ...iterateDynamicSqlAcknowledged<RunRow>(SQLITE_SQL.get, [
            key.connectorId,
            key.connectorInstanceId,
            key.runId,
          ]),
        ];
        return row ? decodeRow(row) : null;
      });
    },
    list(input: ListConnectorObservationRunsInput): Promise<ConnectorObservationRunRecord[]> {
      return settle(() => {
        const connectorId = requireIdentity("connectorId", input.connectorId);
        const limit = boundedLimit(input.limit);
        const rows =
          input.connectorInstanceId === undefined
            ? [...iterateDynamicSqlAcknowledged<RunRow>(SQLITE_SQL.listAllInstances, [connectorId, limit])]
            : [
                ...iterateDynamicSqlAcknowledged<RunRow>(SQLITE_SQL.listOneInstance, [
                  connectorId,
                  requireIdentity("connectorInstanceId", input.connectorInstanceId),
                  limit,
                ]),
              ];
        return rows.map(decodeRow);
      });
    },
    put(input: ConnectorObservationRunInput): Promise<void> {
      return settle(() => {
        const { key, payload } = encodeRecord(input);
        const recordedAt = new Date().toISOString();
        writeTransaction(() => {
          const [existing] = [
            ...iterateDynamicSqlAcknowledged<PayloadRow>(SQLITE_SQL.existing, [
              key.connectorId,
              key.connectorInstanceId,
              key.runId,
            ]),
          ];
          if (existing) {
            assertSamePayload(existing.payload_json, payload);
            return;
          }
          const [sequence] = [
            ...iterateDynamicSqlAcknowledged<NextSequenceRow>(SQLITE_SQL.nextSequence, [key.connectorId]),
          ];
          // REVIEWED-DYNAMIC: fixed static statements; every value is bound.
          execDynamicSqlAcknowledged(SQLITE_SQL.insert, [
            key.connectorId,
            key.connectorInstanceId,
            key.runId,
            Number(sequence?.next_seq ?? 1),
            RECORD_VERSION,
            recordedAt,
            payload,
          ]);
          // REVIEWED-DYNAMIC: fixed static statement; retention is per connector_id across instances.
          execDynamicSqlAcknowledged(SQLITE_SQL.prune, [
            key.connectorId,
            key.connectorId,
            CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR,
          ]);
        });
      });
    },
  };
}

function createPostgresConnectorObservationRunStore(): ConnectorObservationRunStore {
  return {
    async get(input: ConnectorObservationRunKey): Promise<ConnectorObservationRunRecord | null> {
      const key = requireKey(input);
      const result = await postgresQuery<RunRow>(POSTGRES_SQL.get, [
        key.connectorId,
        key.connectorInstanceId,
        key.runId,
      ]);
      const [row] = result.rows;
      return row ? decodeRow(row) : null;
    },
    async list(input: ListConnectorObservationRunsInput): Promise<ConnectorObservationRunRecord[]> {
      const connectorId = requireIdentity("connectorId", input.connectorId);
      const limit = boundedLimit(input.limit);
      const result =
        input.connectorInstanceId === undefined
          ? await postgresQuery<RunRow>(POSTGRES_SQL.listAllInstances, [connectorId, limit])
          : await postgresQuery<RunRow>(POSTGRES_SQL.listOneInstance, [
              connectorId,
              requireIdentity("connectorInstanceId", input.connectorInstanceId),
              limit,
            ]);
      return result.rows.map(decodeRow);
    },
    async put(input: ConnectorObservationRunInput): Promise<void> {
      const { key, payload } = encodeRecord(input);
      const recordedAt = new Date().toISOString();
      await withPostgresTransaction(async (client) => {
        // Transaction-scoped, so it releases at COMMIT or ROLLBACK, and it
        // serializes writers in every process that shares this database.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${LOCK_NAMESPACE}${key.connectorId}`,
        ]);
        const existing = await client.query<PayloadRow>(POSTGRES_SQL.existing, [
          key.connectorId,
          key.connectorInstanceId,
          key.runId,
        ]);
        const [current] = existing.rows;
        if (current) {
          assertSamePayload(current.payload_json, payload);
          return;
        }
        const sequence = await client.query<NextSequenceRow>(POSTGRES_SQL.nextSequence, [key.connectorId]);
        await client.query(POSTGRES_SQL.insert, [
          key.connectorId,
          key.connectorInstanceId,
          key.runId,
          Number(sequence.rows[0]?.next_seq ?? 1),
          RECORD_VERSION,
          recordedAt,
          payload,
        ]);
        await client.query(POSTGRES_SQL.prune, [
          key.connectorId,
          key.connectorId,
          CONNECTOR_OBSERVATION_RUNS_PER_CONNECTOR,
        ]);
      });
    },
  };
}

export function createConnectorObservationRunStore(): ConnectorObservationRunStore {
  return isPostgresStorageBackend()
    ? createPostgresConnectorObservationRunStore()
    : createSqliteConnectorObservationRunStore();
}

let defaultStore: ConnectorObservationRunStore | null = null;
let defaultBackend: string | null = null;

/** Cached singleton keyed by storage backend, mirroring `getDefaultConnectorCoverageHorizonStore`. */
export function getDefaultConnectorObservationStore(): ConnectorObservationRunStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultBackend !== backend) {
    defaultStore = createConnectorObservationRunStore();
    defaultBackend = backend;
  }
  return defaultStore;
}

/** Test and reinitialization seam: drops the cached singleton so the next call rebinds to the active backend. */
export function resetDefaultConnectorObservationStoreCache(): void {
  defaultStore = null;
  defaultBackend = null;
}
