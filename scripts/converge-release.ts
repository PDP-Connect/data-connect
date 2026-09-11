// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Publishes whatever is missing from the lockstep release the newest tag
// already committed to, and nothing else.
//
// This is the executor for the `converge` decision made by
// scripts/resolve-release-version.ts. Its whole job is to turn a tag that
// claims a release into a registry that actually holds one.
//
// WHY THIS DOES NOT RUN semantic-release
//
// semantic-release does two separable things: it DECIDES a version (from
// commits and tags) and it RECORDS that decision (a pushed git tag), and then
// it PUBLISHES. For an incomplete tag, the first two are already done and are
// not in dispute — the tag is on the remote and is the public record. Only
// publishing is outstanding.
//
// Re-running semantic-release to finish that publishing cannot work, and the
// reason is structural rather than a matter of configuration:
//
//   1. It reads the last release from GIT TAGS ONLY (lib/get-last-release.js
//      never contacts a registry), so with the tag present it finds 0 commits
//      since the last release and resolves no version at all:
//        "Found git tag v2.2.1 ... Found 0 commits since last release
//         ... There are no relevant changes, so no new version is released."
//
//   2. Deleting the tag locally to make it recompute does not work either.
//      lib/branches/index.js runs `fetch(repositoryUrl, ...)` — a
//      `git fetch --tags` — BEFORE it enumerates tags, so a locally-deleted
//      release tag is restored from the remote within the same run. Verified
//      by execution: after deleting v2.2.1 locally and running a dry run, the
//      tag was back in `git tag --list` and the run still reported "no
//      relevant changes".
//
//   3. Deleting the tag on the REMOTE would make it recompute the same
//      version (also verified: with v2.2.1 removed and v2.2.0 present, it
//      recomputes exactly 2.2.1). But that means destroying the public,
//      immutable record of a release whose packages are already live and
//      provenance-attested, and re-pushing it. A release pipeline must not
//      rewrite published history to work around its own crash.
//
// So the converge path does what is actually left to do: it drives the same
// publish step, for the same version, against the same registry, through the
// same idempotent plugin — without asking semantic-release to re-derive a
// decision it already made and recorded.
//
// WHAT IT GUARANTEES
//
//   - It publishes ONLY packages the registry reports as missing at this
//     exact version. Live packages are skipped, never republished (npm
//     versions are immutable; republishing is an E403, and the content is
//     already correct).
//   - It creates NO tag and NO GitHub release. The run that pushed the tag
//     already did both. This script only writes to the registry.
//   - It is RE-ENTRANT. A converge run that itself dies partway leaves
//     strictly less missing than it found, and re-running continues from
//     there. There is no state to clean up because there is no state: the
//     registry is the state, and every write to it is additive.
//   - An UNKNOWN registry answer aborts before publishing anything, because
//     "I could not tell" is never "not published".
//
// It publishes in .releaserc.yaml's order (connector-protocol, then
// collector-runtime, then local-collector) so that the dependency edge
// between them is respected: collector-runtime's published manifest pins an
// exact connector-protocol version, and local-collector builds against both.

import { execFile } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { promisify } from "node:util"
import {
  LOCKSTEP_PACKAGES,
  lockstepRegistryState,
  type LockstepPackage,
} from "./release-registry-state.js"

const run = promisify(execFile)

// pkgRoot per package, mirroring .releaserc.yaml's @semantic-release/npm
// entries. Publish order is this array's order.
const PACKAGE_ROOTS: Record<LockstepPackage, string> = {
  "@pdpp/connector-protocol": "packages/connector-protocol",
  "@pdpp/collector-runtime": "packages/collector-runtime",
  "@pdpp/local-collector": "packages/local-collector",
}

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/

function fail(message: string): never {
  process.stderr.write(`[converge-release] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[converge-release] ${message}\n`)
}

export function versionFromTag(tag: string): string | null {
  const match = TAG_PATTERN.exec(tag.trim())
  return match ? (match[1] as string) : null
}

// A converge run publishes to the `latest` dist-tag from `main` only. Any
// other ref is refused before a single registry read, so a branch build can
// never publish.
export function assertReleaseRef(ref: string | undefined): void {
  if (!ref) {
    fail("No ref supplied (GITHUB_REF unset) — refusing to converge a release from an unknown ref")
  }
  if (ref !== "refs/heads/main") {
    fail(`Converge is only allowed on refs/heads/main, got ${ref}`)
  }
}

// Writes the release version into a package's manifest, the same thing
// @semantic-release/npm's prepare step does before publishing. This edit
// happens in the ephemeral CI checkout only and is never committed.
//
// Deliberately a TARGETED TEXT REPLACEMENT of the `version` field rather than
// a JSON.parse/stringify round-trip or a shell-out to `npm version`. Both of
// those rewrite the whole file, and both silently change content they were
// never asked to touch: these manifests contain `—` escapes in their
// descriptions, and a round-trip re-emits them as literal em-dashes, leaving
// unrelated drift in the tarball and the working tree. Caught by running this
// script for real and diffing the tree afterwards.
export function replaceManifestVersion(raw: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m
  if (!pattern.test(raw)) {
    throw new Error("manifest has no top-level \"version\" field to replace")
  }
  return raw.replace(pattern, `$1${JSON.stringify(version)}`)
}

function writeManifestVersion(pkgRoot: string, version: string): void {
  const manifestPath = resolve(process.cwd(), pkgRoot, "package.json")
  const raw = readFileSync(manifestPath, "utf8")
  writeFileSync(manifestPath, replaceManifestVersion(raw, version))
}

async function publishPackage(name: LockstepPackage, version: string, dryRun: boolean): Promise<void> {
  const pkgRoot = PACKAGE_ROOTS[name]

  if (dryRun) {
    log(`[dry-run] would publish ${name}@${version} from ${pkgRoot}`)
    return
  }

  writeManifestVersion(pkgRoot, version)

  // `npm publish` runs the package's own prepack (which builds it) and, with
  // OIDC trusted publishing configured on the workflow, attaches provenance.
  // --provenance is not passed explicitly: npm infers it from the OIDC
  // context, matching how @semantic-release/npm publishes these same packages
  // on the ordinary path.
  log(`publishing ${name}@${version} from ${pkgRoot}`)
  const { stdout, stderr } = await run("npm", ["publish", pkgRoot, "--tag", "latest"], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (stdout.trim()) process.stdout.write(stdout)
  if (stderr.trim()) process.stderr.write(stderr)
  log(`published ${name}@${version}`)
}

async function main(): Promise<void> {
  assertReleaseRef(process.env.GITHUB_REF)

  const dryRun = process.env.CONVERGE_RELEASE_DRY_RUN === "true"

  const tag = process.env.CONVERGE_RELEASE_TAG
  if (!tag) {
    fail("CONVERGE_RELEASE_TAG is not set — the converge path requires the tag it is converging on")
  }

  const version = versionFromTag(tag)
  if (!version) {
    fail(`tag ${tag} is not of the form vX.Y.Z`)
  }

  // Re-read registry state here rather than trusting the resolver's output.
  // The resolve and converge steps run as separate jobs, so the registry may
  // have moved between them (a concurrent run, or propagation catching up).
  // The publish decision must be made against the registry as it is NOW.
  const state = await lockstepRegistryState(version)

  if (state.missing.length === 0) {
    // Not an error: another run converged first, or propagation caught up.
    // The post-state is exactly what was wanted, so this succeeds loudly
    // rather than failing on a race it does not need to win.
    log(`nothing to converge — all ${LOCKSTEP_PACKAGES.length} packages are live at ${version}`)
    return
  }

  if (state.published.length === 0) {
    fail(
      `tag ${tag} has no published packages at ${version} — that is not a partially-completed release. ` +
        `Run an ordinary release instead of converging.`
    )
  }

  log(`converging lockstep release ${version} (tag ${tag})`)
  log(`  already live: ${state.published.join(", ")}`)
  log(`  to publish:   ${state.missing.join(", ")}`)

  // Publish in .releaserc.yaml order, not registry-response order, so the
  // dependency edges between the three packages are respected.
  for (const name of LOCKSTEP_PACKAGES) {
    if (!state.missing.includes(name)) {
      log(`skipping ${name} — already live at ${version}`)
      continue
    }
    await publishPackage(name, version, dryRun)
  }

  log(`converged ${version}`)
}

// Only run when invoked as a script, so tests can import the helpers without
// triggering a registry read or a publish.
if (process.argv[1] && process.argv[1].endsWith("converge-release.ts")) {
  await main()
}
