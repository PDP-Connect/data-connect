// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-process directory lock for installer state under the data directory.
 *
 * `mkdir` is the atomic acquire. The directory holds `owner.json` with the
 * owner's pid and a token that is unique to one process start. A pid alone
 * cannot identify the owner: in a container the server gets the same pid on
 * every start, so a lock left by a crashed process looks held by the live one.
 * A legacy `pid` file is still written so an older build can read the lock.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const OWNER_FILE = "owner.json"
const LEGACY_PID_FILE = "pid"
/** A lock without an owner record is a crash between mkdir and the owner write. */
const UNOWNED_LOCK_GRACE_MS = 60_000

/** Unique to this process start. */
const PROCESS_LOCK_TOKEN = randomUUID()

interface HeldLock {
  readonly acquiredAt: string
  timedOutAt: string | null
}

/** Locks this process acquired and has not released yet, by lock directory. */
const heldLocks = new Map<string, HeldLock>()

export interface DirectoryLockOwner {
  readonly acquiredAt: string | null
  readonly pid: number
  /** Null for a lock written by a build that recorded only the pid. */
  readonly token: string | null
}

export type DirectoryLockDecision =
  { readonly action: "busy"; readonly reason: string } | { readonly action: "reclaim"; readonly reason: string }

/**
 * Decide whether an existing lock may be taken over.
 *
 * Reclaim when the owner record is missing past the grace period, when this
 * process wrote the lock but no longer holds it (an aborted operation skipped
 * its release), when an earlier process with this same pid wrote it, or when
 * the owner pid is dead. Everything else is busy.
 */
export function decideDirectoryLockReclaim(input: {
  readonly isPidAlive: (pid: number) => boolean
  readonly lockAgeMs: number
  readonly owner: DirectoryLockOwner | null
  readonly self: { readonly heldByThisProcess: boolean; readonly pid: number; readonly token: string }
}): DirectoryLockDecision {
  const { owner, self } = input
  if (!owner) {
    return input.lockAgeMs > UNOWNED_LOCK_GRACE_MS
      ? { action: "reclaim", reason: "lock has no owner record" }
      : { action: "busy", reason: "lock is being created" }
  }
  if (owner.token === self.token) {
    return self.heldByThisProcess
      ? { action: "busy", reason: "held by an operation in this process" }
      : { action: "reclaim", reason: "left by an aborted operation in this process" }
  }
  if (owner.pid === self.pid) {
    return { action: "reclaim", reason: "left by an earlier process with the same pid" }
  }
  return input.isPidAlive(owner.pid)
    ? { action: "busy", reason: `held by live process ${String(owner.pid)}` }
    : { action: "reclaim", reason: `owner process ${String(owner.pid)} is gone` }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readOwner(lockDir: string): DirectoryLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf8")) as Record<string, unknown>
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string"
    ) {
      return {
        acquiredAt: typeof parsed.acquired_at === "string" ? parsed.acquired_at : null,
        pid: parsed.pid,
        token: parsed.token,
      }
    }
  } catch {
    // Fall through to the legacy pid file.
  }
  try {
    const pid = Number.parseInt(readFileSync(join(lockDir, LEGACY_PID_FILE), "utf8").trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? { acquiredAt: null, pid, token: null } : null
  } catch {
    return null
  }
}

function sameOwner(left: DirectoryLockOwner | null, right: DirectoryLockOwner | null): boolean {
  return left?.pid === right?.pid && left?.token === right?.token
}

function lockAgeMs(lockDir: string): number {
  try {
    return Date.now() - statSync(lockDir).mtimeMs
  } catch {
    return 0
  }
}

/** Move a judged-stale lock aside. False when it vanished or changed owner meanwhile. */
function reclaim(lockDir: string, judged: DirectoryLockOwner | null): boolean {
  const staleDir = `${lockDir}.stale.${PROCESS_LOCK_TOKEN}.${String(Date.now())}`
  try {
    renameSync(lockDir, staleDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false
    }
    throw error
  }
  if (!sameOwner(readOwner(staleDir), judged)) {
    // Another process reclaimed and re-acquired between our read and rename.
    renameSync(staleDir, lockDir)
    return false
  }
  rmSync(staleDir, { force: true, recursive: true })
  return true
}

function busyDetail(lockDir: string, owner: DirectoryLockOwner | null): string {
  const held = heldLocks.get(lockDir)
  if (owner?.token === PROCESS_LOCK_TOKEN && held?.timedOutAt) {
    return ` It exceeded its deadline at ${held.timedOutAt} and has not stopped; restart the server to clear it.`
  }
  if (!owner) {
    return ""
  }
  return ` Held by pid ${String(owner.pid)}${owner.acquiredAt ? ` since ${owner.acquiredAt}` : ""}.`
}

export interface DirectoryLock {
  /** Record that the guarded operation missed its deadline; later busy errors say so. */
  markTimedOut: () => void
  release: () => void
}

export function acquireDirectoryLock(dataDir: string, lockName: string, busyMessage: string): DirectoryLock {
  mkdirSync(dataDir, { recursive: true })
  const lockDir = join(dataDir, lockName)
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }
      const owner = readOwner(lockDir)
      const decision = decideDirectoryLockReclaim({
        isPidAlive,
        lockAgeMs: lockAgeMs(lockDir),
        owner,
        self: { heldByThisProcess: heldLocks.has(lockDir), pid: process.pid, token: PROCESS_LOCK_TOKEN },
      })
      if (decision.action === "reclaim" && reclaim(lockDir, owner)) {
        continue
      }
      throw new Error(`${busyMessage}${busyDetail(lockDir, owner)}`, { cause: error })
    }
  }
  const acquiredAt = new Date().toISOString()
  const held: HeldLock = { acquiredAt, timedOutAt: null }
  heldLocks.set(lockDir, held)
  try {
    writeFileSync(
      join(lockDir, OWNER_FILE),
      `${JSON.stringify({ acquired_at: acquiredAt, pid: process.pid, token: PROCESS_LOCK_TOKEN })}\n`,
      { mode: 0o600 }
    )
    writeFileSync(join(lockDir, LEGACY_PID_FILE), `${String(process.pid)}\n`, { mode: 0o600 })
  } catch (error) {
    heldLocks.delete(lockDir)
    rmSync(lockDir, { force: true, recursive: true })
    throw error
  }
  let released = false
  return {
    markTimedOut: () => {
      if (!released) held.timedOutAt = new Date().toISOString()
    },
    release: () => {
      if (released) {
        return
      }
      released = true
      heldLocks.delete(lockDir)
      // Remove only our own lock; never one another process took over.
      if (readOwner(lockDir)?.token === PROCESS_LOCK_TOKEN) {
        rmSync(lockDir, { force: true, recursive: true })
      }
    },
  }
}
