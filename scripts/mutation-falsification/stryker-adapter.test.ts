// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  aggregateTrial,
  buildAttemptReceipt,
  hasOwningTestEvidence,
  type MutantObservation,
  projectOutcome,
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
    ...overrides,
  }
}

const intent = freezeIntent({
  cohort: { name: "client", root: ".", productionPrefixes: ["src/"] },
  baseCommit: "base",
  headCommit: "head",
  diff: parseNameStatusZ("M\0src/a.ts\0"),
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
      })
    )
    expect(projected.outcome).toBe("killed")
    expect(projected.basis).toBe("owning_test_failed")
  })

  it("projects Survived as survived, pending triage", () => {
    const projected = projectOutcome(
      observation({ rawStatus: "Survived", failureOutput: undefined, killedBy: [] })
    )
    expect(projected.outcome).toBe("survived")
    expect(projected.basis).toBe("no_selected_test_failed")
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
      cacheDecision: { reuse: false, reason: "execution_inputs_changed" },
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
      cacheDecision: { reuse: false, reason: "no_recorded_inputs" },
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
      cacheDecision: { reuse: true, reason: "execution_inputs_match" },
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
      cacheDecision: { reuse: false, reason: "no_recorded_inputs" },
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
      cacheDecision: { reuse: false, reason: "no_cache_restored" },
      engineExit: "1",
      reportPresent: false,
    })
    const cleanButEmpty = buildAttemptReceipt({
      intent,
      rawReportBytes: "",
      observations: [],
      cacheDecision: { reuse: false, reason: "no_cache_restored" },
      engineExit: "0",
      reportPresent: false,
    })
    expect(rejected.attempt).toEqual({
      engineExit: "1",
      reportPresent: false,
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
      cacheDecision: { reuse: false, reason: "no_cache_restored" },
      ...ranCleanly,
    })
    expect(receipt.attempt).toEqual({
      engineExit: "0",
      reportPresent: true,
      baselineComplete: true,
      status: "evidence",
    })
  })
})
