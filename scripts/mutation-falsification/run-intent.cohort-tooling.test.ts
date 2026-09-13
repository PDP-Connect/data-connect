// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// An executed control for when a cohort's Stryker configuration is REQUIRED.
//
// This workflow's definition is read from the merge ref while the tree it tests
// is the pull request head, so a head branched before a cohort was added does
// not carry the configuration the matrix names. An earlier revision treated
// that absence as fatal for every cohort, before applicability was known, and
// so failed the `scripts` cohort on branches that had changed no script.
//
// The requirement is real but conditional, and both halves have teeth:
//
//   applicable + configuration missing   -> MUST fail
//   not applicable + configuration missing -> MUST NOT fail
//
// Both are executed here against the shipping `run-intent.ts` through its real
// command line, in throwaway git repositories, rather than asserted against a
// restatement of its logic. The failing direction is what keeps this from
// trading one defect for a worse one: a cohort whose production code changed
// must not proceed without the configuration it is about to mutate against.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const REPOSITORY_ROOT = process.cwd()
const RUN_INTENT = resolve(REPOSITORY_ROOT, "scripts/mutation-falsification/run-intent.ts")

/** The `scripts` cohort exactly as `.github/workflows/mutation.yml` defines it. */
const SCRIPTS_COHORT = {
  name: "scripts",
  root: ".",
  config: "stryker.scripts.config.mjs",
  prefixes: "scripts/",
  excludedPrefixes: "scripts/mutation-falsification/",
}

let workspace: string

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" })
}

/**
 * A two-commit repository whose head changes exactly `changedPath`.
 *
 * `run-intent.ts` reads the lockfile and the installed Stryker package to
 * describe the attempt, and resolves both from the working directory, so the
 * fixture links the real ones rather than inventing digests for files whose
 * contents this control has no opinion about.
 */
function repositoryChanging(changedPath: string, carriesConfig: boolean): string {
  const directory = mkdtempSync(join(workspace, "repo-"))
  git(directory, "init", "--quiet", ".")
  git(directory, "config", "user.email", "control@example.invalid")
  git(directory, "config", "user.name", "Executed Control")
  git(directory, "config", "commit.gpgsign", "false")

  const absolute = join(directory, changedPath)
  mkdirSync(resolve(absolute, ".."), { recursive: true })
  writeFileSync(absolute, "export const value = 1\n")
  git(directory, "add", changedPath)
  git(directory, "commit", "--quiet", "-m", "base")

  writeFileSync(absolute, "export const value = 2\n")
  git(directory, "add", changedPath)
  git(directory, "commit", "--quiet", "-m", "head")

  if (carriesConfig) {
    writeFileSync(join(directory, SCRIPTS_COHORT.config), "export default {}\n")
  }

  // Read, never written: the packet names their digests and versions.
  execFileSync("ln", ["-s", join(REPOSITORY_ROOT, "node_modules"), join(directory, "node_modules")])
  writeFileSync(
    join(directory, "package-lock.json"),
    readFileSync(join(REPOSITORY_ROOT, "package-lock.json"))
  )

  return directory
}

/** Invoke `run-intent.ts` the way the workflow's intent step does. */
function freezeIntentFor(directory: string): {
  status: number
  stderr: string
  intentPath: string
} {
  const reports = join(directory, "reports/mutation/scripts")
  mkdirSync(reports, { recursive: true })

  const base = git(directory, "rev-parse", "HEAD^").trim()
  const head = git(directory, "rev-parse", "HEAD").trim()
  const diffPath = join(reports, "diff.nul")
  writeFileSync(
    diffPath,
    execFileSync("git", ["diff", "--name-status", "-z", "--diff-filter=ACMRTD", base, head], {
      cwd: directory,
      encoding: "utf8",
    })
  )

  const intentPath = join(reports, "intent.json")
  let status = 0
  let stderr = ""
  try {
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        RUN_INTENT,
        "--cohort",
        SCRIPTS_COHORT.name,
        "--cohort-root",
        SCRIPTS_COHORT.root,
        "--config",
        SCRIPTS_COHORT.config,
        "--prefixes",
        SCRIPTS_COHORT.prefixes,
        "--excluded-prefixes",
        SCRIPTS_COHORT.excludedPrefixes,
        "--base",
        base,
        "--head",
        head,
        "--diff",
        diffPath,
        "--out",
        intentPath,
        "--selected-tests",
        join(reports, "selected-tests.txt"),
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
  } catch (error) {
    const failure = error as { status?: number; stderr?: string }
    status = failure.status ?? 1
    stderr = failure.stderr ?? ""
  }

  return { status, stderr, intentPath }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "cohort-tooling-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("cohort configuration requirement", () => {
  it("does not fail a revision that changed no file in the cohort", () => {
    // A docs-only branch cut before the `scripts` cohort existed. It has no
    // `stryker.scripts.config.mjs`, and it needs none: it is about to be told
    // there is nothing here to mutate.
    const directory = repositoryChanging("docs/architecture.md", false)
    expect(existsSync(join(directory, SCRIPTS_COHORT.config))).toBe(false)

    const { status, stderr, intentPath } = freezeIntentFor(directory)

    expect(stderr).toBe("")
    expect(status).toBe(0)

    const intent = JSON.parse(readFileSync(intentPath, "utf8"))
    expect(intent.applicability).toBe("not_applicable")
    expect(intent.mutate).toEqual([])
    // The packet says it read no configuration rather than naming one it did
    // not open.
    expect(intent.executionInputs.configDigest).toBe("none:not-applicable")
  })

  it("fails a revision that changed the cohort's production code without the configuration", () => {
    // The direction that keeps the gate's teeth. This branch DOES change a
    // script, so the cohort is about to run an engine, and the configuration
    // that engine reads is absent. Passing here would report a green check for
    // a run that never happened.
    const directory = repositoryChanging("scripts/release/publish.ts", false)
    expect(existsSync(join(directory, SCRIPTS_COHORT.config))).toBe(false)

    const { status, stderr, intentPath } = freezeIntentFor(directory)

    expect(status).not.toBe(0)
    expect(stderr).toContain(SCRIPTS_COHORT.config)
    // The remedy is a property of the branch, so the message says so instead of
    // leaving a reader to infer a weak suite from an empty receipt.
    expect(stderr).toContain("Rebase")
    // Nothing was frozen: an unfreezable attempt must not leave a packet behind
    // that a later step could read as evidence.
    expect(existsSync(intentPath)).toBe(false)
  })

  it("freezes an applicable revision that carries the configuration, naming its digest", () => {
    const directory = repositoryChanging("scripts/release/publish.ts", true)

    const { status, stderr, intentPath } = freezeIntentFor(directory)

    expect(stderr).toBe("")
    expect(status).toBe(0)

    const intent = JSON.parse(readFileSync(intentPath, "utf8"))
    expect(intent.applicability).toBe("applicable")
    expect(intent.mutate.length).toBeGreaterThan(0)
    expect(intent.executionInputs.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
