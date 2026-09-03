// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PoolClient } from "pg";
import { getPostgresLockPool } from "./postgres-storage.ts";

const DERIVED_INDEX_MAINTENANCE_WINDOW_ENV = "PDPP_POSTGRES_DERIVED_INDEX_MAINTENANCE_WINDOW";
const DERIVED_INDEX_MAINTENANCE_LOCK = [482_571, 153] as const;
const DEFAULT_UTC_OFF_PEAK_WINDOW: PostgresUtcOffPeakWindow = { endMinute: 300, startMinute: 60 };
const HEAVY_TABLES = [
  "blobs",
  "lexical_search_index",
  "record_changes",
  "records",
  "semantic_search_blob",
  "spine_events",
] as const;
const REINDEXABLE_DERIVED_INDEXES = [
  { indexName: "idx_pg_lexical_search_document", tableName: "lexical_search_index" },
  { indexName: "idx_pg_lexical_search_scope_document", tableName: "lexical_search_index" },
  { indexName: "idx_pg_semantic_search_scope", tableName: "semantic_search_blob" },
  { indexName: "idx_pg_semantic_search_embedding_hnsw", tableName: "semantic_search_blob" },
] as const;
const DEFAULT_MINIMUM_TABLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MINIMUM_DEAD_TUPLES = 100_000;
const DEFAULT_MINIMUM_DEAD_TUPLE_RATIO = 0.2;

export interface PostgresUtcOffPeakWindow {
  /** Minutes after 00:00 UTC, inclusive. */
  endMinute: number;
  /** Minutes after 00:00 UTC, inclusive. */
  startMinute: number;
}

export interface PostgresDerivedIndexMaintenanceTableReceipt {
  deadTupleRatio: number;
  deadTuples: number;
  liveTuples: number;
  tableName: string;
  totalBytes: number;
  vacuumed: boolean;
}

export interface PostgresDerivedIndexMaintenanceReceipt {
  completedAt: string;
  error?: string;
  reindexedIndexNames: string[];
  startedAt: string;
  status:
    | "already-attempted"
    | "already-completed"
    | "completed"
    | "disabled"
    | "failed"
    | "lock-unavailable"
    | "outside-window";
  tables: PostgresDerivedIndexMaintenanceTableReceipt[];
  window: PostgresUtcOffPeakWindow | null;
}

export interface PostgresDerivedIndexMaintenanceOptions {
  /** Explicit window for a caller such as a scheduler. Null keeps the job disabled. */
  window?: PostgresUtcOffPeakWindow | null;
  /** Injectable clock makes the UTC boundary testable. */
  now?: Date;
  minimumDeadTupleRatio?: number;
  minimumDeadTuples?: number;
  minimumTableBytes?: number;
}

interface TableStat {
  deadTuples: number;
  liveTuples: number;
  tableName: (typeof HEAVY_TABLES)[number];
  totalBytes: number;
}

let lastReceipt: PostgresDerivedIndexMaintenanceReceipt | null = null;

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeGate(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function utcMinute(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isWithinWindow(date: Date, window: PostgresUtcOffPeakWindow): boolean {
  const minute = utcMinute(date);
  if (window.startMinute === window.endMinute) {
    return true;
  }
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : minute >= window.startMinute || minute < window.endMinute;
}

function maintenanceWindowKey(date: Date, window: PostgresUtcOffPeakWindow): string {
  const anchor = new Date(date);
  // A window that crosses midnight belongs to the day on which it started.
  if (window.startMinute > window.endMinute && utcMinute(anchor) < window.endMinute) {
    anchor.setUTCDate(anchor.getUTCDate() - 1);
  }
  return `${anchor.toISOString().slice(0, 10)}:${window.startMinute}-${window.endMinute}`;
}

/**
 * Parse an UTC maintenance window such as "01:30-04:00". Unset uses the
 * built-in 01:00-05:00 UTC window; "disabled" explicitly disables the job.
 */
export function parsePostgresDerivedIndexMaintenanceWindow(
  configuredWindow = process.env[DERIVED_INDEX_MAINTENANCE_WINDOW_ENV]
): PostgresUtcOffPeakWindow | null {
  const value = configuredWindow?.trim();
  if (!value) {
    return { ...DEFAULT_UTC_OFF_PEAK_WINDOW };
  }
  if (value.toLowerCase() === "disabled") {
    return null;
  }
  const match = /^(?<startHour>[01]\d|2[0-3]):(?<startMinute>[0-5]\d)-(?<endHour>[01]\d|2[0-3]):(?<endMinute>[0-5]\d)$/.exec(
    value
  );
  if (!match?.groups) {
    throw new Error(
      `${DERIVED_INDEX_MAINTENANCE_WINDOW_ENV} must be "HH:MM-HH:MM" in UTC, "disabled", or unset.`
    );
  }
  return {
    startMinute: Number(match.groups.startHour) * 60 + Number(match.groups.startMinute),
    endMinute: Number(match.groups.endHour) * 60 + Number(match.groups.endMinute),
  };
}

function recordReceipt(receipt: PostgresDerivedIndexMaintenanceReceipt): PostgresDerivedIndexMaintenanceReceipt {
  lastReceipt = receipt;
  return receipt;
}

function skippedReceipt(
  status: PostgresDerivedIndexMaintenanceReceipt["status"],
  startedAt: string,
  window: PostgresUtcOffPeakWindow | null
): PostgresDerivedIndexMaintenanceReceipt {
  return recordReceipt({
    completedAt: new Date().toISOString(),
    reindexedIndexNames: [],
    startedAt,
    status,
    tables: [],
    window,
  });
}

function transientReceipt(
  status: PostgresDerivedIndexMaintenanceReceipt["status"],
  startedAt: string,
  window: PostgresUtcOffPeakWindow | null
): PostgresDerivedIndexMaintenanceReceipt {
  return {
    completedAt: new Date().toISOString(),
    reindexedIndexNames: [],
    startedAt,
    status,
    tables: [],
    window,
  };
}

function alreadyAttemptedReceipt(
  status: "already-attempted" | "already-completed",
  startedAt: string,
  window: PostgresUtcOffPeakWindow
): PostgresDerivedIndexMaintenanceReceipt {
  return transientReceipt(status, startedAt, window);
}

async function readTableStats(client: PoolClient): Promise<TableStat[]> {
  const result = await client.query<{
    dead_tuples: string;
    live_tuples: string;
    table_name: (typeof HEAVY_TABLES)[number];
    total_bytes: string;
  }>(
    `SELECT stats.relname AS table_name,
            stats.n_live_tup::bigint::text AS live_tuples,
            stats.n_dead_tup::bigint::text AS dead_tuples,
            pg_total_relation_size(stats.relid)::bigint::text AS total_bytes
       FROM pg_stat_user_tables AS stats
       JOIN pg_namespace AS namespace ON namespace.oid = stats.schemaname::regnamespace
      WHERE namespace.nspname = current_schema()
        AND stats.relname = ANY($1::text[])
      ORDER BY stats.relname ASC`,
    [HEAVY_TABLES]
  );
  return result.rows.map((row) => ({
    deadTuples: numeric(row.dead_tuples),
    liveTuples: numeric(row.live_tuples),
    tableName: row.table_name,
    totalBytes: numeric(row.total_bytes),
  }));
}

function meetsReindexGate(
  table: TableStat,
  { minimumDeadTupleRatio, minimumDeadTuples }: Required<Pick<PostgresDerivedIndexMaintenanceOptions, "minimumDeadTupleRatio" | "minimumDeadTuples">>
): boolean {
  const tupleCount = table.liveTuples + table.deadTuples;
  return (
    table.deadTuples >= minimumDeadTuples &&
    table.deadTuples / Math.max(tupleCount, 1) >= minimumDeadTupleRatio
  );
}

async function indexExists(client: PoolClient, indexName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_class AS index_class
         JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
        WHERE namespace.nspname = current_schema()
          AND index_class.relname = $1
     ) AS exists`,
    [indexName]
  );
  return result.rows[0]?.exists === true;
}

async function claimMaintenanceWindow(
  client: PoolClient,
  windowKey: string
): Promise<"already-attempted" | "already-completed" | "claimed"> {
  const inserted = await client.query(
    `INSERT INTO postgres_derived_index_maintenance_receipts (window_key, status, started_at)
     VALUES ($1, 'running', now())
     ON CONFLICT (window_key) DO NOTHING
     RETURNING window_key`,
    [windowKey]
  );
  if ((inserted.rowCount ?? 0) > 0) {
    return "claimed";
  }
  const current = await client.query<{ status: string }>(
    "SELECT status FROM postgres_derived_index_maintenance_receipts WHERE window_key = $1",
    [windowKey]
  );
  if (current.rows[0]?.status === "completed") {
    return "already-completed";
  }
  // VACUUM and REINDEX CONCURRENTLY commit statement-by-statement. Retrying a
  // crashed or failed claim could repeat an expensive partial pass, so every
  // durable claim is terminal for its UTC window.
  return "already-attempted";
}

/**
 * Run bounded maintenance for known heavy tables and rebuildable derived
 * indexes. It intentionally uses no transaction: PostgreSQL rejects both
 * VACUUM and REINDEX CONCURRENTLY inside a transaction block.
 */
export async function runPostgresDerivedIndexMaintenance(
  options: PostgresDerivedIndexMaintenanceOptions = {}
): Promise<PostgresDerivedIndexMaintenanceReceipt> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const window = options.window === undefined ? parsePostgresDerivedIndexMaintenanceWindow() : options.window;
  if (!window) {
    return skippedReceipt("disabled", startedAt, null);
  }
  if (!isWithinWindow(now, window)) {
    // Preserve the last meaningful receipt for health instead of replacing a
    // successful run with routine outside-window scheduler polls.
    return transientReceipt("outside-window", startedAt, window);
  }
  const windowKey = maintenanceWindowKey(now, window);

  const gates = {
    minimumDeadTupleRatio: normalizeGate(options.minimumDeadTupleRatio, DEFAULT_MINIMUM_DEAD_TUPLE_RATIO),
    minimumDeadTuples: normalizeGate(options.minimumDeadTuples, DEFAULT_MINIMUM_DEAD_TUPLES),
    minimumTableBytes: normalizeGate(options.minimumTableBytes, DEFAULT_MINIMUM_TABLE_BYTES),
  };
  const client = await getPostgresLockPool().connect();
  let lockHeld = false;
  let windowClaimed = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [
      ...DERIVED_INDEX_MAINTENANCE_LOCK,
    ]);
    lockHeld = lock.rows[0]?.locked === true;
    if (!lockHeld) {
      return transientReceipt("lock-unavailable", startedAt, window);
    }
    const claim = await claimMaintenanceWindow(client, windowKey);
    if (claim !== "claimed") {
      return alreadyAttemptedReceipt(claim, startedAt, window);
    }
    windowClaimed = true;

    const stats = await readTableStats(client);
    const tables = stats.map((table) => ({
      ...table,
      deadTupleRatio: table.deadTuples / Math.max(table.liveTuples + table.deadTuples, 1),
      vacuumed: table.totalBytes >= gates.minimumTableBytes,
    }));
    for (const table of tables) {
      if (table.vacuumed) {
        await client.query(`VACUUM (ANALYZE) ${quoteIdentifier(table.tableName)}`);
      }
    }

    const reindexedIndexNames: string[] = [];
    for (const index of REINDEXABLE_DERIVED_INDEXES) {
      const table = stats.find((candidate) => candidate.tableName === index.tableName);
      if (table && meetsReindexGate(table, gates) && (await indexExists(client, index.indexName))) {
        await client.query(`REINDEX INDEX CONCURRENTLY ${quoteIdentifier(index.indexName)}`);
        reindexedIndexNames.push(index.indexName);
      }
    }
    await client.query(
      `UPDATE postgres_derived_index_maintenance_receipts
          SET status = 'completed', completed_at = now(), error_text = NULL
        WHERE window_key = $1`,
      [windowKey]
    );
    return recordReceipt({
      completedAt: new Date().toISOString(),
      reindexedIndexNames,
      startedAt,
      status: "completed",
      tables,
      window,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (windowClaimed) {
      await client
        .query(
          `UPDATE postgres_derived_index_maintenance_receipts
              SET status = 'failed', completed_at = now(), error_text = $2
            WHERE window_key = $1`,
          [windowKey, message]
        )
        .catch(() => undefined);
    }
    recordReceipt({
      completedAt: new Date().toISOString(),
      error: message,
      reindexedIndexNames: [],
      startedAt,
      status: "failed",
      tables: [],
      window,
    });
    throw error;
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [...DERIVED_INDEX_MAINTENANCE_LOCK]).catch(() => undefined);
    }
    client.release();
  }
}

/** The most recent local run outcome, for a later health-reporting seam. */
export function getLastPostgresDerivedIndexMaintenanceReceipt(): PostgresDerivedIndexMaintenanceReceipt | null {
  return lastReceipt;
}
