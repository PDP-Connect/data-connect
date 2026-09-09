// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mutation configuration for the reference-implementation cohort.
//
// This cohort runs on `node --test` rather than Vitest, so Stryker drives it
// through the command runner. Three consequences follow, and each is handled
// explicitly rather than left to the tool:
//
//   1. The command runner reports no individual test identities, so per-test
//      coverage analysis is not available and `coverageAnalysis` is "off". Any
//      other setting would claim test-level data the runner cannot supply.
//   2. Because there is no per-test data, test selection has to happen inside
//      the command itself -- Stryker's own `testFiles` option is not supported
//      for this runner and would be silently ignored.
//   3. With no test identities, Stryker's incremental reuse has its weakest
//      signal exactly where each mutant costs the most. The workflow therefore
//      keys reuse on a recorded execution-input identity and forces a fresh run
//      of the current scope whenever any of those inputs changed or is unknown.
//
// The reference implementation runs TypeScript sources directly under Node's
// native type stripping, so there is no build step to instrument: the sandbox
// contains mutated `.ts` files and Node executes them as-is. That removes the
// source/emitted parity question this cohort would otherwise have.
//
// No duration, budget, mutant-count, or admission threshold appears here.

import { readFileSync } from "node:fs"

// The workflow writes the tests to run for this attempt, one path per line,
// derived from the same diff that produced the mutate list. A missing file
// means "no selection recorded", and the command runs the suite the ordinary
// runner would, rather than quietly narrowing to nothing.
function selectedTestArguments() {
  try {
    const listed = readFileSync("reports/mutation/reference-implementation/selected-tests.txt", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (listed.length > 0) {
      return listed
    }
  } catch {
    // Fall through to the full selection below.
  }
  return ["test/"]
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  coverageAnalysis: "off",
  commandRunner: {
    // Test selection lives inside the command, which is the only place this
    // runner can express it. `--test` on explicit paths keeps the selection
    // visible in the retained command string, so a reader of the receipt can
    // see exactly which tests a survivor survived.
    command: `node --test ${selectedTestArguments().join(" ")}`,
  },

  // Populated from the pull request diff by the workflow; empty means this
  // revision touched no reference-implementation production source.
  mutate: [],

  incremental: true,
  incrementalFile: "reports/mutation/reference-implementation/stryker-incremental.json",

  reporters: ["json", "html", "progress"],
  jsonReporter: { fileName: "reports/mutation/reference-implementation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/reference-implementation/mutation.html" },

  inPlace: false,
  checkers: [],

  // Stryker copies the working tree into the sandbox, so anything not needed to
  // run this cohort's tests is excluded. `node_modules` is deliberately absent
  // from this list: the tests import from it, and Stryker links it into the
  // sandbox rather than copying it.
  ignorePatterns: ["reports", "fixtures/large", "vendor/*/dist", "docs", "openapi"],

  tempDirName: ".stryker-tmp/reference-implementation",
}
