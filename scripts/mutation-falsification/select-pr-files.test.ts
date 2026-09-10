// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  canonicalJSON,
  classifyForCohort,
  type CohortDefinition,
  type ExecutionInputs,
  freezeIntent,
  parseNameStatusZ,
  selectCohortTests,
  toCohortRelative,
  verifyIntentDigest,
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
    })
    expect(intent.mutate).toEqual(["src/a.ts", "src/b.ts"])
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
    const forward = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/a.ts\0M\0src/b.ts\0"),
      executionInputs: inputs,
    })
    const reversed = freezeIntent({
      cohort: clientCohort,
      baseCommit: "base",
      headCommit: "head",
      diff: parseNameStatusZ("M\0src/b.ts\0M\0src/a.ts\0"),
      executionInputs: inputs,
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
