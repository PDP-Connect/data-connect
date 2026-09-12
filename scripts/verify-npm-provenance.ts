// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Verifies the SLSA provenance attestation npm trusted publishing attaches
// to a just-published package version.
//
// `gh attestation verify --repo ... --signer-workflow ...` cannot fetch this
// attestation on its own: npm trusted publishing stores its provenance
// bundle on the npm registry packument (`dist.attestations`), never in
// GitHub's attestations store, so the API lookup `gh attestation verify`
// does by default 404s every time. This script fetches the bundle from the
// registry itself (the same place `npm view <pkg> dist.attestations.url`
// points) and hands it to `gh attestation verify --bundle` instead.
//
// A prior revision of this script also claimed `gh attestation verify`
// rejects any bundle not countersigned by GitHub's own Sigstore instance,
// and reimplemented digest and signature verification with `@sigstore/cli`
// to work around that. That claim was wrong: the "verifying with issuer
// sigstore.dev" failure it was based on was caused by omitting
// `--digest-alg sha512` (this bundle's subject digest is sha512; `gh
// attestation verify` defaults to sha256, so without the flag it hashes the
// tarball wrong and misattributes the resulting failure to the issuer).
// With `--digest-alg sha512` set, `gh attestation verify` verifies the
// signature, the digest, and the identity — including `--source-digest`,
// which binds the attestation to an exact commit SHA and was missing from
// the reimplementation entirely. Confirmed against the real, live 2.1.1
// bundles: correct SHA passes, an all-zero SHA fails with "expected
// SourceRepositoryDigest to be 0000...0000, got 4bb3f161...".
//
// Registry propagation lag: `npm publish` returning success does not mean
// `npm view`/`npm pack` can resolve the version immediately — observed ~3
// minutes for @pdpp/local-collector@2.1.1 to become fetchable after its
// publish log said "Published". Each per-package fetch below retries on
// E404 with a bounded wait.

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { isMainModule } from "./is-main-module.js"

const run = promisify(execFile)

export const EXPECTED_REPO = "PDP-Connect/data-connect"
export const EXPECTED_SIGNER_WORKFLOW =
  "PDP-Connect/data-connect/.github/workflows/npm-release.yml"

// npm's provenance subject digest is sha512; `gh attestation verify`
// defaults to sha256, so the algorithm must be stated explicitly or the
// tarball is hashed wrong (see the header note above).
export const SUBJECT_DIGEST_ALG = "sha512"

// Builds the exact `gh attestation verify` argument vector. Kept pure and
// separate from the call so the flags that carry the security properties —
// the sha512 subject digest, the commit-SHA source binding, and the
// repo/workflow signer identity — are directly observable under test
// without executing `gh`.
export function buildAttestationVerifyArgs(input: {
  tarballPath: string
  bundlePath: string
  sourceDigest: string
}): string[] {
  return [
    "attestation",
    "verify",
    input.tarballPath,
    "--bundle",
    input.bundlePath,
    "--digest-alg",
    SUBJECT_DIGEST_ALG,
    "--repo",
    EXPECTED_REPO,
    "--signer-workflow",
    EXPECTED_SIGNER_WORKFLOW,
    "--source-digest",
    input.sourceDigest,
  ]
}

const PROPAGATION_RETRY_ATTEMPTS = 6
const PROPAGATION_RETRY_DELAY_MS = 30_000

function fail(message: string): never {
  process.stderr.write(`[verify-npm-provenance] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[verify-npm-provenance] ${message}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function npmViewJson(spec: string, field: string): Promise<unknown> {
  const { stdout } = await run("npm", ["view", spec, field, "--json"])
  return JSON.parse(stdout.trim())
}

// Retries while the registry hasn't caught up yet (E404 on a version that
// was just published). Any other failure is not a propagation issue and
// should fail immediately rather than burn the retry budget.
async function withPropagationRetry<T>(spec: string, attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; i <= PROPAGATION_RETRY_ATTEMPTS; i++) {
    try {
      return await attempt()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const isMissing = detail.includes("E404")
      if (!isMissing || i === PROPAGATION_RETRY_ATTEMPTS) {
        fail(`giving up resolving ${spec} after ${i} attempt(s): ${detail}`)
      }
      log(`${spec} not yet resolvable on the registry (attempt ${i}/${PROPAGATION_RETRY_ATTEMPTS}), retrying...`)
      await sleep(PROPAGATION_RETRY_DELAY_MS)
    }
  }
  throw new Error("unreachable")
}

interface AttestationEntry {
  predicateType: string
  bundle: unknown
}

interface AttestationsResponse {
  attestations: AttestationEntry[]
}

async function verifyPackage(pkg: string, version: string, sourceDigest: string): Promise<void> {
  const spec = `${pkg}@${version}`
  log(`resolving ${spec} on the registry...`)

  const attestationsUrl = await withPropagationRetry(
    spec,
    () => npmViewJson(spec, "dist.attestations.url") as Promise<string>
  )

  const workdir = await mkdtemp(join(tmpdir(), "npm-provenance-"))
  try {
    log(`downloading published tarball for ${spec}...`)
    await withPropagationRetry(spec, () =>
      run("npm", ["pack", spec, "--pack-destination", workdir, "--foreground-scripts=false"])
    )
    const { stdout: lsOut } = await run("bash", ["-c", `ls "${workdir}"/*.tgz`])
    const tarballPath = lsOut.trim()
    if (!tarballPath || tarballPath.includes("\n")) {
      fail(`expected exactly one .tgz in ${workdir} for ${spec}, got: ${lsOut}`)
    }

    log(`fetching provenance attestation bundle for ${spec}...`)
    const response = await fetch(attestationsUrl)
    if (!response.ok) {
      fail(`fetching ${attestationsUrl} returned HTTP ${response.status}`)
    }
    const { attestations } = (await response.json()) as AttestationsResponse
    const provenance = attestations.find(a => a.predicateType === "https://slsa.dev/provenance/v1")
    if (!provenance) fail(`no SLSA provenance attestation found for ${spec} at ${attestationsUrl}`)

    const bundlePath = join(workdir, "bundle.json")
    await writeFile(bundlePath, JSON.stringify(provenance.bundle))

    log(`verifying provenance signature, digest, and signer identity for ${spec}...`)
    try {
      await run("gh", buildAttestationVerifyArgs({ tarballPath, bundlePath, sourceDigest }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      fail(`provenance verification failed for ${spec}: ${detail}`)
    }
    log(`provenance verified for ${spec}`)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

async function main() {
  const version = process.argv[2]
  const sourceDigest = process.argv[3]
  const packages = process.argv.slice(4)
  if (!version || !sourceDigest || packages.length === 0) {
    fail("Usage: verify-npm-provenance.ts <version> <source-digest> <package>...")
  }

  for (const pkg of packages) {
    await verifyPackage(pkg, version, sourceDigest)
  }
}

// Only run when invoked as a program. Importing this module (as the test
// does, to inspect the argv it builds) must not start verifying packages.
// That import edge is also what lets the mutation gate discover a covering
// test for this file, which `vitest --related` resolves through the module
// graph rather than the filename.
if (isMainModule(import.meta.url, process.argv[1])) {
  await main()
}
