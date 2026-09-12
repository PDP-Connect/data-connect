// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Freezes the intent packet for one cohort, before Stryker runs.
//
// This is the entry point the mutation workflow calls for its INTENT stage. It
// records what was requested; it has no way to record an outcome, because the
// packet type it writes has no field for one.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import {
  type CohortDefinition,
  type CohortName,
  escapesCohortRoot,
  type ExecutionInputs,
  freezeIntent,
  type LineRange,
  parseNameStatusZ,
  parseUnifiedZeroHunks,
  selectCohortTests,
  widenToStatements,
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
  excludedPrefixes: (optionalArgument("excluded-prefixes") ?? "")
    .split(/\s+/)
    .filter((prefix) => prefix.length > 0),
}

// Which Stryker configuration this attempt runs, recorded so the receipt names
// the configuration that actually produced the evidence. Deriving it from the
// cohort root alone is not sufficient any more: two cohorts now share the
// repository root and run different configurations, so a root-derived path
// would have the scripts cohort record the client cohort's digest and claim its
// evidence came from a configuration it never ran.
const configPath =
  optionalArgument("config") ??
  (cohortRoot === "." ? "stryker.config.mjs" : `${cohortRoot}/stryker.config.mjs`)

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

/**
 * First and last line of every statement in a TypeScript source file.
 *
 * Stryker mutates a node only when the node lies wholly inside a `mutate`
 * range, so a range must not start or end in the middle of a statement. These
 * boundaries are what the widening step grows a hunk out to.
 *
 * Every statement is reported, at every nesting depth, and the widener takes
 * the union of the ones a hunk touches. That is what keeps widening tight: a
 * changed line inside a long function is enclosed by its own small statement as
 * well as by the function body, and both are covered, but the nearest enclosing
 * statements are what determine the result -- the outer ones only matter when a
 * hunk genuinely spans them.
 */
function statementBoundaries(source: string, fileName: string): LineRange[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const boundaries: LineRange[] = []
  const visit = (node: ts.Node): void => {
    // Line numbers from the compiler are 0-based; Stryker's `mutate` ranges and
    // git's hunk headers are both 1-based.
    if (ts.isStatement(node) || ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      boundaries.push({ startLine: start, endLine: end })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return boundaries
}

// The line ranges the revision changed, per file, taken from the same
// merge-base..head comparison the name-status diff came from. `-U0` is what
// makes these the changed lines rather than the changed lines plus context.
const hunkDiff = execFileSync(
  "git",
  ["diff", "-U0", "--no-color", argument("base"), argument("head")],
  { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
)

const hunks = new Map<string, readonly LineRange[]>()
for (const file of parseUnifiedZeroHunks(hunkDiff)) {
  const onDisk = file.path
  if (!existsSync(onDisk)) {
    // The widener needs the file's text to find statement boundaries. A path the
    // diff names but the working tree does not hold means the tree is not the
    // revision the diff describes, and the ranges derived from it would not
    // describe what Stryker mutates. Recording no ranges here would hand
    // `freezeIntent` the shape it now rejects, so say what is wrong instead.
    throw new Error(
      `${onDisk} appears in the diff of ${argument("base")}..${argument("head")} but is not ` +
        `present in the working tree, so its changed lines cannot be widened to statements. ` +
        `The checked-out tree is not the revision the scope is being derived for.`
    )
  }
  const widened = widenToStatements(
    file.ranges,
    statementBoundaries(readFileSync(onDisk, "utf8"), onDisk)
  )
  hunks.set(file.path, widened)
}

const intent = freezeIntent({
  cohort,
  baseCommit: argument("base"),
  headCommit: argument("head"),
  diff,
  executionInputs,
  hunks,
})

writeFileSync(argument("out"), `${JSON.stringify(intent, null, 2)}\n`)

// The tests this attempt runs, for cohorts whose runner cannot select tests
// itself. Written unconditionally when asked for: an absent file and an empty
// file mean different things to the config that reads it, and only one of them
// is "no selection was recorded".
const selectedTestsPath = optionalArgument("selected-tests")
if (selectedTestsPath !== undefined) {
  // A test that reads above the cohort root cannot run in Stryker's sandbox,
  // which is rooted there. Left in, its ENOENT fails the initial test run,
  // rejects the baseline, and makes every mutant inconclusive -- so one such
  // test costs the whole attempt its evidence. Held out here it still runs, and
  // still fails if broken, in the cohort's own suite; it is only kept out of a
  // baseline it could never inform, since it exercises no file this batch
  // mutates. The names are printed so the narrowing is visible in the log
  // rather than applied silently.
  const withheld: string[] = []
  const tests = selectCohortTests(diff, cohort).filter((test) => {
    const onDisk = cohort.root === "." ? test : join(cohort.root, test)
    if (!existsSync(onDisk) || !escapesCohortRoot(test, readFileSync(onDisk, "utf8"))) {
      return true
    }
    withheld.push(test)
    return false
  })
  if (withheld.length > 0) {
    process.stdout.write(
      `withheld from the mutation baseline, reads above the cohort root: ${withheld.join(", ")}\n`
    )
  }
  writeFileSync(selectedTestsPath, tests.length === 0 ? "" : `${tests.join("\n")}\n`)
}

// The scope is printed in full. It is the difference between "this revision was
// mutated" and "these lines of this revision were mutated", and a reader of the
// log should not have to open the artifact to tell which one happened.
for (const entry of intent.scope) {
  // `whole_file` is now reachable only from a status-`A` file, so the
  // parenthetical is a fact about the entry rather than an assumption about it.
  const where =
    entry.kind === "whole_file"
      ? "whole file (added in this revision)"
      : entry.ranges.map((range) => `${range.startLine}-${range.endLine}`).join(", ")
  process.stdout.write(`scope ${entry.path}: ${where}\n`)
}

process.stdout.write(
  `intent ${intent.intentDigest} cohort=${intent.cohort} ` +
    `applicability=${intent.applicability} mutate=${intent.mutate.length} ` +
    `excluded=${intent.excluded.length}\n`
)
