// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  canonicalJSON,
  classifyForCohort,
  type CohortDefinition,
  escapesCohortRoot,
  type ExecutionInputs,
  freezeIntent,
  type LineRange,
  mergeRanges,
  parseNameStatusZ,
  parseUnifiedZeroHunks,
  readsMutatedSource,
  selectCohortTests,
  toCohortRelative,
  toMutateEntries,
  verifyIntentDigest,
  widenToStatements,
} from "./select-pr-files.ts"

const clientCohort: CohortDefinition = {
  name: "client",
  root: ".",
  productionPrefixes: ["src/"],
}

const referenceCohort: CohortDefinition = {
  name: "reference-implementation",
  root: "reference-implementation",
  productionPrefixes: [
    "reference-implementation/server/",
    "reference-implementation/lib/",
    "reference-implementation/operations/",
  ],
}

const inputs: ExecutionInputs = {
  cohortRoot: ".",
  configDigest: "sha256:config",
  toolVersion: "10.0.0",
  runtimeVersion: "v22.23.1",
  lockfileDigests: [{ path: "package-lock.json", digest: "sha256:lock" }],
}

describe("parseNameStatusZ", () => {
  it("reads one path for add, modify and delete records", () => {
    const entries = parseNameStatusZ("A\0src/a.ts\0M\0src/b.ts\0D\0src/c.ts\0")
    expect(entries).toEqual([
      { status: "A", path: "src/a.ts" },
      { status: "M", path: "src/b.ts" },
      { status: "D", path: "src/c.ts" },
    ])
  })

  it("takes the destination path of a rename, which is the file that exists at head", () => {
    const entries = parseNameStatusZ("R100\0src/old.ts\0src/new.ts\0M\0src/b.ts\0")
    expect(entries).toEqual([
      { status: "R100", path: "src/new.ts" },
      { status: "M", path: "src/b.ts" },
    ])
  })

  it("keeps a path containing a space intact", () => {
    // The whole reason for NUL delimiting: a shell split would produce two
    // broken paths here and silently mutate the wrong file, or nothing.
    const entries = parseNameStatusZ("M\0src/with space/mod.ts\0")
    expect(entries).toEqual([{ status: "M", path: "src/with space/mod.ts" }])
  })

  it("rejects a truncated record rather than inventing a path", () => {
    expect(() => parseNameStatusZ("R100\0src/old.ts\0")).toThrow(/destination path/)
  })
})

describe("classifyForCohort", () => {
  it("selects a modified production source file", () => {
    expect(classifyForCohort({ status: "M", path: "src/apps/registry.ts" }, clientCohort)).toEqual({
      selected: true,
    })
  })

  it("excludes a deleted file because there is nothing at head to mutate", () => {
    expect(classifyForCohort({ status: "D", path: "src/gone.ts" }, clientCohort)).toEqual({
      selected: false,
      reason: "deleted",
    })
  })

  it("excludes test files", () => {
    expect(
      classifyForCohort({ status: "M", path: "src/apps/registry.test.ts" }, clientCohort)
    ).toEqual({ selected: false, reason: "test_file" })
  })

  it("excludes files outside the cohort", () => {
    expect(
      classifyForCohort({ status: "M", path: "reference-implementation/server/a.ts" }, clientCohort)
    ).toEqual({ selected: false, reason: "outside_cohort" })
  })

  it("calls a cohort's own test file a test file, not something outside the cohort", () => {
    // The reference implementation keeps its tests in `test/`, which is outside
    // every production prefix, so deciding cohort membership first labelled
    // every one of them `outside_cohort`. Both reasons exclude, so the mutate
    // list never changed -- but the receipt's stated reason was wrong.
    expect(
      classifyForCohort(
        { status: "M", path: "reference-implementation/test/acknowledged-loss.test.ts" },
        referenceCohort
      )
    ).toEqual({ selected: false, reason: "test_file" })
  })

  it("excludes a deleted production file, which the diff now reports", () => {
    // The workflow used to filter deletions out of the diff before the
    // classifier saw them, so this branch could not fire in a real run.
    expect(
      classifyForCohort({ status: "D", path: "src/apps/gone.ts" }, clientCohort)
    ).toEqual({ selected: false, reason: "deleted" })
  })

  it("excludes non-source files and declaration files", () => {
    expect(classifyForCohort({ status: "M", path: "src/styles.css" }, clientCohort)).toEqual({
      selected: false,
      reason: "not_production_source",
    })
    expect(classifyForCohort({ status: "M", path: "src/types.d.ts" }, clientCohort)).toEqual({
      selected: false,
      reason: "not_production_source",
    })
  })
})

describe("toCohortRelative", () => {
  it("leaves client paths alone and strips the reference-implementation prefix", () => {
    expect(toCohortRelative("src/a.ts", ".")).toBe("src/a.ts")
    expect(toCohortRelative("reference-implementation/server/a.ts", "reference-implementation")).toBe(
      "server/a.ts"
    )
  })
})

describe("freezeIntent", () => {
  it("selects production files, records exclusions, and derives its own digest", () => {
    const intent = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/b.ts\0A\0src/a.ts\0D\0src/gone.ts\0M\0src/a.test.ts\0"),
      executionInputs: inputs,
      // `src/a.ts` is added, so it needs none; a modified file must carry
      // ranges or freezing rejects it.
      hunks: new Map([["src/b.ts", [{ startLine: 3, endLine: 4 }]]]),
    })
    expect(intent.mutate).toEqual(["src/a.ts", "src/b.ts:3-4"])
    expect(intent.excluded).toEqual([
      { path: "src/a.test.ts", reason: "test_file" },
      { path: "src/gone.ts", reason: "deleted" },
    ])
    expect(intent.applicability).toBe("applicable")
    expect(verifyIntentDigest(intent)).toBe(true)
  })

  it("reports not_applicable when the diff selects no production file", () => {
    // A test-only revision. This is neither a pass nor a failure: the design
    // produces no mutation evidence for it, and says so.
    const intent = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/a.test.ts\0M\0README.md\0"),
      executionInputs: inputs,
    })
    expect(intent.mutate).toEqual([])
    expect(intent.applicability).toBe("not_applicable")
    expect(verifyIntentDigest(intent)).toBe(true)
  })

  it("produces the same digest regardless of the order the diff arrived in", () => {
    const ordered = new Map([
      ["src/a.ts", [{ startLine: 1, endLine: 1 }]],
      ["src/b.ts", [{ startLine: 2, endLine: 2 }]],
    ])
    const forward = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/a.ts\0M\0src/b.ts\0"),
      executionInputs: inputs,
      hunks: ordered,
    })
    const reversed = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/b.ts\0M\0src/a.ts\0"),
      executionInputs: inputs,
      hunks: ordered,
    })
    expect(reversed.intentDigest).toBe(forward.intentDigest)
  })

  it("detects a packet edited after it was frozen", () => {
    const intent = freezeIntent({
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0reference-implementation/server/a.ts\0"),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
      hunks: new Map([["reference-implementation/server/a.ts", [{ startLine: 7, endLine: 7 }]]]),
    })
    expect(verifyIntentDigest(intent)).toBe(true)
    const tampered = { ...intent, mutate: ["server/somewhere-else.ts"] }
    expect(verifyIntentDigest(tampered)).toBe(false)
  })

  it("changes the digest when the head commit changes, so evidence cannot be reattributed", () => {
    const common = {
      cohort: clientCohort,
      baseCommit: "base",
      diff: parseNameStatusZ("M\0src/a.ts\0"),
      executionInputs: inputs,
      hunks: new Map([["src/a.ts", [{ startLine: 5, endLine: 5 }]]]),
    }
    const first = freezeIntent({ ...common, headCommit: "head-one" })
    const second = freezeIntent({ ...common, headCommit: "head-two" })
    expect(second.intentDigest).not.toBe(first.intentDigest)
  })
})

describe("canonicalJSON", () => {
  it("orders object keys so equal content has equal bytes", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJSON({ a: 2, b: 1 })).toBe(canonicalJSON({ b: 1, a: 2 }))
  })
})

describe("selectCohortTests", () => {
  it("derives the cohort-relative test files the revision touched", () => {
    // This is the selection the command runner cannot make for itself, so it is
    // written to a file the cohort's config reads. Nothing wrote that file
    // before, which left the reference-implementation cohort running a fallback
    // that could not resolve and rejecting its own baseline on every run.
    const diff = parseNameStatusZ(
      "M\0reference-implementation/lib/nullish.ts\0" +
        "M\0reference-implementation/test/acknowledged-loss.test.ts\0" +
        "A\0reference-implementation/test/record-expand-helpers-branches.test.ts\0"
    )
    expect(selectCohortTests(diff, referenceCohort)).toEqual([
      "test/acknowledged-loss.test.ts",
      "test/record-expand-helpers-branches.test.ts",
    ])
  })

  it("selects no test from another cohort's tree", () => {
    const diff = parseNameStatusZ("M\0src/apps/external-url.test.ts\0")
    expect(selectCohortTests(diff, referenceCohort)).toEqual([])
  })

  it("takes a renamed test's destination, since that is the file at head", () => {
    const diff = parseNameStatusZ(
      "R100\0reference-implementation/test/old.test.ts\0reference-implementation/test/new.test.ts\0"
    )
    expect(selectCohortTests(diff, referenceCohort)).toEqual(["test/new.test.ts"])
  })

  it("omits a deleted test, which cannot be run", () => {
    const diff = parseNameStatusZ("D\0reference-implementation/test/gone.test.ts\0")
    expect(selectCohortTests(diff, referenceCohort)).toEqual([])
  })

  it("returns nothing when the revision touched no test, so the caller runs the whole cohort", () => {
    // An empty selection must never narrow the command to nothing: a mutant
    // recorded as surviving an empty selection would be a false survivor.
    const diff = parseNameStatusZ("M\0reference-implementation/lib/nullish.ts\0")
    expect(selectCohortTests(diff, referenceCohort)).toEqual([])
  })
})

describe("parseUnifiedZeroHunks", () => {
  it("reads the head-side range of each hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,2 @@ function f() {",
      "+  const x = 1;",
      "+  const y = 2;",
      "@@ -40,3 +42,1 @@ function g() {",
      "+  return 3;",
    ].join("\n")
    expect(parseUnifiedZeroHunks(diff)).toEqual([
      { path: "src/a.ts", ranges: [{ startLine: 11, endLine: 12 }, { startLine: 42, endLine: 42 }] },
    ])
  })

  it("reads a hunk header with no count as a single line", () => {
    const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -783,0 +784 @@", "+  const x = 1;"].join(
      "\n"
    )
    expect(parseUnifiedZeroHunks(diff)).toEqual([
      { path: "src/a.ts", ranges: [{ startLine: 784, endLine: 784 }] },
    ])
  })

  it("contributes no range for a pure deletion hunk", () => {
    // `+42,0` means the hunk removed lines and added none. Git reports the
    // position as the line before the removal, so reading it as a one-line
    // range would scope mutation to a surviving line the revision never
    // touched. Deleted content cannot carry a fault into head.
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -42,3 +41,0 @@",
      "-  const gone = 1;",
    ].join("\n")
    expect(parseUnifiedZeroHunks(diff)).toEqual([{ path: "src/a.ts", ranges: [] }])
  })

  it("skips a deleted file, which has no head revision to mutate", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-  const gone = 1;",
    ].join("\n")
    expect(parseUnifiedZeroHunks(diff)).toEqual([])
  })

  it("attributes a rename's hunks to the destination path", () => {
    // The destination is the file that exists at head, so it is the only one
    // Stryker can mutate. Attributing these lines to the source path would
    // produce a `mutate` entry naming a file that is not there.
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 92%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -5,0 +6 @@",
      "+  const added = 1;",
    ].join("\n")
    expect(parseUnifiedZeroHunks(diff)).toEqual([
      { path: "src/new.ts", ranges: [{ startLine: 6, endLine: 6 }] },
    ])
  })

  it("keeps each file's hunks under its own path", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2 @@",
      "+a",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -9,0 +10 @@",
      "+b",
    ].join("\n")
    expect(parseUnifiedZeroHunks(diff)).toEqual([
      { path: "src/a.ts", ranges: [{ startLine: 2, endLine: 2 }] },
      { path: "src/b.ts", ranges: [{ startLine: 10, endLine: 10 }] },
    ])
  })
})

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(
      mergeRanges([
        { startLine: 10, endLine: 12 },
        { startLine: 13, endLine: 15 },
        { startLine: 11, endLine: 14 },
      ])
    ).toEqual([{ startLine: 10, endLine: 15 }])
  })

  it("keeps separated ranges apart and sorts them", () => {
    expect(
      mergeRanges([
        { startLine: 40, endLine: 41 },
        { startLine: 10, endLine: 11 },
      ])
    ).toEqual([
      { startLine: 10, endLine: 11 },
      { startLine: 40, endLine: 41 },
    ])
  })
})

describe("widenToStatements", () => {
  // One statement spanning lines 5-20 -- a multi-line call, say -- inside a
  // function body spanning 1-100.
  const boundaries: LineRange[] = [
    { startLine: 1, endLine: 100 },
    { startLine: 5, endLine: 20 },
    { startLine: 30, endLine: 31 },
  ]

  it("grows a range that starts inside a statement out to that statement", () => {
    // Stryker mutates a node only when the node lies wholly inside the range,
    // so a range starting at line 8 would generate nothing for the 5-20
    // statement while still reporting a completed run.
    expect(widenToStatements([{ startLine: 8, endLine: 9 }], boundaries)).toEqual([
      { startLine: 5, endLine: 20 },
    ])
  })

  it("does not grow a range out to a statement that merely contains it whole", () => {
    // The 1-100 function body contains every range here. Widening to it would
    // restore the whole-file cost this scoping exists to remove, and the
    // revision did not change that body as a unit.
    expect(widenToStatements([{ startLine: 30, endLine: 31 }], boundaries)).toEqual([
      { startLine: 30, endLine: 31 },
    ])
  })

  it("leaves a range already covering whole statements untouched", () => {
    expect(widenToStatements([{ startLine: 5, endLine: 20 }], boundaries)).toEqual([
      { startLine: 5, endLine: 20 },
    ])
  })

  it("merges ranges that widening brought together", () => {
    expect(
      widenToStatements(
        [
          { startLine: 8, endLine: 8 },
          { startLine: 19, endLine: 19 },
        ],
        boundaries
      )
    ).toEqual([{ startLine: 5, endLine: 20 }])
  })

  it("returns nothing for no ranges, so a file with no head-side change stays unscoped", () => {
    expect(widenToStatements([], boundaries)).toEqual([])
  })
})

describe("toMutateEntries", () => {
  it("renders ranges in the path:startLine-endLine form Stryker parses", () => {
    expect(
      toMutateEntries("server/index.ts", [
        { startLine: 725, endLine: 850 },
        { startLine: 6226, endLine: 6242 },
      ])
    ).toEqual(["server/index.ts:725-850", "server/index.ts:6226-6242"])
  })

  it("renders a bare path when there are no ranges, which is whole-file scope", () => {
    expect(toMutateEntries("server/added.ts", [])).toEqual(["server/added.ts"])
  })
})

describe("freezeIntent line-range scope", () => {
  const hunks = new Map<string, readonly LineRange[]>([
    ["reference-implementation/server/index.ts", [{ startLine: 725, endLine: 850 }]],
  ])

  it("scopes a modified file to its changed ranges", () => {
    const intent = freezeIntent({
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0reference-implementation/server/index.ts\0"),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
      hunks,
    })
    expect(intent.mutate).toEqual(["server/index.ts:725-850"])
    expect(intent.scope).toEqual([
      { path: "server/index.ts", kind: "changed_ranges", ranges: [{ startLine: 725, endLine: 850 }] },
    ])
  })

  it("keeps whole-file scope for a newly added file, where the whole file is the change", () => {
    const intent = freezeIntent({
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("A\0reference-implementation/server/added.ts\0"),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
      hunks: new Map(),
    })
    expect(intent.mutate).toEqual(["server/added.ts"])
    expect(intent.scope).toEqual([
      { path: "server/added.ts", kind: "whole_file", ranges: [] },
    ])
  })

  it("scopes a renamed file by its destination ranges", () => {
    const intent = freezeIntent({
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ(
        "R92\0reference-implementation/server/old.ts\0reference-implementation/server/new.ts\0"
      ),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
      hunks: new Map([
        ["reference-implementation/server/new.ts", [{ startLine: 6, endLine: 6 }]],
      ]),
    })
    expect(intent.mutate).toEqual(["server/new.ts:6-6"])
  })

  it("selects nothing for a deleted file and records the deletion", () => {
    const intent = freezeIntent({
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("D\0reference-implementation/server/gone.ts\0"),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
      hunks: new Map(),
    })
    expect(intent.mutate).toEqual([])
    expect(intent.applicability).toBe("not_applicable")
    expect(intent.excluded).toEqual([
      { path: "reference-implementation/server/gone.ts", reason: "deleted" },
    ])
  })

  it("covers the scope in the digest, so the mutated lines cannot be restated later", () => {
    const common = {
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0reference-implementation/server/index.ts\0"),
      executionInputs: { ...inputs, cohortRoot: "reference-implementation" },
    }
    const narrow = freezeIntent({ ...common, hunks })
    const wide = freezeIntent({
      ...common,
      hunks: new Map([
        ["reference-implementation/server/index.ts", [{ startLine: 1, endLine: 9000 }]],
      ]),
    })
    expect(verifyIntentDigest(narrow)).toBe(true)
    expect(narrow.intentDigest).not.toBe(wide.intentDigest)
  })
})

describe("escapesCohortRoot", () => {
  it("detects the repository-root read that rejected the baseline", () => {
    // Verbatim from reference-implementation/scripts/ci-console-prebuild.test.ts.
    // Stryker's sandbox is rooted at the cohort root, so this resolves to a path
    // the sandbox does not contain; the ENOENT failed the initial test run and
    // left the whole attempt with no evidence.
    const source = `const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, "../../.github/workflows/reference-implementation.yml");`
    expect(escapesCohortRoot("scripts/ci-console-prebuild.test.ts", source)).toBe(true)
  })

  it("measures the climb against the test's own depth, not a fixed one", () => {
    // The same literal escapes from `scripts/` but stays inside the root from
    // one directory deeper, so depth is what decides.
    const source = `readFileSync(join(__dirname, "../../lib/nullish.ts"))`
    expect(escapesCohortRoot("test/nested/deep.test.ts", source)).toBe(false)
    expect(escapesCohortRoot("scripts/shallow.test.ts", source)).toBe(true)
  })

  it("keeps a test that climbs only to the cohort root", () => {
    // Reaching a sibling directory inside the cohort is fine: the sandbox holds
    // the whole cohort, so this path resolves there exactly as it does on disk.
    const source = `await readFile(join(__dirname, "../test/composed-origin.test.ts"), "utf8")`
    expect(escapesCohortRoot("scripts/ci-console-prebuild.test.ts", source)).toBe(false)
  })

  it("keeps a test that reads no relative path at all", () => {
    const source = `import assert from "node:assert/strict"\ntest("x", () => assert.ok(true))`
    expect(escapesCohortRoot("test/plain.test.ts", source)).toBe(false)
  })
})

describe("readsMutatedSource", () => {
  it("detects the instrumented-source read that rejected PR #64's baseline", () => {
    // Verbatim from reference-implementation/test/web-push-notifications.test.ts.
    // The revision changed `runtime/controller.ts`, so Stryker instrumented it
    // and this regex met a `stryNS_`-prefixed, `@ts-nocheck` copy instead of the
    // authored source. The mismatch failed the initial test run and left the
    // attempt with no evidence.
    const source = `const src = await readFile(new URL("../runtime/controller.ts", import.meta.url), "utf8");
assert.match(src, /detachControllerTask\\(\\s*fireAssistanceWebPush\\(\\{/);`
    expect(readsMutatedSource(source, ["runtime/controller.ts:2466-4597"])).toBe(true)
  })

  it("keeps the same test when the batch mutates nothing it reads", () => {
    // The decisive difference from escapesCohortRoot: this test is sound in a
    // batch that leaves controller.ts alone, so it must not be withheld there.
    const source = `const src = await readFile(new URL("../runtime/controller.ts", import.meta.url), "utf8");`
    expect(readsMutatedSource(source, ["server/auth.ts:53-57"])).toBe(false)
  })

  it("matches a whole-file mutate entry as well as a line-ranged one", () => {
    const source = `readFileSync(new URL("../server/grant-lifecycle.ts", import.meta.url), "utf8")`
    expect(readsMutatedSource(source, ["server/grant-lifecycle.ts"])).toBe(true)
  })

  it("does not match a file whose name merely ends with a mutated one", () => {
    // `controller.ts` must not match `other-controller.ts`: the suffix
    // comparison is on a path-segment boundary.
    const source = `readFileSync(new URL("../runtime/other-controller.ts", import.meta.url), "utf8")`
    expect(readsMutatedSource(source, ["runtime/controller.ts:1-10"])).toBe(false)
  })

  it("withholds nothing when the batch mutates nothing", () => {
    const source = `readFileSync(new URL("../runtime/controller.ts", import.meta.url), "utf8")`
    expect(readsMutatedSource(source, [])).toBe(false)
  })

  it("keeps a test that imports a mutated module instead of reading its text", () => {
    // The one outcome that must never happen. Executing the mutated module is
    // what the baseline measures, so withholding an importing test would report
    // survivors for mutants nothing ran -- false evidence, which is worse than
    // the rejected baseline this predicate exists to prevent. Matching every
    // string literal rather than only file-reading calls did exactly that.
    const source = `import { createController } from "../runtime/controller.ts"\ntest("x", () => createController())`
    expect(readsMutatedSource(source, ["runtime/controller.ts:2466-4597"])).toBe(false)
  })

  it("recognises the read however it is spelled", () => {
    // The three forms in this repo: a `new URL` read, a member-call read, and a
    // `join(__dirname, ...)` read.
    expect(
      readsMutatedSource(
        `const s = fs.readFileSync(new URL("../server/explore-timeline-substrate.ts", import.meta.url), "utf8")`,
        ["server/explore-timeline-substrate.ts:10-20"]
      )
    ).toBe(true)
    expect(
      readsMutatedSource(`const s = readFileSync(join(__dirname, "../operations/x/index.ts"), "utf8")`, [
        "operations/x/index.ts",
      ])
    ).toBe(true)
  })
})
