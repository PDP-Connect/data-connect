// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  findProcessesUsingDirectory,
  collectOldStageGenerations,
  publishStageGeneration,
} from "./stage-generations.js"

/**
 * Spawn `script` detached (via `setsid`), reparented off this test process
 * entirely, and return its pid.
 *
 * The real target of this module's process-liveness checks is never a
 * child of the Node script that finds it via `/proc` scanning -- it is a
 * sidecar owned by the Tauri/Rust supervisor. Spawning test processes with
 * plain `child_process.spawn` instead would make THIS test process their
 * parent, and a blocking, event-loop-starving poll (see `stage-generations.js`'s
 * `sleepSync`) never lets Node's own SIGCHLD reaper run in that case -- the
 * child sits as a real kernel zombie, and `kill(pid, 0)` correctly (if
 * confusingly) keeps reporting it alive for as long as the poll blocks.
 * Verified 2026-09-21: that same scenario against a `setsid`-detached
 * process (reaped by init, exactly as a production sidecar is not reaped by
 * this script) resolves in ~25ms, matching the fast path this module is
 * meant to provide.
 */
function spawnDetached(script, cwd) {
  const command = `setsid ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 & echo $!`
  const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" })
  return Number(result.stdout.trim())
}

describe("stage-generations shared staging primitives", () => {
  it("preserves an existing stage and its process while publishing the next stage", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage-generations-test-"))
    const target = join(root, "stable")
    const generationA = join(root, "gen-a")
    const generationB = join(root, "gen-b")
    mkdirSync(generationA, { recursive: true })
    mkdirSync(generationB, { recursive: true })
    writeFileSync(join(generationA, "marker.txt"), "generation-a")
    writeFileSync(join(generationB, "marker.txt"), "generation-b")

    let pid
    try {
      publishStageGeneration(target, generationA)
      expect(readFileSync(join(target, "marker.txt"), "utf8")).toBe(
        "generation-a"
      )

      // A real detached process is running from the stable path. Publication
      // must preserve its old tree and publish the new one without signalling.
      pid = spawnDetached(
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)",
        target
      )
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      expect(findProcessesUsingDirectory(target)).toContain(pid)

      publishStageGeneration(target, generationB)
      const previous = readdirSync(root).find((name) => name.startsWith("stable.previous-"))
      expect(previous).toBeDefined()
      expect(findProcessesUsingDirectory(join(root, previous))).toContain(pid)
      expect(readFileSync(join(root, previous, "marker.txt"), "utf8")).toBe("generation-a")
      expect(findProcessesUsingDirectory(target)).not.toContain(pid)
      expect(readFileSync(join(target, "marker.txt"), "utf8")).toBe("generation-b")
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("retains old generations when no owner can prove they are unused", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-generations-retain-"))
    const old = join(root, "console-old")
    const current = join(root, "console-current")
    mkdirSync(old)
    mkdirSync(current)
    try {
      expect(collectOldStageGenerations(root, "console", 1)).toEqual([])
      expect(existsSync(old)).toBe(true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("publishStageGeneration does not attempt to stop anything when the target path does not exist yet (cold start)", () => {
    // lane unifydefault-0921 makes the unified stack the default, so a
    // first launch on a clean machine reaches staging with no prior
    // `reference-stack` directory at all -- stopProcessesUsingDirectory
    // must not be invoked (there's nothing to stop, and findProcessesUsingDirectory
    // would just scan /proc for zero benefit) and the publish must succeed
    // as a plain first-time creation.
    const root = mkdtempSync(join(tmpdir(), "stage-generations-cold-"))
    const target = join(root, "stable")
    const generation = join(root, "gen-a")
    mkdirSync(generation, { recursive: true })
    writeFileSync(join(generation, "marker.txt"), "first-build")
    try {
      expect(existsSync(target)).toBe(false)
      publishStageGeneration(target, generation)
      expect(readFileSync(join(target, "marker.txt"), "utf8")).toBe(
        "first-build"
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

})
