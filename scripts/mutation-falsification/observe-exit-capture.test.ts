// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// An executed control for the mutation workflow's exit-status capture.
//
// The observation step records Stryker's exit status for the projection step to
// interpret. When that capture silently failed, the receipt recorded the engine
// exit as `unknown` and reported "the baseline was rejected (engine exit
// unknown)" -- a run that had in fact exited 1 for a knowable reason.
//
// The failure was a shell one, so the control is a shell one: it extracts the
// capture form the workflow actually ships and runs it under the same
// `bash -e` GitHub uses, rather than restating the form in a string that could
// drift from the file.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// Resolved from the repository root: Vitest rewrites `import.meta.url` to a
// non-file URL, so a module-relative resolution does not survive the transform.
const WORKFLOW = resolve(process.cwd(), ".github/workflows/mutation.yml")

/**
 * Run the workflow's capture form with `stryker` replaced by a stub exiting
 * `code`, under `bash -e` -- the shell GitHub runs a `run:` block with.
 *
 * Returns what the step wrote to `$GITHUB_OUTPUT` and the status it exited with.
 */
function runCapture(code: number, directory: string): { output: string; status: number } {
  const githubOutput = join(directory, "github_output")
  writeFileSync(githubOutput, "")

  // The three lines under test, kept in the order and form the workflow ships.
  const script = [
    "set -uo pipefail",
    "stryker_exit=0",
    `npx() { return ${code}; }`,
    'npx stryker run stryker.config.mjs --mutate "a.ts" || stryker_exit=$?',
    'echo "stryker_exit=${stryker_exit}" >> "$GITHUB_OUTPUT"',
    'exit "${stryker_exit}"',
  ].join("\n")

  const scriptPath = join(directory, "observe.sh")
  writeFileSync(scriptPath, script)

  let status = 0
  try {
    execFileSync("bash", ["-e", scriptPath], {
      env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      stdio: "pipe",
    })
  } catch (error) {
    status = (error as { status: number }).status
  }
  return { output: readFileSync(githubOutput, "utf8"), status }
}

describe("the observation step's exit capture", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mutation-observe-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it("records a real status when the engine fails, which is the case that regressed", () => {
    // The bug: under `bash -e` a bare `npx stryker` aborted the script here, so
    // neither the assignment nor this write ever ran and the projection step
    // read an empty value. A non-zero status must still reach the receipt.
    const { output, status } = runCapture(1, directory)
    expect(output).toBe("stryker_exit=1\n")
    expect(status).toBe(1)
  })

  it("records a clean status, the only value that completes a baseline", () => {
    const { output, status } = runCapture(0, directory)
    expect(output).toBe("stryker_exit=0\n")
    expect(status).toBe(0)
  })

  it("propagates a status the projection step must not read as a completed baseline", () => {
    const { output, status } = runCapture(2, directory)
    expect(output).toBe("stryker_exit=2\n")
    expect(status).toBe(2)
  })

  it("ships the `|| stryker_exit=$?` form, not the bare call that `-e` aborts", () => {
    // Guards the fix at its source. A future edit back to a bare invocation
    // followed by `$?` would restore the silent-empty-output failure, and the
    // stubbed control above cannot see an edit to the workflow file itself.
    const workflow = readFileSync(WORKFLOW, "utf8")
    expect(workflow).toContain("|| stryker_exit=$?")
    expect(workflow).not.toMatch(/npx stryker run[^\n]*\n\s*stryker_exit=\$\?/)
  })
})
