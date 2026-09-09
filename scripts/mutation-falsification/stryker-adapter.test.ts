// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  aggregateTrial,
  buildAttemptReceipt,
  hasOwningAssertionEvidence,
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

describe("hasOwningAssertionEvidence", () => {
  it("accepts a node --test assertion failure, the reference-implementation dialect", () => {
    expect(hasOwningAssertionEvidence("AssertionError [ERR_ASSERTION]: no")).toBe(true)
  })

  it("accepts Vitest comparison output, the client dialect", () => {
    // Verbatim from a real client-cohort run: the two dialects differ enough
    // that a predicate written for one rejects every kill from the other.
    expect(hasOwningAssertionEvidence("expected [Function] to throw an error")).toBe(true)
    expect(hasOwningAssertionEvidence("expected 'http:' to be 'https:'")).toBe(true)
  })

  it("rejects a crash, which is the engine falling over rather than a test catching a fault", () => {
    expect(hasOwningAssertionEvidence("RangeError: Maximum call stack size exceeded")).toBe(false)
    expect(hasOwningAssertionEvidence("TypeError: x is not a function")).toBe(false)
  })

  it("rejects a bare thrown value carrying no assertion vocabulary", () => {
    // Also verbatim from a real client-cohort run. A test that asserted on a
    // rejection can print only the rejected value, which does not show that an
    // assertion is what failed. Conservative by design: this understates what
    // the suite detects rather than overstating it.
    expect(
      hasOwningAssertionEvidence('[{"code":"custom","message":"externalUrl must use https://."}]')
    ).toBe(false)
  })

  it("rejects absent or empty output", () => {
    expect(hasOwningAssertionEvidence(undefined)).toBe(false)
    expect(hasOwningAssertionEvidence("   ")).toBe(false)
  })
})

describe("projectOutcome", () => {
  it("projects Killed with owning-assertion evidence as killed", () => {
    const projected = projectOutcome(observation())
    expect(projected.outcome).toBe("killed")
    expect(projected.basis).toBe("owning_assertion_failed")
    expect(projected.rawStatus).toBe("Killed")
  })

  it("refuses to call a Killed a kill when the failure was a crash, not an assertion", () => {
    // The measured case that motivates the whole adapter: the same engine
    // reports Killed for both, and only one is evidence about the suite.
    const projected = projectOutcome(
      observation({ failureOutput: "RangeError: Maximum call stack size exceeded" })
    )
    expect(projected.outcome).toBe("inconclusive")
    expect(projected.basis).toBe("killed_without_owning_assertion_evidence")
    expect(projected.rawStatus).toBe("Killed")
  })

  it("refuses to call a Killed a kill when no failure output was retained", () => {
    expect(projectOutcome(observation({ failureOutput: undefined })).outcome).toBe("inconclusive")
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

  it("binds the intent digest, the raw report digest, and the computed projection", () => {
    const receipt = buildAttemptReceipt({
      intent,
      rawReportBytes,
      observations: [observation({ id: "1" })],
      cacheDecision: { reuse: false, reason: "execution_inputs_changed" },
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
    })
    expect(receipt.projections).toHaveLength(1)
    expect(receipt.projections[0]).toMatchObject({ basis: "contradictory_observations" })
    expect(receipt.summary).toMatchObject({ inconclusive: 1, validDenominator: 0 })
  })
})
