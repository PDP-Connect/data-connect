// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Re-projects one cohort's Stryker report and writes the attempt receipt.
//
// This is the entry point the mutation workflow calls for its PROJECTION and
// RECEIPT stages. It reads Stryker's raw JSON as an observation artifact and
// computes the verdict itself; no status is copied through.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { buildAttemptReceipt, readObservations } from "./stryker-adapter.ts"
import { type IntentPacket, verifyIntentDigest } from "./select-pr-files.ts"

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
const rawReportBytes = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""

// The baseline is complete only when Stryker itself exited cleanly. Anything
// else makes every mutant in the batch inconclusive, because there is no
// established "the suite passes on unmutated code" to compare against.
const baselineComplete = strykerExit === "0"

const observations =
  rawReportBytes.length === 0
    ? []
    : readObservations(JSON.parse(rawReportBytes), { baselineComplete })

// The cache decision is `mayReuseCache`'s, recorded by the step that made it.
// It is read rather than re-derived here so the receipt reports the mechanism
// that actually governed the run. An absent file means that step did not run,
// which is not the same as a decision to run cold.
const cacheDecisionPath = argument("cache-decision")
const cacheDecision = existsSync(cacheDecisionPath)
  ? (JSON.parse(readFileSync(cacheDecisionPath, "utf8")) as {
      readonly reuse: boolean
      readonly reason: string
    })
  : { reuse: false, reason: "no_cache_decision_recorded" }

const receipt = buildAttemptReceipt({
  intent,
  rawReportBytes,
  observations,
  cacheDecision,
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
// absence of any evidence does. A revision that mutates nothing never reaches
// here, because the workflow reports it as not_applicable instead.
const failures: string[] = []
if (!baselineComplete) {
  failures.push(
    `the baseline was rejected (engine exit ${strykerExit}), so every mutant in this ` +
      "batch is inconclusive and the run established nothing about the suite"
  )
}
if (receipt.projections.length === 0) {
  failures.push("no mutant trials were recorded, so this attempt produced no evidence")
} else if (validDenominator === 0) {
  failures.push(
    `all ${inconclusive} trial(s) were inconclusive, so no fault was shown to be ` +
      "either detected or missed"
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
