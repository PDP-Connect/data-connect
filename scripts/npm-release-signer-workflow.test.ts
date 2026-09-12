// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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

const REPO_ROOT = resolve(__dirname, "..")

// Runs verify-npm-provenance.ts as the program the release workflow invokes,
// with `npm` and `gh` replaced by stubs on PATH and the registry's
// attestations URL pointed at a throwaway local server. `gh` records the argv
// it was handed, so the assertion observes the vector at the process boundary
// instead of the builder's return value. Nothing here contacts the network or
// runs a real `gh attestation verify`.
async function runVerifierAgainstStubs(input: {
  version: string
  sourceDigest: string
  packageName: string
}): Promise<{
  status: number
  ghArgv: string[]
  packedTarball: string
  writtenBundle: string
}> {
  const dir = mkdtempSync(join(tmpdir(), "provenance-stubs-"))
  let sidecar: ReturnType<typeof spawn> | undefined
  try {
    const body = JSON.stringify({
      attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { mock: true } }],
    })

    // The attestations endpoint runs in its OWN process, not in this one: the
    // verifier is launched with execFileSync, which blocks this thread, so an
    // in-process server could never answer the child's fetch.
    const portPath = join(dir, "port")
    const serverPath = join(dir, "attestations-server.mjs")
    writeFileSync(
      serverPath,
      `import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
const body = ${JSON.stringify(body)}
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(body)
})
server.listen(0, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))
})
`
    )
    sidecar = spawn(process.execPath, [serverPath], { stdio: "ignore" })

    const deadline = Date.now() + 10_000
    let port = ""
    while (Date.now() < deadline) {
      if (existsSync(portPath)) {
        port = readFileSync(portPath, "utf8").trim()
        if (port) break
      }
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},25)"])
    }
    if (!port) throw new Error("attestations sidecar did not report a port")
    const attestationsUrl = `http://127.0.0.1:${port}/attestations`

    const ghArgvPath = join(dir, "gh-argv.json")
    const packedNamePath = join(dir, "packed.txt")

    // `npm view` answers with the array shape npm 11 emits; `npm pack` writes
    // a real file into the workdir the script created, so the tarball path the
    // script discovers is a genuine filesystem result.
    writeFileSync(
      join(dir, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path")
const a = process.argv.slice(2)
if (a[0] === "view") {
  process.stdout.write(JSON.stringify([${JSON.stringify(attestationsUrl)}]) + "\\n")
  process.exit(0)
}
if (a[0] === "pack") {
  const dest = a[a.indexOf("--pack-destination") + 1]
  const tgz = path.join(dest, "pdpp-local-collector-${input.version}.tgz")
  fs.writeFileSync(tgz, "not a real tarball")
  fs.writeFileSync(${JSON.stringify(packedNamePath)}, tgz)
  process.exit(0)
}
process.stderr.write("stub npm: unexpected invocation: " + a.join(" ") + "\\n")
process.exit(2)
`
    )
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(ghArgvPath)}, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`
    )
    chmodSync(join(dir, "npm"), 0o755)
    chmodSync(join(dir, "gh"), 0o755)

    const tsxEntry = require.resolve("tsx")
    let status = 0
    let childOut = ""
    try {
      childOut = execFileSync(
        process.execPath,
        [
          "--import",
          tsxEntry,
          join(REPO_ROOT, "scripts/verify-npm-provenance.ts"),
          input.version,
          input.sourceDigest,
          input.packageName,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      status = e.status ?? 1
      childOut = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }

    if (status !== 0) {
      throw new Error(`verifier exited ${status}; output:\n${childOut}`)
    }

    const packedTarball = readFileSync(packedNamePath, "utf8").trim()
    return {
      status,
      ghArgv: JSON.parse(readFileSync(ghArgvPath, "utf8")) as string[],
      packedTarball,
      // The script writes the fetched bundle next to the tarball it packed.
      writtenBundle: join(dirname(packedTarball), "bundle.json"),
    }
  } finally {
    sidecar?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
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

  // Everything above observes the builder's return value. That leaves the one
  // line that hands the vector to `gh` unobserved: inlining a different array
  // at the call site, swapping the tarball and bundle operands, or passing the
  // version where the source digest belongs all satisfy the assertions above.
  // So the script is also run as the program `npm-release.yml` invokes, with
  // `gh` replaced by a stub that records the argv it was actually given.
  it("hands gh the built vector at the call site, with the real fetched paths", async () => {
    const captured = await runVerifierAgainstStubs({
      version: "9.9.9",
      sourceDigest: "deadbeefcafe0000000000000000000000000000",
      packageName: "@pdpp/local-collector",
    })

    expect(captured.status).toBe(0)

    const argv = captured.ghArgv
    expect(argv.slice(0, 2)).toEqual(["attestation", "verify"])

    // The tarball operand is the file `npm pack` actually wrote, and the
    // bundle is the file the fetched attestation was written to — not two
    // strings that merely look plausible.
    expect(argv[2]).toBe(captured.packedTarball)
    expect(flagValue(argv, "--bundle")).toBe(captured.writtenBundle)
    expect(argv[2]).not.toBe(flagValue(argv, "--bundle"))

    // The digest reaches gh from process.argv, through main() and
    // verifyPackage, rather than being any other value in scope.
    expect(flagValue(argv, "--source-digest")).toBe("deadbeefcafe0000000000000000000000000000")
    expect(flagValue(argv, "--source-digest")).not.toBe("9.9.9")

    expect(flagValue(argv, "--digest-alg")).toBe("sha512")
    expect(flagValue(argv, "--repo")).toBe(EXPECTED_REPO)
    expect(flagValue(argv, "--signer-workflow")).toBe(EXPECTED_SIGNER_WORKFLOW)

    // Whole-vector equality at the boundary: the argv gh received is exactly
    // what the builder produces for those paths, so a call site that edits,
    // truncates, or replaces the vector fails here.
    expect(argv).toEqual(
      buildAttestationVerifyArgs({
        tarballPath: captured.packedTarball,
        bundlePath: captured.writtenBundle,
        sourceDigest: "deadbeefcafe0000000000000000000000000000",
      })
    )
  })
})
