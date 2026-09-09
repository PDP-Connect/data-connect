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

const receipt = buildAttemptReceipt({
  intent,
  rawReportBytes,
  observations,
  cacheDecision:
    argument("cache-hit") === "true"
      ? { reuse: true, reason: "execution_inputs_match" }
      : { reuse: false, reason: "execution_inputs_changed_or_absent" },
})

writeFileSync(argument("out"), `${JSON.stringify(receipt, null, 2)}\n`)

const { killed, survived, inconclusive, validDenominator } = receipt.summary
process.stdout.write(
  `receipt ${receipt.receiptDigest} cohort=${argument("cohort")} ` +
    `killed=${killed} survived=${survived} inconclusive=${inconclusive} ` +
    `valid_denominator=${validDenominator} stryker_exit=${strykerExit}\n`
)
