// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// `--repo`/`--signer-workflow` alone bind an attestation to a repository
// and workflow file, but not to a specific commit — a workflow run
// triggered from a different commit on the same ref would still pass. This
// test parses the REAL workflow YAML and the REAL verification script to
// assert the verification also pins `--source-digest` to `$GITHUB_SHA`,
// in addition to the repo, workflow file, and digest algorithm.

interface WorkflowStep {
  name?: string
  run?: string
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

function findVerificationStep(workflow: WorkflowDocument): WorkflowStep {
  const step = workflow.jobs.release?.steps.find(
    s => s.name === "Verify npm provenance attestation"
  )
  if (!step) throw new Error("Missing 'Verify npm provenance attestation' step in release job")
  return step
}

function readVerifyScript(): string {
  return readFileSync(resolve(process.cwd(), "scripts/verify-npm-provenance.ts"), "utf8")
}

describe("npm-release.yml attestation verification", () => {
  it("delegates to the provenance verification script for all three published packages, with GITHUB_SHA", () => {
    const step = findVerificationStep(loadNpmReleaseWorkflow())
    const run = step.run ?? ""

    expect(run).toContain("scripts/verify-npm-provenance.ts")
    expect(run).toContain('"$GITHUB_SHA"')
    expect(run).toContain("@pdpp/connector-protocol")
    expect(run).toContain("@pdpp/collector-runtime")
    expect(run).toContain("@pdpp/local-collector")
  })

  it("pins verification to this exact repo, workflow file, source commit, and digest algorithm", () => {
    const script = readVerifyScript()

    expect(script).toContain("PDP-Connect/data-connect/.github/workflows/npm-release.yml")
    expect(script).toContain("--source-digest")
    expect(script).toContain("--digest-alg")
    expect(script).toContain("sha512")
  })

  it("verifies with gh attestation verify against a bundle fetched from the npm registry", () => {
    const script = readVerifyScript()

    expect(script).toContain('"gh"')
    expect(script).toContain("attestation")
    expect(script).toContain("--bundle")
    expect(script).toMatch(/dist\.attestations\.url|attestationsUrl/)
  })

  // The retry budget itself moved to scripts/npm-propagation-retry.ts, which
  // is now the single policy this script and the publish-ordering barrier
  // both use — they used to carry separate copies, and the barrier's copy
  // was a single unretried lookup, which is what aborted the v2.2.1 release.
  // What this test still owns is that THIS script goes through that policy;
  // npm-propagation-retry.test.ts owns the budget's size and behaviour.
  it("retries registry propagation lag instead of failing on the first lookup", () => {
    const script = readVerifyScript()

    expect(script).toContain("withPropagationRetry")
    expect(script).toMatch(/from "\.\/npm-propagation-retry\.ts"/)

    const policy = readFileSync(
      resolve(process.cwd(), "scripts/npm-propagation-retry.ts"),
      "utf8"
    )
    expect(policy).toContain("E404")
    expect(policy).toMatch(/PROPAGATION_RETRY_ATTEMPTS/)
  })
})
