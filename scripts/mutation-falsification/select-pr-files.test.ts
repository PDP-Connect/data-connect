// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import {
  canonicalJSON,
  classifyForCohort,
  type CohortDefinition,
  type ExecutionInputs,
  freezeIntent,
  mayReuseCache,
  parseNameStatusZ,
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

describe("mayReuseCache", () => {
  it("reuses only when every execution input matches", () => {
    expect(mayReuseCache(inputs, inputs)).toEqual({
      reuse: true,
      reason: "execution_inputs_match",
    })
  })

  it("refuses reuse when the lockfile changed", () => {
    // Stryker's own incremental tracking does not see changes outside mutated
    // and test files, so a dependency bump would otherwise reuse stale verdicts.
    const changed: ExecutionInputs = {
      ...inputs,
      lockfileDigests: [{ path: "package-lock.json", digest: "sha256:different" }],
    }
    expect(mayReuseCache(inputs, changed)).toEqual({
      reuse: false,
      reason: "execution_inputs_changed",
    })
  })

  it("refuses reuse when the tool version, runtime, or config digest changed", () => {
    expect(mayReuseCache(inputs, { ...inputs, toolVersion: "10.0.1" }).reuse).toBe(false)
    expect(mayReuseCache(inputs, { ...inputs, runtimeVersion: "v24.0.0" }).reuse).toBe(false)
    expect(mayReuseCache(inputs, { ...inputs, configDigest: "sha256:other" }).reuse).toBe(false)
  })

  it("refuses reuse when no inputs were recorded at all", () => {
    expect(mayReuseCache(undefined, inputs)).toEqual({
      reuse: false,
      reason: "no_recorded_inputs",
    })
  })
})
