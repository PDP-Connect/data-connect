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
//
// WHAT IT MUST REPRODUCE FROM THE ORDINARY PREPARE PIPELINE
//
// Publishing is not just "set the version and run npm publish". The ordinary
// release runs a `prepare` lifecycle first (.releaserc.yaml), and a converge
// that skips it publishes a DIFFERENT artifact under the same version — which
// npm immutability then makes permanent. Two steps of that pipeline change
// what ends up in the tarball, so both are reproduced here:
//
//   1. The VERSION field in each manifest (@semantic-release/npm's prepare,
//      which runs `npm version`). See replaceManifestVersion below.
//
//   2. The DEPENDENCY PIN: pin-collector-runtime-protocol-dependency.ts
//      rewrites collector-runtime's `@pdpp/connector-protocol` dependency
//      from its committed placeholder ("0.0.1") to this release's version.
//      Without it a converged collector-runtime@X resolves connector-protocol
//      from whatever "0.0.1" means on the registry — an ancient version that
//      really exists — so the package installs cleanly and is broken, and the
//      lockstep invariant reads TRUE while being false. Reproduced by
//      pinCollectorRuntimeDependency below, which is deliberately the same
//      edit the prepare script makes rather than a second implementation of
//      the rule.
//
// WHICH NPM RUNS THE PUBLISH
//
// OIDC trusted publishing (this workflow has `id-token: write` and no
// NPM_TOKEN) is only implemented in npm >= 11.5.1. The runner's ambient npm
// is older (10.9.8 on the setup-node used here), and it cannot authenticate
// at all — the publish would fail before writing anything. The ordinary path
// never hits this because @semantic-release/npm shells out with
// `preferLocal: true`, which finds the npm 11 that package depends on and
// that package-lock.json hoists at node_modules/npm. This script is invoked
// as `node --import tsx ...`, not through an npm run-script, so
// node_modules/.bin is NOT on its PATH and bare "npm" would resolve to the
// ambient one. resolveNpmBin below makes that explicit rather than
// accidental.

import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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

// The lockstep dependency edge: collector-runtime declares an EXACT
// connector-protocol version, and both are published from one version. The
// committed manifest carries a placeholder, so the pin has to be applied at
// publish time on every path that publishes.
export const PINNED_DEPENDENCY = "@pdpp/connector-protocol"
export const PINNED_DEPENDENT: LockstepPackage = "@pdpp/collector-runtime"

// Same targeted-replacement discipline as replaceManifestVersion, and for the
// same reason: a JSON round-trip re-emits these manifests' `—` escapes as
// literal em-dashes, leaving unrelated drift in the published tarball. The
// dependency line is matched by name so the edit cannot land on a
// same-valued string elsewhere in the file.
export function replaceDependencyVersion(raw: string, dependency: string, version: string): string {
  const pattern = new RegExp(`("${dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*)"[^"]*"`)
  if (!pattern.test(raw)) {
    throw new Error(`manifest has no "${dependency}" dependency to pin`)
  }
  return raw.replace(pattern, `$1${JSON.stringify(version)}`)
}

// Reproduces pin-collector-runtime-protocol-dependency.ts's effect for the
// converge path. Called for every package published here, and a no-op for the
// two that do not declare the dependency.
function pinSiblingDependency(name: LockstepPackage, pkgRoot: string, version: string): void {
  if (name !== PINNED_DEPENDENT) return

  const manifestPath = resolve(process.cwd(), pkgRoot, "package.json")
  const raw = readFileSync(manifestPath, "utf8")
  writeFileSync(manifestPath, replaceDependencyVersion(raw, PINNED_DEPENDENCY, version))
  log(`pinned ${PINNED_DEPENDENCY} to ${version} in ${pkgRoot}/package.json`)
}

// Resolves the npm that can actually authenticate via OIDC trusted
// publishing. See the WHICH NPM RUNS THE PUBLISH note in this file's header:
// bare "npm" here is the runner's ambient npm 10, which has no
// trusted-publishing support, so this prefers the npm 11 that
// @semantic-release/npm depends on and package-lock.json hoists.
//
// Refuses rather than silently falling back: a converge that quietly used the
// wrong npm would fail deep inside a publish with an opaque auth error, and
// the whole point of this path is that it either finishes the release or says
// clearly why it cannot.
export function resolveNpmBin(cwd: string): string {
  const local = resolve(cwd, "node_modules/.bin/npm")
  if (existsSync(local)) return local
  fail(
    `node_modules/.bin/npm is not present — refusing to publish with the ambient npm, which cannot ` +
      `authenticate via OIDC trusted publishing (that needs npm >= 11.5.1; runners ship npm 10). ` +
      `Run \`npm ci\` before converging.`
  )
}

async function publishPackage(
  name: LockstepPackage,
  version: string,
  dryRun: boolean,
  npmBin: string
): Promise<void> {
  const pkgRoot = PACKAGE_ROOTS[name]

  if (dryRun) {
    log(`[dry-run] would publish ${name}@${version} from ${pkgRoot}`)
    return
  }

  // Both prepare-pipeline edits, applied before the tarball is built. Order
  // does not matter (they touch different fields), but both must precede
  // `npm publish`, which runs prepack and packs from the tree as it is then.
  writeManifestVersion(pkgRoot, version)
  pinSiblingDependency(name, pkgRoot, version)

  // `npm publish` runs the package's own prepack (which builds it) and, with
  // OIDC trusted publishing configured on the workflow, attaches provenance.
  // --provenance is not passed explicitly: npm infers it from the OIDC
  // context, matching how @semantic-release/npm publishes these same packages
  // on the ordinary path.
  log(`publishing ${name}@${version} from ${pkgRoot}`)
  const { stdout, stderr } = await run(npmBin, ["publish", pkgRoot, "--tag", "latest"], {
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

  // Resolved before the first publish so a missing npm 11 is a refusal at the
  // top rather than a failure partway through the set.
  const npmBin = dryRun ? "npm" : resolveNpmBin(process.cwd())

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
    await publishPackage(name, version, dryRun, npmBin)
  }

  log(`converged ${version}`)
}

// Only run when invoked as a script, so tests can import the helpers without
// triggering a registry read or a publish.
if (process.argv[1] && process.argv[1].endsWith("converge-release.ts")) {
  await main()
}
