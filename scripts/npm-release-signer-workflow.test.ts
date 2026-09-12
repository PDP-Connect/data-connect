// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"
import {
  EXPECTED_REPO,
  EXPECTED_SIGNER_WORKFLOW,
  SUBJECT_DIGEST_ALG,
  buildAttestationVerifyArgs,
} from "./verify-npm-provenance"

// `--repo`/`--signer-workflow` alone bind an attestation to a repository
// and workflow file, but not to a specific commit — a workflow run
// triggered from a different commit on the same ref would still pass. The
// verification must additionally pin `--source-digest` to `$GITHUB_SHA`
// and `--digest-alg` to sha512 (npm's subject digest algorithm; `gh
// attestation verify` defaults to sha256 and would hash the tarball wrong).
//
// These tests import the verifier and assert on the argument vector it
// actually builds. They deliberately do NOT substring-match the script's
// source text: every flag named here also appears verbatim in that file's
// header comment, so a source-text assertion is satisfied by the prose
// alone and passes even when the real argv has been gutted.

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

// The argv the verifier would hand to `gh` for a representative package,
// built by the real production function rather than read off the page.
function verifyArgs(sourceDigest = "4bb3f161ad0f0f5b1a9f2e6c7d8e9f0a1b2c3d4e"): string[] {
  return buildAttestationVerifyArgs({
    tarballPath: "/tmp/workdir/pdpp-local-collector-2.1.1.tgz",
    bundlePath: "/tmp/workdir/bundle.json",
    sourceDigest,
  })
}

// Reads the value `gh` would receive for a flag, so a test fails when a
// flag is dropped, reordered, or left with the wrong operand.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
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

  it("binds verification to an exact source commit via --source-digest", () => {
    const sourceDigest = "4bb3f161ad0f0f5b1a9f2e6c7d8e9f0a1b2c3d4e"
    const args = verifyArgs(sourceDigest)

    // Without this flag the attestation binds to the repo and workflow file
    // but to no particular commit: a run from a different commit on the
    // same ref verifies clean.
    expect(args).toContain("--source-digest")
    expect(flagValue(args, "--source-digest")).toBe(sourceDigest)
  })

  it("hashes the tarball with sha512, npm's subject digest algorithm", () => {
    const args = verifyArgs()

    // `gh attestation verify` defaults to sha256. Against an npm
    // provenance bundle that produces a digest mismatch reported as an
    // issuer failure, which is what the sha512 flag exists to prevent.
    expect(args).toContain("--digest-alg")
    expect(flagValue(args, "--digest-alg")).toBe("sha512")
    expect(SUBJECT_DIGEST_ALG).toBe("sha512")
  })

  it("pins the signer identity to this exact repo and workflow file", () => {
    const args = verifyArgs()

    expect(flagValue(args, "--repo")).toBe("PDP-Connect/data-connect")
    expect(flagValue(args, "--signer-workflow")).toBe(
      "PDP-Connect/data-connect/.github/workflows/npm-release.yml"
    )
    // A signer-workflow that names only the repo, or only a bare filename,
    // would let a different workflow in the same repo sign a release.
    expect(EXPECTED_SIGNER_WORKFLOW.startsWith(`${EXPECTED_REPO}/.github/workflows/`)).toBe(true)
  })

  it("builds the complete gh attestation verify argv, with the tarball and fetched bundle", () => {
    const args = verifyArgs("abc123")

    // Whole-vector equality: a dropped, reordered, or renamed flag fails
    // here even if every other assertion is individually satisfied.
    expect(args).toEqual([
      "attestation",
      "verify",
      "/tmp/workdir/pdpp-local-collector-2.1.1.tgz",
      "--bundle",
      "/tmp/workdir/bundle.json",
      "--digest-alg",
      "sha512",
      "--repo",
      "PDP-Connect/data-connect",
      "--signer-workflow",
      "PDP-Connect/data-connect/.github/workflows/npm-release.yml",
      "--source-digest",
      "abc123",
    ])
  })

  it("passes the subject tarball and bundle through to the operands gh reads", () => {
    const args = buildAttestationVerifyArgs({
      tarballPath: "/scratch/one.tgz",
      bundlePath: "/scratch/one-bundle.json",
      sourceDigest: "f00d",
    })

    // The tarball is a positional operand, not a flag value; verifying a
    // different file than the one downloaded would still "pass" gh.
    expect(args[2]).toBe("/scratch/one.tgz")
    expect(flagValue(args, "--bundle")).toBe("/scratch/one-bundle.json")
  })
})
