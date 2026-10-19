// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// An empty test selection must not mean "run everything" when the emptiness came
// from withholding.
//
// `selected-tests.txt` is empty in two situations the runners cannot tell apart:
// no test changed in the revision, and tests changed but every one was withheld
// from the baseline (it reads the source Stryker instruments, escapes the
// sandbox root, or is run by a nested package). Both cohorts' commands read an
// empty list as "run the whole suite", which for the second case brings back
// exactly the tests that were withheld. These controls execute the shipping
// `run-intent.ts`, `plan-engine-run.ts`, `run-projection.ts` and the reference
// Stryker configuration against throwaway repositories.

import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { classifySelection, planEngineRun } from "./selection-outcome.ts"

const REPOSITORY_ROOT = process.cwd()
const TOOLING = resolve(REPOSITORY_ROOT, "scripts/mutation-falsification")
const WORKFLOW = resolve(REPOSITORY_ROOT, ".github/workflows/mutation.yml")

interface Cohort {
  name: string
  root: string
  config: string
  prefixes: string
  excluded: string
  bound: boolean
}

const SCRIPTS: Cohort = {
  name: "scripts",
  root: ".",
  config: "stryker.scripts.config.mjs",
  prefixes: "scripts/",
  excluded: "scripts/mutation-falsification/",
  bound: false,
}

const REFERENCE: Cohort = {
  name: "reference-implementation",
  root: "reference-implementation",
  config: "reference-implementation/stryker.config.mjs",
  prefixes: "reference-implementation/server/",
  excluded: "",
  bound: true,
}

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "selection-outcome-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" })
}

function write(directory: string, path: string, content: string): void {
  const absolute = join(directory, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

/**
 * A two-commit repository. `base` is committed first, then `head` overwrites or
 * adds files; the head commit's diff is what the cohort sees.
 */
function repository(
  cohort: Cohort,
  base: Record<string, string>,
  head: Record<string, string>
): string {
  const directory = mkdtempSync(join(workspace, "repo-"))
  git(directory, "init", "--quiet", ".")
  git(directory, "config", "user.email", "control@example.invalid")
  git(directory, "config", "user.name", "Executed Control")
  git(directory, "config", "commit.gpgsign", "false")
  for (const [path, content] of Object.entries(base)) {
    write(directory, path, content)
  }
  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "--allow-empty", "-m", "base")
  for (const [path, content] of Object.entries(head)) {
    write(directory, path, content)
  }
  git(directory, "add", ".")
  git(directory, "commit", "--quiet", "-m", "head")

  // The configuration the cohort is about to read. The reference configuration
  // is exercised for real elsewhere; here it only has to exist and, for the
  // bound, export the globs run-intent counts.
  write(
    directory,
    cohort.config,
    "export const wholeCohortTests = ['test/**/*.test.ts']\nexport default {}\n"
  )
  symlinkSync(
    join(REPOSITORY_ROOT, "node_modules"),
    join(directory, "node_modules")
  )
  writeFileSync(
    join(directory, "package-lock.json"),
    readFileSync(join(REPOSITORY_ROOT, "package-lock.json"))
  )
  return directory
}

interface Frozen {
  reports: string
  selectedTests: string[]
  outcome: string
}

/** Run `run-intent.ts` the way the workflow's intent step does. */
function freeze(
  cohort: Cohort,
  directory: string,
  maxChangedLines = "200"
): Frozen {
  const reports = join(directory, "reports/mutation", cohort.name)
  mkdirSync(reports, { recursive: true })
  const base = git(directory, "rev-parse", "HEAD^").trim()
  const head = git(directory, "rev-parse", "HEAD").trim()
  const diffPath = join(reports, "diff.nul")
  writeFileSync(
    diffPath,
    git(
      directory,
      "diff",
      "--name-status",
      "-z",
      "--diff-filter=ACMRTD",
      base,
      head
    )
  )
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(TOOLING, "run-intent.ts"),
      ...["--cohort", cohort.name],
      ...["--cohort-root", cohort.root],
      ...["--config", cohort.config],
      ...["--prefixes", cohort.prefixes],
      ...["--excluded-prefixes", cohort.excluded],
      ...["--base", base],
      ...["--head", head],
      ...["--diff", diffPath],
      ...["--out", join(reports, "intent.json")],
      ...["--selected-tests", join(reports, "selected-tests.txt")],
      ...["--selection-outcome", join(reports, "selection-outcome.txt")],
      ...(cohort.bound
        ? ["--max-changed-lines", maxChangedLines, "--max-tests", "8"]
        : []),
    ],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  )
  return {
    reports,
    selectedTests: readFileSync(join(reports, "selected-tests.txt"), "utf8")
      .split("\n")
      .filter(Boolean),
    outcome: readFileSync(
      join(reports, "selection-outcome.txt"),
      "utf8"
    ).trim(),
  }
}

const SOURCE_V1 = "export const value = 1\n"
const SOURCE_V2 = "export const value = 2\n"

describe("classifySelection", () => {
  it("separates 'nothing was requested' from 'everything requested was withheld'", () => {
    expect(classifySelection(0, 0)).toBe("whole_cohort")
    expect(classifySelection(3, 0)).toBe("none_runnable")
    expect(classifySelection(3, 2)).toBe("selected")
  })
})

describe("planEngineRun", () => {
  it("does not start the engine when every selected test was withheld", () => {
    const plan = planEngineRun("none_runnable")
    expect(plan.run).toBe(false)
    expect(plan.run === false && plan.engineExit).toBe("not_run")
  })

  it("starts the engine for a selection and for an explicit whole-cohort run", () => {
    expect(planEngineRun("selected")).toEqual({ run: true })
    expect(planEngineRun("whole_cohort")).toEqual({ run: true })
  })

  it("refuses an outcome nobody classified, rather than defaulting to running everything", () => {
    expect(() => planEngineRun("")).toThrow(/unrecognised/)
    expect(() => planEngineRun("whatever")).toThrow(/unrecognised/)
  })
})

describe("the scripts cohort", () => {
  it("records a no-run outcome when its only changed test is withheld", () => {
    // The test asserts on the text of the file this revision mutates, so it is
    // withheld; nothing else is selected. The workflow used to omit
    // `--testFiles` here and Stryker ran the whole root suite.
    const directory = repository(
      SCRIPTS,
      {
        "scripts/publish.ts": SOURCE_V1,
        "scripts/publish.test.ts":
          'import { readFileSync } from "node:fs"\nreadFileSync("scripts/publish.ts", "utf8")\n',
      },
      {
        "scripts/publish.ts": SOURCE_V2,
        "scripts/publish.test.ts":
          'import { readFileSync } from "node:fs"\nreadFileSync("./publish.ts", "utf8")\n// changed\n',
      }
    )
    const frozen = freeze(SCRIPTS, directory)
    expect(frozen.selectedTests).toEqual([])
    expect(frozen.outcome).toBe("none_runnable")
  })

  it("names the whole-suite run explicitly when no test changed at all", () => {
    const directory = repository(
      SCRIPTS,
      { "scripts/publish.ts": SOURCE_V1 },
      { "scripts/publish.ts": SOURCE_V2 }
    )
    const frozen = freeze(SCRIPTS, directory)
    expect(frozen.selectedTests).toEqual([])
    expect(frozen.outcome).toBe("whole_cohort")
  })

  it("lists a runnable test and records it as selected", () => {
    const directory = repository(
      SCRIPTS,
      { "scripts/publish.ts": SOURCE_V1, "scripts/publish.test.ts": "// v1\n" },
      { "scripts/publish.ts": SOURCE_V2, "scripts/publish.test.ts": "// v2\n" }
    )
    const frozen = freeze(SCRIPTS, directory)
    expect(frozen.selectedTests).toEqual(["scripts/publish.test.ts"])
    expect(frozen.outcome).toBe("selected")
  })
})

describe("the reference-implementation cohort", () => {
  const withheldRevision = (): string =>
    repository(
      REFERENCE,
      {
        "reference-implementation/server/policy.ts": SOURCE_V1,
        "reference-implementation/test/policy.test.ts": "// v1\n",
      },
      {
        "reference-implementation/server/policy.ts": SOURCE_V2,
        "reference-implementation/test/policy.test.ts":
          'import { readFileSync } from "node:fs"\nreadFileSync("../server/policy.ts", "utf8")\n',
      }
    )

  it("records a no-run outcome when every selected test is withheld", () => {
    const frozen = freeze(REFERENCE, withheldRevision())
    expect(frozen.selectedTests).toEqual([])
    expect(frozen.outcome).toBe("none_runnable")
  })

  // The only test is withheld and unchanged, so the change set is source-only
  // and the bound counts the cohort's whole suite -- which withholding empties.
  const ESCAPING_TEST =
    'import { readFileSync } from "node:fs"\nreadFileSync("../server/policy.ts", "utf8")\n'

  it("records a no-run outcome for a source-only change whose whole suite is withheld", () => {
    const directory = repository(
      REFERENCE,
      {
        "reference-implementation/server/policy.ts": SOURCE_V1,
        "reference-implementation/test/policy.test.ts": ESCAPING_TEST,
      },
      { "reference-implementation/server/policy.ts": SOURCE_V2 }
    )
    const frozen = freeze(REFERENCE, directory)
    expect(frozen.selectedTests).toEqual([])
    expect(frozen.outcome).toBe("none_runnable")
  })

  it("records a no-run outcome, rather than throwing, when a change over the bound has every changed test withheld", () => {
    const lines = (tag: string): string =>
      Array.from({ length: 61 }, (_, index) => `export const v${index} = "${tag}"`).join("\n") + "\n"
    const directory = repository(
      REFERENCE,
      {
        "reference-implementation/server/policy.ts": lines("a"),
        "reference-implementation/test/policy.test.ts": "// v1\n",
      },
      {
        "reference-implementation/server/policy.ts": lines("b"),
        "reference-implementation/test/policy.test.ts": ESCAPING_TEST,
      }
    )
    const frozen = freeze(REFERENCE, directory, "60")
    expect(frozen.selectedTests).toEqual([])
    expect(frozen.outcome).toBe("none_runnable")
  })

  it("carries the no-run outcome into an explicit receipt without starting the engine", () => {
    const directory = withheldRevision()
    const frozen = freeze(REFERENCE, directory)

    // The plan step: the engine is not started and the exit it reports is the one
    // the projection step is handed.
    const plan = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(TOOLING, "plan-engine-run.ts"),
        ...["--outcome", join(frozen.reports, "selection-outcome.txt")],
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
    expect(plan).toBe("run=false\nengine_exit=not_run\n")

    // The projection step, with no report because Stryker never ran. This must
    // exit zero -- neither a pass nor a failure -- and the receipt must say so.
    const receiptPath = join(frozen.reports, "receipt.json")
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(TOOLING, "run-projection.ts"),
        ...["--cohort", REFERENCE.name],
        ...["--intent", join(frozen.reports, "intent.json")],
        ...["--report", join(frozen.reports, "absent-mutation.json")],
        ...["--stryker-exit", "not_run"],
        ...["--out", receiptPath],
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
    expect(output).toContain("The engine was not started")
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
    expect(receipt.attempt.engineExit).toBe("not_run")
    expect(receipt.attempt.reportPresent).toBe(false)
    expect(receipt.summary.validDenominator).toBe(0)
  })

  it("still fails an absent report when the engine was due to run", () => {
    // The no-run exemption must not widen: a real exit with no report is the
    // failure it always was.
    const directory = withheldRevision()
    const frozen = freeze(REFERENCE, directory)
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          join(TOOLING, "run-projection.ts"),
          ...["--cohort", REFERENCE.name],
          ...["--intent", join(frozen.reports, "intent.json")],
          ...["--report", join(frozen.reports, "absent-mutation.json")],
          ...["--stryker-exit", "1"],
          ...["--out", join(frozen.reports, "receipt.json")],
        ],
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    ).toThrow()
  })

  it("refuses to fall back to the whole cohort when the recorded outcome is no-run", () => {
    // Defence in depth: the workflow does not start Stryker for this outcome,
    // but a run that reaches the configuration anyway must not read the empty
    // list as "every test".
    const directory = mkdtempSync(join(workspace, "config-"))
    write(
      directory,
      "reports/mutation/reference-implementation/selected-tests.txt",
      ""
    )
    write(
      directory,
      "reports/mutation/reference-implementation/selection-outcome.txt",
      "none_runnable\n"
    )
    const configUrl = pathToFileURL(
      join(REPOSITORY_ROOT, REFERENCE.config)
    ).href
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(configUrl)})`,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
    ).toThrow(/withheld/)
  })

  it("keeps the whole-cohort fallback when no outcome was recorded", () => {
    const directory = mkdtempSync(join(workspace, "config-"))
    const configUrl = pathToFileURL(
      join(REPOSITORY_ROOT, REFERENCE.config)
    ).href
    const command = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const c = (await import(${JSON.stringify(configUrl)})).default; process.stdout.write(c.commandRunner.command)`,
      ],
      { cwd: directory, encoding: "utf8" }
    )
    expect(command).toContain("--test test/**/*.test.ts")
  })
})

describe("the workflow", () => {
  const workflow = readFileSync(WORKFLOW, "utf8")

  it("asks run-intent for the outcome and decides before the engine starts", () => {
    expect(workflow).toContain(
      '--selection-outcome "reports/mutation/${COHORT}/selection-outcome.txt"'
    )
    expect(workflow).toContain(
      "scripts/mutation-falsification/plan-engine-run.ts"
    )
    expect(workflow).toMatch(
      /- name: Run mutation testing on the changed files\n\s+if: steps\.plan\.outputs\.run == 'true'/
    )
  })

  it("hands the projection step the engine exit the plan recorded when Stryker did not start", () => {
    expect(workflow).toContain(
      "STRYKER_EXIT: ${{ steps.observe.outputs.stryker_exit || steps.plan.outputs.engine_exit }}"
    )
  })
})
