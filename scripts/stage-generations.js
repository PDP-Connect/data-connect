// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Immutable build directories for the staged sidecars.
 *
 * ## The incident this exists for
 *
 * Staging used to delete and replace the fixed `reference-stack/<name>`
 * path. That is atomic at the filesystem level but still pulls the
 * directory out from under any server already running inside it: the OS
 * keeps the process alive against the now-unlinked inode (its
 * `/proc/<pid>/cwd` reads `(deleted)`), so it keeps answering
 * server-rendered HTML from memory while every static asset request 404s,
 * because a Next server reads its build manifest once at boot and never
 * re-reads it.
 *
 * Reproduced 2026-09-21 against a minimal server with the old sequence:
 * after an in-place restage, `/` returned `200` referencing the OLD build
 * id while `/chunk` returned `404`, and the process's cwd read
 * `.../console (deleted)`. Re-run against the generation scheme below, the
 * same restage leaves the old server serving a COHERENT old build (`200`
 * for both) with its directory intact on disk.
 *
 * The rule, from
 * `ai/research/nextjs-deployment/version-skew-fix-is-one-process-per-immutable-build-directory-not-deploymentid.md`:
 * one process per immutable build directory, cut over by changing which
 * directory is current -- never by patching or deleting files underneath a
 * live server.
 *
 * ## Why the stable path is a copy and not a symlink
 *
 * Verified 2026-09-21: `cpSync(..., { recursive: true })` PRESERVES a
 * symlink rather than following it, and both `scripts/build-prod.js`
 * (macOS) and `scripts/finalize-linux-appimage.js` (Linux) copy the stable
 * path into the packaged app that way -- so publishing a symlink would ship
 * a dangling link inside the bundle. Tauri's own `resources` glob in
 * `tauri.conf.json` has the same fixed-path requirement, and the RI's
 * `assertNoSymlinks` forbids links inside a staged tree.
 *
 * So the generation directory is the durable artifact and the stable path
 * is a materialised copy of it. That costs one extra copy per CHANGED
 * build (unchanged content reuses its generation and is skipped entirely)
 * and leaves every packaging path working untouched.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs"
import { join, resolve } from "node:path"

/**
 * Synchronous in-process sleep. Measured 2026-09-21: using `spawnSync` to
 * launch a whole new Node process as a poll tick (the original approach)
 * costs ~50ms of process-spawn overhead on top of the intended interval --
 * that overhead compounds across a poll loop into multi-second waits for a
 * process that actually exited almost immediately, which defeats the point
 * of polling instead of sleeping a fixed duration.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * How many generations to keep per sidecar. Two covers the case this
 * exists for: a previous build still has a server running from it while
 * the next one is staged.
 */
export const KEEP_GENERATIONS = 2

/**
 * PIDs of processes whose current working directory is inside
 * `targetDirectory`, via `/proc/<pid>/cwd`.
 *
 * Linux only. macOS and Windows have no equivalent without a new
 * dependency and return `[]`, which is safe in both directions here: the
 * pruner keeps a generation it cannot prove is idle only on Linux, and
 * elsewhere it may delete a generation whose process is gone anyway --
 * the STABLE path it published is a separate copy either way, so a running
 * process never loses the directory it booted from mid-flight on the
 * platform where we can detect it.
 */
export function findProcessesUsingDirectory(targetDirectory, procRoot = "/proc") {
  if (process.platform !== "linux" || !existsSync(procRoot)) return []
  const resolvedTarget = resolve(targetDirectory)
  const pids = []
  let entries
  try {
    entries = readdirSync(procRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    let cwd
    try {
      cwd = readlinkSync(join(procRoot, entry.name, "cwd"))
    } catch {
      continue
    }
    // readlink on a deleted directory yields "<path> (deleted)"; strip it
    // so a process already stranded by an older in-place restage is still
    // recognised as using this directory.
    const normalised = cwd.replace(/ \(deleted\)$/, "")
    if (normalised === resolvedTarget || normalised.startsWith(`${resolvedTarget}/`)) {
      pids.push(pid)
    }
  }
  return pids
}

/**
 * Block (synchronously) until every pid in `pids` is confirmed gone, or
 * `timeoutMs` elapses -- whichever first. Polls process liveness rather
 * than sleeping a fixed duration: measured live 2026-09-21 (three real
 * incidents against the console, most recently within the hour --
 * `InvariantError: client reference manifest for route "/connect" does not
 * exist`, a 500 that blocked testing), a fixed sleep-then-swap is not
 * actually load-bearing -- a server mid-request (or one that does not exit
 * cleanly on the first SIGTERM at all) can still be alive, with its own
 * module/file resolution mid-flight against the directory tree, at the
 * exact moment the swap below runs underneath it. There is no
 * "has released this specific directory" signal from outside a process on
 * Linux short of confirming the PID itself is gone, so this polls
 * liveness -- the strongest check actually available -- instead of
 * guessing a duration.
 */
function waitForProcessesToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = pids
  while (remaining.length > 0 && Date.now() < deadline) {
    sleepSync(25)
    remaining = remaining.filter((pid) => isProcessAlive(pid))
  }
  return remaining
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Stop any process still running from inside `targetDirectory`, so a
 * restage never leaves a server running against a directory tree that is
 * about to be swapped out from under it (see this module's own doc comment
 * for the live incident this fixes). Graceful SIGTERM first, escalating to
 * SIGKILL only for whatever is still alive after `gracefulTimeoutMs` --
 * ACTUALLY WAITS for the process to be gone (polled, see
 * `waitForProcessesToExit`) rather than a fixed sleep that may or may not
 * be long enough. A best-effort safety net for the dev/rebuild loop, not a
 * substitute for the Tauri supervisor's own lifecycle management of the
 * process IT started -- this only catches a process still bound to a stage
 * directory whose owning app session is no longer tracking it as "the one
 * to stop before restaging" (e.g. a previous dev session, or an iterative
 * rebuild against an already-launched app).
 */
export function stopProcessesUsingDirectory(targetDirectory, gracefulTimeoutMs = 3000) {
  const pids = findProcessesUsingDirectory(targetDirectory)
  if (pids.length === 0) return
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Already exited, or not ours to signal (EPERM) -- either way there
      // is nothing more this script can safely do about it.
    }
  }
  const stillAlive = waitForProcessesToExit(pids, gracefulTimeoutMs)
  for (const pid of stillAlive) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already exited in the gap between the poll and this call.
    }
  }
  // A final short wait for the OS to actually reap the SIGKILLed
  // processes (kill(pid, 0) can still briefly report a zombie as
  // "alive"); the swap below does not depend on this succeeding --
  // findProcessesUsingDirectory strips "(deleted)" so a process that
  // somehow outlives even SIGKILL's effect is still found and stopped on
  // the NEXT restage rather than silently forgotten.
  waitForProcessesToExit(stillAlive, 500)
}

/**
 * Point the stable `<parent>/<name>` path at `generationDirectory` by
 * materialising a copy beside it and renaming it into place.
 *
 * Stops whatever is currently running from `targetDirectory` FIRST, and
 * blocks until it is confirmed gone -- this is load-bearing for
 * correctness, not merely cleanup: a live process whose cwd is the stable
 * path can still be serving requests, with module/file resolution against
 * that exact directory tree in flight, at the moment the swap below
 * replaces it. `stopProcessesUsingDirectory`'s doc comment has the full
 * incident detail.
 *
 * The rename itself is atomic, so a reader never sees a partially-populated
 * stable path -- unlike the previous delete-then-copy, which left no
 * directory there at all for the duration of the copy.
 */
export function publishStageGeneration(targetDirectory, generationDirectory) {
  if (existsSync(targetDirectory)) {
    stopProcessesUsingDirectory(targetDirectory)
  }
  const swapDirectory = `${targetDirectory}.swap-${process.pid}`
  rmSync(swapDirectory, { force: true, recursive: true })
  cpSync(generationDirectory, swapDirectory, {
    recursive: true,
    dereference: true,
  })
  rmSync(targetDirectory, { force: true, recursive: true })
  renameSync(swapDirectory, targetDirectory)
}

/**
 * Delete `<name>-<id>` generation directories under `parent`, keeping the
 * newest `keep` and never removing one a live process is running from.
 *
 * Without this every changed rebuild would leave a full staged tree on
 * disk forever.
 */
export function collectOldStageGenerations(parent, name, keep = KEEP_GENERATIONS) {
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  const prefix = `${name}-`
  const generations = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(parent, entry.name))
    .sort()
  const removed = []
  for (const generation of generations.slice(
    0,
    Math.max(0, generations.length - keep)
  )) {
    if (findProcessesUsingDirectory(generation).length > 0) continue
    rmSync(generation, { force: true, recursive: true })
    removed.push(generation)
  }
  return removed
}
