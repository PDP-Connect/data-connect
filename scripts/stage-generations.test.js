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
import { describe, expect, it, vi } from "vitest"
import {
  collectOldStageGenerations,
  findProcessesUsingDirectory,
  installStageGeneration,
  publishStageGeneration,
} from "./stage-generations.js"

/**
 * Spawn `script` detached (via `setsid`), reparented off this test process
 * entirely, and return its pid. This models a sidecar owned by a different
 * process, which lets the test prove publication never signals it.
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(collectOldStageGenerations(root, "console", 1)).toEqual([])
      expect(existsSync(old)).toBe(true)
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("staged disk use can grow without bound"),
      )
    } finally {
      warning.mockRestore()
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("reuses a deterministic generation only after its contents are approved", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-generations-reuse-"))
    const generation = join(root, "console-content-id")
    const candidate = join(root, "candidate")
    mkdirSync(generation)
    mkdirSync(candidate)
    writeFileSync(join(generation, "marker.txt"), "same")
    writeFileSync(join(candidate, "marker.txt"), "same")
    try {
      installStageGeneration(
        generation,
        candidate,
        (existing, next) =>
          readFileSync(join(existing, "marker.txt"), "utf8") ===
          readFileSync(join(next, "marker.txt"), "utf8"),
      )
      expect(existsSync(candidate)).toBe(false)
      expect(readFileSync(join(generation, "marker.txt"), "utf8")).toBe("same")

      mkdirSync(candidate)
      writeFileSync(join(candidate, "marker.txt"), "different")
      expect(() =>
        installStageGeneration(
          generation,
          candidate,
          (existing, next) =>
            readFileSync(join(existing, "marker.txt"), "utf8") ===
            readFileSync(join(next, "marker.txt"), "utf8"),
        ),
      ).toThrow(/refusing to replace/)
      expect(readFileSync(join(generation, "marker.txt"), "utf8")).toBe("same")
      expect(existsSync(candidate)).toBe(true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("publishes a new stage on cold start", () => {
    // lane unifydefault-0921 makes the unified stack the default, so a
    // first launch on a clean machine reaches staging with no prior
    // `reference-stack` directory at all. Publication creates it directly.
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
