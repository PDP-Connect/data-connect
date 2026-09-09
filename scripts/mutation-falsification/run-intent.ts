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
  type CohortDefinition,
  type CohortName,
  type ExecutionInputs,
  freezeIntent,
  parseNameStatusZ,
} from "./select-pr-files.ts"

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined) {
    throw new Error(`missing required argument --${name}`)
  }
  return value
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

const intent = freezeIntent({
  cohort,
  baseCommit: argument("base"),
  headCommit: argument("head"),
  diff: parseNameStatusZ(readFileSync(argument("diff"), "utf8")),
  executionInputs,
})

writeFileSync(argument("out"), `${JSON.stringify(intent, null, 2)}\n`)

process.stdout.write(
  `intent ${intent.intentDigest} cohort=${intent.cohort} ` +
    `applicability=${intent.applicability} mutate=${intent.mutate.length} ` +
    `excluded=${intent.excluded.length}\n`
)
