// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  aggregateTrial,
  buildAttemptReceipt,
  hasOwningTestEvidence,
  type MutantObservation,
  projectOutcome,
  readKnownTestIds,
  readObservations,
  type StrykerStatus,
  summarize,
  verifyReceipt,
} from "./stryker-adapter.ts"
import { freezeIntent, parseNameStatusZ } from "./select-pr-files.ts"

function observation(overrides: Partial<MutantObservation> = {}): MutantObservation {
  return {
    id: "1",
    file: "src/a.ts",
    mutatorName: "ConditionalExpression",
    rawStatus: "Killed",
    killedBy: ["covers the boundary"],
    failureOutput: "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
    baselineComplete: true,
    // A default kill executed the test that killed it. Cases that turn on the
    // count -- a reported zero, or a reporter that wrote no count at all --
    // say so explicitly in `overrides`.
    testsCompleted: 1,
    // The default killer resolves: a fixture that asserts something OTHER than
    // resolution should not be graded by the missing-table rule as a
    // side-effect. Cases that turn on resolution, or on an absent table,
    // override this explicitly.
    knownTestIds: new Set<string>(["covers the boundary"]),
    // Static is the exception, not the default: a static kill is held whatever
    // its identity resolves to, so the ordinary fixture must not be one.
    isStatic: false,
    ...overrides,
  }
}

const intent = freezeIntent({
  cohort: { name: "client", root: ".", productionPrefixes: ["src/"] },
  baseCommit: "base",
  headCommit: "head",
  diff: parseNameStatusZ("M\0src/a.ts\0"),
  hunks: new Map([["src/a.ts", [{ startLine: 1, endLine: 2 }]]]),
  executionInputs: {
    cohortRoot: ".",
    configDigest: "sha256:config",
    toolVersion: "10.0.0",
    runtimeVersion: "v22.23.1",
    lockfileDigests: [{ path: "package-lock.json", digest: "sha256:lock" }],
  },
})

describe("hasOwningTestEvidence", () => {
  it("accepts a kill that names a killing test, in either runner's dialect", () => {
    expect(hasOwningTestEvidence("AssertionError [ERR_ASSERTION]: no", ["t1"])).toBe(true)
    expect(hasOwningTestEvidence("expected 'http:' to be 'https:'", ["38"])).toBe(true)
  })

  // A named test is not an attribution unless the name RESOLVES. Stryker
  // renumbers the tests it observed when it writes the report and leaves an
  // unrecognised id as the raw string it arrived as, so a killer that is still
  // a raw identity names a test the run has no record of observing.
  it("accepts a killer id that resolves to an observed test", () => {
    expect(
      hasOwningTestEvidence("expected 3 to equal 4", ["0"], new Set(["0", "1"]))
    ).toBe(true)
  })

  it("refuses a killer id that resolves to nothing in the test table", () => {
    expect(
      hasOwningTestEvidence(
        "expected 3 to equal 4",
        ["f.test.ts#outer checks value"],
        new Set(["0", "1"])
      )
    ).toBe(false)
  })

  // Without a test table there is nothing to resolve against, and refusing
  // every kill on missing input would be refusing on absence of evidence
  // rather than on evidence. Callers holding only mutant records keep the
  // non-empty check.
  it("does not require resolution when no test table was read", () => {
    expect(
      hasOwningTestEvidence("expected 3 to equal 4", ["t1"], new Set())
    ).toBe(true)
  })

  it("accepts a real assertion kill whose retained text carries no assertion words", () => {
    // The measured regression this predicate was rewritten for. On the first
    // client file it ran against, five of six real kills looked like this: the
    // mutant made a validator reject a valid input, so a ZodError was thrown
    // inside the subject expression of a genuine `expect(...).toEqual(...)` and
    // the retained text is the Zod issue array. `killedBy` names the test that
    // failed -- `src/apps/submission-registry.test.ts` "parses a live
    // submission" -- so this is a kill, and the earlier vocabulary match called
    // it inconclusive.
    const zodIssues =
      '[{"code":"custom","path":["externalUrl"],"message":"externalUrl must use https://."}]'
    expect(hasOwningTestEvidence(zodIssues, ["38"])).toBe(true)
  })

  it("rejects a crash, which is the engine falling over rather than a test catching a fault", () => {
    // A named killing test does not rescue these: the mutant broke the harness,
    // so the failure says nothing about whether the suite protects the code.
    expect(
      hasOwningTestEvidence("RangeError: Maximum call stack size exceeded", ["t1"])
    ).toBe(false)
    expect(hasOwningTestEvidence("FATAL ERROR: JavaScript heap out of memory", ["t1"])).toBe(
      false
    )
    expect(hasOwningTestEvidence("Error: Cannot find module '/x/test'", ["t1"])).toBe(false)
  })

  it("rejects a Killed that names no test at all", () => {
    // A status the engine wrote about itself with nothing to attribute it to.
    // Conservative by design: it understates what the suite detects.
    expect(hasOwningTestEvidence("something failed", [])).toBe(false)
    expect(hasOwningTestEvidence(undefined, [])).toBe(false)
    expect(hasOwningTestEvidence("expected 1 to be 2", ["  "])).toBe(false)
  })

  it("accepts a named killing test even when the runner retained no output", () => {
    // The command runner reports no failure text for individual tests. Requiring
    // prose here is what made that cohort unable to record a kill at all.
    expect(hasOwningTestEvidence(undefined, ["test/a.test.ts"])).toBe(true)
  })
})

describe("projectOutcome", () => {
  it("projects Killed with an owning test identity as killed", () => {
    const projected = projectOutcome(observation())
    expect(projected.outcome).toBe("killed")
    expect(projected.basis).toBe("owning_test_failed")
    expect(projected.rawStatus).toBe("Killed")
  })

  it("refuses to call a Killed a kill when the failure was a crash, not a test", () => {
    // The measured case that motivates the whole adapter: the same engine
    // reports Killed for both, and only one is evidence about the suite.
    const projected = projectOutcome(
      observation({ failureOutput: "RangeError: Maximum call stack size exceeded" })
    )
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("killed_by_runner_crash")
    expect(projected.rawStatus).toBe("Killed")
  })

  it("refuses to call a Killed a kill when it names no killing test", () => {
    const projected = projectOutcome(observation({ failureOutput: undefined, killedBy: [] }))
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("killed_without_owning_test_identity")
  })

  it("counts a real assertion kill whose thrown value carries no assertion words", () => {
    // Reproduces the five undercounted kills from the measured client run. The
    // earlier predicate matched failure prose, so a ZodError thrown inside a
    // genuine assertion's subject expression read as "no assertion evidence".
    const projected = projectOutcome(
      observation({
        failureOutput:
          '[{"code":"custom","path":["externalUrl"],"message":"externalUrl must use https://."}]',
        killedBy: ["38"],
        knownTestIds: new Set(["38"]),
      })
    )
    expect(projected.outcome).toBe("killed")
    expect(projected.basis).toBe("owning_test_failed")
  })

  // A static mutant's trial is the whole suite, so a failure proves the suite
  // noticed and not that a test owning this code did. Held whatever the killer
  // resolves to: the resolution of a static killer is a function of how the run
  // was scoped, not of the mutant, and grading on it makes the same head report
  // different numbers at different concurrencies and different --mutate ranges.
  it("holds a static kill inconclusive even when its killer resolves", () => {
    const projected = projectOutcome(
      observation({
        isStatic: true,
        killedBy: ["covers the boundary"],
        knownTestIds: new Set(["covers the boundary"]),
      })
    )
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("static_whole_suite_kill")
  })

  // The other direction of the same rule: an unresolved static killer lands on
  // the static basis too, not on the unresolved-identity one. Both scopings of
  // the same mutant therefore report the same basis, which is the property the
  // engine controls check.
  it("holds a static kill whose killer does not resolve on the same basis", () => {
    const projected = projectOutcome(
      observation({
        isStatic: true,
        killedBy: ["scripts/a.test.ts#never renumbered"],
        knownTestIds: new Set(["0", "1"]),
      })
    )
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("static_whole_suite_kill")
  })

  // Static is read off the report, not inferred. A report that does not carry
  // the flag must not have every kill held: absent is not true.
  it("does not treat a mutant without the static flag as static", () => {
    const [projected] = readObservations(
      {
        files: {
          "scripts/a.ts": {
            mutants: [{ id: "1", status: "Killed", killedBy: ["0"], testsCompleted: 3 }],
          },
        },
        testFiles: { "scripts/a.test.ts": { tests: [{ id: "0", name: "checks it" }] } },
      },
      { baselineComplete: true }
    ).map(projectOutcome)
    expect(projected).toMatchObject({ outcome: "killed", basis: "owning_test_failed" })
  })

  it("reads the static flag off the report", () => {
    const [projected] = readObservations(
      {
        files: {
          "scripts/a.ts": {
            mutants: [
              { id: "1", status: "Killed", static: true, killedBy: ["0"], testsCompleted: 3 },
            ],
          },
        },
        testFiles: { "scripts/a.test.ts": { tests: [{ id: "0", name: "checks it" }] } },
      },
      { baselineComplete: true }
    ).map(projectOutcome)
    expect(projected).toMatchObject({
      outcome: "inconclusive",
      basis: "static_whole_suite_kill",
    })
  })

  it("projects Survived as survived, pending triage", () => {
    const projected = projectOutcome(
      observation({
        rawStatus: "Survived",
        failureOutput: undefined,
        killedBy: [],
        testsCompleted: 3,
      })
    )
    expect(projected.outcome).toBe("survived")
    expect(projected.basis).toBe("no_selected_test_failed")
  })

  it("projects a Survived that executed no tests as inconclusive", () => {
    // Stryker defaults an unexecuted mutant to `Survived`. A runner that fails
    // to execute its trials therefore reports survivors the suite in fact
    // kills, which reads as a verdict on the tests and is a fact about the
    // runner. Observed on the `scripts` cohort, where 47 mutants came back
    // `Survived` with `testsCompleted: 0`, and applying three of them by hand
    // failed 3, 6 and 3 tests respectively.
    const projected = projectOutcome(
      observation({
        rawStatus: "Survived",
        failureOutput: undefined,
        killedBy: [],
        testsCompleted: 0,
      })
    )
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("survived_without_executing_tests")
  })

  it("keeps Survived a survivor when the runner reported no count at all", () => {
    // An absent count is a reporter that never wrote the field, not a reported
    // zero. Treating the two alike would condemn every run predating it.
    const projected = projectOutcome(
      observation({
        rawStatus: "Survived",
        failureOutput: undefined,
        killedBy: [],
        testsCompleted: undefined,
      })
    )
    expect(projected.outcome).toBe("survived")
    expect(projected.basis).toBe("no_selected_test_failed")
  })

  it("reads testsCompleted off the raw report", () => {
    const [observed] = readObservations(
      {
        files: {
          "scripts/a.ts": {
            mutants: [
              { id: "1", mutatorName: "StringLiteral", status: "Survived", testsCompleted: 0 },
            ],
          },
        },
      },
      { baselineComplete: true }
    )
    expect(observed?.testsCompleted).toBe(0)
    expect(projectOutcome(observed!).outcome).toBe("inconclusive")
  })

  it.each<[StrykerStatus, string]>([
    ["Timeout", "timeout_is_not_a_kill"],
    ["RuntimeError", "runtime_error"],
    ["CompileError", "compile_error"],
    ["NoCoverage", "not_exercised"],
    ["Ignored", "ignored_by_configuration"],
    ["Pending", "no_result_recorded"],
  ])("projects %s as inconclusive (%s)", (rawStatus, basis) => {
    const projected = projectOutcome(observation({ rawStatus, failureOutput: undefined }))
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe(basis)
    // The raw status is never overwritten by the projection.
    expect(projected.rawStatus).toBe(rawStatus)
  })

  it("does not count NoCoverage as survived", () => {
    // "Do not count unreached code as survived": it is an absence of evidence,
    // not evidence the suite would miss the fault.
    expect(projectOutcome(observation({ rawStatus: "NoCoverage" })).outcome).not.toBe("survived")
  })

  it("makes every mutant inconclusive when the baseline did not complete", () => {
    for (const rawStatus of ["Killed", "Survived", "Timeout"] as const) {
      expect(projectOutcome(observation({ rawStatus, baselineComplete: false }))).toMatchObject({
        outcome: "inconclusive",
        basis: "baseline_incomplete",
      })
    }
  })
})

describe("aggregateTrial", () => {
  it("keeps a single projection unchanged", () => {
    const single = projectOutcome(observation())
    expect(aggregateTrial([single])).toEqual(single)
  })

  it("keeps agreeing projections", () => {
    const agreeing = projectOutcome(observation())
    expect(aggregateTrial([agreeing, agreeing]).outcome).toBe("killed")
  })

  it("makes contradictory observations inconclusive rather than picking a winner", () => {
    const killed = projectOutcome(observation())
    const survived = projectOutcome(
      observation({ rawStatus: "Survived", failureOutput: undefined })
    )
    expect(aggregateTrial([killed, survived])).toMatchObject({
      outcome: "inconclusive",
      basis: "contradictory_observations",
    })
  })

  it("rejects an empty group rather than inventing an outcome", () => {
    expect(() => aggregateTrial([])).toThrow(/at least one projection/)
  })
})

describe("summarize", () => {
  it("counts inconclusive separately and excludes it from the valid denominator", () => {
    const projections = [
      projectOutcome(observation({ id: "1" })),
      projectOutcome(observation({ id: "2", rawStatus: "Survived", failureOutput: undefined })),
      projectOutcome(observation({ id: "3", rawStatus: "Timeout", failureOutput: undefined })),
      projectOutcome(observation({ id: "4", rawStatus: "NoCoverage", failureOutput: undefined })),
    ]
    expect(summarize(projections)).toEqual({
      killed: 1,
      survived: 1,
      inconclusive: 2,
      validDenominator: 2,
      rawStatusCounts: { Killed: 1, Survived: 1, Timeout: 1, NoCoverage: 1 },
    })
  })
})

// The report is where the two identity namespaces meet: the test table is keyed
// by the ids the dry run reported, and `killedBy` is keyed by whatever the
// mutant run returned. These drive a whole report through the reader and the
// projector, both directions, rather than checking the predicate alone.
describe("killer identity resolved against the report's test table", () => {
  function report(killedBy: readonly string[]) {
    return {
      files: {
        "scripts/a.ts": {
          mutants: [
            {
              id: "1",
              mutatorName: "ConditionalExpression",
              status: "Killed",
              killedBy,
              statusReason: "expected 3 to equal 4",
              testsCompleted: 6,
            },
          ],
        },
      },
      testFiles: {
        "scripts/a.test.ts": {
          tests: [
            { id: "0", name: "outer > checks value" },
            { id: "1", name: "outer > checks other" },
          ],
        },
      },
    }
  }

  it("reads the test table the report names", () => {
    expect([...readKnownTestIds(report(["0"]))]).toEqual(["0", "1"])
  })

  it("projects a kill whose killer resolves to the test table", () => {
    const [observation] = readObservations(report(["0"]), { baselineComplete: true })

    expect(observation.knownTestIds.has("0")).toBe(true)
    expect(projectOutcome(observation)).toMatchObject({
      outcome: "killed",
      basis: "owning_test_failed",
    })
  })

  // The negative control, and the whole point of P2-3: an unknown identity is
  // non-empty, so the old predicate accepted it. It names a test the report has
  // no record of, and cannot become an attributed kill.
  it("refuses a kill whose killer is an unknown identity", () => {
    const [observation] = readObservations(
      report(["scripts/a.test.ts#outer checks value"]),
      { baselineComplete: true }
    )

    expect(projectOutcome(observation)).toMatchObject({
      outcome: "inconclusive",
      basis: "killed_without_owning_test_identity",
    })
  })

  // A report that carried kills and no test table is still readable -- nothing
  // throws, and the mutant record survives. What it is not is gradable as a
  // kill: there is no inventory for the killer to resolve against, so the
  // resolution rule cannot run and the kill is held under its own basis rather
  // than quietly falling back to the weaker pre-resolution non-empty rule.
  it("holds a kill in a report with no test table under its own basis", () => {
    const [observation] = readObservations(
      { files: report(["0"]).files },
      { baselineComplete: true }
    )

    expect(observation.knownTestIds.size).toBe(0)
    expect(projectOutcome(observation)).toMatchObject({
      outcome: "inconclusive",
      basis: "killed_without_resolvable_test_table",
    })
  })
})

describe("readObservations", () => {
  it("reads mutants out of a mutation-testing-elements report", () => {
    const report = {
      files: {
        "src/a.ts": {
          mutants: [
            {
              id: "0",
              mutatorName: "EqualityOperator",
              status: "Killed",
              killedBy: ["t1"],
              statusReason: "AssertionError [ERR_ASSERTION]",
            },
            { id: "1", mutatorName: "BooleanLiteral", status: "Survived" },
          ],
        },
      },
    }
    const observations = readObservations(report, { baselineComplete: true })
    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({ id: "0", file: "src/a.ts", rawStatus: "Killed" })
    expect(observations[1]).toMatchObject({ id: "1", rawStatus: "Survived", killedBy: [] })
  })

  it("maps an unrecognised status to Pending so an unreadable result cannot vanish", () => {
    const report = { files: { "src/a.ts": { mutants: [{ id: "0", status: "Splendid" }] } } }
    const [observed] = readObservations(report, { baselineComplete: true })
    expect(observed?.rawStatus).toBe("Pending")
    expect(projectOutcome(observed as MutantObservation).outcome).toBe("inconclusive")
  })

  it("returns nothing for a report with no files section", () => {
    expect(readObservations({}, { baselineComplete: true })).toEqual([])
    expect(readObservations(null, { baselineComplete: true })).toEqual([])
  })
})

describe("buildAttemptReceipt", () => {
  const rawReportBytes = JSON.stringify({ files: {} })
  const ranCleanly = { engineExit: "0", reportPresent: true } as const

  it("binds the intent digest, the raw report digest, and the computed projection", () => {
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [observation({ id: "1" })],
      ...ranCleanly,
    })
    expect(receipt.intentDigest).toBe(intent.intentDigest)
    expect(receipt.summary).toMatchObject({ killed: 1, validDenominator: 1 })
    expect(verifyReceipt(receipt, rawReportBytes)).toEqual({
      valid: true,
      reason: "digests_match",
    })
  })

  it("detects a receipt edited after publication", () => {
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [observation({ id: "1", rawStatus: "Survived", failureOutput: undefined })],
      ...ranCleanly,
    })
    const tampered = {
      ...receipt,
      summary: { ...receipt.summary, survived: 0, killed: 1, validDenominator: 1 },
    }
    expect(verifyReceipt(tampered, rawReportBytes)).toEqual({
      valid: false,
      reason: "receipt_digest_mismatch",
    })
  })

  it("detects raw report bytes that were replaced after the digest was taken", () => {
    // A digest whose bytes are not retained and revalidatable is not evidence.
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [observation({ id: "1" })],
      ...ranCleanly,
    })
    expect(verifyReceipt(receipt, JSON.stringify({ files: { "src/a.ts": {} } }))).toEqual({
      valid: false,
      reason: "raw_report_digest_mismatch",
    })
  })

  it("folds repeated observations of one mutant into a single projection", () => {
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [
        observation({ id: "1" }),
        observation({ id: "1", rawStatus: "Survived", failureOutput: undefined }),
      ],
      ...ranCleanly,
    })
    expect(receipt.projections).toHaveLength(1)
    expect(receipt.projections[0]).toMatchObject({ basis: "contradictory_observations" })
    expect(receipt.summary).toMatchObject({ inconclusive: 1, validDenominator: 0 })
  })

  it("distinguishes a rejected attempt from a clean attempt that produced nothing", () => {
    // Both have zero trials, so the projection alone cannot tell them apart.
    // They used to write byte-identical receipts, which meant the artifact --
    // the thing that outlives the run -- could not say whether the engine had
    // even succeeded. The check failing is not enough on its own.
    const rejected = buildAttemptReceipt({
      intent,
      rawReportBytes: "",
      observations: [],
      engineExit: "1",
      reportPresent: false,
    })
    const cleanButEmpty = buildAttemptReceipt({
      intent,
      rawReportBytes: "",
      observations: [],
      engineExit: "0",
      reportPresent: false,
    })
    expect(rejected.attempt).toEqual({
      engineExit: "1",
      reportPresent: false,
      reportValidity: "absent",
      baselineComplete: false,
      status: "no_evidence",
    })
    expect(cleanButEmpty.attempt.engineExit).toBe("0")
    expect(rejected.receiptDigest).not.toBe(cleanButEmpty.receiptDigest)
  })

  it("records an attempt that produced evidence as having produced it", () => {
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [observation({ id: "1" })],
      ...ranCleanly,
    })
    expect(receipt.attempt).toEqual({
      engineExit: "0",
      reportPresent: true,
      reportValidity: "valid",
      baselineComplete: true,
      status: "evidence",
    })
  })
})
