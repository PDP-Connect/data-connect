// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The reference-implementation row's attempt bound has to fit the job's time
// limit at the runner's actual concurrency.
//
// The bound (`max-changed-lines`, `max-tests`) was calibrated when the cohort ran
// four Stryker workers. It now runs one (reference-implementation/stryker.config.mjs),
// so trials no longer overlap and the same bound costs several times as long.
// This control holds the workflow's two numbers to the measurements that
// justify them, so raising either without re-measuring fails here rather than as
// a killed six-hour job that leaves no evidence.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/mutation.yml"),
  "utf8"
)

// Measured 2026-10-18 under `test-sandbox` (4 CPUs, 8 GB), one Stryker worker,
// on server/introspection-http.ts with 8 selected test files, one of them slow
// (about 30 s alone): 16 mutants in 8 min 20 s = 31.3 s a mutant. See the
// comment beside `max-changed-lines` for the rest of the measurements.
const SLOW_SELECTION_SECONDS_PER_MUTANT = 31.3
// The densest scope on record: PR #83, 179 mutants from 34 changed lines.
const DENSEST_MUTANTS_PER_LINE = 179 / 34
// A hosted runner is assumed to be this many times slower than the sandbox.
const RUNNER_SLOWDOWN = 2
// Checkout, install, builds and the dry run. An allowance, not a measurement.
const FIXED_OVERHEAD_MINUTES = 20

function referenceRowBound(): number {
  const row = workflow.slice(
    workflow.indexOf("- cohort: reference-implementation")
  )
  const match = /max-changed-lines: "(\d+)"/.exec(row)
  if (match === null) {
    throw new Error("the reference-implementation row has no max-changed-lines")
  }
  return Number(match[1])
}

function jobTimeoutMinutes(): number {
  const match = /timeout-minutes: (\d+)/.exec(workflow)
  if (match === null) {
    throw new Error("the mutation job has no timeout-minutes")
  }
  return Number(match[1])
}

describe("the reference-implementation attempt bound", () => {
  it("fits the job time limit at one worker in the worst measured case", () => {
    const worstMinutes =
      (referenceRowBound() *
        DENSEST_MUTANTS_PER_LINE *
        SLOW_SELECTION_SECONDS_PER_MUTANT *
        RUNNER_SLOWDOWN) /
        60 +
      FIXED_OVERHEAD_MINUTES

    expect(worstMinutes).toBeLessThanOrEqual(jobTimeoutMinutes())
  })
})
