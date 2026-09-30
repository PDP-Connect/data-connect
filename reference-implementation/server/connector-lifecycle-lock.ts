// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function acquireSqliteSync(connectorId: string): () => void {
  validateConnectorId(connectorId);
  sqliteLockTable();
  const token = randomUUID();
  const acquired = getDb()
    .transaction(() => {
      const row = getDb()
        .prepare("SELECT owner_pid FROM connector_lifecycle_locks WHERE connector_id=?")
        .get<{ owner_pid: number }>(connectorId);
      if (row) {
        let alive = true;
        try {
          process.kill(row.owner_pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
        if (alive) return false;
        getDb().prepare("DELETE FROM connector_lifecycle_locks WHERE connector_id=?").run(connectorId);
      }
      getDb()
        .prepare("INSERT INTO connector_lifecycle_locks(connector_id, owner_token, owner_pid) VALUES(?, ?, ?)")
        .run(connectorId, token, process.pid);
      return true;
    })
    .immediate();
  if (!acquired) throw new Error("Connector lifecycle operation is busy.");
  return () => {
    getDb()
      .prepare("DELETE FROM connector_lifecycle_locks WHERE connector_id=? AND owner_token=?")
      .run(connectorId, token);
  };
}

async function acquireSqliteAsync(connectorId: string): Promise<() => void> {
  for (;;) {
    try {
      return acquireSqliteSync(connectorId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Connector lifecycle operation is busy.") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

async function withProcessLocalLifecycleLock<T>(connectorId: string, operation: () => Promise<T>): Promise<T> {
  const previous = processLocalLocks.get(connectorId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  processLocalLocks.set(connectorId, next);
  await previous;
  const nested = new Set(heldLifecycleLocks.getStore() ?? []);
  nested.add(connectorId);
  try {
    return await heldLifecycleLocks.run(nested, operation);
  } finally {
    release();
    if (processLocalLocks.get(connectorId) === next) processLocalLocks.delete(connectorId);
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

export async function withConnectorLifecycleLock<T>(
  _dataDir: string,
  connectorId: string,
  operation: () => Promise<T>
): Promise<T> {
  if (heldLifecycleLocks.getStore()?.has(connectorId)) return operation();
  validateConnectorId(connectorId);
  const nested = new Set(heldLifecycleLocks.getStore() ?? []);
  nested.add(connectorId);
  if (isPostgresStorageBackend()) {
    const lockId = createHash("sha256").update(`connector-lifecycle:${connectorId}`).digest().readBigInt64BE(0);
    return await withPostgresTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId.toString()]);
      return await heldLifecycleLocks.run(nested, operation);
    });
  }
  if (!getDb()) return await withProcessLocalLifecycleLock(connectorId, operation);
  const release = await acquireSqliteAsync(connectorId);
  try {
    return await heldLifecycleLocks.run(nested, operation);
  } finally {
    await release();
  }
}

export function connectorLifecycleDataDir(): string {
  return process.env.PDPP_CONNECTOR_PRELOAD_DIR || process.env.PDPP_DATA_DIR || resolve(process.cwd(), "data");
}
