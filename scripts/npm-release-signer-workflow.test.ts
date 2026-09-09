// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// `gh attestation verify --repo <owner>/<repo>` alone would accept an
// attestation signed by ANY workflow in the named repository — a
// compromised or malicious workflow added to this same repository could
// still forge a passing attestation for an artifact it built. This is moot
// for `gh attestation verify` itself (it cannot verify npm's provenance
// bundles at all — see scripts/verify-npm-provenance.ts), but the same
// binding requirement applies to the replacement: this test parses the REAL
// workflow YAML and the REAL verification script to assert both the
// workflow step and the script pin an EXPLICIT expected signer identity
// (repo + workflow file + ref, and OIDC issuer), not just a bare repo name.

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
  it("delegates to the provenance verification script for all three published packages", () => {
    const step = findVerificationStep(loadNpmReleaseWorkflow())
    const run = step.run ?? ""

    expect(run).toContain("scripts/verify-npm-provenance.ts")
    expect(run).toContain("@pdpp/connector-protocol")
    expect(run).toContain("@pdpp/collector-runtime")
    expect(run).toContain("@pdpp/local-collector")
  })

  it("pins verification to this exact repo, workflow file, ref, and OIDC issuer", () => {
    const script = readVerifyScript()

    expect(script).toContain(
      "https://github.com/PDP-Connect/data-connect/.github/workflows/npm-release.yml@refs/heads/main"
    )
    expect(script).toContain("https://token.actions.githubusercontent.com")
    expect(script).toContain("--certificate-identity-uri")
    expect(script).toContain("--certificate-issuer")
  })

  it("verifies the attestation subject digest against the actual downloaded tarball", () => {
    const script = readVerifyScript()

    expect(script).toContain("sha512sum")
    expect(script).toMatch(/digest mismatch/i)
  })

  it("retries registry propagation lag instead of failing on the first lookup", () => {
    const script = readVerifyScript()

    expect(script).toContain("E404")
    expect(script).toMatch(/PROPAGATION_RETRY_ATTEMPTS/)
  })
})
