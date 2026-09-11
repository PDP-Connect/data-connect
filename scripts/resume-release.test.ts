// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { afterEach, describe, expect, it } from "vitest"
import {
  ResumeRefusal,
  assertReleaseRef,
  packageNameFor,
  planResume,
  publishPackage,
  readPublishOrder,
  registryStateFor,
  versionFromTag,
} from "./resume-release.ts"

const repoRoot = process.cwd()

const PACKAGES = [
  "@pdpp/connector-protocol",
  "@pdpp/collector-runtime",
  "@pdpp/local-collector",
]

function states(...pairs: ["published" | "missing", string][]) {
  return pairs.map(([state, name]) => ({ name, state }) as const)
}

// ---------------------------------------------------------------------------
// Refusals. Each of these is a state where guessing would do real damage:
// republish a live version, skip a missing one, or report a no-op as a
// finished release.
// ---------------------------------------------------------------------------

describe("refuses rather than guessing", () => {
  it("refuses when nothing is missing — a no-op is not a successful release", () => {
    expect(() =>
      planResume(
        "2.2.1",
        states(
          ["published", PACKAGES[0] as string],
          ["published", PACKAGES[1] as string],
          ["published", PACKAGES[2] as string]
        )
      )
    ).toThrow(/nothing to resume/)
  })

  it("refuses when nothing is published — that is not a partial release", () => {
    expect(() =>
      planResume(
        "2.2.1",
        states(
          ["missing", PACKAGES[0] as string],
          ["missing", PACKAGES[1] as string],
          ["missing", PACKAGES[2] as string]
        )
      )
    ).toThrow(/not a partially-completed release/)
  })

  it("refuses on any ref but main", () => {
    expect(() => assertReleaseRef("refs/heads/feature/x")).toThrow(/only allowed on refs\/heads\/main/)
    expect(() => assertReleaseRef("refs/tags/v2.2.1")).toThrow(/only allowed on refs\/heads\/main/)
  })

  it("refuses when there is no ref at all", () => {
    expect(() => assertReleaseRef(undefined)).toThrow(/No ref supplied/)
    expect(() => assertReleaseRef("")).toThrow(/No ref supplied/)
  })

  // The one that matters most. A 500 means the registry declined to answer.
  // Reading that as "not published" would republish a live version.
  it("refuses on a non-404 registry error — 'could not tell' is not 'not published'", async () => {
    await expect(
      registryStateFor("@pdpp/collector-runtime", "2.2.1", () =>
        Promise.reject(new Error("npm error code E500 registry unavailable"))
      )
    ).rejects.toThrow(/is not "not published"/)

    await expect(
      registryStateFor("@pdpp/collector-runtime", "2.2.1", () =>
        Promise.reject(new Error("npm error code ETIMEDOUT request to registry failed"))
      )
    ).rejects.toThrow(/Could not determine whether/)

    await expect(
      registryStateFor("@pdpp/collector-runtime", "2.2.1", () =>
        Promise.reject(new Error("npm error code E403 Forbidden"))
      )
    ).rejects.toThrow(/Could not determine whether/)
  })

  it("refuses when the registry answers with a different version", async () => {
    await expect(
      registryStateFor("@pdpp/collector-runtime", "2.2.1", () => Promise.resolve("2.1.1"))
    ).rejects.toThrow(/instead of "2.2.1"/)
  })

  it("refuses a tag that is not vX.Y.Z", () => {
    expect(() => versionFromTag("2.2.1")).toThrow(/refusing to guess a version/)
    expect(() => versionFromTag("v2.2")).toThrow(/refusing to guess a version/)
    expect(() => versionFromTag("release-2.2.1")).toThrow(/refusing to guess a version/)
    expect(() => versionFromTag("")).toThrow(/refusing to guess a version/)
  })

  it("raises ResumeRefusal, not a generic Error, so refusals stay distinguishable", () => {
    expect(() => versionFromTag("nope")).toThrow(ResumeRefusal)
    expect(() => assertReleaseRef("refs/heads/dev")).toThrow(ResumeRefusal)
  })
})

// ---------------------------------------------------------------------------
// The real v2.2.1 state.
// ---------------------------------------------------------------------------

describe("the actual half-published v2.2.1 release", () => {
  it("selects exactly the two packages that never published", () => {
    const plan = planResume(
      "2.2.1",
      states(
        ["published", PACKAGES[0] as string],
        ["missing", PACKAGES[1] as string],
        ["missing", PACKAGES[2] as string]
      )
    )
    expect(plan.version).toBe("2.2.1")
    expect(plan.published).toEqual(["@pdpp/connector-protocol"])
    expect(plan.missing).toEqual(["@pdpp/collector-runtime", "@pdpp/local-collector"])
  })

  it("reads 2.2.1 from the tag the failed run pushed", () => {
    expect(versionFromTag("v2.2.1")).toBe("2.2.1")
  })

  it("treats an E404 as the registry answering 'missing'", async () => {
    await expect(
      registryStateFor("@pdpp/collector-runtime", "2.2.1", () =>
        Promise.reject(new Error("npm error code E404\nnpm error 404 No match found for version 2.2.1"))
      )
    ).resolves.toBe("missing")
  })

  // `npm view @pdpp/connector-protocol@2.2.1 version --json` returns
  // ["2.2.1"], not "2.2.1" — confirmed against the live registry. A strict
  // comparison against the raw value reports a mismatch between two
  // identical versions, which is exactly what a dry run against the real
  // registry produced before normalizeViewedVersion existed.
  it("reads connector-protocol as published from npm's real array-shaped answer", async () => {
    await expect(
      registryStateFor("@pdpp/connector-protocol", "2.2.1", () => Promise.resolve(["2.2.1"]))
    ).resolves.toBe("published")
  })

  it("still refuses an array answer carrying the wrong version", async () => {
    await expect(
      registryStateFor("@pdpp/connector-protocol", "2.2.1", () => Promise.resolve(["2.1.1"]))
    ).rejects.toThrow(/instead of "2.2.1"/)
  })

  it("refuses a multi-element answer rather than flattening it into a match", async () => {
    await expect(
      registryStateFor("@pdpp/connector-protocol", "2.2.1", () =>
        Promise.resolve(["2.2.1", "2.1.1"])
      )
    ).rejects.toThrow(/refusing to guess what is published/)
  })
})

// ---------------------------------------------------------------------------
// Publish order and identity, read from the real repo files.
// ---------------------------------------------------------------------------

describe("publish order", () => {
  it("comes from .releaserc.yaml, in that file's order", () => {
    const order = readPublishOrder(resolve(repoRoot, ".releaserc.yaml"))
    expect(order).toEqual([
      "packages/connector-protocol",
      "packages/collector-runtime",
      "packages/local-collector",
    ])
  })

  it("maps each pkgRoot to its real published name", () => {
    const order = readPublishOrder(resolve(repoRoot, ".releaserc.yaml"))
    expect(order.map(root => packageNameFor(root, repoRoot))).toEqual(PACKAGES)
  })

  it("refuses a config with no npm pkgRoots rather than inventing an order", () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-order-"))
    try {
      const path = join(dir, ".releaserc.yaml")
      writeFileSync(path, "plugins:\n  - '@semantic-release/commit-analyzer'\n")
      expect(() => readPublishOrder(path)).toThrow(/refusing to guess a publish order/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// publishPackage writes. A dry run must never reach it.
// ---------------------------------------------------------------------------

describe("publishPackage", () => {
  it("sets the version before publishing, in the package's own directory", async () => {
    const calls: { args: string[]; cwd: string }[] = []
    await publishPackage("packages/collector-runtime", "2.2.1", repoRoot, {
      npm: async (args, cwd) => {
        calls.push({ args, cwd })
      },
      log: () => {},
    })
    expect(calls.map(c => c.args)).toEqual([
      ["version", "2.2.1", "--no-git-tag-version", "--allow-same-version"],
      ["publish"],
    ])
    expect(calls.every(c => c.cwd === resolve(repoRoot, "packages/collector-runtime"))).toBe(true)
  })

  it("does not pass --tag or otherwise override publishConfig", async () => {
    const calls: string[][] = []
    await publishPackage("packages/local-collector", "2.2.1", repoRoot, {
      npm: async args => {
        calls.push(args)
      },
      log: () => {},
    })
    expect(calls.at(-1)).toEqual(["publish"])
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the real CLI. Refusals must exit 1, and a dry run must
// leave the working tree untouched — an earlier revision ran `npm version`
// before the dry-run check and edited two tracked manifests.
// ---------------------------------------------------------------------------

function runResume(env: Record<string, string | undefined>) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/resume-release.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, RESUME_RELEASE_DRY_RUN: undefined, ...env },
      }
    )
    return { code: 0, stdout, stderr: "" }
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string }
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

function workingTreeDirt() {
  return execFileSync("git", ["status", "--porcelain", "--", "packages"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim()
}

describe("resume-release CLI", () => {
  afterEach(() => {
    expect(workingTreeDirt()).toBe("")
  })

  it("exits 1 on a non-main ref, before touching the registry", () => {
    const result = runResume({ GITHUB_REF: "refs/heads/some-branch" })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/only allowed on refs\/heads\/main/)
  })

  it("exits 1 with no ref at all", () => {
    const result = runResume({ GITHUB_REF: undefined })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/No ref supplied/)
  })

  it("exits 1 on a malformed tag without publishing", () => {
    const result = runResume({
      GITHUB_REF: "refs/heads/main",
      RESUME_RELEASE_TAG: "not-a-tag",
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/refusing to guess a version/)
  })

  // The regression this exists for: a dry run that edits package.json is not
  // a dry run. afterEach asserts a clean tree for every case above too, but
  // this one drives the path that used to write.
  it("a dry run writes nothing, even with a resolvable tag", () => {
    const before = PACKAGES.map((_, i) =>
      readFileSync(
        resolve(
          repoRoot,
          ["packages/connector-protocol", "packages/collector-runtime", "packages/local-collector"][
            i
          ] as string,
          "package.json"
        ),
        "utf8"
      )
    )
    runResume({
      GITHUB_REF: "refs/heads/main",
      RESUME_RELEASE_TAG: "v2.2.1",
      RESUME_RELEASE_DRY_RUN: "true",
    })
    const after = PACKAGES.map((_, i) =>
      readFileSync(
        resolve(
          repoRoot,
          ["packages/connector-protocol", "packages/collector-runtime", "packages/local-collector"][
            i
          ] as string,
          "package.json"
        ),
        "utf8"
      )
    )
    expect(after).toEqual(before)
  })

  it("returns before publishing when RESUME_RELEASE_DRY_RUN=true", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/resume-release.ts"), "utf8")
    const dryRunAt = source.indexOf('RESUME_RELEASE_DRY_RUN === "true"')
    const publishAt = source.indexOf("await publishPackage(")
    expect(dryRunAt).toBeGreaterThan(-1)
    expect(publishAt).toBeGreaterThan(dryRunAt)
  })
})

// ---------------------------------------------------------------------------
// Workflow wiring. The script is only reachable if the workflow actually
// exposes it, gates it, and denies it the permissions it must not have.
// ---------------------------------------------------------------------------

interface WorkflowStep {
  name?: string
  run?: string
  with?: Record<string, unknown>
}
interface WorkflowJob {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}
interface WorkflowDocument {
  on?: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } }
  jobs: Record<string, WorkflowJob>
}

function loadWorkflow(): WorkflowDocument {
  return load(
    readFileSync(resolve(repoRoot, ".github/workflows/npm-release.yml"), "utf8")
  ) as WorkflowDocument
}

describe("npm-release.yml resume wiring", () => {
  // js-yaml parses the unquoted key `on:` as boolean true (YAML 1.1).
  const workflow = loadWorkflow()
  const dispatch = (workflow.on ?? (workflow as unknown as Record<string, WorkflowDocument["on"]>)["true"])
    ?.workflow_dispatch

  it("exposes resume as a boolean workflow-dispatch input defaulting to false", () => {
    const input = dispatch?.inputs?.resume
    expect(input).toBeDefined()
    expect(input?.type).toBe("boolean")
    expect(input?.default).toBe(false)
  })

  it("has a resume job that runs the script and is gated to main", () => {
    const job = workflow.jobs.resume
    expect(job).toBeDefined()
    expect(job?.if).toContain("inputs.resume == true")
    expect(job?.if).toContain("refs/heads/main")
    const run = (job?.steps ?? []).map(s => s.run ?? "").join("\n")
    expect(run).toContain("scripts/resume-release.ts")
  })

  // The tag and the GitHub release already exist; a resume that could write
  // to the repo could clobber them.
  it("denies the resume job repository write access", () => {
    expect(workflow.jobs.resume?.permissions?.contents).toBe("read")
    expect(workflow.jobs.resume?.permissions?.["id-token"]).toBe("write")
  })

  it("runs the full quality job before the resume job publishes", () => {
    const needs = workflow.jobs.resume?.needs
    expect(Array.isArray(needs) ? needs : [needs]).toContain("quality")
  })

  it("still runs quality on the resume path, where resolve-version is skipped", () => {
    const gate = workflow.jobs.quality?.if ?? ""
    expect(gate).toContain("always()")
    expect(gate).toContain("inputs.resume == true")
    expect(gate).toContain("needs.resolve-version.result == 'skipped'")
  })

  it("skips resolve-version on a resume", () => {
    expect(workflow.jobs["resolve-version"]?.if).toContain("inputs.resume != true")
  })

  // Mutual exclusion: semantic-release must never run on a resume, or it
  // would try to tag and release again.
  it("cannot run the ordinary release job on a resume", () => {
    const gate = workflow.jobs.release?.if ?? ""
    expect(gate).toContain("needs.resolve-version.outputs.new-release-published == 'true'")
    const releaseRun = (workflow.jobs.release?.steps ?? []).map(s => s.run ?? "").join("\n")
    expect(releaseRun).toContain("release:npm")
    const resumeRun = (workflow.jobs.resume?.steps ?? []).map(s => s.run ?? "").join("\n")
    expect(resumeRun).not.toContain("release:npm")
    expect(resumeRun).not.toContain("semantic-release")
  })

  it("checks out tags, since the resumed version comes from a tag", () => {
    const checkout = (workflow.jobs.resume?.steps ?? []).find(s => s.name === "Checkout")
    expect(checkout?.with?.["fetch-tags"]).toBe(true)
    expect(checkout?.with?.["fetch-depth"]).toBe(0)
  })

  it("runs the resume and retry tests in the quality job", () => {
    const run = (workflow.jobs.quality?.steps ?? []).map(s => s.run ?? "").join("\n")
    expect(run).toContain("scripts/resume-release.test.ts")
    expect(run).toContain("scripts/npm-propagation-retry.test.ts")
  })
})
