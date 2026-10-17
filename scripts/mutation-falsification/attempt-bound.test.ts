// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The attempt bound: a revision too large for one attempt mutates a bounded,
// recorded sample instead of running until the job is killed.
//
// The properties that keep a partial attempt honest are checked here:
//   - a revision within the bound is unchanged (`complete`);
//   - a sample never includes a file that no selected test exercises, since
//     every mutant in it would be a false survivor;
//   - every deferred file is named in the intent, and the intent digest covers
//     the completeness record, so a partial packet cannot pass as complete;
//   - the sample is reproducible for one head and moves with the next.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CohortDefinition,
  exercisedCandidates,
  freezeIntent,
  type IntentPacket,
  parseNameStatusZ,
  relativeImports,
  sampleAttempt,
  verifyIntentDigest,
} from "./select-pr-files.ts"

const referenceCohort: CohortDefinition = {
  name: "reference-implementation",
  root: "reference-implementation",
  productionPrefixes: ["reference-implementation/server/"],
}

const executionInputs = {
  cohortRoot: "reference-implementation",
  configDigest: `sha256:${"0".repeat(64)}`,
  toolVersion: "10.0.0",
  runtimeVersion: "v24.21.0",
  lockfileDigests: [],
}

function scopeOf(lines: Record<string, number>): IntentPacket["scope"] {
  return Object.entries(lines).map(([path, count]) => ({
    path,
    kind: "changed_ranges" as const,
    ranges: [{ startLine: 1, endLine: count }],
  }))
}

describe("relativeImports", () => {
  it("resolves static, re-export, dynamic and extensionless imports against the module", () => {
    const source = [
      'import { a } from "../server/a.ts"',
      'export { b } from "./helpers/b.ts"',
      'const c = await import("../server/c.ts")',
      'import d from "../server/d"',
      'import assert from "node:assert"',
      'import { e } from "@pdpp/elsewhere"',
    ].join("\n")
    expect(relativeImports("test/x.test.ts", source)).toEqual([
      "server/a.ts",
      "server/c.ts",
      "server/d",
      "server/d.ts",
      "test/helpers/b.ts",
    ])
  })
})

describe("exercisedCandidates", () => {
  const modules: Record<string, string> = {
    "test/a.test.ts": 'import "../server/a.ts"\nimport "./helpers/h.ts"',
    "test/helpers/h.ts": 'import "../../server/b.ts"',
    "server/a.ts": 'import "./c.ts"',
    "server/c.ts": "",
  }
  const isSupport = (path: string): boolean => path.startsWith("test/")
  const read = (path: string): string | undefined => modules[path]

  it("follows test-support modules and stops at the first production file", () => {
    const candidates = new Set(["server/a.ts", "server/b.ts", "server/c.ts"])
    // `server/c.ts` is reached only through production code, which is not
    // followed: otherwise one import of a server entrypoint relates every test
    // to every file.
    expect(exercisedCandidates("test/a.test.ts", candidates, isSupport, read)).toEqual([
      "server/a.ts",
      "server/b.ts",
    ])
  })
})

describe("sampleAttempt", () => {
  const exercised: Record<string, string[]> = {
    "test/a.test.ts": ["server/a.ts"],
    "test/b.test.ts": ["server/b.ts"],
    "test/shared.test.ts": ["server/a.ts", "server/c.ts"],
  }
  const base = {
    scope: scopeOf({ "server/a.ts": 10, "server/b.ts": 10, "server/c.ts": 10, "server/untested.ts": 5 }),
    tests: Object.keys(exercised),
    exercisedBy: (test: string) => exercised[test] ?? [],
    wholeFileLines: () => 0,
    sampleKey: "head-1",
  }

  it("leaves a revision within the bound complete", () => {
    expect(sampleAttempt({ ...base, bound: { maxChangedLines: 35, maxTests: 3 } })).toEqual({
      kind: "complete",
    })
  })

  it("samples within both bounds, never takes an unexercised file, and runs only the exercising tests", () => {
    const sample = sampleAttempt({ ...base, bound: { maxChangedLines: 20, maxTests: 2 } })
    if (sample.kind !== "partial") {
      throw new Error("expected a partial sample")
    }
    expect(sample.paths.has("server/untested.ts")).toBe(false)
    expect(sample.completeness.changedLines.sampled).toBeLessThanOrEqual(20)
    expect(sample.tests.length).toBeLessThanOrEqual(2)
    expect(sample.paths.size).toBeGreaterThan(0)
    for (const path of sample.paths) {
      expect(sample.tests.some((test) => exercised[test]?.includes(path))).toBe(true)
    }
    for (const test of sample.tests) {
      expect(exercised[test]?.some((path) => sample.paths.has(path))).toBe(true)
    }
    expect(sample.completeness).toMatchObject({
      kind: "partial",
      bound: { maxChangedLines: 20, maxTests: 2 },
      sampleKey: "head-1",
      files: { sampled: sample.paths.size, total: 4 },
      changedLines: { total: 35 },
      tests: { sampled: sample.tests.length, total: 3 },
    })
  })

  it("is reproducible for one head and differs across heads", () => {
    const bound = { maxChangedLines: 10, maxTests: 3 }
    const first = sampleAttempt({ ...base, bound })
    const again = sampleAttempt({ ...base, bound })
    expect(again).toEqual(first)
    const picks = new Set<string>()
    for (let index = 0; index < 20; index += 1) {
      const sample = sampleAttempt({ ...base, bound, sampleKey: `head-${index}` })
      if (sample.kind === "partial") {
        for (const path of sample.paths) {
          picks.add(path)
        }
      }
    }
    expect(picks).toEqual(new Set(["server/a.ts", "server/b.ts", "server/c.ts"]))
  })
})

describe("freezeIntent with a sample", () => {
  it("defers every unsampled file by name and binds the completeness record into the digest", () => {
    const diff = parseNameStatusZ(
      "M\0reference-implementation/server/a.ts\0M\0reference-implementation/server/b.ts\0"
    )
    const hunks = new Map([
      ["reference-implementation/server/a.ts", [{ startLine: 1, endLine: 2 }]],
      ["reference-implementation/server/b.ts", [{ startLine: 3, endLine: 4 }]],
    ])
    const completeness = {
      kind: "partial" as const,
      bound: { maxChangedLines: 2, maxTests: 1 },
      sampleKey: "head",
      files: { sampled: 1, total: 2 },
      changedLines: { sampled: 2, total: 4 },
      tests: { sampled: 1, total: 2 },
    }
    const input = {
      cohort: referenceCohort,
      baseCommit: "base",
      headCommit: "head",
      diff,
      executionInputs,
      hunks,
    }
    const complete = freezeIntent(input)
    expect(complete.completeness).toEqual({ kind: "complete" })

    const partial = freezeIntent({ ...input, sample: { paths: new Set(["server/a.ts"]), completeness } })
    expect(partial.mutate).toEqual(["server/a.ts:1-2"])
    expect(partial.excluded).toContainEqual({
      path: "reference-implementation/server/b.ts",
      reason: "deferred_by_attempt_bound",
    })
    expect(partial.completeness).toEqual(completeness)
    expect(verifyIntentDigest(partial)).toBe(true)
    // A partial packet relabelled complete no longer verifies.
    expect(verifyIntentDigest({ ...partial, completeness: { kind: "complete" } })).toBe(false)
  })
})

// Executed through the real command line, as the workflow's intent step runs it.
describe("run-intent with an attempt bound", () => {
  const REPOSITORY_ROOT = process.cwd()
  const RUN_INTENT = resolve(REPOSITORY_ROOT, "scripts/mutation-falsification/run-intent.ts")
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "attempt-bound-"))
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  function git(directory: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8" })
  }

  function write(directory: string, path: string, contents: string): void {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), contents)
  }

  /** Three changed server files; two tests exercise one each, one exercises none. */
  function repository(): string {
    const directory = mkdtempSync(join(workspace, "repo-"))
    git(directory, "init", "--quiet", ".")
    git(directory, "config", "user.email", "control@example.invalid")
    git(directory, "config", "user.name", "Executed Control")
    git(directory, "config", "commit.gpgsign", "false")
    for (const name of ["a", "b", "c"]) {
      write(directory, `reference-implementation/server/${name}.ts`, "export const value = 1\n")
    }
    write(directory, "reference-implementation/stryker.config.mjs", "export default {}\n")
    git(directory, "add", ".")
    git(directory, "commit", "--quiet", "-m", "base")
    for (const name of ["a", "b", "c"]) {
      write(directory, `reference-implementation/server/${name}.ts`, "export const value = 2\n")
    }
    write(
      directory,
      "reference-implementation/test/a.test.ts",
      'import { value } from "../server/a.ts"\nconsole.log(value)\n'
    )
    write(
      directory,
      "reference-implementation/test/helpers/b-helper.ts",
      'export { value } from "../../server/b.ts"\n'
    )
    write(
      directory,
      "reference-implementation/test/b.test.ts",
      'import { value } from "./helpers/b-helper.ts"\nconsole.log(value)\n'
    )
    write(directory, "reference-implementation/test/other.test.ts", "console.log(0)\n")
    git(directory, "add", ".")
    git(directory, "commit", "--quiet", "-m", "head")
    execFileSync("ln", ["-s", join(REPOSITORY_ROOT, "node_modules"), join(directory, "node_modules")])
    writeFileSync(join(directory, "package-lock.json"), readFileSync(join(REPOSITORY_ROOT, "package-lock.json")))
    return directory
  }

  function runIntent(directory: string, boundArguments: string[]) {
    const reports = join(directory, "reports/mutation/reference-implementation")
    mkdirSync(reports, { recursive: true })
    const base = git(directory, "rev-parse", "HEAD^").trim()
    const head = git(directory, "rev-parse", "HEAD").trim()
    writeFileSync(
      join(reports, "diff.nul"),
      git(directory, "diff", "--name-status", "-z", "--diff-filter=ACMRTD", base, head)
    )
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        RUN_INTENT,
        "--cohort",
        "reference-implementation",
        "--cohort-root",
        "reference-implementation",
        "--config",
        "reference-implementation/stryker.config.mjs",
        "--prefixes",
        "reference-implementation/server/",
        "--base",
        base,
        "--head",
        head,
        "--diff",
        join(reports, "diff.nul"),
        "--out",
        join(reports, "intent.json"),
        "--selected-tests",
        join(reports, "selected-tests.txt"),
        ...boundArguments,
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
    return {
      stdout,
      intent: JSON.parse(readFileSync(join(reports, "intent.json"), "utf8")) as IntentPacket,
      tests: readFileSync(join(reports, "selected-tests.txt"), "utf8").split("\n").filter(Boolean),
    }
  }

  it("runs the whole scope when the revision fits", () => {
    const { intent, tests } = runIntent(repository(), ["--max-changed-lines", "100", "--max-tests", "10"])
    expect(intent.completeness).toEqual({ kind: "complete" })
    expect(intent.mutate).toHaveLength(3)
    expect(tests).toEqual(["test/a.test.ts", "test/b.test.ts", "test/other.test.ts"])
  })

  it("freezes a partial sample whose tests exercise exactly the sampled files", () => {
    const { stdout, intent, tests } = runIntent(repository(), [
      "--max-changed-lines",
      "1",
      "--max-tests",
      "1",
    ])
    expect(stdout).toContain("partial attempt")
    expect(intent.completeness).toMatchObject({
      kind: "partial",
      files: { sampled: 1, total: 3 },
      changedLines: { sampled: 1, total: 3 },
    })
    expect(intent.mutate).toHaveLength(1)
    const sampled = intent.mutate[0]?.split(":")[0]
    expect(["server/a.ts", "server/b.ts"]).toContain(sampled)
    expect(tests).toEqual([sampled === "server/a.ts" ? "test/a.test.ts" : "test/b.test.ts"])
    const deferred = intent.excluded.filter((entry) => entry.reason === "deferred_by_attempt_bound")
    expect(deferred).toHaveLength(2)
  })

  it("refuses half a bound", () => {
    expect(() => runIntent(repository(), ["--max-changed-lines", "10"])).toThrow()
  })
})
