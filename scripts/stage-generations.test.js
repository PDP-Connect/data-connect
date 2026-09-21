// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  findProcessesUsingDirectory,
  publishStageGeneration,
  stopProcessesUsingDirectory,
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
  it("publishStageGeneration stops a live process at the target path -- including one that ignores SIGTERM -- before swapping its contents", async () => {
    // The property BOTH ensure-console-stack.js and ensure-reference-stack.js
    // depend on by calling this function: a live process whose cwd is the
    // STABLE path (this is what src-tauri/src/unified.rs's
    // console_process_spec/ri_process_spec actually spawn with as `cwd` --
    // never a generation directory) must be confirmed gone before the swap
    // beneath it proceeds, not merely signalled and hoped for. Measured live
    // 2026-09-21: a fixed sleep-then-swap was not sufficient -- three real
    // incidents against the console, most recently within the hour of this
    // fix, `InvariantError: client reference manifest for route "/connect"
    // does not exist`.
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

      // A real, detached process (see spawnDetached), deliberately ignoring
      // SIGTERM, whose cwd is the STABLE path -- surviving the swap below
      // would mean the fix only handles processes that exit cleanly on the
      // first signal, which a busy or stuck server is not guaranteed to do.
      pid = spawnDetached(
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)",
        target
      )
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      expect(findProcessesUsingDirectory(target)).toContain(pid)

      publishStageGeneration(target, generationB)

      // The process must be gone (escalated to SIGKILL) by the time this
      // call returns -- not eventually, not on a best-effort basis.
      expect(findProcessesUsingDirectory(target)).not.toContain(pid)
      expect(readFileSync(join(target, "marker.txt"), "utf8")).toBe(
        "generation-b"
      )
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

  it("stopProcessesUsingDirectory is a no-op when nothing is using the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-generations-noop-"))
    const target = join(root, "empty")
    mkdirSync(target, { recursive: true })
    try {
      expect(() => stopProcessesUsingDirectory(target)).not.toThrow()
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it("stopProcessesUsingDirectory returns promptly once a cooperative process exits on SIGTERM, without waiting out the full graceful timeout", async () => {
    // A process that DOES exit cleanly on SIGTERM must not make callers
    // pay the full gracefulTimeoutMs -- the wait is a poll with a ceiling,
    // not a fixed sleep, so a well-behaved server restages fast.
    const root = mkdtempSync(join(tmpdir(), "stage-generations-fast-"))
    const target = join(root, "stable")
    mkdirSync(target, { recursive: true })
    let pid
    try {
      pid = spawnDetached("setTimeout(() => {}, 30000)", target)
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      expect(findProcessesUsingDirectory(target)).toContain(pid)

      const started = Date.now()
      stopProcessesUsingDirectory(target, 5000)
      const elapsedMs = Date.now() - started

      expect(findProcessesUsingDirectory(target)).not.toContain(pid)
      expect(
        elapsedMs,
        "a process that exits cleanly on SIGTERM must not cost the full graceful timeout"
      ).toBeLessThan(4000)
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
})
