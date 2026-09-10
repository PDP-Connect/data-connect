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
//
// "What the pull request touched" is measured in LINES, not files. Stryker's
// `mutate` entries take a `path:startLine-endLine` form, so the diff's own hunk
// ranges become the scope directly. A file entry with no range mutates every
// statement in the file, which for a 10,000-line file means thousands of
// mutants for a four-line change -- work that produces no evidence about the
// change, because a mutant a thousand lines away is not a fault this revision
// could have introduced.

import { createHash } from "node:crypto"

/**
 * A production source entry selected for mutation, relative to the cohort root.
 *
 * Either a bare path -- the whole file -- or `path:startLine-endLine`, the form
 * Stryker reads as "mutate only the statements overlapping these lines".
 */
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
  /**
   * Stryker `mutate` entries, sorted, deduplicated. Each is either
   * `path:startLine-endLine` -- the changed line ranges of a modified file,
   * widened to whole statements -- or a bare path for a newly added file, where
   * the whole file is the change.
   *
   * This is the exact list handed to the engine, so the evidence says precisely
   * what was mutated rather than only which files were involved.
   */
  readonly mutate: readonly SelectedFile[]
  /**
   * How each selected file was scoped, kept beside `mutate` so a reader can see
   * the derivation without re-parsing the entries. `whole_file` appears only for
   * a file the diff gave status `A`, and is decided by that status rather than
   * by an empty range list, so no other shape can fall into it.
   */
  readonly scope: readonly {
    readonly path: string
    readonly kind: "changed_ranges" | "whole_file"
    readonly ranges: readonly LineRange[]
  }[]
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

/** A closed, 1-based line interval in the head revision of a file. */
export interface LineRange {
  readonly startLine: number
  readonly endLine: number
}

/** The changed line ranges of one file at head, as read from `git diff -U0`. */
export interface FileHunks {
  /** Path in the head tree. */
  readonly path: string
  readonly ranges: readonly LineRange[]
}

/**
 * Parse the hunk headers of `git diff -U0 <base> <head>`.
 *
 * Only two line kinds matter: `+++ b/<path>` names the file the following hunks
 * belong to, and `@@ -<old> +<newStart>[,<newCount>] @@` gives the range those
 * hunks occupy in the head revision. Zero context (`-U0`) is what makes those
 * ranges the changed lines themselves rather than the changed lines plus three
 * lines of neighbourhood on each side.
 *
 * A `newCount` of 0 marks a pure deletion: the hunk removed lines and added
 * none, so there is nothing at head to mutate and the hunk contributes no
 * range. Git reports the position as the line *before* the removal for such a
 * hunk, so treating it as a one-line range would scope mutation to an unrelated
 * surviving line. Deleted content cannot carry a fault into head.
 *
 * `/dev/null` as the destination is a deleted file; it is skipped for the same
 * reason, and the file-level classifier records the deletion separately.
 */
export function parseUnifiedZeroHunks(diff: string): FileHunks[] {
  const byPath = new Map<string, LineRange[]>()
  let current: LineRange[] | undefined
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const destination = line.slice(4).trim()
      if (destination === "/dev/null") {
        current = undefined
        continue
      }
      // `+++ b/<path>`. Git prefixes the destination with `b/` unless
      // `--no-prefix` was used, in which case the path stands alone.
      const path = destination.startsWith("b/") ? destination.slice(2) : destination
      current = byPath.get(path) ?? []
      byPath.set(path, current)
      continue
    }
    if (!line.startsWith("@@") || current === undefined) {
      continue
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header === null) {
      continue
    }
    const startLine = Number(header[1])
    const count = header[2] === undefined ? 1 : Number(header[2])
    if (count === 0) {
      continue
    }
    current.push({ startLine, endLine: startLine + count - 1 })
  }
  return [...byPath].map(([path, ranges]) => ({ path, ranges: mergeRanges(ranges) }))
}

/**
 * Merge ranges that touch or overlap, so the mutate list carries one entry per
 * contiguous region instead of several that name the same statements. Adjacent
 * ranges are merged too: two hunks on lines 10 and 11 describe one region, and
 * emitting them separately would ask Stryker the same question twice.
 */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine)
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.startLine <= last.endLine + 1) {
      merged[merged.length - 1] = {
        startLine: last.startLine,
        endLine: Math.max(last.endLine, range.endLine),
      }
      continue
    }
    merged.push(range)
  }
  return merged
}

/**
 * Grow each range until it covers whole statements.
 *
 * This is a correctness requirement, not tidying. Stryker mutates a node only
 * when the node is wholly *inside* a range -- `locationIncluded`, not
 * `locationOverlaps` -- so a range that starts in the middle of a multi-line
 * statement mutates nothing in that statement. PR #83 changes exactly this
 * shape: one hunk replaces the first lines of a `setImmediate(...)` call whose
 * remaining lines are unchanged, and a range of only the changed lines would
 * silently mutate none of it while still reporting a completed run.
 *
 * A range is left alone when it cuts no statement -- when every statement is
 * either wholly inside it or wholly outside it -- however much else encloses it.
 * That restraint is what keeps this tight: growing out to every enclosing
 * statement would widen a one-line change to its function and then to the
 * module, which on `server/index.ts` turned four changed lines into ranges
 * covering a third of a 10,000-line file, the whole-file cost this change
 * exists to remove.
 *
 * A range that does cut a statement grows outward only, and only as far as the
 * *smallest* statement containing it whole. Where no statement contains it --
 * the usual shape at the top level of a module -- each edge grows out to the
 * smallest statement that edge cuts, and the union covers every statement
 * between. Both halves matter: a range spanning two adjacent top-level
 * statements has no single containing statement, and looking only for one left
 * it slicing both, generating nothing for either while the run still reported
 * completion. Growth repeats until no statement is left straddling the range,
 * because moving an edge can expose a further statement across the new edge --
 * the ordinary shape wherever statement spans partially overlap, as an `if`'s
 * two blocks do on the `} else {` line.
 *
 * `boundaries` gives, for each statement in the file, its first and last line.
 * Supplying it as data keeps this function a pure interval computation that can
 * be tested without a parser, and lets the caller decide what "statement" means
 * for a given language.
 */
export function widenToStatements(
  ranges: readonly LineRange[],
  boundaries: readonly LineRange[]
): LineRange[] {
  /**
   * Grow a range out to the smallest statement cut by each of its edges.
   *
   * A statement is "cut" by an edge when it lies partly inside the range and
   * partly outside: that is the statement Stryker cannot mutate, because the
   * range does not contain it whole. Each edge is treated separately and the
   * results unioned, which is what makes a range spanning several statements
   * cover all of them -- at the top level of a module there is often no single
   * statement containing the whole range, and looking only for one left such a
   * range slicing every statement it touched.
   *
   * "Smallest" is what keeps this tight. A cut line sits inside its own small
   * statement and inside the function body alike, and following the body out
   * would restore the whole-file cost this scoping removes -- on
   * `server/index.ts` the enclosing body spans the file. The innermost one is
   * the smallest region Stryker can mutate as a unit that holds the cut
   * statement whole, so growing stops there.
   *
   * A statement lying wholly inside the range is already covered, and one
   * strictly containing a range that cuts nothing is left alone: the revision
   * did not change it as a unit, and Stryker still mutates the statements
   * nested within.
   */
  const smaller = (candidate: LineRange, held: LineRange | undefined): boolean =>
    held === undefined || candidate.endLine - candidate.startLine < held.endLine - held.startLine

  /** Whether any statement lies partly inside `range` and partly outside it. */
  const cutsAStatement = (range: LineRange): boolean =>
    boundaries.some(
      (statement) =>
        (statement.startLine < range.startLine && statement.endLine >= range.startLine) ||
        (statement.endLine > range.endLine && statement.startLine <= range.endLine)
    )

  /** Whether some statement's span is exactly `range`. */
  const isWholeStatement = (range: LineRange): boolean =>
    boundaries.some(
      (statement) =>
        statement.startLine === range.startLine && statement.endLine === range.endLine
    )

  /**
   * Whether any statement overlaps `range` while the range neither holds it
   * whole nor is held whole by it -- the statements Stryker generates nothing
   * for. A statement inside the range is mutated; one containing the range is
   * the unit the range sits within, and Stryker still mutates the statements
   * nested inside it. Anything else is a genuine loss, and is what growing must
   * eliminate.
   */
  const straddlesAStatement = (range: LineRange): boolean =>
    boundaries.some(
      (statement) =>
        statement.startLine <= range.endLine &&
        statement.endLine >= range.startLine &&
        !(statement.startLine >= range.startLine && statement.endLine <= range.endLine) &&
        !(statement.startLine <= range.startLine && statement.endLine >= range.endLine)
    )

  const widenOne = (range: LineRange): LineRange => {
    // A range that cuts nothing is already made of whole statements, whatever
    // else encloses it. Growing it out to that encloser would reach the
    // function and then the module -- the whole-file cost this scoping removes
    // -- and buys nothing, because Stryker mutates the statements inside a
    // range it contains whole.
    if (!cutsAStatement(range)) {
      return range
    }

    // The smallest statement containing the whole range. Where one exists this
    // is the multi-line call or block the range splits, and covering it is what
    // makes Stryker mutate it at all. Smallest is what keeps the result tight.
    let covering: LineRange | undefined
    for (const statement of boundaries) {
      if (statement.startLine > range.startLine || statement.endLine < range.endLine) {
        continue
      }
      // A statement whose span is exactly the range is no progress: returning it
      // makes growth a fixed point at a range a sibling still straddles. That is
      // the `} else {` shape -- the consequent block ends on the line the
      // alternative starts, so a hunk on that line is contained by both, and this
      // lookup returns the one the range already equals.
      if (statement.startLine === range.startLine && statement.endLine === range.endLine) {
        continue
      }
      if (smaller(statement, covering)) {
        covering = statement
      }
    }
    if (covering !== undefined) {
      return { startLine: covering.startLine, endLine: covering.endLine }
    }

    // Nothing contains the range: it spans several statements, which at the top
    // level of a module is the usual shape. Each edge grows out to the smallest
    // statement it cuts, and the union covers every statement between them.
    // Looking only for a single covering statement left these ranges slicing
    // every statement they touched, generating nothing for any of them.
    let atStart: LineRange | undefined
    let atEnd: LineRange | undefined
    for (const statement of boundaries) {
      if (
        statement.startLine < range.startLine &&
        statement.endLine >= range.startLine &&
        smaller(statement, atStart)
      ) {
        atStart = statement
      }
      if (
        statement.endLine > range.endLine &&
        statement.startLine <= range.endLine &&
        smaller(statement, atEnd)
      ) {
        atEnd = statement
      }
    }
    return {
      startLine: Math.min(range.startLine, atStart?.startLine ?? range.startLine),
      endLine: Math.max(range.endLine, atEnd?.endLine ?? range.endLine),
    }
  }

  /**
   * Grow a range until no statement straddles it.
   *
   * `widenOne` treats both edges, but one application of it is not enough:
   * moving an edge can expose a further statement straddling the *new* edge.
   * Real ASTs make this ordinary, because statement spans partially overlap --
   * an `if`'s consequent block ends on the line its alternative begins
   * (`} else {`), so a hunk on that line grows to one block while the other is
   * left straddled and Stryker generates nothing for it. A hunk that starts
   * inside a nested statement and runs into the next top-level statement fails
   * the same way: the start edge grows to the innermost statement it cut and
   * leaves the encloser straddled.
   *
   * Termination: growth is monotone, each step only moving edges outward, and it
   * is bounded by the outermost statement in `boundaries`. The step cap is a
   * guard against a malformed boundary set rather than a normal exit -- one
   * statement can move an edge at most once, so a run longer than `boundaries`
   * means the range had already stopped growing.
   */
  const widenToFixpoint = (range: LineRange): LineRange => {
    let current = range
    for (let step = 0; step <= boundaries.length + 1; step += 1) {
      // A range that is exactly some statement's span with nothing straddling it
      // is done: every statement it touches is either held whole by it or holds
      // it whole. Stopping here is what keeps a one-line change inside a long
      // function at its own line rather than following the function out to the
      // module. A range that is not yet a whole statement falls through to
      // `widenOne`, whose own `cutsAStatement` gate decides whether to grow.
      if (isWholeStatement(current) && !straddlesAStatement(current)) {
        return current
      }
      const grown = widenOne(current)
      if (grown.startLine === current.startLine && grown.endLine === current.endLine) {
        return current
      }
      current = grown
    }
    return current
  }

  // Asking instead for a single statement covering the *whole* range failed in
  // three ways, each measured: at the top level of a module nothing covers a
  // range spanning two adjacent statements, so it was returned still cutting
  // both; a range whose two ends happened to touch the boundaries of two
  // *different* statements was taken as already clean while a third statement
  // straddled it; and one pass of edge growth leaves the shapes `widenToFixpoint`
  // above exists for. Each yielded zero mutants for genuinely changed code while
  // the run reported completion -- the silent false evidence this widening exists
  // to prevent.
  return mergeRanges(ranges.map(widenToFixpoint))
}

/**
 * Render one file's ranges as Stryker `mutate` entries.
 *
 * A file with no ranges yields a bare path -- whole-file scope. That is the
 * correct reading for a newly added file, where every line is part of the
 * change, and an added file is the only thing `freezeIntent` calls this with no
 * ranges for: every other selected file must carry ranges or be rejected.
 */
export function toMutateEntries(path: string, ranges: readonly LineRange[]): SelectedFile[] {
  if (ranges.length === 0) {
    return [path]
  }
  return ranges.map((range) => `${path}:${range.startLine}-${range.endLine}`)
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
  /**
   * Changed line ranges per repository-relative path, already widened to whole
   * statements by the caller, which is the only place with a parser. A selected
   * path absent from this map, or present with no ranges, is an error unless the
   * diff gave it status `A`; it is never quietly promoted to whole-file scope.
   */
  readonly hunks?: ReadonlyMap<string, readonly LineRange[]>
}): IntentPacket {
  const selectedPaths: string[] = []
  const excluded: { path: string; reason: ExclusionReason }[] = []
  for (const entry of input.diff) {
    const verdict = classifyForCohort(entry, input.cohort)
    if (verdict.selected) {
      selectedPaths.push(entry.path)
      continue
    }
    excluded.push({ path: entry.path, reason: verdict.reason })
  }

  // A newly added file has no prior revision to diff against line by line: the
  // whole file is the change, so whole-file scope is the accurate scope for it
  // rather than a concession. Every other selected file is scoped to the ranges
  // the diff attributed to it.
  const statusByPath = new Map(input.diff.map((entry) => [entry.path, entry.status]))

  const scope: { path: string; kind: "changed_ranges" | "whole_file"; ranges: LineRange[] }[] = []
  const mutate: SelectedFile[] = []
  for (const path of [...new Set(selectedPaths)].sort()) {
    const relative = toCohortRelative(path, input.cohort.root)
    const status = statusByPath.get(path) ?? ""

    // Whole-file scope is keyed on the status, never on an empty range list.
    // Deriving it from "no ranges" instead made it reachable by accident: a
    // 100%-similarity rename produces no `git diff -U0` hunk at all, and a
    // modification whose only hunk is a pure deletion contributes no range by
    // design, so both used to be scoped to the entire file and recorded as
    // "added in this revision". That is the whole-file cost this scoping exists
    // to remove, reappearing silently, on a revision that added nothing.
    if (status.startsWith("A")) {
      scope.push({ path: relative, kind: "whole_file", ranges: [] })
      mutate.push(...toMutateEntries(relative, []))
      continue
    }

    const ranges = [...(input.hunks?.get(path) ?? [])]
    if (ranges.length === 0) {
      // Failing here is the point. The caller selected this file, so the
      // evidence has to say which of its lines were mutated; there is no
      // reading of "none" that a completed run could honestly report. A revision
      // that legitimately changes no line of a selected file -- a pure rename --
      // must drop it from the diff rather than have it silently mutated whole.
      throw new Error(
        `${relative} was selected for mutation (status ${status || "unknown"}) but has no ` +
          `changed line ranges. Whole-file scope is reserved for added files; a selected file ` +
          `with no derived ranges cannot be scoped, and silently mutating it in full would ` +
          `report evidence this revision's diff does not support.`
      )
    }
    scope.push({ path: relative, kind: "changed_ranges", ranges })
    mutate.push(...toMutateEntries(relative, ranges))
  }
  mutate.sort()
  excluded.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  const body = {
    schema: "pdpp.mutation.intent.v1" as const,
    cohort: input.cohort.name,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    mutate,
    scope,
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
