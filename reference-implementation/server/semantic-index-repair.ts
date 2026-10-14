// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded, version-aware repair of the semantic index.
 *
 * Replaces the old "count drift => delete the whole stream and re-embed it"
 * behavior. Count drift is no longer an input: a semantic row is CURRENT only
 * when its `source_version` equals the live record's `version`. A missing row,
 * a NULL (legacy, unknown) version, a LOWER version and a HIGHER version are
 * all repaired by re-embedding from the current text. Rows with no live record
 * (orphans) are removed. Whole-stream deletion is reserved for an identity
 * change (fields fingerprint, model, dimensions, metric); that decision lives
 * in search-semantic.ts and only calls `deleteStreamRows` here.
 *
 * One pass per physical scope (connector_instance_id, stream) walks `records`
 * by id (missing/stale phase) and then each declared semantic scope key by
 * record_key (orphan phase). The cursor, the pass identity and the dirty
 * revision captured at the START of the pass are persisted on the existing
 * `semantic_search_backfill_progress` row, so the next call resumes instead of
 * rescanning from zero.
 *
 * Single flight and fencing: the progress row carries a lease
 * (`lease_owner`, `lease_generation`, `lease_expires_at`). Every write, cursor
 * save and completion re-proves `(owner, generation, not expired)` inside the
 * same statement or transaction. A holder whose lease was taken over, or has
 * expired, cannot commit.
 *
 * Lock order (all code paths, documented so none can deadlock):
 *   semantic_search_backfill_progress  <  records (by record_key)  <  search_index_dirty
 *   records  <  semantic_search_blob rows
 * - repair page write: progress FOR SHARE -> records FOR SHARE (record_key order) -> semantic rows
 * - orphan delete:     progress FOR SHARE -> records FOR UPDATE (record_key order) -> semantic rows
 * - completion/reset:  progress FOR UPDATE -> search_index_dirty
 * - profile reset:     progress FOR SHARE -> semantic rows (no records lock)
 * - live publisher:    records FOR UPDATE -> semantic rows (never touches progress)
 * - ingest:            records -> search_index_dirty
 * No path takes a lock that precedes one it already holds, so there is no cycle.
 *
 * Dirty revision: `pass_dirty_revision` is written exactly once per pass (when
 * the pass is created or reset) and never re-read on a resume or takeover. The
 * completion CAS is `... WHERE revision = pass_dirty_revision`; if a newer
 * revision survived, the pass is reset (new revision, cursor at the start) and
 * the scope stays dirty. Nothing here ever writes `revision`.
 */

import { setImmediate as yieldImmediate } from "node:timers/promises";
import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../lib/db.ts";
import {
  isPostgresSemanticVectorEmbedding,
  postgresBulkQuery,
  postgresQuery,
  withPostgresBulkTransaction,
  withPostgresTransaction,
} from "./postgres-storage.ts";

// ─── Public types ───────────────────────────────────────────────────────────

export interface RepairScope {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
}

export interface RepairIdentity {
  dimensions: number;
  distanceMetric: string;
  fieldsFingerprint: string;
  modelId: string;
}

export type RepairPassKind = "rebuild" | "repair";

export interface RepairFence {
  generation: number;
  owner: string;
}

export interface RepairPriorRow {
  cursor: RepairCursor | null;
  identity: RepairIdentity;
  kind: RepairPassKind;
  passDirtyRevision: number | null;
}

export type RepairAcquireResult =
  | { busy: true }
  | { busy: false; created: boolean; fence: RepairFence; prior: RepairPriorRow | null };

export type RepairCursor = { id: number; p: "records" } | { k: string | null; p: "orphans"; s: number };

export interface RepairRecordRef {
  id: number;
  recordKey: string;
  version: number;
}

export interface RepairRecordBody {
  data: unknown;
  recordKey: string;
  version: number;
}

export interface RepairEntry {
  connectorId: string;
  connectorInstanceId: string;
  recordKey: string;
  scopeKey: string;
  vector: Float32Array;
  version: number;
}

export interface RepairEmptied {
  recordKey: string;
  scopeKey: string;
  version: number;
}

export type RepairCompletion = "complete" | "lost" | "reset";

/** The dialect seam. The engine below is identical for Postgres and SQLite. */
/** SQLite is synchronous; Postgres is not. The engine awaits either. */
type Awaitable<T> = T | Promise<T>;

export interface RepairStore {
  acquire: (args: { identity: RepairIdentity; owner: string; scope: RepairScope }) => Awaitable<RepairAcquireResult>;
  complete: (scope: RepairScope, fence: RepairFence) => Awaitable<RepairCompletion>;
  deleteEmptied: (scope: RepairScope, fence: RepairFence, items: readonly RepairEmptied[]) => Awaitable<boolean>;
  deleteOrphans: (
    scope: RepairScope,
    fence: RepairFence,
    scopeKey: string,
    recordKeys: readonly string[]
  ) => Awaitable<boolean>;
  /** Whole-stream delete of semantic ROWS only (identity change). Fenced. */
  deleteStreamRows: (scope: RepairScope, fence: RepairFence) => Awaitable<boolean>;
  fetchRecords: (scope: RepairScope, recordKeys: readonly string[]) => Awaitable<RepairRecordBody[]>;
  indexedKeysPage: (
    scope: RepairScope,
    scopeKey: string,
    afterRecordKey: string | null,
    limit: number
  ) => Awaitable<string[]>;
  liveKeys: (scope: RepairScope, recordKeys: readonly string[]) => Awaitable<Set<string>>;
  recordsPage: (scope: RepairScope, afterId: number, limit: number) => Awaitable<RepairRecordRef[]>;
  release: (scope: RepairScope, fence: RepairFence) => Awaitable<void>;
  /** New pass: identity + kind, cursor NULL, fresh pass_dirty_revision. Fenced. */
  resetPass: (
    scope: RepairScope,
    fence: RepairFence,
    args: { identity: RepairIdentity; kind: RepairPassKind }
  ) => Awaitable<boolean>;
  /** Cursor save + lease renewal in one fenced statement. */
  saveCursor: (scope: RepairScope, fence: RepairFence, cursor: RepairCursor) => Awaitable<boolean>;
  versions: (
    scope: RepairScope,
    scopeKeys: readonly string[],
    recordKeys: readonly string[]
  ) => Awaitable<Map<string, number | null>>;
  writeEntries: (scope: RepairScope, fence: RepairFence, entries: readonly RepairEntry[]) => Awaitable<boolean>;
}

export const REPAIR_PAGE_SIZE = 500;
export const REPAIR_LEASE_TTL_MS = 120_000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_DURATION_MS = 10_000;

export function versionKey(scopeKey: string, recordKey: string): string {
  return `${scopeKey}\u0000${recordKey}`;
}

export function encodeRepairCursor(cursor: RepairCursor): string {
  return JSON.stringify(cursor);
}

export function decodeRepairCursor(raw: unknown): RepairCursor | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.p === "records" && typeof value.id === "number" && Number.isFinite(value.id)) {
      return { id: value.id, p: "records" };
    }
    if (
      value.p === "orphans" &&
      typeof value.s === "number" &&
      Number.isInteger(value.s) &&
      (value.k === null || typeof value.k === "string")
    ) {
      return { k: value.k, p: "orphans", s: value.s };
    }
  } catch {
    // A malformed cursor restarts the pass; repair is idempotent.
  }
  return null;
}

// ─── Budget ─────────────────────────────────────────────────────────────────

export interface RepairBudget {
  deadlineAt: number;
  embedsStarted: number;
  now: () => number;
  pagesLeft: number;
}

function envPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * One budget per `semanticIndexBackfillForManifest` call, shared by every scope
 * in that call. `callerDeadlineAt` is the coordinator's remaining round time:
 * the reconcile passes it so a 250 ms self-heal round is honored INSIDE a scope.
 */
export function newRepairBudget(
  options: {
    callerDeadlineAt?: number | null | undefined;
    maxDurationMs?: number | undefined;
    maxPages?: number | undefined;
    now?: () => number;
  } = {}
): RepairBudget {
  const now = options.now ?? Date.now;
  const maxPages = options.maxPages ?? envPositiveInteger("PDPP_SEMANTIC_REPAIR_MAX_PAGES", DEFAULT_MAX_PAGES);
  const maxDurationMs =
    options.maxDurationMs ?? envPositiveInteger("PDPP_SEMANTIC_REPAIR_MAX_MS", DEFAULT_MAX_DURATION_MS);
  const ownDeadline = now() + maxDurationMs;
  return {
    deadlineAt:
      options.callerDeadlineAt === null || options.callerDeadlineAt === undefined
        ? ownDeadline
        : Math.min(ownDeadline, options.callerDeadlineAt),
    embedsStarted: 0,
    now,
    pagesLeft: maxPages,
  };
}

export function repairBudgetExhausted(budget: RepairBudget): boolean {
  return budget.pagesLeft <= 0 || budget.now() >= budget.deadlineAt;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface RepairPassInput {
  assertManifestCurrent: () => Promise<void>;
  budget: RepairBudget;
  cursor: RepairCursor | null;
  declaredFields: readonly string[];
  embed: (text: string) => Promise<Float32Array>;
  fence: RepairFence;
  onProgress?: (progress: { scanned: number }) => void;
  pageSize?: number | undefined;
  scope: RepairScope;
  scopeKeyFor: (field: string) => string;
  signal: AbortSignal | null;
  store: RepairStore;
  textFor: (data: unknown, field: string) => string | null;
  /** The per-instance writer fence: held only around one page's write. */
  writeFence: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type RepairPassOutcome = "done" | "lost" | "partial";

type PageOutcome = "deadline" | "lost" | "ok";

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("semantic backfill aborted");
  }
}

function parseRecordData(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface EmbeddedBodies {
  deadlineHit: boolean;
  emptied: RepairEmptied[];
  entries: RepairEntry[];
}

/**
 * Embed every non-current declared field of the fetched bodies. Overshoot
 * bound: the deadline is checked before EVERY embed, so a call overruns its
 * budget by at most one embed; at least one embed is always attempted per call
 * so a pass always makes progress.
 */
async function embedRepairBodies(
  input: RepairPassInput,
  bodies: readonly RepairRecordBody[],
  versions: ReadonlyMap<string, number | null>
): Promise<EmbeddedBodies> {
  const { scope, budget, declaredFields } = input;
  const result: EmbeddedBodies = { deadlineHit: false, emptied: [], entries: [] };
  for (const body of bodies) {
    const data = parseRecordData(body.data);
    if (data === null || data === undefined) {
      continue;
    }
    for (const field of declaredFields) {
      const scopeKey = input.scopeKeyFor(field);
      const stored = versions.get(versionKey(scopeKey, body.recordKey));
      const text = input.textFor(data, field);
      if (!text) {
        if (stored !== undefined) {
          result.emptied.push({ recordKey: body.recordKey, scopeKey, version: body.version });
        }
        continue;
      }
      if (stored === body.version) {
        continue;
      }
      if (budget.embedsStarted > 0 && budget.now() >= budget.deadlineAt) {
        result.deadlineHit = true;
        return result;
      }
      budget.embedsStarted += 1;
      // biome-ignore lint/performance/noAwaitInLoops: embeds are admission-gated and must stay sequential per page.
      const vector = await input.embed(text);
      result.entries.push({
        connectorId: scope.connectorId,
        connectorInstanceId: scope.connectorInstanceId,
        recordKey: body.recordKey,
        scopeKey,
        vector,
        version: body.version,
      });
    }
  }
  return result;
}

async function repairRecordsPage(input: RepairPassInput, page: readonly RepairRecordRef[]): Promise<PageOutcome> {
  const { store, scope, declaredFields } = input;
  const scopeKeys = declaredFields.map(input.scopeKeyFor);
  const versions = await store.versions(
    scope,
    scopeKeys,
    page.map((ref) => ref.recordKey)
  );
  // A row is current ONLY when source_version === records.version. Missing,
  // NULL, lower and higher all need validation against the current text.
  const candidates = page.filter((ref) =>
    scopeKeys.some((scopeKey) => versions.get(versionKey(scopeKey, ref.recordKey)) !== ref.version)
  );
  if (candidates.length === 0) {
    return "ok";
  }
  const bodies = await store.fetchRecords(
    scope,
    candidates.map((ref) => ref.recordKey)
  );
  const { deadlineHit, emptied, entries } = await embedRepairBodies(input, bodies, versions);
  if (entries.length > 0 || emptied.length > 0) {
    await input.assertManifestCurrent();
    const ok = await input.writeFence(async () => {
      const wrote = entries.length === 0 || (await store.writeEntries(scope, input.fence, entries));
      return wrote && (emptied.length === 0 || (await store.deleteEmptied(scope, input.fence, emptied)));
    });
    if (!ok) {
      return "lost";
    }
  }
  return deadlineHit ? "deadline" : "ok";
}

async function repairRecordsPhase(
  input: RepairPassInput,
  cursor: { id: number; p: "records" }
): Promise<{ next: RepairCursor; outcome: PageOutcome }> {
  const pageSize = input.pageSize ?? REPAIR_PAGE_SIZE;
  const page = await input.store.recordsPage(input.scope, cursor.id, pageSize);
  if (page.length === 0) {
    return { next: { k: null, p: "orphans", s: 0 }, outcome: "ok" };
  }
  const outcome = await repairRecordsPage(input, page);
  if (outcome !== "ok") {
    return { next: cursor, outcome };
  }
  input.onProgress?.({ scanned: page.length });
  const last = page.at(-1) as RepairRecordRef;
  return {
    next: page.length < pageSize ? { k: null, p: "orphans", s: 0 } : { id: last.id, p: "records" },
    outcome: "ok",
  };
}

async function repairOrphansPhase(
  input: RepairPassInput,
  cursor: { k: string | null; p: "orphans"; s: number }
): Promise<{ next: RepairCursor; outcome: PageOutcome }> {
  const scopeKey = input.scopeKeyFor(input.declaredFields[cursor.s] as string);
  const keys = await input.store.indexedKeysPage(input.scope, scopeKey, cursor.k, input.pageSize ?? REPAIR_PAGE_SIZE);
  if (keys.length === 0) {
    return { next: { k: null, p: "orphans", s: cursor.s + 1 }, outcome: "ok" };
  }
  const live = await input.store.liveKeys(input.scope, keys);
  const orphans = keys.filter((key) => !live.has(key));
  if (orphans.length > 0) {
    await input.assertManifestCurrent();
    const ok = await input.writeFence(() =>
      Promise.resolve(input.store.deleteOrphans(input.scope, input.fence, scopeKey, orphans))
    );
    if (!ok) {
      return { next: cursor, outcome: "lost" };
    }
  }
  return { next: { k: keys.at(-1) as string, p: "orphans", s: cursor.s }, outcome: "ok" };
}

function runRepairStep(
  input: RepairPassInput,
  cursor: RepairCursor
): Promise<{ next: RepairCursor; outcome: PageOutcome }> {
  return cursor.p === "records" ? repairRecordsPhase(input, cursor) : repairOrphansPhase(input, cursor);
}

/**
 * Runs pages until the pass is done, the budget is spent, or the lease is lost.
 * The cursor is persisted (fenced, lease renewed) after every completed page.
 * A page cut short by the deadline writes the entries it already embedded and
 * does NOT advance the cursor; the next call re-reads the page, sees those rows
 * current, and continues.
 */
export async function runRepairPass(input: RepairPassInput): Promise<RepairPassOutcome> {
  let cursor: RepairCursor = input.cursor ?? { id: 0, p: "records" };
  for (;;) {
    throwIfAborted(input.signal);
    if (cursor.p === "orphans" && cursor.s >= input.declaredFields.length) {
      return "done";
    }
    if (repairBudgetExhausted(input.budget)) {
      return "partial";
    }
    input.budget.pagesLeft -= 1;
    // biome-ignore lint/performance/noAwaitInLoops: pages are strictly sequential; each persists its cursor before the next.
    const step = await runRepairStep(input, cursor);
    if (step.outcome === "lost") {
      return "lost";
    }
    if (step.outcome === "deadline") {
      return "partial";
    }
    cursor = step.next;
    if (!(await input.store.saveCursor(input.scope, input.fence, cursor))) {
      return "lost";
    }
    await yieldImmediate();
  }
}

// ─── Postgres store ─────────────────────────────────────────────────────────

const PG_NOW = "(extract(epoch FROM clock_timestamp()) * 1000)::bigint";

type PgClient = Parameters<Parameters<typeof withPostgresTransaction>[0]>[0];

function semanticScopeLikePattern(stream: string): string {
  const scopePrefix = `[${JSON.stringify(stream)},`;
  return `${scopePrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

async function pgFenceHeld(client: PgClient, scope: RepairScope, fence: RepairFence, mode: "SHARE" | "UPDATE") {
  const result = await client.query(
    `SELECT pass_dirty_revision FROM semantic_search_backfill_progress
      WHERE connector_instance_id = $1 AND stream = $2
        AND lease_owner = $3 AND lease_generation = $4 AND lease_expires_at > ${PG_NOW}
      FOR ${mode}`,
    [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
  );
  return result.rows[0] as { pass_dirty_revision: string | number | null } | undefined;
}

/** Ensure the dirty row (no revision change), then read the revision. Same transaction as the caller's pass write. */
async function pgEnsureDirtyAndRevision(client: PgClient, scope: RepairScope): Promise<number> {
  await client.query(
    `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
     VALUES ($1, $2, $3, 1, $4, 1)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1`,
    [scope.connectorInstanceId, scope.connectorId, scope.stream, new Date().toISOString()]
  );
  const result = await client.query(
    "SELECT revision FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
    [scope.connectorInstanceId, scope.stream]
  );
  return Number(result.rows[0]?.revision ?? 0);
}

function pgRowToPrior(row: Record<string, unknown>): RepairPriorRow {
  return {
    cursor: decodeRepairCursor(row.cursor_key),
    identity: {
      dimensions: Number(row.dimensions),
      distanceMetric: String(row.distance_metric),
      fieldsFingerprint: String(row.fields_fingerprint),
      modelId: String(row.model_id),
    },
    kind: row.pass_kind === "repair" ? "repair" : "rebuild",
    passDirtyRevision: row.pass_dirty_revision === null ? null : Number(row.pass_dirty_revision),
  };
}

export function createPostgresRepairStore(options: { leaseTtlMs?: number | undefined } = {}): RepairStore {
  const ttl = options.leaseTtlMs ?? REPAIR_LEASE_TTL_MS;
  const vectorMode = () => (isPostgresSemanticVectorEmbedding() ? "vector" : "jsonb");
  return {
    async acquire({ scope, owner, identity }) {
      return await withPostgresTransaction(async (client): Promise<RepairAcquireResult> => {
        const existing = await client.query(
          `SELECT fields_fingerprint, model_id, dimensions, distance_metric, pass_kind, cursor_key,
                  pass_dirty_revision, lease_owner, lease_expires_at, ${PG_NOW} AS now_ms
             FROM semantic_search_backfill_progress
            WHERE connector_instance_id = $1 AND stream = $2
            FOR UPDATE`,
          [scope.connectorInstanceId, scope.stream]
        );
        const [row] = existing.rows;
        if (row) {
          if (row.lease_owner && Number(row.lease_expires_at) > Number(row.now_ms)) {
            return { busy: true };
          }
          // pass_dirty_revision and cursor_key are NOT listed: a takeover or
          // resume reuses the persisted values and never re-reads the revision.
          const taken = await client.query(
            `UPDATE semantic_search_backfill_progress
                SET lease_owner = $3, lease_generation = lease_generation + 1, lease_expires_at = ${PG_NOW} + $4
              WHERE connector_instance_id = $1 AND stream = $2
              RETURNING lease_generation`,
            [scope.connectorInstanceId, scope.stream, owner, ttl]
          );
          return {
            busy: false,
            created: false,
            fence: { generation: Number(taken.rows[0].lease_generation), owner },
            prior: pgRowToPrior(row),
          };
        }
        const revision = await pgEnsureDirtyAndRevision(client, scope);
        const inserted = await client.query(
          `INSERT INTO semantic_search_backfill_progress(
             connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric,
             updated_at, pass_kind, cursor_key, pass_dirty_revision, lease_owner, lease_generation, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'repair', NULL, $9, $10, 1, ${PG_NOW} + $11)
           ON CONFLICT (connector_instance_id, stream) DO NOTHING
           RETURNING lease_generation`,
          [
            scope.connectorInstanceId,
            scope.connectorId,
            scope.stream,
            identity.fieldsFingerprint,
            identity.modelId,
            identity.dimensions,
            identity.distanceMetric,
            new Date().toISOString(),
            revision,
            owner,
            ttl,
          ]
        );
        if (inserted.rowCount === 0) {
          return { busy: true };
        }
        return { busy: false, created: true, fence: { generation: 1, owner }, prior: null };
      });
    },

    async complete(scope, fence) {
      return await withPostgresTransaction(async (client): Promise<RepairCompletion> => {
        const held = await pgFenceHeld(client, scope, fence, "UPDATE");
        if (!held) {
          return "lost";
        }
        const passRevision = held.pass_dirty_revision === null ? null : Number(held.pass_dirty_revision);
        const cleared =
          passRevision === null
            ? 0
            : (
                await client.query(
                  `UPDATE search_index_dirty
                      SET dirty = 0, reconciled_at = $3, last_error = NULL, attempts = 0, next_attempt_at = NULL
                    WHERE connector_instance_id = $1 AND stream = $2 AND revision = $4`,
                  [scope.connectorInstanceId, scope.stream, new Date().toISOString(), passRevision]
                )
              ).rowCount;
        if (cleared) {
          await client.query(
            `DELETE FROM semantic_search_backfill_progress
              WHERE connector_instance_id = $1 AND stream = $2 AND lease_owner = $3 AND lease_generation = $4`,
            [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
          );
          return "complete";
        }
        // A newer revision survived: start a NEW pass, keep the scope dirty.
        const revision = await pgEnsureDirtyAndRevision(client, scope);
        await client.query(
          `UPDATE semantic_search_backfill_progress
              SET cursor_key = NULL, pass_dirty_revision = $5, pass_kind = 'repair',
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = $6
            WHERE connector_instance_id = $1 AND stream = $2 AND lease_owner = $3 AND lease_generation = $4`,
          [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation, revision, new Date().toISOString()]
        );
        return "reset";
      });
    },

    async deleteEmptied(scope, fence, items) {
      if (items.length === 0) {
        return true;
      }
      return await withPostgresBulkTransaction(async (client) => {
        if (!(await pgFenceHeld(client, scope, fence, "SHARE"))) {
          return false;
        }
        await client.query(
          `WITH locked AS MATERIALIZED (
             SELECT r.record_key, r.version FROM records r
              WHERE r.connector_instance_id = $1 AND r.stream = $2 AND r.record_key = ANY($3::text[]) AND NOT r.deleted
              ORDER BY r.record_key FOR SHARE)
           DELETE FROM semantic_search_blob b
            USING unnest($4::text[], $5::text[], $6::bigint[]) AS d(scope_key, record_key, version), locked l
            WHERE b.connector_instance_id = $1 AND b.scope_key = d.scope_key AND b.record_key = d.record_key
              AND l.record_key = d.record_key AND l.version = d.version`,
          [
            scope.connectorInstanceId,
            scope.stream,
            [...new Set(items.map((item) => item.recordKey))].sort(),
            items.map((item) => item.scopeKey),
            items.map((item) => item.recordKey),
            items.map((item) => item.version),
          ]
        );
        return true;
      });
    },

    async deleteOrphans(scope, fence, scopeKey, recordKeys) {
      if (recordKeys.length === 0) {
        return true;
      }
      return await withPostgresBulkTransaction(async (client) => {
        if (!(await pgFenceHeld(client, scope, fence, "SHARE"))) {
          return false;
        }
        // Lock the records rows (tombstones included) so a concurrent publish
        // of a resurrected record waits; then re-check liveness under the lock.
        const locked = await client.query(
          `SELECT record_key, deleted FROM records
            WHERE connector_instance_id = $1 AND stream = $2 AND record_key = ANY($3::text[])
            ORDER BY record_key FOR UPDATE`,
          [scope.connectorInstanceId, scope.stream, [...recordKeys].sort()]
        );
        const live = new Set(locked.rows.filter((row) => row.deleted === false).map((row) => row.record_key as string));
        const doomed = recordKeys.filter((key) => !live.has(key));
        if (doomed.length > 0) {
          await client.query(
            `DELETE FROM semantic_search_blob
              WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key = ANY($3::text[])`,
            [scope.connectorInstanceId, scopeKey, doomed]
          );
        }
        return true;
      });
    },

    async deleteStreamRows(scope, fence) {
      return await withPostgresTransaction(async (client) => {
        if (!(await pgFenceHeld(client, scope, fence, "SHARE"))) {
          return false;
        }
        await client.query(
          "DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 ESCAPE '\\'",
          [scope.connectorInstanceId, semanticScopeLikePattern(scope.stream)]
        );
        return true;
      });
    },

    async fetchRecords(scope, recordKeys) {
      const result = await postgresBulkQuery(
        `SELECT record_key, version, record_json FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = ANY($3::text[]) AND deleted = FALSE`,
        [scope.connectorInstanceId, scope.stream, [...recordKeys]]
      );
      return result.rows.map((row) => ({
        data: row.record_json,
        recordKey: row.record_key as string,
        version: Number(row.version),
      }));
    },

    async indexedKeysPage(scope, scopeKey, afterRecordKey, limit) {
      const result = await postgresBulkQuery(
        `SELECT record_key FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND scope_key = $2 AND ($3::text IS NULL OR record_key > $3)
          ORDER BY record_key ASC LIMIT $4`,
        [scope.connectorInstanceId, scopeKey, afterRecordKey, limit]
      );
      return result.rows.map((row) => row.record_key as string);
    },

    async liveKeys(scope, recordKeys) {
      const result = await postgresBulkQuery(
        `SELECT record_key FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = ANY($3::text[]) AND deleted = FALSE`,
        [scope.connectorInstanceId, scope.stream, [...recordKeys]]
      );
      return new Set(result.rows.map((row) => row.record_key as string));
    },

    async recordsPage(scope, afterId, limit) {
      const result = await postgresBulkQuery(
        `SELECT id, record_key, version FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE AND id > $3
          ORDER BY id ASC LIMIT $4`,
        [scope.connectorInstanceId, scope.stream, afterId, limit]
      );
      return result.rows.map((row) => ({
        id: Number(row.id),
        recordKey: row.record_key as string,
        version: Number(row.version),
      }));
    },

    async release(scope, fence) {
      await postgresQuery(
        `UPDATE semantic_search_backfill_progress SET lease_owner = NULL, lease_expires_at = NULL
          WHERE connector_instance_id = $1 AND stream = $2 AND lease_owner = $3 AND lease_generation = $4`,
        [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
      );
    },

    async resetPass(scope, fence, { identity, kind }) {
      return await withPostgresTransaction(async (client) => {
        if (!(await pgFenceHeld(client, scope, fence, "UPDATE"))) {
          return false;
        }
        const revision = await pgEnsureDirtyAndRevision(client, scope);
        await client.query(
          `UPDATE semantic_search_backfill_progress
              SET pass_kind = $5, fields_fingerprint = $6, model_id = $7, dimensions = $8, distance_metric = $9,
                  cursor_key = NULL, pass_dirty_revision = $10, updated_at = $11
            WHERE connector_instance_id = $1 AND stream = $2 AND lease_owner = $3 AND lease_generation = $4`,
          [
            scope.connectorInstanceId,
            scope.stream,
            fence.owner,
            fence.generation,
            kind,
            identity.fieldsFingerprint,
            identity.modelId,
            identity.dimensions,
            identity.distanceMetric,
            revision,
            new Date().toISOString(),
          ]
        );
        return true;
      });
    },

    async saveCursor(scope, fence, cursor) {
      const result = await postgresQuery(
        `UPDATE semantic_search_backfill_progress
            SET cursor_key = $5, lease_expires_at = ${PG_NOW} + $6, updated_at = $7
          WHERE connector_instance_id = $1 AND stream = $2 AND lease_owner = $3 AND lease_generation = $4
            AND lease_expires_at > ${PG_NOW}`,
        [
          scope.connectorInstanceId,
          scope.stream,
          fence.owner,
          fence.generation,
          encodeRepairCursor(cursor),
          ttl,
          new Date().toISOString(),
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async versions(scope, scopeKeys, recordKeys) {
      const out = new Map<string, number | null>();
      if (scopeKeys.length === 0 || recordKeys.length === 0) {
        return out;
      }
      // EXACT scope keys, never a LIKE on the middle PK column.
      const result = await postgresBulkQuery(
        `SELECT scope_key, record_key, source_version FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND scope_key = ANY($2::text[]) AND record_key = ANY($3::text[])`,
        [scope.connectorInstanceId, [...scopeKeys], [...recordKeys]]
      );
      for (const row of result.rows) {
        out.set(
          versionKey(row.scope_key as string, row.record_key as string),
          row.source_version === null ? null : Number(row.source_version)
        );
      }
      return out;
    },

    async writeEntries(scope, fence, entries) {
      if (entries.length === 0) {
        return true;
      }
      // Dedupe on the primary key; the last entry wins.
      const unique = new Map<string, RepairEntry>();
      for (const entry of entries) {
        unique.set(versionKey(entry.scopeKey, entry.recordKey), entry);
      }
      const rows = [...unique.values()].filter(
        (entry) => entry.vector.length > 0 || !isPostgresSemanticVectorEmbedding()
      );
      if (rows.length === 0) {
        return true;
      }
      return await withPostgresBulkTransaction(async (client) => {
        if (!(await pgFenceHeld(client, scope, fence, "SHARE"))) {
          return false;
        }
        // The guard is the AUTHORITATIVE record version, locked for the
        // duration of this transaction (FOR SHARE conflicts with the live
        // publisher's FOR UPDATE and with the ingest UPDATE). A newer version
        // that committed first fails `l.version = rows.version` after the lock
        // wait; one that arrives later blocks until we commit, then overwrites.
        // No stored-version comparison is used: a stored version HIGHER than
        // the record's must stay repairable.
        await client.query(
          `WITH locked AS MATERIALIZED (
             SELECT r.record_key, r.version FROM records r
              WHERE r.connector_instance_id = $7 AND r.stream = $8 AND r.record_key = ANY($4::text[]) AND NOT r.deleted
              ORDER BY r.record_key FOR SHARE)
           INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding, source_version)
           SELECT rows.connector_id, rows.connector_instance_id, rows.scope_key, rows.record_key,
                  rows.embedding::${vectorMode()}, rows.version
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[])
               AS rows(connector_id, connector_instance_id, scope_key, record_key, embedding, version)
             JOIN locked l ON l.record_key = rows.record_key AND l.version = rows.version
           ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
             SET embedding = EXCLUDED.embedding, source_version = EXCLUDED.source_version
             WHERE semantic_search_blob.embedding IS DISTINCT FROM EXCLUDED.embedding
                OR semantic_search_blob.source_version IS DISTINCT FROM EXCLUDED.source_version`,
          [
            rows.map((entry) => entry.connectorId),
            rows.map((entry) => entry.connectorInstanceId),
            rows.map((entry) => entry.scopeKey),
            rows.map((entry) => entry.recordKey),
            rows.map((entry) => JSON.stringify(Array.from(entry.vector))),
            rows.map((entry) => entry.version),
            scope.connectorInstanceId,
            scope.stream,
          ]
        );
        return true;
      });
    },
  };
}

// ─── SQLite store ───────────────────────────────────────────────────────────

/** The slice of the SQLite `SemanticIndex` (sqlite-vec or blob-flat) this store needs. */
export interface RepairVectorIndex {
  deleteByConnectorStream: (args: { connectorId: string; connectorInstanceId: string; stream: string }) => unknown;
  deleteExactKeys: (args: { connectorInstanceId: string; recordKeys: string[]; scopeKey: string }) => void;
  listVersions: (args: {
    connectorInstanceId: string;
    recordKeys: string[];
    scopeKeys: string[];
  }) => Map<string, number | null>;
  pageKeys: (args: {
    afterRecordKey: string | null;
    connectorInstanceId: string;
    limit: number;
    scopeKey: string;
  }) => string[];
  upsertMany: (entries: RepairEntry[]) => unknown;
}

type SqlRow = Record<string, unknown>;

function sqliteRows(sql: string, params: unknown[]): SqlRow[] {
  // REVIEWED-DYNAMIC: page-sized IN-lists and columns added by
  // migrateSemanticSearchRepairColumns; every read here carries LIMIT or an exact key list.
  return Array.from(iterateDynamicSqlAcknowledged<SqlRow>(sql, params as never[]));
}

function sqliteRun(sql: string, params: unknown[]): number {
  // REVIEWED-DYNAMIC: see sqliteRows.
  return execDynamicSqlAcknowledged(sql, params as never[]).changes;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function sqliteFenceHeld(scope: RepairScope, fence: RepairFence): SqlRow | undefined {
  return sqliteRows(
    `SELECT pass_dirty_revision FROM semantic_search_backfill_progress
      WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
    [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation, Date.now()]
  )[0];
}

function sqliteEnsureDirtyAndRevision(scope: RepairScope): number {
  sqliteRun(
    `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
     VALUES(?, ?, ?, 1, ?, 1)
     ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1`,
    [scope.connectorInstanceId, scope.connectorId, scope.stream, new Date().toISOString()]
  );
  const [row] = sqliteRows("SELECT revision FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?", [
    scope.connectorInstanceId,
    scope.stream,
  ]);
  return Number(row?.revision ?? 0);
}

function sqliteRecordState(scope: RepairScope, recordKey: string): { deleted: boolean; version: number } | null {
  const [row] = sqliteRows(
    "SELECT version, deleted FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
    [scope.connectorInstanceId, scope.stream, recordKey]
  );
  return row ? { deleted: Boolean(row.deleted), version: Number(row.version) } : null;
}

export function createSqliteRepairStore(
  getIndex: () => RepairVectorIndex,
  options: { leaseTtlMs?: number | undefined } = {}
): RepairStore {
  const ttl = options.leaseTtlMs ?? REPAIR_LEASE_TTL_MS;
  const live = (scope: RepairScope, recordKeys: readonly string[]): Set<string> => {
    if (recordKeys.length === 0) {
      return new Set();
    }
    return new Set(
      sqliteRows(
        `SELECT record_key FROM records
          WHERE connector_instance_id = ? AND stream = ? AND deleted = 0 AND record_key IN (${placeholders(recordKeys)})`,
        [scope.connectorInstanceId, scope.stream, ...recordKeys]
      ).map((row) => row.record_key as string)
    );
  };
  return {
    acquire({ scope, owner, identity }) {
      return writeTransaction((): RepairAcquireResult => {
        const now = Date.now();
        const [row] = sqliteRows(
          `SELECT fields_fingerprint, model_id, dimensions, distance_metric, pass_kind, cursor_key,
                  pass_dirty_revision, lease_owner, lease_expires_at, lease_generation
             FROM semantic_search_backfill_progress WHERE connector_instance_id = ? AND stream = ?`,
          [scope.connectorInstanceId, scope.stream]
        );
        if (row) {
          if (row.lease_owner && Number(row.lease_expires_at) > now) {
            return { busy: true };
          }
          const generation = Number(row.lease_generation) + 1;
          sqliteRun(
            `UPDATE semantic_search_backfill_progress SET lease_owner = ?, lease_generation = ?, lease_expires_at = ?
              WHERE connector_instance_id = ? AND stream = ?`,
            [owner, generation, now + ttl, scope.connectorInstanceId, scope.stream]
          );
          return {
            busy: false,
            created: false,
            fence: { generation, owner },
            prior: {
              cursor: decodeRepairCursor(row.cursor_key),
              identity: {
                dimensions: Number(row.dimensions),
                distanceMetric: String(row.distance_metric),
                fieldsFingerprint: String(row.fields_fingerprint),
                modelId: String(row.model_id),
              },
              kind: row.pass_kind === "repair" ? "repair" : "rebuild",
              passDirtyRevision: row.pass_dirty_revision === null ? null : Number(row.pass_dirty_revision),
            },
          };
        }
        const revision = sqliteEnsureDirtyAndRevision(scope);
        sqliteRun(
          `INSERT INTO semantic_search_backfill_progress(
             connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric,
             updated_at, pass_kind, cursor_key, pass_dirty_revision, lease_owner, lease_generation, lease_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'repair', NULL, ?, ?, 1, ?)`,
          [
            scope.connectorInstanceId,
            scope.connectorId,
            scope.stream,
            identity.fieldsFingerprint,
            identity.modelId,
            identity.dimensions,
            identity.distanceMetric,
            new Date().toISOString(),
            revision,
            owner,
            now + ttl,
          ]
        );
        return { busy: false, created: true, fence: { generation: 1, owner }, prior: null };
      });
    },

    complete(scope, fence) {
      return writeTransaction((): RepairCompletion => {
        const held = sqliteFenceHeld(scope, fence);
        if (!held) {
          return "lost";
        }
        const passRevision = held.pass_dirty_revision === null ? null : Number(held.pass_dirty_revision);
        const cleared =
          passRevision === null
            ? 0
            : sqliteRun(
                `UPDATE search_index_dirty
                    SET dirty = 0, reconciled_at = ?, last_error = NULL, attempts = 0, next_attempt_at = NULL
                  WHERE connector_instance_id = ? AND stream = ? AND revision = ?`,
                [new Date().toISOString(), scope.connectorInstanceId, scope.stream, passRevision]
              );
        if (cleared > 0) {
          sqliteRun(
            `DELETE FROM semantic_search_backfill_progress
              WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ?`,
            [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
          );
          return "complete";
        }
        const revision = sqliteEnsureDirtyAndRevision(scope);
        sqliteRun(
          `UPDATE semantic_search_backfill_progress
              SET cursor_key = NULL, pass_dirty_revision = ?, pass_kind = 'repair',
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ?`,
          [revision, new Date().toISOString(), scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
        );
        return "reset";
      });
    },

    deleteEmptied(scope, fence, items) {
      return writeTransaction(() => {
        if (!sqliteFenceHeld(scope, fence)) {
          return false;
        }
        const byScope = new Map<string, string[]>();
        for (const item of items) {
          const state = sqliteRecordState(scope, item.recordKey);
          if (state && !state.deleted && state.version === item.version) {
            byScope.set(item.scopeKey, [...(byScope.get(item.scopeKey) ?? []), item.recordKey]);
          }
        }
        for (const [scopeKey, recordKeys] of byScope) {
          getIndex().deleteExactKeys({ connectorInstanceId: scope.connectorInstanceId, recordKeys, scopeKey });
        }
        return true;
      });
    },

    deleteOrphans(scope, fence, scopeKey, recordKeys) {
      return writeTransaction(() => {
        if (!sqliteFenceHeld(scope, fence)) {
          return false;
        }
        const liveNow = live(scope, recordKeys);
        const doomed = recordKeys.filter((key) => !liveNow.has(key));
        if (doomed.length > 0) {
          getIndex().deleteExactKeys({ connectorInstanceId: scope.connectorInstanceId, recordKeys: doomed, scopeKey });
        }
        return true;
      });
    },

    deleteStreamRows(scope, fence) {
      return writeTransaction(() => {
        if (!sqliteFenceHeld(scope, fence)) {
          return false;
        }
        getIndex().deleteByConnectorStream({
          connectorId: scope.connectorId,
          connectorInstanceId: scope.connectorInstanceId,
          stream: scope.stream,
        });
        return true;
      });
    },

    fetchRecords(scope, recordKeys) {
      if (recordKeys.length === 0) {
        return [];
      }
      return sqliteRows(
        `SELECT record_key, version, record_json FROM records
          WHERE connector_instance_id = ? AND stream = ? AND deleted = 0 AND record_key IN (${placeholders(recordKeys)})`,
        [scope.connectorInstanceId, scope.stream, ...recordKeys]
      ).map((row) => ({
        data: row.record_json,
        recordKey: row.record_key as string,
        version: Number(row.version),
      }));
    },

    indexedKeysPage(scope, scopeKey, afterRecordKey, limit) {
      return getIndex().pageKeys({ afterRecordKey, connectorInstanceId: scope.connectorInstanceId, limit, scopeKey });
    },

    liveKeys(scope, recordKeys) {
      return live(scope, recordKeys);
    },

    recordsPage(scope, afterId, limit) {
      return sqliteRows(
        `SELECT id, record_key, version FROM records
          WHERE connector_instance_id = ? AND stream = ? AND deleted = 0 AND id > ?
          ORDER BY id ASC LIMIT ?`,
        [scope.connectorInstanceId, scope.stream, afterId, limit]
      ).map((row) => ({ id: Number(row.id), recordKey: row.record_key as string, version: Number(row.version) }));
    },

    release(scope, fence) {
      sqliteRun(
        `UPDATE semantic_search_backfill_progress SET lease_owner = NULL, lease_expires_at = NULL
          WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ?`,
        [scope.connectorInstanceId, scope.stream, fence.owner, fence.generation]
      );
    },

    resetPass(scope, fence, { identity, kind }) {
      return writeTransaction(() => {
        if (!sqliteFenceHeld(scope, fence)) {
          return false;
        }
        const revision = sqliteEnsureDirtyAndRevision(scope);
        sqliteRun(
          `UPDATE semantic_search_backfill_progress
              SET pass_kind = ?, fields_fingerprint = ?, model_id = ?, dimensions = ?, distance_metric = ?,
                  cursor_key = NULL, pass_dirty_revision = ?, updated_at = ?
            WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ?`,
          [
            kind,
            identity.fieldsFingerprint,
            identity.modelId,
            identity.dimensions,
            identity.distanceMetric,
            revision,
            new Date().toISOString(),
            scope.connectorInstanceId,
            scope.stream,
            fence.owner,
            fence.generation,
          ]
        );
        return true;
      });
    },

    saveCursor(scope, fence, cursor) {
      const now = Date.now();
      return (
        sqliteRun(
          `UPDATE semantic_search_backfill_progress SET cursor_key = ?, lease_expires_at = ?, updated_at = ?
            WHERE connector_instance_id = ? AND stream = ? AND lease_owner = ? AND lease_generation = ?
              AND lease_expires_at > ?`,
          [
            encodeRepairCursor(cursor),
            now + ttl,
            new Date(now).toISOString(),
            scope.connectorInstanceId,
            scope.stream,
            fence.owner,
            fence.generation,
            now,
          ]
        ) > 0
      );
    },

    versions(scope, scopeKeys, recordKeys) {
      return getIndex().listVersions({
        connectorInstanceId: scope.connectorInstanceId,
        recordKeys: [...recordKeys],
        scopeKeys: [...scopeKeys],
      });
    },

    writeEntries(scope, fence, entries) {
      return writeTransaction(() => {
        if (!sqliteFenceHeld(scope, fence)) {
          return false;
        }
        // Single writer: the authoritative version re-read and the write share
        // one synchronous transaction, so nothing can interleave between them.
        const current = entries.filter((entry) => {
          const state = sqliteRecordState(scope, entry.recordKey);
          return state !== null && !state.deleted && state.version === entry.version;
        });
        if (current.length > 0) {
          getIndex().upsertMany(current);
        }
        return true;
      });
    },
  };
}
