// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PoolClient } from "pg";
import { tryAcquireDirectoryLock } from "./connector-install/directory-lock.ts";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "./postgres-storage.ts";

const heldLifecycleLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const processLocalLocks = new Map<string, Promise<void>>();

function validateConnectorId(connectorId: string): void {
  if (!connectorId.trim()) throw new Error("Connector id is required.");
}

function lifecycleMarkerPath(dataDir: string, connectorId: string): string {
  validateConnectorId(connectorId);
  const markerKey = createHash("sha256").update(connectorId).digest("hex");
  return resolve(dataDir, ".connector-lifecycle-locks", `${markerKey}.uninstalled`);
}

export function assertConnectorLifecycleAvailable(dataDir: string, connectorId: string): void {
  if (existsSync(lifecycleMarkerPath(dataDir, connectorId))) {
    throw new Error("Connector is not installed.");
  }
}

export function markConnectorLifecycleUninstalled(dataDir: string, connectorId: string): void {
  const marker = lifecycleMarkerPath(dataDir, connectorId);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "uninstalled", { flag: "wx", mode: 0o600 });
}

export function clearConnectorLifecycleUninstalled(dataDir: string, connectorId: string): void {
  rmSync(lifecycleMarkerPath(dataDir, connectorId), { force: true });
}

function sqliteLockTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS connector_lifecycle_locks (
    connector_id TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL
  )`);
}

const BUSY_MESSAGE = "Connector lifecycle operation is busy.";
const LOCK_POLL_MS = 10;
/** Lifecycle locks held in this process on an in-memory SQLite database, which no other process can open. */
const inMemoryHeld = new Set<string>();

/**
 * The SQLite lifecycle lock is an OS file lock per connector, next to the
 * database file, so exactly the processes that share the database share it.
 * The OS drops it when its holder ends, so no process ever judges another
 * dead from a pid: a pid proves nothing across PID namespaces (two
 * containers, each pid 1) or after a restart (the same pid again).
 */
function sqliteLifecycleLockDir(): string | null {
  const handle = getDb() as unknown as { memory?: unknown; name?: unknown };
  return handle.memory === true || typeof handle.name !== "string" ? null : `${resolve(handle.name)}.lifecycle-locks`;
}

/** Prefix of the row tokens this build writes. Such a row is only ever held together with the OS lock. */
const OS_LOCKED_ROW_TOKEN_PREFIX = "os-lock:";

/**
 * Whether an older build that locks by row alone may hold a row. It may when
 * its pid is alive in this PID namespace and is not this process's pid. A dead
 * pid is provably stale here; this process's pid is a row left by an earlier
 * start of a server with the same pid (a container restart). A row this build
 * wrote is stale whenever the OS lock is free, so it never blocks.
 */
function olderBuildMayHoldRow(row: { owner_pid: number; owner_token: string }): boolean {
  if (row.owner_token.startsWith(OS_LOCKED_ROW_TOKEN_PREFIX) || row.owner_pid === process.pid) return false;
  try {
    process.kill(row.owner_pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Under the OS lock, claim the `connector_lifecycle_locks` row, or return
 * false when an older build that locks by row alone may hold it. That row is
 * never deleted. The row this build writes names the holder for diagnostics,
 * and an older build in this PID namespace sees a live owner in it.
 */
function claimLifecycleLockRow(connectorId: string, token: string): boolean {
  sqliteLockTable();
  return getDb()
    .transaction(() => {
      const row = getDb()
        .prepare("SELECT owner_token, owner_pid FROM connector_lifecycle_locks WHERE connector_id=?")
        .get<{ owner_pid: number; owner_token: string }>(connectorId);
      if (row && olderBuildMayHoldRow(row)) return false;
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO connector_lifecycle_locks(connector_id, owner_token, owner_pid) VALUES(?, ?, ?)"
        )
        .run(connectorId, token, process.pid);
      return true;
    })
    .immediate();
}

/** Take the connector's SQLite lifecycle lock without waiting, or return null when it is held. */
function tryAcquireSqlite(connectorId: string): (() => void) | null {
  validateConnectorId(connectorId);
  const lockDir = sqliteLifecycleLockDir();
  if (!lockDir) {
    if (inMemoryHeld.has(connectorId)) return null;
    inMemoryHeld.add(connectorId);
    return () => inMemoryHeld.delete(connectorId);
  }
  const lock = tryAcquireDirectoryLock(lockDir, createHash("sha256").update(connectorId).digest("hex"));
  if (!lock) return null;
  const token = `${OS_LOCKED_ROW_TOKEN_PREFIX}${randomUUID()}`;
  try {
    if (!claimLifecycleLockRow(connectorId, token)) {
      lock.release();
      return null;
    }
  } catch (error) {
    lock.release();
    throw error;
  }
  return () => {
    try {
      getDb()
        .prepare("DELETE FROM connector_lifecycle_locks WHERE connector_id=? AND owner_token=?")
        .run(connectorId, token);
    } finally {
      lock.release();
    }
  };
}

function acquireSqliteSync(connectorId: string): () => void {
  const release = tryAcquireSqlite(connectorId);
  if (!release) throw new Error(BUSY_MESSAGE);
  return release;
}

/** Resolve when `work` does, or reject with the abort reason as soon as `signal` aborts. */
async function settledOrAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return await work;
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Wait `ms`, or reject with the abort reason as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return settledOrAborted(new Promise((resolveDelay) => setTimeout(resolveDelay, ms)), signal);
}

async function acquireSqliteAsync(connectorId: string, signal: AbortSignal | undefined): Promise<() => void> {
  for (;;) {
    signal?.throwIfAborted();
    const release = tryAcquireSqlite(connectorId);
    if (release) return release;
    await pause(LOCK_POLL_MS, signal);
  }
}

async function withProcessLocalLifecycleLock<T>(
  connectorId: string,
  operation: () => Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  const previous = processLocalLocks.get(connectorId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  processLocalLocks.set(connectorId, next);
  const settle = () => {
    release();
    if (processLocalLocks.get(connectorId) === next) processLocalLocks.delete(connectorId);
  };
  try {
    await settledOrAborted(previous, signal);
  } catch (error) {
    // An aborted waiter leaves the queue; its successors still wait for its predecessor.
    void previous.then(settle);
    throw error;
  }
  const nested = new Set(heldLifecycleLocks.getStore() ?? []);
  nested.add(connectorId);
  try {
    return await heldLifecycleLocks.run(nested, operation);
  } finally {
    settle();
  }
}

/** Take the advisory lock, polling so that an abort can end the wait. */
async function acquirePostgresAdvisoryXactLock(
  client: PoolClient,
  lockId: bigint,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId.toString()]);
    return;
  }
  for (;;) {
    signal.throwIfAborted();
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1::bigint) AS locked", [
      lockId.toString(),
    ]);
    if (result.rows[0]?.locked) return;
    await pause(LOCK_POLL_MS, signal);
  }
}

export function withConnectorLifecycleLockSync<T>(_dataDir: string, connectorId: string, operation: () => T): T {
  if (heldLifecycleLocks.getStore()?.has(connectorId)) return operation();
  const release = acquireSqliteSync(connectorId);
  try {
    const nested = new Set(heldLifecycleLocks.getStore() ?? []);
    nested.add(connectorId);
    return heldLifecycleLocks.run(nested, operation);
  } finally {
    release();
  }
}

/**
 * Run `operation` under the connector's lifecycle lock. `signal` bounds only
 * the wait: an abort before the lock is taken rejects with the abort reason
 * and takes nothing; once `operation` runs, it runs to completion.
 */
export async function withConnectorLifecycleLock<T>(
  _dataDir: string,
  connectorId: string,
  operation: () => Promise<T>,
  options: { readonly signal?: AbortSignal } = {}
): Promise<T> {
  const { signal } = options;
  if (heldLifecycleLocks.getStore()?.has(connectorId)) return operation();
  validateConnectorId(connectorId);
  const nested = new Set(heldLifecycleLocks.getStore() ?? []);
  nested.add(connectorId);
  if (isPostgresStorageBackend()) {
    const lockId = createHash("sha256").update(`connector-lifecycle:${connectorId}`).digest().readBigInt64BE(0);
    // Same-process callers queue in memory first. Queued on the advisory lock,
    // each waiter would pin a pooled connection, and enough waiters exhaust the
    // pool the holder itself needs to finish: a deadlock Postgres cannot see.
    return await withProcessLocalLifecycleLock(
      connectorId,
      () =>
        withPostgresTransaction(async (client) => {
          await acquirePostgresAdvisoryXactLock(client, lockId, signal);
          return await heldLifecycleLocks.run(nested, operation);
        }),
      signal
    );
  }
  if (!getDb()) return await withProcessLocalLifecycleLock(connectorId, operation, signal);
  const release = await acquireSqliteAsync(connectorId, signal);
  try {
    return await heldLifecycleLocks.run(nested, operation);
  } finally {
    await release();
  }
}

export function connectorLifecycleDataDir(): string {
  return process.env.PDPP_CONNECTOR_PRELOAD_DIR || process.env.PDPP_DATA_DIR || resolve(process.cwd(), "data");
}
