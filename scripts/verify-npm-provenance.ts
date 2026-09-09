// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Verifies the SLSA provenance attestation npm trusted publishing attaches
// to a just-published package version.
//
// `gh attestation verify` cannot do this: npm trusted publishing signs
// through the public-good Sigstore instance (issuer "sigstore.dev" in the
// certificate's transparency-log entry), and `gh attestation verify`
// unconditionally rejects any bundle not countersigned by GitHub's own
// Sigstore instance, before it even looks at --repo/--signer-workflow.
// Confirmed by reproduction: `gh attestation verify <tarball> --bundle
// <registry-attestation-bundle> --repo PDP-Connect/data-connect
// --signer-workflow ...` fails with `Error: verifying with issuer
// "sigstore.dev"` regardless of flags. The attestation also isn't in
// GitHub's attestations store at all — trusted publishing stores it on the
// npm registry packument (`dist.attestations`), which is why the prior
// revision of this check (looking it up via the GitHub attestations API)
// got a 404: that store never had it.
//
// This script instead fetches the attestation bundle straight from the
// registry (the same place `npm view <pkg> dist.attestations.url` points)
// and verifies it in two independent steps:
//   1. The DSSE statement's subject digest (sha512, matching
//      `dist.integrity`) is recomputed from the actual downloaded tarball
//      and compared byte-for-byte — proving the attestation is actually
//      about this artifact, not just cryptographically well-formed.
//      (`@sigstore/cli verify --blob-file` cannot be trusted for this: it
//      only hashes with sha256, and npm's subject digest here is sha512,
//      so it verifies the signature but silently skips the artifact
//      binding — confirmed by feeding it garbage input and watching it
//      report success.)
//   2. `@sigstore/cli verify` checks the Sigstore signature, transparency
//      log inclusion, and the certificate identity against an EXPLICIT
//      expected signer: --certificate-identity-uri pins the exact
//      repo+workflow+ref, --certificate-issuer pins the OIDC issuer. Both
//      are required flags here (not optional filters) so a mismatch on
//      either fails closed.
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

const run = promisify(execFile)

const EXPECTED_ISSUER = "https://token.actions.githubusercontent.com"
const EXPECTED_IDENTITY_URI =
  "https://github.com/PDP-Connect/data-connect/.github/workflows/npm-release.yml@refs/heads/main"

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

interface DsseEnvelope {
  payload: string
}

interface AttestationEntry {
  predicateType: string
  bundle: { dsseEnvelope: DsseEnvelope }
}

interface AttestationsResponse {
  attestations: AttestationEntry[]
}

function decodeSha512Subject(entry: AttestationEntry): string {
  const payload = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as {
    subject: Array<{ digest: { sha512?: string } }>
  }
  const digest = payload.subject[0]?.digest.sha512
  if (!digest) fail(`provenance attestation for predicate ${entry.predicateType} has no sha512 subject digest`)
  return digest
}

async function verifyPackage(pkg: string, version: string): Promise<void> {
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

    const expectedDigest = decodeSha512Subject(provenance)
    const { stdout: tarballBuffer } = await run("sha512sum", [tarballPath])
    const actualDigest = tarballBuffer.trim().split(/\s+/)[0]
    if (actualDigest !== expectedDigest) {
      fail(
        `provenance subject digest mismatch for ${spec}: attestation says ${expectedDigest}, ` +
          `downloaded tarball hashes to ${actualDigest}`
      )
    }
    log(`provenance subject digest matches the downloaded tarball for ${spec}`)

    const bundlePath = join(workdir, "bundle.json")
    await writeFile(bundlePath, JSON.stringify(provenance.bundle))

    log(`verifying Sigstore signature and signer identity for ${spec}...`)
    await run("npx", [
      "--yes",
      "@sigstore/cli",
      "verify",
      bundlePath,
      "--certificate-identity-uri",
      EXPECTED_IDENTITY_URI,
      "--certificate-issuer",
      EXPECTED_ISSUER,
    ])
    log(`provenance verified for ${spec}`)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

async function main() {
  const version = process.argv[2]
  const packages = process.argv.slice(3)
  if (!version || packages.length === 0) {
    fail("Usage: verify-npm-provenance.ts <version> <package>...")
  }

  for (const pkg of packages) {
    await verifyPackage(pkg, version)
  }
}

await main()
