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
 * A `<name>/` directory left by an older build that locked with `mkdir` is
 * ignored. Two builds that lock differently must not share a data directory.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export interface DirectoryLock {
  /** Record that the guarded operation missed its deadline; later busy errors say so. */
  markTimedOut: () => void;
  release: () => void;
}

export function acquireDirectoryLock(dataDir: string, lockName: string, busyMessage: string): DirectoryLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, `${lockName}.db`);
  const ownerPath = join(dataDir, `${lockName}.owner`);
  refuseSymlink(lockPath);
  refuseSymlink(ownerPath);
  // SQLite also refuses a second connection in this process, but the map
  // must be checked first: it is what knows that the holder missed a deadline.
  const connection = heldLocks.has(lockPath) ? null : tryLockFile(lockPath);
  if (!connection) {
    throw new Error(`${busyMessage}${busyDetail(lockPath, ownerPath)}`);
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
