// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// INTENT stage of the reactive mutation pipeline.
//
// Stryker has no `--since` / changed-files selection of its own, so git
// supplies the scope and Stryker consumes it as a `mutate` list. This module
// derives that list from a merge-base..head diff and freezes it, together with
// the identity of every input the run depends on, into an intent packet whose
// identity is DERIVED from its own bytes rather than supplied by a caller.
//
// The intent packet records what was requested. It never records, and must
// never be able to record, what the outcome was: `killed`, `survived`, and
// `inconclusive` are computed downstream in project-outcome.ts from raw
// observations, and are not accepted as inputs here or anywhere else.
//
// There are deliberately no duration, budget, mutant-count, or admission
// thresholds in this file. Scope is whatever the pull request touched.

import { createHash } from "node:crypto"

/** A production source file selected for mutation, relative to the cohort root. */
export type SelectedFile = string

export type CohortName = "client" | "reference-implementation"

/**
 * Everything a cohort's mutation run reads, recorded in the intent so a reader
 * can tell what the evidence was produced against. It is a description of the
 * attempt, not an authorisation to reuse anything: this pipeline has no result
 * cache, and an earlier revision that used this identity for that purpose got
 * it wrong -- it did not cover the resolved test command.
 */
export interface ExecutionInputs {
  /** Cohort root relative to the repository root, e.g. "." or "reference-implementation". */
  readonly cohortRoot: string
  /** Digest of the resolved Stryker configuration for this cohort. */
  readonly configDigest: string
  /** Resolved version of the mutation tool, e.g. "10.0.0". */
  readonly toolVersion: string
  /** Resolved runtime version the cohort's tests execute under, e.g. "v22.23.1". */
  readonly runtimeVersion: string
  /**
   * Digests of the dependency manifests governing the cohort.
   */
  readonly lockfileDigests: readonly { readonly path: string; readonly digest: string }[]
}

export interface IntentPacket {
  readonly schema: "pdpp.mutation.intent.v1"
  readonly cohort: CohortName
  /** Merge base of the pull request's base branch and the exact tested head. */
  readonly baseCommit: string
  /** The exact commit the evidence is about. */
  readonly headCommit: string
  /** Production files selected for mutation, sorted, deduplicated. */
  readonly mutate: readonly SelectedFile[]
  /** Files the diff named that were deliberately not selected, with the reason. */
  readonly excluded: readonly { readonly path: string; readonly reason: ExclusionReason }[]
  readonly executionInputs: ExecutionInputs
  /**
   * `not_applicable` when the diff selected no production file. This is neither
   * a pass nor a failure: no mutation evidence exists for such a revision.
   */
  readonly applicability: "applicable" | "not_applicable"
  /** SHA-256 over the canonical bytes of every field above. Derived, never supplied. */
  readonly intentDigest: string
}

export type ExclusionReason =
  | "deleted"
  | "not_production_source"
  | "outside_cohort"
  | "test_file"

/** One `git diff` name-status record, already parsed out of the NUL-delimited stream. */
export interface DiffEntry {
  /** "A", "M", "D", "R100", "C75", ... */
  readonly status: string
  /** Path in the head tree; for a rename this is the destination. */
  readonly path: string
}

/**
 * Parse `git diff --name-status -z --diff-filter=ACMRT <base> <head>`.
 *
 * NUL delimiting is not cosmetic: it is what lets a path containing a space,
 * a quote, or a newline survive into the `mutate` list intact instead of being
 * split by a shell. Rename and copy records carry two path fields (source then
 * destination); the destination is the file that exists at head, so that is the
 * one that can be mutated.
 */
export function parseNameStatusZ(raw: string): DiffEntry[] {
  const fields = raw.split("\0").filter((field) => field.length > 0)
  const entries: DiffEntry[] = []
  let index = 0
  while (index < fields.length) {
    const status = fields[index]
    if (status === undefined) {
      break
    }
    index += 1
    const takesTwoPaths = status.startsWith("R") || status.startsWith("C")
    const first = fields[index]
    index += 1
    if (first === undefined) {
      throw new Error(`git name-status record "${status}" has no path field`)
    }
    if (takesTwoPaths) {
      const second = fields[index]
      index += 1
      if (second === undefined) {
        throw new Error(`git name-status record "${status}" has no destination path`)
      }
      entries.push({ status, path: second })
      continue
    }
    entries.push({ status, path: first })
  }
  return entries
}

export interface CohortDefinition {
  readonly name: CohortName
  /** Repository-relative cohort root; "." for the client cohort. */
  readonly root: string
  /** Repository-relative path prefixes whose files are mutable production source. */
  readonly productionPrefixes: readonly string[]
}

const PRODUCTION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"]

function isTestPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1)
  return (
    /\.test\.[cm]?tsx?$/.test(base) ||
    /\.conformance\.test\./.test(base) ||
    path.includes("/test/") ||
    path.includes("/__tests__/")
  )
}

function isProductionSourceExtension(path: string): boolean {
  return (
    PRODUCTION_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
    !path.endsWith(".d.ts")
  )
}

/**
 * Classify one diff entry for one cohort.
 *
 * Deleted paths are excluded because there is nothing at head to mutate; the
 * exclusion is recorded rather than dropped so the receipt shows the diff was
 * seen in full. A test-only change selects nothing: it is the accepted blind
 * spot of a diff-scoped design, recorded as `not_applicable` rather than
 * silently reported as a clean run.
 */
export function classifyForCohort(
  entry: DiffEntry,
  cohort: CohortDefinition
): { readonly selected: true } | { readonly selected: false; readonly reason: ExclusionReason } {
  if (entry.status.startsWith("D")) {
    return { selected: false, reason: "deleted" }
  }
  // `test_file` is decided before cohort membership, because a cohort's tests
  // usually live outside its production prefixes -- the reference
  // implementation keeps them in `test/` -- and calling those `outside_cohort`
  // describes them wrongly. Both reasons exclude, so the mutate list is the
  // same either way; only the recorded reason differs, and the receipt is
  // supposed to say why a file was skipped.
  if (isTestPath(entry.path)) {
    return { selected: false, reason: "test_file" }
  }
  const withinCohort = cohort.productionPrefixes.some((prefix) => entry.path.startsWith(prefix))
  if (!withinCohort) {
    return { selected: false, reason: "outside_cohort" }
  }
  if (!isProductionSourceExtension(entry.path)) {
    return { selected: false, reason: "not_production_source" }
  }
  return { selected: true }
}

/**
 * The tests a command-runner cohort should run for this attempt.
 *
 * The command runner reports no per-test identities, so Stryker cannot select
 * tests itself and the selection has to be expressed inside the command. This
 * derives it from the same diff that produced the `mutate` list: every test file
 * the revision touched, cohort-relative, sorted and deduplicated.
 *
 * An empty result means the revision touched no test file in this cohort, which
 * is not the same as "run nothing". The caller falls back to the cohort's whole
 * suite, so a mutant is never recorded as surviving a selection that was empty.
 */
export function selectCohortTests(
  diff: readonly DiffEntry[],
  cohort: CohortDefinition
): SelectedFile[] {
  const selected: SelectedFile[] = []
  for (const entry of diff) {
    if (entry.status.startsWith("D")) {
      continue
    }
    if (!isTestPath(entry.path) || !isProductionSourceExtension(entry.path)) {
      continue
    }
    // Test files live inside the cohort root but outside the production
    // prefixes, so cohort membership is decided by the root here.
    if (cohort.root !== "." && !entry.path.startsWith(`${cohort.root}/`)) {
      continue
    }
    selected.push(toCohortRelative(entry.path, cohort.root))
  }
  return [...new Set(selected)].sort()
}

/**
 * Whether a test can run inside Stryker's sandbox for a cohort.
 *
 * Stryker copies a cohort into a sandbox rooted at the cohort root and writes
 * each file at its path relative to that root, so nothing above the root exists
 * in the sandbox and no `files` or `ignorePatterns` entry can put it there. A
 * test that reads a repository-root path -- `../../.github/workflows/...`, say --
 * therefore fails with ENOENT in the sandbox while passing on disk. One such
 * failure fails Stryker's initial test run, which rejects the baseline and makes
 * every mutant in the batch inconclusive, so the whole attempt yields nothing.
 *
 * Excluding these is not the same as letting a test skip when its file is
 * missing: the test still runs, and still fails, in the cohort's own suite. It
 * is held out of the mutation baseline only, where it can bear on no mutant --
 * it exercises a file outside the cohort, which no mutant in this batch touches.
 * The exclusion is recorded in the intent packet rather than applied silently.
 */
export function escapesCohortRoot(testPath: SelectedFile, testSource: string): boolean {
  // How far the test's own directory sits below the cohort root. A `../` budget
  // larger than this climbs past the root, which is what leaves the sandbox.
  const depth = testPath.split("/").length - 1

  // The traversals these tests build with `join(__dirname, "../../...")`. Each
  // literal is measured against the budget rather than matched at a fixed
  // depth, because the same `../../` escapes from `scripts/` but not from
  // `test/nested/`.
  for (const [, literal] of testSource.matchAll(/["'`]([^"'`\n]*\.\.\/[^"'`\n]*)["'`]/g)) {
    let climbed = 0
    for (const segment of literal.split("/")) {
      if (segment === "..") {
        climbed += 1
      } else if (segment !== "." && segment !== "") {
        break
      }
    }
    if (climbed > depth) {
      return true
    }
  }
  return false
}

/** Make a repository-relative path cohort-relative, so it can be a `mutate` glob. */
export function toCohortRelative(path: string, cohortRoot: string): string {
  if (cohortRoot === ".") {
    return path
  }
  const prefix = `${cohortRoot}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Canonical JSON per RFC 8785's ordering rule: object keys sorted by code unit,
 * no insignificant whitespace. Two packets with the same content therefore have
 * the same bytes and the same digest regardless of construction order.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJSON(element)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const members = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
  return `{${members.join(",")}}`
}

export function digestOf(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`
}

/**
 * Build the frozen intent packet. The digest is computed over the packet's own
 * canonical bytes with the digest field absent, so it cannot be asserted by a
 * caller; `verifyIntentDigest` recomputes it the same way.
 */
export function freezeIntent(input: {
  readonly cohort: CohortDefinition
  readonly baseCommit: string
  readonly headCommit: string
  readonly diff: readonly DiffEntry[]
  readonly executionInputs: ExecutionInputs
}): IntentPacket {
  const selected: SelectedFile[] = []
  const excluded: { path: string; reason: ExclusionReason }[] = []
  for (const entry of input.diff) {
    const verdict = classifyForCohort(entry, input.cohort)
    if (verdict.selected) {
      selected.push(toCohortRelative(entry.path, input.cohort.root))
      continue
    }
    excluded.push({ path: entry.path, reason: verdict.reason })
  }
  const mutate = [...new Set(selected)].sort()
  excluded.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  const body = {
    schema: "pdpp.mutation.intent.v1" as const,
    cohort: input.cohort.name,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    mutate,
    excluded,
    executionInputs: input.executionInputs,
    applicability: (mutate.length === 0 ? "not_applicable" : "applicable") as
      | "applicable"
      | "not_applicable",
  }
  return { ...body, intentDigest: digestOf(canonicalJSON(body)) }
}

export function verifyIntentDigest(packet: IntentPacket): boolean {
  const { intentDigest, ...body } = packet
  return digestOf(canonicalJSON(body)) === intentDigest
}
