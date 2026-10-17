// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The reference-implementation cohort runs its tests inside Stryker's sandbox,
// a copy of the cohort tree. Two settings decide whether that copy can run the
// tests the way the cohort's own suite does, and on PR #141 both were wrong:
//
//   - `ignorePatterns` left out `openapi/`, which a selected test reads, so the
//     test failed with ENOENT in the sandbox while passing in the repository.
//   - Stryker's default `disableTypeChecks` rewrote every test-tree JavaScript
//     and TypeScript file to prepend `// @ts-nocheck`. A rewritten file loses its
//     mode, and the Slack stub the compiled-Slack tests execute directly lost
//     its executable bit.
//
// A third setting decides whether Stryker hears the result: the command
// runner's `exec` kills a command whose output passes 1 MiB.
//
// Any one of these rejects the baseline, which makes every mutant inconclusive.

import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const COHORT_ROOT = "reference-implementation"

function testSources(directory: string): string[] {
  const sources: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...testSources(path))
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      sources.push(path)
    }
  }
  return sources
}

describe("reference-implementation mutation sandbox", () => {
  it("copies files unrewritten, so executable test fixtures keep their mode", async () => {
    const configPath = "../../reference-implementation/stryker.config.mjs"
    const { default: config } = await import(configPath)
    // No checker runs in this cohort, so the header would protect nothing.
    expect(config.checkers).toEqual([])
    expect(config.disableTypeChecks).toBe(false)
  })

  it("does not ignore a directory that a cohort test reads", async () => {
    const configPath = "../../reference-implementation/stryker.config.mjs"
    const { default: config } = await import(configPath)
    const plainDirectories = (config.ignorePatterns as string[]).filter(
      (pattern) => !/[*?[\]{}!]/.test(pattern)
    )
    const offenders: string[] = []
    for (const path of testSources(join(COHORT_ROOT, "test"))) {
      const source = readFileSync(path, "utf8")
      for (const directory of plainDirectories) {
        if (source.includes(`../${directory}/`)) {
          offenders.push(`${path} reads ${directory}/`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("hands Stryker a bounded tail of the output and the command's own exit status", async () => {
    const configPath = "../../reference-implementation/stryker.config.mjs"
    const { default: config } = await import(configPath)
    // A stand-in `node` that prints 2 MiB, well past exec's 1 MiB limit, ends
    // with the line a reader needs, and fails the way a failing suite does.
    const bin = mkdtempSync(join(tmpdir(), "pdpp-bounded-output-"))
    try {
      const fakeNode = join(bin, "node")
      writeFileSync(
        fakeNode,
        `#!/bin/sh\nhead -c 2097152 /dev/zero | tr '\\0' x\necho\necho "failing tests: the last line" >&2\nexit 3\n`
      )
      chmodSync(fakeNode, 0o755)
      const run = spawnSync("/bin/sh", ["-c", config.commandRunner.command], {
        cwd: bin,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        maxBuffer: 8 * 1024 * 1024,
      })
      expect(run.status).toBe(3)
      expect(run.stdout.length).toBeLessThan(1024 * 1024)
      expect(run.stdout.toString().trimEnd().endsWith("failing tests: the last line")).toBe(true)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
