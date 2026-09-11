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
import { withPropagationRetry as retryWhileMissing } from "./npm-propagation-retry.ts"

const run = promisify(execFile)

const EXPECTED_REPO = "PDP-Connect/data-connect"
const EXPECTED_SIGNER_WORKFLOW = "PDP-Connect/data-connect/.github/workflows/npm-release.yml"

function fail(message: string): never {
  process.stderr.write(`[verify-npm-provenance] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[verify-npm-provenance] ${message}\n`)
}

async function npmViewJson(spec: string, field: string): Promise<unknown> {
  const { stdout } = await run("npm", ["view", spec, field, "--json"])
  return JSON.parse(stdout.trim())
}

// Retries while the registry hasn't caught up yet (E404 on a version that
// was just published), using the one shared propagation policy — see
// scripts/npm-propagation-retry.ts for the measured lag and the budget. Any
// other failure is not a propagation issue and fails immediately rather than
// burning the retry budget.
async function withPropagationRetry<T>(spec: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await retryWhileMissing(spec, attempt, { log })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
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
      await run("gh", [
        "attestation",
        "verify",
        tarballPath,
        "--bundle",
        bundlePath,
        "--digest-alg",
        "sha512",
        "--repo",
        EXPECTED_REPO,
        "--signer-workflow",
        EXPECTED_SIGNER_WORKFLOW,
        "--source-digest",
        sourceDigest,
      ])
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

await main()
