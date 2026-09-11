// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Executed controls for the projection step's pass/fail surface.
//
// The projection step is what turns a raw engine report into the check a reader
// sees first, so the interesting property is its EXIT STATUS, not its receipt --
// the receipt was always honest. These controls therefore run the shipped script
// as a subprocess and assert the status, rather than restating its conditions.
//
// The regression that motivated them: applicability is decided from the diff's
// changed line ranges before the engine runs, so a revision whose only
// production change is a non-mutable line is reported `applicable` and then
// instruments zero mutants. The step read that as absent evidence and failed.
// A one-line link change in a .tsx file failed with `stryker_exit=0` and
// `Instrumented 1 source file(s) with 0 mutant(s)`, which no work on the
// revision could clear. `not_applicable` means no file was SELECTED; it never
// meant no mutant EXISTS.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CohortDefinition,
  type ExecutionInputs,
  freezeIntent,
  parseNameStatusZ,
} from "./select-pr-files.ts"

// Resolved from the repository root: Vitest rewrites `import.meta.url` to a
// non-file URL, so a module-relative resolution does not survive the transform.
const PROJECTION = resolve(process.cwd(), "scripts/mutation-falsification/run-projection.ts")

const clientCohort: CohortDefinition = {
  name: "client",
  root: ".",
  productionPrefixes: ["src/"],
}

const inputs: ExecutionInputs = {
  cohortRoot: ".",
  configDigest: "sha256:config",
  toolVersion: "10.0.0",
  runtimeVersion: "v22.23.1",
  lockfileDigests: [{ path: "package-lock.json", digest: "sha256:lock" }],
}

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pdpp-projection-"))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

/** An intent that selects one production file, so the attempt is `applicable`. */
function applicableIntentPath(): string {
  const intent = freezeIntent({
    cohort: clientCohort,
    baseCommit: "base",
    headCommit: "head",
    diff: parseNameStatusZ("M\0src/available-sources-list.tsx\0"),
    executionInputs: inputs,
    hunks: new Map([["src/available-sources-list.tsx", [{ startLine: 12, endLine: 12 }]]]),
  })
  const path = join(workdir, "intent.json")
  writeFileSync(path, `${JSON.stringify(intent)}\n`)
  return path
}

/** Runs the shipped projection script; returns its status and streams. */
function runProjection(args: {
  readonly intent: string
  readonly report: string
  readonly strykerExit: string
}): { status: number; stdout: string; stderr: string } {
  const receipt = join(workdir, "receipt.json")
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        PROJECTION,
        "--cohort",
        "client",
        "--intent",
        args.intent,
        "--report",
        args.report,
        "--stryker-exit",
        args.strykerExit,
        "--out",
        receipt,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
    return { status: 0, stdout, stderr: "" }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
}

describe("run-projection exit surface", () => {
  it("does not fail an applicable attempt whose clean engine run found nothing to mutate", () => {
    // The exact shape of the regression: the engine completed (exit 0) and wrote
    // a report, and that report contains a file with an empty mutant list. No
    // evidence exists, but none could -- the changed line is not mutable.
    const report = join(workdir, "mutation.json")
    writeFileSync(
      report,
      `${JSON.stringify({
        schemaVersion: "1",
        files: { "src/available-sources-list.tsx": { mutants: [] } },
      })}\n`
    )

    const result = runProjection({
      intent: applicableIntentPath(),
      report,
      strykerExit: "0",
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("found no mutable code")
    expect(result.stdout).toContain("not a pass and not a failure")
    // Still reported honestly, not papered over as a clean result.
    expect(result.stdout).toContain("valid_denominator=0")
  })

  it("fails an applicable attempt that wrote no report at all", () => {
    // Absent evidence for a reason the revision COULD be responsible for: the
    // engine never got far enough to speak. This must keep failing.
    const result = runProjection({
      intent: applicableIntentPath(),
      report: join(workdir, "missing-mutation.json"),
      strykerExit: "0",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("the engine wrote no report")
  })

  it("fails an applicable attempt whose baseline was rejected", () => {
    // A non-zero engine exit makes every mutant inconclusive, so the run
    // established nothing about the suite even though a report exists.
    const report = join(workdir, "mutation.json")
    writeFileSync(
      report,
      `${JSON.stringify({
        schemaVersion: "1",
        files: { "src/available-sources-list.tsx": { mutants: [] } },
      })}\n`
    )

    const result = runProjection({
      intent: applicableIntentPath(),
      report,
      strykerExit: "1",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("the baseline was rejected")
  })
})

// Negative controls for the zero-mutant exception above.
//
// Every input here has the same two surface properties as the legitimate
// zero-mutant run: the report file exists, and the engine exited 0. Each also
// yields zero projections, because the raw-report reader is deliberately
// permissive and maps an unreadable structure to an empty observation list. So
// the projection count alone cannot tell them apart from a clean run over
// non-mutable code, and an exception keyed on file existence accepted all six.
//
// Each case is a broken mutation run reporting success -- the gate claiming the
// run was fine when it was not. They are asserted against the shipped script's
// real exit status for the same reason the positive control is: the surface is
// what a reader sees, and a receipt that records the failure honestly does not
// undo a green check printed over it.
describe("run-projection rejects reports it cannot read as evidence", () => {
  const unusable: readonly { readonly name: string; readonly bytes: string; readonly says: string }[] =
    [
      {
        name: "an existing zero-byte report",
        bytes: "",
        says: "exists but is empty",
      },
      {
        name: "a report that is JSON null",
        bytes: "null",
        says: "not a recognisable Stryker report",
      },
      {
        name: "a report with no `files` key",
        bytes: JSON.stringify({ schemaVersion: "1" }),
        says: "`files` is absent",
      },
      {
        name: "a report whose `files` is the wrong type",
        bytes: JSON.stringify({ schemaVersion: "1", files: "src/available-sources-list.tsx" }),
        says: "`files` is a string",
      },
      {
        name: "a file entry that omits its `mutants` array",
        bytes: JSON.stringify({
          schemaVersion: "1",
          files: { "src/available-sources-list.tsx": {} },
        }),
        says: "has no `mutants` array",
      },
      {
        name: "an empty-mutant report about a file this attempt did not select",
        bytes: JSON.stringify({
          schemaVersion: "1",
          files: { "src/pages/home/index.tsx": { mutants: [] } },
        }),
        says: "not about the code this attempt selected",
      },
    ]

  for (const { name, bytes, says } of unusable) {
    it(`fails on ${name}, despite a clean engine exit`, () => {
      const report = join(workdir, "mutation.json")
      writeFileSync(report, bytes)

      const result = runProjection({
        intent: applicableIntentPath(),
        report,
        strykerExit: "0",
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(says)
      // The specific wrong outcome this guards: the neutral zero-mutant message
      // printed over an unusable report is the gate asserting the run was fine.
      expect(result.stdout).not.toContain("found no mutable code")
    })
  }

  it("still fails a syntactically invalid report", () => {
    // A control on the control: this case failed before the exception existed
    // and must keep failing, now with a reason rather than an uncaught throw.
    const report = join(workdir, "mutation.json")
    writeFileSync(report, "{ not json")

    const result = runProjection({
      intent: applicableIntentPath(),
      report,
      strykerExit: "0",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("not valid JSON")
  })

  it("records why the report was unusable in the retained receipt", () => {
    // The check that fails is not enough: the receipt outlives the run, and a
    // reader of the artifact must be able to tell an unusable report from a run
    // that found nothing. Both record zero trials, so the cause is its own field.
    const report = join(workdir, "mutation.json")
    writeFileSync(report, "")

    const receiptPath = join(workdir, "receipt.json")
    runProjection({ intent: applicableIntentPath(), report, strykerExit: "0" })

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      attempt: { reportPresent: boolean; reportValidity: string; baselineComplete: boolean }
    }
    expect(receipt.attempt.reportPresent).toBe(true)
    expect(receipt.attempt.reportValidity).toBe("empty")
  })

  it("records a clean zero-mutant run as a completed baseline over a valid report", () => {
    // The receipt inconsistency the exception shipped with: the accepted run
    // wrote `baselineComplete: false` while the check beside it required the
    // baseline to be complete. Baseline completion is a fact about the engine's
    // run, not about how many mutants it happened to find.
    const report = join(workdir, "mutation.json")
    writeFileSync(
      report,
      `${JSON.stringify({
        schemaVersion: "1",
        files: { "src/available-sources-list.tsx": { mutants: [] } },
      })}\n`
    )

    const receiptPath = join(workdir, "receipt.json")
    const result = runProjection({ intent: applicableIntentPath(), report, strykerExit: "0" })

    expect(result.status).toBe(0)
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      attempt: { reportValidity: string; baselineComplete: boolean; status: string }
    }
    expect(receipt.attempt.reportValidity).toBe("valid")
    expect(receipt.attempt.baselineComplete).toBe(true)
    // Still no evidence -- accepting the run is not claiming it proved anything.
    expect(receipt.attempt.status).toBe("no_evidence")
  })
})
