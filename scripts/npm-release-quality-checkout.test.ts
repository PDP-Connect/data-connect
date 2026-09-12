// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// The `quality` job is the only gate in front of a converge publish, and npm
// versions are immutable — a converge that publishes an unverified tarball
// cannot be taken back. So `quality` has to check out the SAME tree the
// publishing job builds: the tag on a converge, the push head otherwise.
//
// Run 34654643962 is what happens when it does not. `quality` checked out the
// push head while `converge` checked out the tag, so the gate verified a tree
// that would never be published. Because the artifact receipts in
// packages/*/artifact.json are per-tree by construction (each records the
// digests of the sources it was generated from, including collector-runtime's
// embedded copy of connector-protocol's), and main had moved past v2.2.1, the
// receipt check compared main's connector-protocol sources against the tag's
// collector-runtime receipt and failed a release whose own tree was
// internally consistent.
//
// This test parses the REAL workflow YAML rather than asserting on a copy, so
// it fails if the two checkouts ever drift apart again — in either direction:
// a `quality` that stops following the tag (the original bug), or a `converge`
// that stops building it.

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  "working-directory"?: string
  with?: Record<string, string>
}

interface WorkflowJob {
  steps: WorkflowStep[]
}

interface WorkflowDocument {
  jobs: Record<string, WorkflowJob>
}

function loadNpmReleaseWorkflow(): WorkflowDocument {
  return load(
    readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
  ) as WorkflowDocument
}

function stepsOf(job: string): WorkflowStep[] {
  const steps = loadNpmReleaseWorkflow().jobs[job]?.steps
  if (!steps) throw new Error(`Missing '${job}' job in npm-release.yml`)
  return steps
}

function checkoutStepsOf(job: string): WorkflowStep[] {
  const steps = stepsOf(job).filter(s => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"))
  if (steps.length === 0) throw new Error(`Missing an actions/checkout step in the '${job}' job`)
  return steps
}

// The checkout that supplies the tree being RELEASED. On a job with several
// checkouts that is the one following the converge tag; the others supply
// tooling. Selected by its ref rather than its position so reordering the
// steps does not silently change which one the assertions read.
function checkoutStepOf(job: string): WorkflowStep {
  const steps = checkoutStepsOf(job)
  if (steps.length === 1) return steps[0] as WorkflowStep
  const tagged = steps.filter(s => (s.with?.ref ?? "").includes("converge-tag"))
  if (tagged.length !== 1) {
    throw new Error(
      `'${job}' has ${steps.length} checkouts and ${tagged.length} follow the converge tag; ` +
        `expected exactly one tag checkout`
    )
  }
  return tagged[0] as WorkflowStep
}

/**
 * Evaluates a GitHub `A && B || C` expression the way the runner does: `&&`
 * yields its right operand when the left is truthy, `||` falls through to its
 * right operand when the left is falsy, and the empty string is falsy.
 */
function evaluateRef(
  expression: string | undefined,
  mode: string,
  convergeTag: string,
  headSha: string
): string {
  if (!expression) {
    // The original bug: no `ref` at all, so checkout silently takes the
    // triggering ref and a converge verifies the push head.
    throw new Error("checkout step sets no `ref`, so a converge would verify the push head")
  }
  const body = expression.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim()
  const normalized = body.replace(/[()]/g, " ")
  const usesConvergeTag = /needs\.resolve-version\.outputs\.converge-tag/.test(normalized)
  const comparesMode = /needs\.resolve-version\.outputs\.mode\s*==\s*'converge'/.test(normalized)
  if (!(usesConvergeTag && comparesMode)) {
    throw new Error(`ref expression does not branch on converge mode and tag: ${expression}`)
  }
  const fallback = /github\.sha/.test(normalized) ? headSha : ""
  return (mode === "converge" && convergeTag) || fallback
}

describe("npm-release quality job checks out the tree it gates", () => {
  it("resolves to the converge tag on a converge and the push head otherwise", () => {
    const ref = checkoutStepOf("quality").with?.ref
    expect(ref, "quality's checkout must set an explicit `ref`").toBeTruthy()

    const headSha = "72d1d7979219035440aed676c3cfeee24038268f"
    // The failing release: mode=converge at v2.2.1, main already moved on.
    expect(evaluateRef(ref, "converge", "v2.2.1", headSha)).toBe("v2.2.1")
    // An ordinary release still verifies the commit that triggered it.
    expect(evaluateRef(ref, "release", "", headSha)).toBe(headSha)
    // A converge is never allowed to silently fall back to the push head.
    expect(evaluateRef(ref, "converge", "v3.0.0", headSha)).toBe("v3.0.0")
  })

  it("gates the exact ref the converge job publishes", () => {
    const qualityRef = checkoutStepOf("quality").with?.ref
    const convergeRef = checkoutStepOf("converge").with?.ref
    expect(convergeRef, "converge's checkout must set an explicit `ref`").toBeTruthy()

    // The converge job pins the tag directly; quality must resolve to that
    // same value when the run is a converge.
    expect(convergeRef).toContain("converge-tag")
    const headSha = "72d1d7979219035440aed676c3cfeee24038268f"
    expect(evaluateRef(qualityRef, "converge", "v2.2.1", headSha)).toBe("v2.2.1")
  })

  it("runs before the converge job so the gate cannot be bypassed", () => {
    const workflow = load(
      readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
    ) as { jobs: Record<string, { needs?: string | string[] }> }
    const needs = workflow.jobs.converge?.needs
    const asArray = Array.isArray(needs) ? needs : [needs]
    expect(asArray).toContain("quality")
  })

  // A gate that exists but is not wired into `needs` is indistinguishable from
  // no gate: the job runs, goes green or red, and the publish proceeds anyway.
  // Both publishing jobs must depend on BOTH gates, or an unverified tarball
  // reaches npm — where it is immutable.
  it("wires both gates into both publishing jobs", () => {
    const workflow = load(
      readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
    ) as { jobs: Record<string, { needs?: string | string[] }> }

    for (const job of ["release", "converge"]) {
      const needs = workflow.jobs[job]?.needs
      expect(needs, `'${job}' job must declare needs`).toBeTruthy()
      const asArray = Array.isArray(needs) ? needs : [needs]
      expect(asArray, `'${job}' must not publish without the artifact gate`).toContain("quality")
      expect(asArray, `'${job}' must not publish without the policy gate`).toContain("release-policy")
    }
  })

  // The policy tests assert what the release rules ARE, so they only mean
  // something if the job running them reads THIS repository's current
  // workflow. If `release-policy` ever gained the tag-following `ref` that
  // `quality` correctly uses, a converge would test the copy of the rules
  // committed at the tag and any rule added since would silently not run.
  it("runs policy tests against the current rules, not the tag's copy", () => {
    const ref = checkoutStepOf("release-policy").with?.ref
    expect(ref, "release-policy must check out the default ref, not the tag").toBeFalsy()
  })
})

// WHAT THE ASSERTIONS ABOVE CANNOT SEE
//
// Every test in the block above passed at 752a30e63, and the converge job was
// still unrunnable. They ask whether the right REF was checked out and whether
// the job DEPENDENCIES are wired — both necessary, neither sufficient — and
// then stop. Nothing asked the one question that decides whether the job does
// anything at all: is the program it runs present in the directory it runs it
// from?
//
// It was not. `scripts/` at v2.2.1 (07173d030) contains no
// converge-release.ts; the driver was written after the tag it converges, so
// the tag could not contain it and never will. A job that checks out the tag
// and runs `node --import tsx scripts/converge-release.ts` from there exits on
// ERR_MODULE_NOT_FOUND before reading the registry.
//
// The generalisation, and the reason these tests are phrased against the
// commands rather than against this one script: a converge always runs CURRENT
// tooling against a HISTORICAL tree, so any file the job executes must be
// resolved from a checkout that is NOT the tag. That is a property of the
// arrangement, checkable for whatever the job runs next year.
describe("npm-release converge job can execute what it is told to run", () => {
  const TAG_WITHOUT_THE_DRIVER = "07173d030ee6be0270aed0120f90f317b5ce5e94"

  // Maps each `run:` step to the checkout it executes in, by matching its
  // working-directory against the checkout `path`s declared in the same job.
  // A step with no working-directory runs in the workspace root.
  function checkoutForStep(job: string, step: WorkflowStep): WorkflowStep | null {
    const dir = step["working-directory"]
    if (!dir) return null
    return checkoutStepsOf(job).find(c => c.with?.path === dir) ?? null
  }

  // Files a `run:` line invokes from the repository. Deliberately narrow —
  // node/tsx entrypoints and `npm run --workspace` roots are what this job
  // actually uses — because a broad heuristic that matched flags or URLs would
  // fail noisily on unrelated edits and get deleted.
  function repoFilesExecutedBy(run: string): string[] {
    return [...run.matchAll(/(?:^|\s)((?:scripts|packages)\/[\w./-]+\.(?:ts|mjs|js))(?=\s|$)/g)].map(
      m => m[1] as string
    )
  }

  function existsAtTag(path: string): boolean {
    try {
      execFileSync("git", ["cat-file", "-e", `${TAG_WITHOUT_THE_DRIVER}:${path}`], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }

  // THE TEST THAT WOULD HAVE CAUGHT IT. For every command the converge job
  // runs, the file it executes must exist in the checkout that command runs
  // in. Asserted against the real git object store at the real tag, so it
  // cannot be satisfied by a plausible-looking YAML edit.
  it("runs every command from a checkout that contains it", () => {
    const job = "converge"
    const runSteps = stepsOf(job).filter(s => typeof s.run === "string")
    expect(runSteps.length, "converge job runs no commands at all").toBeGreaterThan(0)

    let executedFiles = 0
    for (const step of runSteps) {
      for (const file of repoFilesExecutedBy(step.run as string)) {
        executedFiles += 1
        const checkout = checkoutForStep(job, step)
        const ref = checkout?.with?.ref ?? ""
        const followsTag = ref.includes("converge-tag")

        if (!checkout) {
          throw new Error(
            `step '${step.name}' runs ${file} in the workspace root, which is not a checkout. ` +
              `With more than one checkout in this job, every command must name the one it runs in ` +
              `via working-directory.`
          )
        }

        // The whole finding, as an assertion: a command whose working
        // directory is the tag's checkout can only run if the tag's tree
        // contains it — and for this driver it provably does not.
        if (followsTag) {
          expect(
            existsAtTag(file),
            `step '${step.name}' runs ${file} from the tag's checkout, but ${file} does not exist at ` +
              `${TAG_WITHOUT_THE_DRIVER}. The converge job would exit ERR_MODULE_NOT_FOUND before ` +
              `publishing anything. Run current tooling from a current checkout instead.`
          ).toBe(true)
        }
      }
    }

    expect(executedFiles, "no executed repository file was checked").toBeGreaterThan(0)
  })

  // The converge driver specifically: it must run from a checkout of the
  // CURRENT revision. Pinned separately from the generic rule above because
  // this is the one command whose absence from the tag is already proven, and
  // a regression here republishes the original defect.
  it("runs the converge driver from the current tooling checkout, not the tag", () => {
    const step = stepsOf("converge").find(s => (s.run ?? "").includes("scripts/converge-release.ts"))
    expect(step, "converge job must still run scripts/converge-release.ts").toBeTruthy()

    expect(
      existsAtTag("scripts/converge-release.ts"),
      "the premise of this test changed: the tag now contains the driver"
    ).toBe(false)

    const checkout = checkoutForStep("converge", step as WorkflowStep)
    expect(checkout, "the driver's step must name the checkout it runs in").toBeTruthy()
    const ref = (checkout as WorkflowStep).with?.ref ?? ""
    expect(
      ref.includes("converge-tag"),
      "the driver must NOT run from the tag's checkout — the tag has no driver"
    ).toBe(false)
  })

  // Separating the two checkouts only helps if the driver is then TOLD which
  // one holds the packages. Without that it would publish the tooling
  // checkout's own sources — current main — under the tag's immutable version,
  // which is the failure the tag checkout exists to prevent, reintroduced from
  // the other side.
  it("points the driver at the tagged checkout for package source", () => {
    const step = stepsOf("converge").find(s => (s.run ?? "").includes("scripts/converge-release.ts"))
    const source = (step as WorkflowStep).env?.CONVERGE_PACKAGE_SOURCE
    expect(source, "the driver must be given an explicit package source").toBeTruthy()

    const taggedPath = checkoutStepsOf("converge").find(c => (c.with?.ref ?? "").includes("converge-tag"))
      ?.with?.path
    expect(taggedPath, "the tag's checkout must declare a path so it can be referenced").toBeTruthy()
    expect(
      source,
      `CONVERGE_PACKAGE_SOURCE must point at the tag's checkout (${taggedPath})`
    ).toContain(taggedPath as string)
  })

  // Both checkouts have to install their own dependencies. The tagged tree's
  // install is what each package's prepack builds against; the tooling tree's
  // is what supplies tsx and the npm 11 that can authenticate via OIDC. One
  // `npm ci` cannot serve both, because the two lockfiles are different.
  it("installs dependencies in both checkouts", () => {
    const installDirs = stepsOf("converge")
      .filter(s => (s.run ?? "").trim().startsWith("npm ci"))
      .map(s => s["working-directory"])

    for (const checkout of checkoutStepsOf("converge")) {
      const path = checkout.with?.path
      expect(path, "every converge checkout must declare an explicit path").toBeTruthy()
      expect(
        installDirs,
        `checkout '${checkout.name}' gets no \`npm ci\`, so nothing it provides is resolvable`
      ).toContain(path)
    }
  })
})
