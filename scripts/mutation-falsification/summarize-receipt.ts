// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Renders one attempt receipt as the pull request's job summary.
//
// The summary reports projected outcomes and raw Stryker statuses side by side,
// and never reduces them to a single score. A percentage would have to pick a
// denominator, and every choice of denominator either hides the trials that
// produced no evidence or counts them as if they had.

import { readFileSync } from "node:fs"
import type { AttemptReceipt } from "./stryker-adapter.ts"

const receipt = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as AttemptReceipt
const { killed, survived, inconclusive, validDenominator, rawStatusCounts } = receipt.summary

const lines: string[] = [
  "| Projected outcome | Count |",
  "| --- | --- |",
  `| killed (an assertion failed) | ${killed} |`,
  `| survived (pending triage) | ${survived} |`,
  `| inconclusive | ${inconclusive} |`,
  `| valid denominator (killed + survived) | ${validDenominator} |`,
  "",
  "Inconclusive trials stay outside the valid denominator, so no ratio here is",
  "inflated by dropping the trials that produced no evidence.",
  "",
  "| Raw engine status | Count |",
  "| --- | --- |",
  ...Object.entries(rawStatusCounts)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([status, count]) => `| ${status} | ${count} |`),
  "",
  `Intent: \`${receipt.intentDigest}\``,
  `Raw report: \`${receipt.rawReportDigest}\``,
  `Receipt: \`${receipt.receiptDigest}\``,
  `Incremental cache reused: ${receipt.cacheDecision.reuse} (${receipt.cacheDecision.reason})`,
  "",
]

if (survived > 0) {
  lines.push(
    "A survivor is an observation, not a defect finding. Dismissing one as equivalent",
    "requires a separate triage record written by someone other than the author of",
    "this change.",
    ""
  )
}

if (inconclusive > 0) {
  lines.push(
    "Inconclusive trials produced no evidence either way. In particular a timeout is",
    "not a kill, unreached code is not a survivor, and an engine `Killed` without",
    "retained assertion output is not an assertion kill.",
    ""
  )
}

process.stdout.write(`${lines.join("\n")}\n`)
