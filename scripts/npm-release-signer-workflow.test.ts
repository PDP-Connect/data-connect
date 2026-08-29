// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// `gh attestation verify --repo <owner>/<repo> --source-digest <sha>` alone
// accepts an attestation signed by ANY workflow in the named repository, not
// just the release workflow that is supposed to have produced it. A
// compromised or malicious workflow added to this same repository could
// still forge a passing attestation for an artifact it built. This test
// parses the REAL workflow YAML (not a hand-copied string) and asserts the
// verification step also binds `--signer-workflow` to this exact workflow
// file, using the flag syntax `gh attestation verify --help` documents:
// `[host/]<owner>/<repo>/<path>/<to>/<workflow>`.

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

describe("npm-release.yml attestation verification", () => {
  it("invokes gh attestation verify with repo, source-digest, and signer-workflow", () => {
    const step = findVerificationStep(loadNpmReleaseWorkflow())
    const run = step.run ?? ""

    expect(run).toContain("gh attestation verify")
    expect(run).toContain("--repo PDP-Connect/data-connect")
    expect(run).toContain('--source-digest "$GITHUB_SHA"')
    expect(run).toMatch(/--signer-workflow\s+"?PDP-Connect\/data-connect\/\.github\/workflows\/npm-release\.yml"?/)
  })

  it("binds signer-workflow to this exact workflow file, not a bare repo/owner", () => {
    const step = findVerificationStep(loadNpmReleaseWorkflow())
    const run = step.run ?? ""
    const match = run.match(/--signer-workflow\s+"?([^"\s]+)"?/)

    expect(match).toBeTruthy()
    const signerWorkflow = match?.[1] ?? ""
    // gh attestation verify --help: --signer-workflow expects
    // [host/]<owner>/<repo>/<path>/<to>/<workflow> — a path ending in this
    // repo's own workflow file, not just an owner/repo pair (which --repo
    // already covers and which alone would accept any workflow in the repo).
    expect(signerWorkflow).toBe("PDP-Connect/data-connect/.github/workflows/npm-release.yml")
    expect(signerWorkflow.split("/").length).toBeGreaterThan(2)
  })

  it("keeps signer-workflow verification inside the loop that checks every published package", () => {
    const step = findVerificationStep(loadNpmReleaseWorkflow())
    const run = step.run ?? ""
    const loopStart = run.indexOf("for pkg in")
    const signerFlagIndex = run.indexOf("--signer-workflow")

    expect(loopStart).toBeGreaterThanOrEqual(0)
    expect(signerFlagIndex).toBeGreaterThan(loopStart)
  })
})
