// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Re-projects one cohort's Stryker report and writes the attempt receipt.
//
// This is the entry point the mutation workflow calls for its PROJECTION and
// RECEIPT stages. It reads Stryker's raw JSON as an observation artifact and
// computes the verdict itself; no status is copied through.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  buildAttemptReceipt,
  classifyReport,
  readObservations,
  type ReportValidity,
} from "./stryker-adapter.ts"
import { type IntentPacket, verifyIntentDigest } from "./select-pr-files.ts"

/**
 * Say what was wrong with the report, in terms of the artifact rather than of
 * this program's internals. A reader who sees this check fail has not opened the
 * report, so the message is the only place the cause is stated.
 */
function reportUnusableReason(validity: ReportValidity): string {
  switch (validity.kind) {
    case "valid":
      throw new Error("reportUnusableReason called for a valid report")
    case "absent":
      return "the engine wrote no report, so this attempt produced no evidence"
    case "empty":
      return "the report file exists but is empty, so the engine wrote nothing to read"
    case "unparseable":
      return `the report is not valid JSON (${validity.detail}), so nothing can be read from it`
    case "unrecognised":
      return `the report is not a recognisable Stryker report: ${validity.detail}`
    case "out_of_scope":
      return (
        `the report is not about the code this attempt selected: ${validity.detail}. ` +
        "An empty result for other files establishes nothing about these lines"
      )
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined) {
    throw new Error(`missing required argument --${name}`)
  }
  return value
}

const intent = JSON.parse(readFileSync(argument("intent"), "utf8")) as IntentPacket
if (!verifyIntentDigest(intent)) {
  // The packet was edited between freezing and projection. Refusing here is the
  // point: evidence bound to an intent nobody can vouch for is not evidence.
  throw new Error(`intent packet digest does not match its contents: ${intent.intentDigest}`)
}

const reportPath = argument("report")
const strykerExit = argument("stryker-exit")

// A missing report means the run did not get far enough to write one. That is
// recorded as an empty observation set, which the projector turns into zero
// trials rather than into a clean result.
const reportPresent = existsSync(reportPath)
const rawReportBytes = reportPresent ? readFileSync(reportPath, "utf8") : ""

// The baseline is complete only when Stryker itself exited cleanly. Anything
// else makes every mutant in the batch inconclusive, because there is no
// established "the suite passes on unmutated code" to compare against.
const baselineComplete = strykerExit === "0"

// Whether the engine SPOKE, decided separately from what it said. File
// existence is not this fact: a zero-byte file, a `null`, or an object without
// `files` all exist and all read as zero observations, which is the same shape a
// clean run over non-mutable code produces. Only a structurally valid report
// covering the selected scope licenses the zero-mutant exception below.
const reportValidity = classifyReport({
  reportPresent,
  rawReportBytes,
  selectedPaths: intent.mutate,
})

const observations =
  reportValidity.kind === "valid"
    ? readObservations(JSON.parse(rawReportBytes), { baselineComplete })
    : []

const receipt = buildAttemptReceipt({
  intent,
  rawReportBytes,
  observations,
  engineExit: strykerExit,
  reportPresent,
  reportValidity: reportValidity.kind,
  baselineComplete,
})

writeFileSync(argument("out"), `${JSON.stringify(receipt, null, 2)}\n`)

const { killed, survived, inconclusive, validDenominator } = receipt.summary
process.stdout.write(
  `receipt ${receipt.receiptDigest} cohort=${argument("cohort")} ` +
    `killed=${killed} survived=${survived} inconclusive=${inconclusive} ` +
    `valid_denominator=${validDenominator} stryker_exit=${strykerExit}\n`
)

// A run that was applicable and produced no evidence must not report success.
//
// The receipt is honest either way -- it records "no evidence" accurately -- but
// a green check on top of an empty receipt is not, and the surface is what a
// reader sees first. The failure modes this catches are exactly the ones that
// look identical to a clean run from the outside: a rejected baseline makes
// every mutant inconclusive, and a run that never wrote a report produces no
// trials at all.
//
// This is not a mutation-score gate. Survivors do not fail the job; only the
// absence of any evidence does.
//
// One case that looks like absent evidence is not: a clean engine run that found
// nothing to mutate. Applicability is decided from the diff's changed line
// ranges before the engine runs, so a revision whose only production change is a
// non-mutable line -- a URL or message string, a comment, an import -- is
// reported `applicable` and then instruments zero mutants. An earlier revision
// of this file assumed "a revision that mutates nothing never reaches here,
// because the workflow reports it as not_applicable instead". That is false:
// `not_applicable` means no file was SELECTED, not that no mutant EXISTS. A
// one-line link change in a .tsx file failed this gate with `stryker_exit=0` and
// `Instrumented 1 source file(s) with 0 mutant(s)`, which no amount of work on
// the revision could have cleared.
//
// Zero mutants after a complete baseline is therefore reported the same way the
// workflow reports a non-applicable cohort: neither a pass nor a failure. It is
// only absent evidence when the engine did not get to speak -- no report at all,
// or a rejected baseline.
//
// "The engine got to speak" is a claim about the REPORT, and an earlier revision
// of this exception tested `reportPresent` for it. That is file existence, which
// a zero-byte file, a `null`, an object with no `files`, a `files` of the wrong
// type, an entry missing its `mutants` array, and a report about entirely
// different files all satisfy. Every one of those also yields zero projections,
// so the exception swallowed them: six malformed inputs exited 0 while printing
// that the engine found no mutable code. A gate that reports success on a broken
// run is worse than no gate, because it is also a claim that the run was fine.
// The exception now requires a report this program could actually read as a
// report about the lines this attempt selected.
const engineRanAndFoundNothingToMutate =
  reportValidity.kind === "valid" && baselineComplete && receipt.projections.length === 0

const failures: string[] = []
if (!baselineComplete) {
  failures.push(
    `the baseline was rejected (engine exit ${strykerExit}), so every mutant in this ` +
      "batch is inconclusive and the run established nothing about the suite"
  )
}
if (reportValidity.kind !== "valid") {
  failures.push(reportUnusableReason(reportValidity))
}
if (receipt.projections.length === 0) {
  if (!engineRanAndFoundNothingToMutate && reportValidity.kind === "valid") {
    failures.push("no mutant trials were recorded, so this attempt produced no evidence")
  }
} else if (validDenominator === 0) {
  failures.push(
    `all ${inconclusive} trial(s) were inconclusive, so no fault was shown to be ` +
      "either detected or missed"
  )
}

if (engineRanAndFoundNothingToMutate && failures.length === 0) {
  process.stdout.write(
    "The engine completed and found no mutable code in this revision's changed lines, so no\n" +
      "mutation evidence exists for it. This is not a pass and not a failure. The receipt and\n" +
      "the raw report are still published and record the empty trial set accurately.\n"
  )
}

if (failures.length > 0) {
  process.stderr.write(
    `\nThis attempt produced no mutation evidence:\n${failures
      .map((failure) => `  - ${failure}\n`)
      .join("")}` +
      "\nThe receipt and the raw report are still published, and they record this " +
      "accurately. This step fails so the absence of evidence is visible without " +
      "opening the artifact.\n"
  )
  process.exitCode = 1
}
