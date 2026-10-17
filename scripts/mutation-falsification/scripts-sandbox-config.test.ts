// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What the scripts cohort's Stryker sandbox contains.
//
// The scripts cohort runs from the repository root and copies the working tree
// into its sandbox, minus `ignorePatterns`. A revision that touches a test in
// `scripts/mutation-falsification/` selects it for that cohort's baseline, so
// the sandbox has to hold whatever such a test reads. On PR #141 the reference
// implementation was excluded whole, `reference-runner-config.test.ts` could
// not import `reference-implementation/stryker.config.mjs`, and the baseline was
// rejected.
//
// The file list comes from Stryker's own project reader, so this checks the
// rule semantics Stryker applies rather than a restatement of them. The reader
// is internal to @stryker-mutator/core; if an upgrade moves it, this import
// fails loudly rather than passing.

import { readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

async function scriptsSandboxInputs(): Promise<string[]> {
  // The package entry initialises modules the reader depends on; importing the
  // reader alone hits an initialisation-order error.
  await import("@stryker-mutator/core")
  const readerPath = resolve("node_modules/@stryker-mutator/core/dist/src/fs/project-reader.js")
  const { ProjectReader } = await import(pathToFileURL(readerPath).href)
  const configPath = "../../stryker.scripts.config.mjs"
  const { default: config } = await import(configPath)
  const quiet = { debug() {}, info() {}, warn() {} }
  const reader = new ProjectReader({ readdir }, quiet, {
    mutate: [],
    tempDirName: ".stryker-tmp",
    ignorePatterns: config.ignorePatterns,
    incremental: false,
    incrementalFile: "reports/stryker-incremental.json",
    force: false,
    htmlReporter: { fileName: "reports/mutation/mutation.html" },
    jsonReporter: { fileName: "reports/mutation/mutation.json" },
  })
  const root = process.cwd()
  const files: string[] = await reader.resolveInputFileNames()
  return files.map((file) => file.slice(root.length + 1))
}

describe("scripts cohort sandbox", () => {
  it("holds the reference configuration and test tree that the reference-runner test reads, and nothing else of the reference implementation", async () => {
    const reference = (await scriptsSandboxInputs()).filter((file) =>
      file.startsWith("reference-implementation/")
    )
    expect(reference).toContain("reference-implementation/stryker.config.mjs")
    expect(reference.some((file) => file.startsWith("reference-implementation/test/"))).toBe(true)
    const outside = reference.filter(
      (file) =>
        file !== "reference-implementation/stryker.config.mjs" &&
        !file.startsWith("reference-implementation/test/")
    )
    expect(outside).toEqual([])
  })
})
