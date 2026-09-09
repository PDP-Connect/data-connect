// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Freezes the intent packet for one cohort, before Stryker runs.
//
// This is the entry point the mutation workflow calls for its INTENT stage. It
// records what was requested; it has no way to record an outcome, because the
// packet type it writes has no field for one.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import {
  canonicalJSON,
  type CohortDefinition,
  type CohortName,
  digestOf,
  type ExecutionInputs,
  freezeIntent,
  parseNameStatusZ,
  selectCohortTests,
} from "./select-pr-files.ts"

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined) {
    throw new Error(`missing required argument --${name}`)
  }
  return value
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function digestOfFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
}

const cohortName = argument("cohort") as CohortName
const cohortRoot = argument("cohort-root")
const cohort: CohortDefinition = {
  name: cohortName,
  root: cohortRoot,
  productionPrefixes: argument("prefixes")
    .split(/\s+/)
    .filter((prefix) => prefix.length > 0),
}

const configPath = cohortRoot === "." ? "stryker.config.mjs" : `${cohortRoot}/stryker.config.mjs`

// Every input the run depends on, named so a later run can tell whether it is
// looking at the same thing. The lockfile is in here because Stryker's own
// incremental tracking does not see changes outside mutated and test files,
// which is exactly where a dependency change lives.
const executionInputs: ExecutionInputs = {
  cohortRoot,
  configDigest: digestOfFile(configPath),
  toolVersion: JSON.parse(
    readFileSync("node_modules/@stryker-mutator/core/package.json", "utf8")
  ).version,
  runtimeVersion: process.version,
  lockfileDigests: [{ path: "package-lock.json", digest: digestOfFile("package-lock.json") }],
}

const diff = parseNameStatusZ(readFileSync(argument("diff"), "utf8"))

const intent = freezeIntent({
  cohort,
  baseCommit: argument("base"),
  headCommit: argument("head"),
  diff,
  executionInputs,
})

writeFileSync(argument("out"), `${JSON.stringify(intent, null, 2)}\n`)

// The execution-input identity, written on its own so the incremental cache can
// be keyed on it alone. Keying on the whole intent packet would fold in the head
// commit and the changed-file list, which differ on every revision, so no key
// could ever match and every run would be cold.
const inputsDigestPath = optionalArgument("inputs-digest")
if (inputsDigestPath !== undefined) {
  writeFileSync(inputsDigestPath, `${digestOf(canonicalJSON(executionInputs))}\n`)
}

// The tests this attempt runs, for cohorts whose runner cannot select tests
// itself. Written unconditionally when asked for: an absent file and an empty
// file mean different things to the config that reads it, and only one of them
// is "no selection was recorded".
const selectedTestsPath = optionalArgument("selected-tests")
if (selectedTestsPath !== undefined) {
  const tests = selectCohortTests(diff, cohort)
  writeFileSync(selectedTestsPath, tests.length === 0 ? "" : `${tests.join("\n")}\n`)
}

process.stdout.write(
  `intent ${intent.intentDigest} cohort=${intent.cohort} ` +
    `applicability=${intent.applicability} mutate=${intent.mutate.length} ` +
    `excluded=${intent.excluded.length}\n`
)
