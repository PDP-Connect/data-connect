// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-process lock for installer state under the data directory.
 *
 * The lock is held by the kernel, not by a path that may or may not exist.
 * The holder keeps an exclusive SQLite transaction open on `<name>.db`.
 * SQLite takes an OS byte-range lock for it: fcntl on Linux and macOS,
 * LockFileEx on Windows. The OS drops that lock when the holder process ends,
 * on a crash too, so no process ever has to decide that another one is dead
 * and remove its lock. A live lock cannot look absent, and a pid reused after
 * a container restart cannot keep a dead lock alive.
 *
 * The `<name>.owner` file records the holder's pid, a token unique to its
 * process start, and when it took the lock. It is diagnostics for the busy
 * message only; no decision reads it. The holder removes it before it unlocks.
 *
 * An older build locked by creating the `<name>/` directory. While such a
 * directory exists, the lock is busy, unless it is provably stale in this
 * process's PID namespace: an owner pid that does not exist here and is not
 * this process's pid, or no owner record past the grace period that build
 * also used. This build never renames or removes that directory. An owner
 * with this process's pid is ambiguous (a restarted container, or a live
 * server in another container), so it stays busy until an operator removes
 * the directory.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteDriver } from "../sqlite-driver.ts";

type LockConnection = InstanceType<typeof SqliteDriver>;

/** Unique to this process start. */
const PROCESS_LOCK_TOKEN = randomUUID();

interface HeldLock {
  readonly connection: LockConnection;
  timedOutAt: string | null;
}

/** Locks this process holds, by lock file. The map also keeps each connection reachable. */
const heldLocks = new Map<string, HeldLock>();

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Installer lock path ${path} is a symbolic link.`);
  }
}

/** Take the OS lock without waiting, or return null when another holder has it. */
function tryLockFile(lockPath: string): LockConnection | null {
  // timeout 0: a held lock fails at once with SQLITE_BUSY instead of waiting.
  const connection = new SqliteDriver(lockPath, { timeout: 0 });
  try {
    // In rollback-journal mode this takes the OS write lock at once, even on
    // an empty file. Nothing is ever written: the transaction is only a lock.
    connection.exec("BEGIN EXCLUSIVE");
    return connection;
  } catch (error) {
    connection.close();
    if (isSqliteBusy(error)) {
      return null;
    }
    throw error;
  }
}

function busyDetail(lockPath: string, ownerPath: string): string {
  const timedOutAt = heldLocks.get(lockPath)?.timedOutAt;
  if (timedOutAt) {
    return ` It exceeded its deadline at ${timedOutAt} and has not stopped; restart the server to clear it.`;
  }
  try {
    const [pid, , acquiredAt] = readFileSync(ownerPath, "utf8").split("\n");
    return /^\d+$/.test(pid ?? "") ? ` Held by pid ${String(pid)}${acquiredAt ? ` since ${acquiredAt}` : ""}.` : "";
  } catch {
    // The holder has not written its owner record yet, or is releasing.
    return "";
  }
}

/** Same grace period as the `mkdir` build: an owner record can lag the mkdir. */
const LEGACY_UNOWNED_GRACE_MS = 60_000;

function legacyOwnerPid(legacyDir: string): number | null {
  for (const file of ["owner", "pid"]) {
    try {
      const value = Number(readFileSync(join(legacyDir, file), "utf8").split("\n")[0]?.trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Try the next record.
    }
  }
  return null;
}

/** Why an older build's lock directory keeps the lock busy, or null if it is absent or provably stale. */
function legacyLockHolder(legacyDir: string): string | null {
  let mtimeMs: number;
  try {
    const stat = statSync(legacyDir);
    if (!stat.isDirectory()) return null;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }
  const pid = legacyOwnerPid(legacyDir);
  const detail = ` An older build's lock directory ${legacyDir} is held`;
  if (pid === null) {
    return Date.now() - mtimeMs > LEGACY_UNOWNED_GRACE_MS ? null : `${detail} and is being created.`;
  }
  if (pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    }
  }
  return `${detail} by pid ${String(pid)}; if no older server uses this data directory, remove it.`;
}

export interface DirectoryLock {
  /** Record that the guarded operation missed its deadline; later busy errors say so. */
  markTimedOut: () => void;
  release: () => void;
}

/** Take the lock, or return the reason it is busy. */
function attemptDirectoryLock(dataDir: string, lockName: string): DirectoryLock | string {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, `${lockName}.db`);
  const ownerPath = join(dataDir, `${lockName}.owner`);
  refuseSymlink(lockPath);
  refuseSymlink(ownerPath);
  // SQLite also refuses a second connection in this process, but the map
  // must be checked first: it is what knows that the holder missed a deadline.
  const connection = heldLocks.has(lockPath) ? null : tryLockFile(lockPath);
  if (!connection) {
    return busyDetail(lockPath, ownerPath);
  }
  // Checked while holding the OS lock, so no build of this kind enters meanwhile.
  const legacyHolder = legacyLockHolder(join(dataDir, lockName));
  if (legacyHolder) {
    connection.close();
    return legacyHolder;
  }
  const held: HeldLock = { connection, timedOutAt: null };
  heldLocks.set(lockPath, held);
  const acquiredAt = new Date().toISOString();
  try {
    writeFileSync(ownerPath, `${String(process.pid)}\n${PROCESS_LOCK_TOKEN}\n${acquiredAt}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics only: the OS lock is what excludes other processes.
  }
  let released = false;
  return {
    markTimedOut: () => {
      if (!released) held.timedOutAt = new Date().toISOString();
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      heldLocks.delete(lockPath);
      try {
        // Still locked here, so this removes our own record, never a successor's.
        rmSync(ownerPath, { force: true });
      } catch {
        // A stale owner record is harmless; the next holder overwrites it.
      }
      try {
        connection.exec("ROLLBACK");
      } finally {
        // Closing the connection is what gives the OS lock back.
        connection.close();
      }
    },
  };
}

/** Take the lock, or return null when another holder has it. */
export function tryAcquireDirectoryLock(dataDir: string, lockName: string): DirectoryLock | null {
  const attempt = attemptDirectoryLock(dataDir, lockName);
  return typeof attempt === "string" ? null : attempt;
}

export function acquireDirectoryLock(dataDir: string, lockName: string, busyMessage: string): DirectoryLock {
  const attempt = attemptDirectoryLock(dataDir, lockName);
  if (typeof attempt === "string") {
    throw new Error(`${busyMessage}${attempt}`);
  }
  return attempt;
}
