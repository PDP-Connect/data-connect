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
 * Point the stable `<parent>/<name>` path at `generationDirectory` by
 * materialising a copy beside it and renaming it into place.
 *
 * The rename is atomic, so a reader never sees a partially-populated
 * stable path -- unlike the previous delete-then-copy, which left no
 * directory there at all for the duration of the copy.
 */
export function publishStageGeneration(targetDirectory, generationDirectory) {
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
