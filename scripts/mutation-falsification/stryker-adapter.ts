// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// OBSERVATION, PROJECTION and RECEIPT stages of the reactive mutation pipeline.
//
// The governing rule of this file, and the reason it exists at all:
//
//     Stryker is a black box that produces observations. It is never allowed to
//     produce a verdict.
//
// Stryker's report collapses several distinct concerns into one `status` field
// that the engine writes about its own run. `killed`, `survived`, and
// `inconclusive` are NEVER accepted as input anywhere in this program. They are
// computed here, and only here, from raw observations, by a projection that is
// total (every input maps somewhere) and conservative (every unclear input maps
// to `inconclusive`).
//
// Two disagreements with Stryker's own vocabulary are deliberate:
//
//   - A `Killed` status only means some test failed. It does not distinguish
//     "a test protecting this code failed" from "the mutant crashed the
//     runner". Only the first is evidence that the suite would catch the fault.
//     A `Killed` that names no killing test, or whose retained output shows the
//     runner crashed, is `inconclusive` here, not a kill.
//   - `Timeout`, `RuntimeError`, `CompileError` and `NoCoverage` are all
//     `inconclusive`. In particular a timeout is not a kill, and code with no
//     coverage is not a survivor -- it is an absence of evidence either way.
//
// There are no duration, budget, retry, or admission thresholds in this file.
// A contradiction between two observations of the same mutant is preserved as
// `inconclusive`, never resolved by re-running until one answer wins.

import { canonicalJSON, digestOf, type IntentPacket } from "./select-pr-files.ts"

/** The statuses Stryker's JSON report can carry. Raw input, never a verdict. */
export type StrykerStatus =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "Timeout"
  | "RuntimeError"
  | "CompileError"
  | "Ignored"
  | "Pending"

/**
 * What the harness observed about one mutant, with no interpretation applied.
 * Every field is a fact reported by, or read out of, the run -- not a judgment
 * about what those facts mean.
 */
export interface MutantObservation {
  readonly id: string
  readonly file: string
  readonly mutatorName: string
  /** Stryker's own status, retained verbatim and separately from the projection. */
  readonly rawStatus: StrykerStatus
  /** Test identities Stryker reported as covering or killing this mutant. */
  readonly killedBy: readonly string[]
  /** Retained failure output for the killing test, if the runner produced any. */
  readonly failureOutput: string | undefined
  /** True only when the baseline run for this cohort completed successfully. */
  readonly baselineComplete: boolean
}

export type ProjectedOutcome = "killed" | "survived" | "inconclusive"

export interface Projection {
  readonly id: string
  readonly outcome: ProjectedOutcome
  /** Why the projection landed where it did, in the projector's own terms. */
  readonly basis: string
  /** Stryker's status, carried alongside so raw and projected never merge. */
  readonly rawStatus: StrykerStatus
}

/**
 * Failures that are the runner falling over rather than a test catching a fault.
 *
 * These are the cases where a mutant broke the harness itself, so the failure
 * says nothing about whether the suite protects the mutated code. Stack
 * overflows and out-of-memory kills are the ones a mutated loop or recursion
 * actually produces; the engine's own infrastructure errors are the rest.
 *
 * This list disqualifies a kill. It is deliberately not the mirror image of an
 * "assertion vocabulary" allow-list: see `hasOwningTestEvidence` for why
 * that direction does not work.
 */
const RUNNER_CRASH_PATTERNS: readonly RegExp[] = [
  /Maximum call stack size exceeded/i,
  /JavaScript heap out of memory/i,
  /\bENOMEM\b/,
  /Cannot find module/i,
  /Stryker\w* (?:error|failed)/i,
  /\bSIGKILL\b|\bSIGSEGV\b|\bSIGABRT\b/,
]

function isRunnerCrashOutput(failureOutput: string | undefined): boolean {
  if (failureOutput === undefined) {
    return false
  }
  return RUNNER_CRASH_PATTERNS.some((pattern) => pattern.test(failureOutput))
}

/**
 * Evidence that a test owning this code failed, rather than the process falling
 * over.
 *
 * This is the distinction the whole design turns on. Stryker reports `Killed`
 * for both "a test protecting this code failed" and "the mutant crashed the
 * runner", and only the first says anything about whether the suite would catch
 * the fault in production.
 *
 * The question is answered from STRUCTURE, not from prose. An earlier version
 * regex-matched the failure text for assertion vocabulary, and that was wrong in
 * a way execution exposed: on the first client file it was run against, five of
 * six real kills were refused. Those mutants made a validator reject a valid
 * input, so a `ZodError` was thrown inside the subject expression of a genuine
 * `expect(...).toEqual(...)`, and the retained text was the Zod issue array with
 * no assertion words in it. A dialect list cannot fix that: the failure text of
 * a real assertion kill is whatever the thrown value happened to print. The
 * predicate was separating message dialects, not assertions from crashes.
 *
 * So a kill requires a killing test IDENTITY -- `killedBy`, which Stryker
 * populates from the runner's own per-test results -- and the absence of
 * crash evidence. A `Killed` with no named test is a status the engine wrote
 * about itself with nothing to attribute it to, which stays `inconclusive`.
 */
export function hasOwningTestEvidence(
  failureOutput: string | undefined,
  killedBy: readonly string[] = []
): boolean {
  if (isRunnerCrashOutput(failureOutput)) {
    return false
  }
  return killedBy.some((test) => test.trim().length > 0)
}

/**
 * The projection table. Total and conservative: every status has a row, and
 * every row whose evidence is incomplete resolves to `inconclusive`.
 */
export function projectOutcome(observation: MutantObservation): Projection {
  const carry = { id: observation.id, rawStatus: observation.rawStatus }

  // A baseline that did not complete invalidates every mutant in the batch:
  // there is no established "the suite passes on unmutated code" to compare to.
  if (!observation.baselineComplete) {
    return { ...carry, outcome: "inconclusive", basis: "baseline_incomplete" }
  }

  switch (observation.rawStatus) {
    case "Killed": {
      if (isRunnerCrashOutput(observation.failureOutput)) {
        return { ...carry, outcome: "inconclusive", basis: "killed_by_runner_crash" }
      }
      if (!hasOwningTestEvidence(observation.failureOutput, observation.killedBy)) {
        return {
          ...carry,
          outcome: "inconclusive",
          basis: "killed_without_owning_test_identity",
        }
      }
      return { ...carry, outcome: "killed", basis: "owning_test_failed" }
    }
    case "Survived":
      // Survival is an observation pending independent triage, not a defect
      // finding, and not a claim about tests that were never selected.
      return { ...carry, outcome: "survived", basis: "no_selected_test_failed" }
    case "Timeout":
      return { ...carry, outcome: "inconclusive", basis: "timeout_is_not_a_kill" }
    case "RuntimeError":
      return { ...carry, outcome: "inconclusive", basis: "runtime_error" }
    case "CompileError":
      return { ...carry, outcome: "inconclusive", basis: "compile_error" }
    case "NoCoverage":
      // Explicitly not `survived`: unreached code produced no evidence at all.
      return { ...carry, outcome: "inconclusive", basis: "not_exercised" }
    case "Ignored":
      return { ...carry, outcome: "inconclusive", basis: "ignored_by_configuration" }
    case "Pending":
      return { ...carry, outcome: "inconclusive", basis: "no_result_recorded" }
    default: {
      // An unrecognised status from a future engine version is unclear
      // evidence, which this table already has an answer for.
      const unknown: never = observation.rawStatus
      return {
        ...carry,
        outcome: "inconclusive",
        basis: `unrecognised_status:${String(unknown)}`,
      }
    }
  }
}

/**
 * Fold repeated observations of one mutant into a single projection.
 *
 * Two valid observations that disagree make the aggregate `inconclusive`. The
 * run is not repeated until the answers agree: a contradiction is itself the
 * finding, and discarding it would be the kind of retry-until-green that makes
 * the rest of this evidence worthless.
 */
export function aggregateTrial(projections: readonly Projection[]): Projection {
  const first = projections[0]
  if (first === undefined) {
    throw new Error("aggregateTrial requires at least one projection")
  }
  if (projections.length === 1) {
    return first
  }
  const outcomes = new Set(projections.map((projection) => projection.outcome))
  if (outcomes.size === 1) {
    return first
  }
  return {
    id: first.id,
    rawStatus: first.rawStatus,
    outcome: "inconclusive",
    basis: "contradictory_observations",
  }
}

export interface ProjectionSummary {
  readonly killed: number
  readonly survived: number
  readonly inconclusive: number
  /**
   * Exactly `killed + survived`. Inconclusive trials stay visible as their own
   * count and never enter this denominator, so no percentage can be inflated by
   * quietly dropping the trials that produced no evidence.
   */
  readonly validDenominator: number
  /** Stryker's own status totals, retained unchanged next to the projection. */
  readonly rawStatusCounts: Readonly<Record<string, number>>
}

export function summarize(projections: readonly Projection[]): ProjectionSummary {
  const rawStatusCounts: Record<string, number> = {}
  let killed = 0
  let survived = 0
  let inconclusive = 0
  for (const projection of projections) {
    rawStatusCounts[projection.rawStatus] = (rawStatusCounts[projection.rawStatus] ?? 0) + 1
    if (projection.outcome === "killed") {
      killed += 1
    } else if (projection.outcome === "survived") {
      survived += 1
    } else {
      inconclusive += 1
    }
  }
  return { killed, survived, inconclusive, validDenominator: killed + survived, rawStatusCounts }
}

/** The shape this adapter reads out of Stryker's `json` reporter output. */
interface StrykerReport {
  readonly files?: Record<
    string,
    { readonly mutants?: readonly Record<string, unknown>[] } | undefined
  >
}

/**
 * Read raw observations out of a Stryker mutation-testing-elements report.
 *
 * The report is treated strictly as an observation artifact: its bytes are
 * retained and digested elsewhere, and nothing is read from it except facts.
 * A malformed record yields a `Pending` observation, which the projector maps
 * to `inconclusive` -- an unreadable result is not permitted to disappear.
 */
export function readObservations(
  report: unknown,
  context: { readonly baselineComplete: boolean }
): MutantObservation[] {
  const files = (report as StrykerReport | null)?.files
  if (files === undefined || files === null || typeof files !== "object") {
    return []
  }
  const observations: MutantObservation[] = []
  for (const [file, entry] of Object.entries(files)) {
    for (const mutant of entry?.mutants ?? []) {
      const killedBy = Array.isArray(mutant.killedBy)
        ? mutant.killedBy.filter((test): test is string => typeof test === "string")
        : []
      observations.push({
        id: typeof mutant.id === "string" ? mutant.id : String(mutant.id ?? "unknown"),
        file,
        mutatorName: typeof mutant.mutatorName === "string" ? mutant.mutatorName : "unknown",
        rawStatus: isStrykerStatus(mutant.status) ? mutant.status : "Pending",
        killedBy,
        failureOutput:
          typeof mutant.statusReason === "string" ? mutant.statusReason : undefined,
        baselineComplete: context.baselineComplete,
      })
    }
  }
  return observations
}

function isStrykerStatus(value: unknown): value is StrykerStatus {
  return (
    value === "Killed" ||
    value === "Survived" ||
    value === "NoCoverage" ||
    value === "Timeout" ||
    value === "RuntimeError" ||
    value === "CompileError" ||
    value === "Ignored" ||
    value === "Pending"
  )
}

export interface AttemptReceipt {
  readonly schema: "pdpp.mutation.receipt.v1"
  /** Binds this receipt to the intent that was frozen before the run started. */
  readonly intentDigest: string
  /**
   * Digest of the retained raw report bytes. A digest whose bytes are not also
   * retained is not evidence, so publication of the raw report alongside this
   * receipt is part of the contract, not a convenience.
   */
  readonly rawReportDigest: string
  /**
   * What the run itself did, as opposed to what its mutants did.
   *
   * Without this, a rejected attempt and an attempt that produced an empty
   * report on a clean exit wrote byte-identical receipts: both have no trials,
   * so the projection alone cannot tell them apart. The check that fails is not
   * enough, because the artifact is what outlives the run -- so the facts a
   * reader needs in order to know whether the attempt happened at all belong
   * here, in the retained record.
   */
  readonly attempt: {
    /** The engine's own exit status, verbatim, or "unknown" if unrecorded. */
    readonly engineExit: string
    /** Whether the engine wrote a report for this attempt at all. */
    readonly reportPresent: boolean
    /** Whether a baseline established that the tests pass on unmutated code. */
    readonly baselineComplete: boolean
    /**
     * `evidence` only when this attempt produced at least one killed or
     * survived trial. Anything else is `no_evidence`: the attempt ran, and
     * established nothing either way.
     */
    readonly status: "evidence" | "no_evidence"
  }
  readonly observations: readonly MutantObservation[]
  readonly projections: readonly Projection[]
  readonly summary: ProjectionSummary
  /** Derived from this receipt's own canonical bytes. */
  readonly receiptDigest: string
}

/**
 * Bind intent, retained raw bytes, and computed projection into one receipt.
 *
 * Triage is not part of this record. A survivor is dismissed as equivalent only
 * in a separate receipt written later by someone other than the author of the
 * change, and this function has no field in which such a disposition could be
 * pre-filled.
 */
export function buildAttemptReceipt(input: {
  readonly intent: IntentPacket
  readonly rawReportBytes: string
  readonly observations: readonly MutantObservation[]
  /** The engine's exit status, verbatim. "unknown" when the step never ran. */
  readonly engineExit: string
  /** Whether the engine wrote a report for this attempt at all. */
  readonly reportPresent: boolean
}): AttemptReceipt {
  const byId = new Map<string, Projection[]>()
  for (const observation of input.observations) {
    const projection = projectOutcome(observation)
    const existing = byId.get(observation.id)
    if (existing === undefined) {
      byId.set(observation.id, [projection])
      continue
    }
    existing.push(projection)
  }
  const projections = [...byId.values()].map((group) => aggregateTrial(group))
  const summary = summarize(projections)
  const baselineComplete = input.observations.every(
    (observation) => observation.baselineComplete
  )

  const body = {
    schema: "pdpp.mutation.receipt.v1" as const,
    intentDigest: input.intent.intentDigest,
    rawReportDigest: digestOf(input.rawReportBytes),
    attempt: {
      engineExit: input.engineExit,
      reportPresent: input.reportPresent,
      baselineComplete: input.observations.length > 0 && baselineComplete,
      status: (summary.validDenominator > 0 ? "evidence" : "no_evidence") as
        | "evidence"
        | "no_evidence",
    },
    observations: input.observations,
    projections,
    summary,
  }
  return { ...body, receiptDigest: digestOf(canonicalJSON(body)) }
}

export function verifyReceipt(
  receipt: AttemptReceipt,
  retainedRawReportBytes: string
): { readonly valid: boolean; readonly reason: string } {
  const { receiptDigest, ...body } = receipt
  if (digestOf(canonicalJSON(body)) !== receiptDigest) {
    return { valid: false, reason: "receipt_digest_mismatch" }
  }
  // Revalidate the digest against the bytes actually retained, rather than
  // trusting that the bytes recorded at write time are the bytes present now.
  if (digestOf(retainedRawReportBytes) !== receipt.rawReportDigest) {
    return { valid: false, reason: "raw_report_digest_mismatch" }
  }
  return { valid: true, reason: "digests_match" }
}
