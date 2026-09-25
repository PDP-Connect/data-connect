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
 * is a materialised copy of it. Each changed build also retains its previous
 * stable copy. This currently has no disk bound: no cross-platform owner
 * registry proves when those old trees are unused. Staging warns whenever
 * more than KEEP_GENERATIONS trees exist; cleanup requires that ownership
 * proof.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
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
 * Linux only. This is diagnostic; an empty result does not prove a directory
 * is unused, and the collector does not use it to delete generations.
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
 * Publish a copy at the stable path while retaining its previous directory.
 * Renaming the old tree preserves its files for existing processes; staging
 * never signals processes it does not own.
 */
export function publishStageGeneration(targetDirectory, generationDirectory) {
  const swapDirectory = `${targetDirectory}.swap-${process.pid}`
  rmSync(swapDirectory, { force: true, recursive: true })
  cpSync(generationDirectory, swapDirectory, {
    recursive: true,
    dereference: true,
  })
  const previousDirectory = `${targetDirectory}.previous-${randomUUID()}`
  const movedPrevious = existsSync(targetDirectory)
  if (movedPrevious) renameSync(targetDirectory, previousDirectory)
  try {
    renameSync(swapDirectory, targetDirectory)
  } catch (error) {
    if (movedPrevious) renameSync(previousDirectory, targetDirectory)
    throw error
  }
}

/**
 * Retain old generations until their owner can prove they are unused.
 *
 * The current process model has no cross-platform generation reference
 * registry, so pruning based on cwd scans can delete files used by a live
 * process on platforms where those scans are unavailable.
 */
export function collectOldStageGenerations(_parent, _name, _keep = KEEP_GENERATIONS) {
  let count = 0
  try {
    count = readdirSync(_parent, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(`${_name}-`),
    ).length
  } catch {
    return []
  }
  const excess = Math.max(0, count - _keep)
  if (excess > 0) {
    console.warn(
      `[stage-generations] ${_name}: retaining ${excess} prior build generation(s) and all previous stable trees; staged disk use can grow without bound until cross-platform ownership tracking is available.`,
    )
  }
  // A process may have its cwd or open files in a generation, and no
  // cross-platform owner registry can currently prove it unused.
  return []
}
