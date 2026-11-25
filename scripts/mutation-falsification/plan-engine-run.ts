// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Decides, from the recorded test-selection outcome, whether the mutation
// workflow may start Stryker. Prints lines for `$GITHUB_OUTPUT`.

import { readFileSync } from "node:fs"
import { planEngineRun } from "./selection-outcome.ts"

const index = process.argv.indexOf("--outcome")
const path = index === -1 ? undefined : process.argv[index + 1]
if (path === undefined) {
  throw new Error("missing required argument --outcome")
}

const plan = planEngineRun(readFileSync(path, "utf8").trim())
if (plan.run) {
  process.stdout.write("run=true\n")
} else {
  process.stdout.write(`run=false\nengine_exit=${plan.engineExit}\n`)
  // An output value holds one line, so the reason goes to the log.
  process.stderr.write(`${plan.reason}\n`)
}
