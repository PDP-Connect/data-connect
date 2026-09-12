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
//   2. The SIBLING BUILDS. On the ordinary path, each package's own prepack
//      builds it during its own `npm publish`, and the three publish in
//      dependency order — so by the time collector-runtime packs,
//      connector-protocol's `dist/` exists as a side effect of the publish
//      that preceded it. A converge publishes a SUBSET: the live siblings are
//      skipped, so their builds never happen, and the dependent's prepack then
//      fails on the missing `dist/`. Reproduced at v2.2.1: `npm publish
//      packages/collector-runtime` in the tagged checkout dies with five
//      TS2307 "Cannot find module '@pdpp/connector-protocol'" before packing.
//      Reproduced by buildLiveSiblings below. See its own note for why this is
//      not just "run the workspace build for everything".
//
//   3. The DEPENDENCY PIN: pin-collector-runtime-protocol-dependency.ts
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
//
// WHY THE TOOLING ROOT AND THE PACKAGE SOURCE ARE TWO DIFFERENT PLACES
//
// A converge runs CURRENT tooling against a HISTORICAL tree, and those two
// requirements point at different commits:
//
//   - The package source must be the tag's, exactly. That is the tree the tag
//     committed to and the only one whose tarballs may carry that version.
//   - The driver must be the current one. This script did not exist at
//     v2.2.1 — `scripts/` at 07173d030 has no converge-release.ts at all, so
//     running it from the tag's checkout runs no driver, not a stale one.
//
//     The PUBLISHING NPM is a separate matter, and the reason is NOT that the
//     tag's toolchain is too old. It is not: `git show
//     07173d030:package-lock.json` pins node_modules/npm at 11.19.0, and after
//     `npm ci` at the tag `node_modules/.bin/npm --version` prints 11.19.0,
//     with tsx and tsc present (verified by execution). The npm is resolved
//     from the tooling root anyway, because the converge must not depend on
//     what an arbitrary historical lockfile happens to pin. Any tag old enough
//     to need converging predates the requirement it is being converged under,
//     and a tag whose lockfile pinned npm 10 (or no npm) would fail deep
//     inside an OIDC publish. Taking the npm from the tooling root makes the
//     publishing toolchain a property of the current pipeline rather than of
//     the tree being republished.
//
// Resolving both from one `process.cwd()` cannot satisfy both. Checking out
// the tag and running `scripts/converge-release.ts` from it fails with MODULE
// NOT FOUND — no driver in that tree. The inverse — running from the current
// checkout so the driver exists — publishes main's package source under the
// tag's version, which is the immutability violation the tag checkout was
// added to prevent.
//
// So the two are separate inputs, each named explicitly:
//
//   TOOLING ROOT   this file's own repository root. Supplies the driver, its
//                  resolved dependencies, and the npm that can authenticate.
//                  Derived from import.meta.url, so it is wherever this
//                  script actually lives — never assumed to be cwd.
//   PACKAGE SOURCE CONVERGE_PACKAGE_SOURCE: the checkout of the tag. Supplies
//                  packages/*, and every manifest edit and `npm publish`
//                  target is resolved beneath it.
//
// Neither is allowed to default to the other. Silently falling back would
// reintroduce exactly one of the two failures above, and npm immutability
// means the second one cannot be undone.

import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  LOCKSTEP_PACKAGES,
  lockstepRegistryState,
  type LockstepPackage,
} from "./release-registry-state.js"

const run = promisify(execFile)

// pkgRoot per package, RELATIVE TO THE PACKAGE SOURCE, mirroring
// .releaserc.yaml's @semantic-release/npm entries. Publish order is this
// array's order.
const PACKAGE_ROOTS: Record<LockstepPackage, string> = {
  "@pdpp/connector-protocol": "packages/connector-protocol",
  "@pdpp/collector-runtime": "packages/collector-runtime",
  "@pdpp/local-collector": "packages/local-collector",
}

// The repository this script was loaded from — scripts/ is one level under
// the root. Deliberately derived from the module's own location rather than
// cwd: the whole point of the split is that the driver runs from somewhere
// other than the tree it operates on, so cwd is not evidence of where the
// tooling is.
export const TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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

function writeManifestVersion(packageSource: string, pkgRoot: string, version: string): void {
  const manifestPath = resolve(packageSource, pkgRoot, "package.json")
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
function pinSiblingDependency(
  packageSource: string,
  name: LockstepPackage,
  pkgRoot: string,
  version: string
): void {
  if (name !== PINNED_DEPENDENT) return

  const manifestPath = resolve(packageSource, pkgRoot, "package.json")
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
// Takes the TOOLING root, not the package source — and deliberately NOT
// because the tag's install lacks an npm 11. At v2.2.1 it has one (11.19.0,
// pinned by that tag's own lockfile and verified present after `npm ci`
// there). The reason is that this must hold for every tag a converge can ever
// be pointed at, and a converge is by definition aimed at a historical tree
// whose lockfile was written before the requirement existed. Resolving the
// publishing npm from the tooling root makes the toolchain a property of the
// current pipeline instead of a coincidence of the tree being republished.
//
// Refuses rather than silently falling back: a converge that quietly used the
// wrong npm would fail deep inside a publish with an opaque auth error, and
// the whole point of this path is that it either finishes the release or says
// clearly why it cannot.
export function resolveNpmBin(toolingRoot: string): string {
  const local = resolve(toolingRoot, "node_modules/.bin/npm")
  if (existsSync(local)) return local
  fail(
    `node_modules/.bin/npm is not present under the release tooling root ${toolingRoot} — refusing ` +
      `to publish with the ambient npm, which cannot authenticate via OIDC trusted publishing (that ` +
      `needs npm >= 11.5.1; runners ship npm 10). Run \`npm ci\` in the tooling checkout before converging.`
  )
}

// The tag's checkout, supplied explicitly. Verified to be a real tree holding
// all three package roots BEFORE any registry read, so a misconfigured
// checkout is a refusal at the top rather than an ENOENT discovered partway
// through a publish set — by which point earlier packages are already live
// and immutable.
//
// There is deliberately NO default. Falling back to cwd is the failure this
// separation exists to prevent: it would publish whatever tree the driver
// happens to be sitting in under the tag's version.
export function resolvePackageSource(raw: string | undefined): string {
  if (!raw || !raw.trim()) {
    fail(
      "CONVERGE_PACKAGE_SOURCE is not set — the converge path requires an explicit checkout of the " +
        "tag to publish from, and will not fall back to the tooling checkout's own package source."
    )
  }
  const root = resolve(raw.trim())
  for (const pkgRoot of Object.values(PACKAGE_ROOTS)) {
    const manifest = resolve(root, pkgRoot, "package.json")
    if (!existsSync(manifest)) {
      fail(
        `CONVERGE_PACKAGE_SOURCE ${root} is not a checkout of this repository — expected a manifest ` +
          `at ${pkgRoot}/package.json and found none.`
      )
    }
  }
  return root
}

// The lockstep siblings a package declares a dependency on, in any dependency
// field. Read from the TAG's manifest rather than hardcoded, because the edges
// are a property of the tree being converged: at v2.2.1 collector-runtime
// depends on connector-protocol (`dependencies`) and local-collector on both
// (`devDependencies`), and a tag five releases from now may differ.
export function siblingDependencies(raw: string, self: LockstepPackage): LockstepPackage[] {
  const manifest = JSON.parse(raw) as Record<string, unknown>
  const declared = new Set<string>()
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest[field]
    if (block && typeof block === "object") {
      for (const dependency of Object.keys(block as Record<string, unknown>)) declared.add(dependency)
    }
  }
  return LOCKSTEP_PACKAGES.filter((sibling) => sibling !== self && declared.has(sibling))
}

// Builds the siblings a package needs at pack time that NOTHING ELSE IN THIS
// RUN WILL BUILD.
//
// `npm publish <dir>` runs that package's prepack, which is `npm run build`
// for all three of these packages, and the build typechecks against its
// siblings' BUILT `dist/` (their manifests' exports resolve to ./dist/*.d.ts;
// there is no `paths` mapping back to source). On the ordinary path those
// dist/ directories appear as a side effect of publish order: all three
// publish, in dependency order, and each one's own prepack builds it before
// the next one packs.
//
// A converge publishes a SUBSET. The live siblings are skipped by design —
// npm versions are immutable and their content is already correct — so their
// prepacks never run and their dist/ never appears. The dependent then fails
// in its own prepack, before packing. That is the v2.2.1 state exactly:
// connector-protocol@2.2.1 live, so skipped, so unbuilt, so
// collector-runtime's prepack dies on TS2307.
//
// Only the SKIPPED siblings are built here. A sibling that is itself in the
// publish set is left alone: it publishes earlier in LOCKSTEP_PACKAGES order,
// its own prepack builds it, and pre-building it here would also mean building
// it before its manifest edits, which is the ordering the ordinary path does
// not have either.
//
// The build runs the sibling's OWN TAG-COMMITTED `build` script, through the
// tag's own install, by shelling out to `npm run build --workspace <root>`
// with the package source as cwd. Not a reimplementation of the build, and not
// current main's build script: the tarball must be what that tree's build
// produces. The npm BINARY is still the tooling root's, for the same reason
// the publish uses it.
async function buildLiveSiblings(
  packageSource: string,
  name: LockstepPackage,
  missing: readonly LockstepPackage[],
  dryRun: boolean,
  npmBin: string
): Promise<void> {
  const manifestPath = resolve(packageSource, PACKAGE_ROOTS[name], "package.json")
  const siblings = siblingDependencies(readFileSync(manifestPath, "utf8"), name).filter(
    (sibling) => !missing.includes(sibling)
  )

  for (const sibling of siblings) {
    const siblingRoot = PACKAGE_ROOTS[sibling]
    log(`building already-live ${sibling} in the tagged checkout — ${name}'s prepack typechecks against its dist/`)
    const { stderr } = await run(npmBin, ["run", "build", "--workspace", siblingRoot], {
      cwd: packageSource,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (stderr.trim()) process.stderr.write(stderr)
    // Asserted, not assumed. A `build` script that silently produced nothing
    // would otherwise surface as the same TS2307 this step exists to prevent,
    // one layer further in.
    const dist = resolve(packageSource, siblingRoot, "dist")
    if (!existsSync(dist)) {
      fail(`built ${sibling} but ${dist} does not exist — ${name}'s prepack cannot resolve it`)
    }
    if (dryRun) log(`[dry-run] built ${sibling} at ${dist}`)
  }
}

async function publishPackage(
  packageSource: string,
  name: LockstepPackage,
  version: string,
  missing: readonly LockstepPackage[],
  dryRun: boolean,
  npmBin: string
): Promise<void> {
  const pkgRoot = PACKAGE_ROOTS[name]
  const absolutePkgRoot = resolve(packageSource, pkgRoot)

  // Before the manifest edits and before the pack, on BOTH paths. On the dry
  // run this is the part most worth exercising: it is a real build in the real
  // tagged tree, it writes only inside that ephemeral checkout, and it is the
  // step whose absence made this job unrunnable.
  await buildLiveSiblings(packageSource, name, missing, dryRun, npmBin)

  // Both prepare-pipeline edits, applied before the tarball is built. Order
  // does not matter (they touch different fields), but both must precede
  // `npm publish`, which runs prepack and packs from the tree as it is then.
  //
  // Applied on the DRY-RUN path too. They are writes, but every one of them
  // lands inside the ephemeral package-source checkout that the caller owns
  // and throws away, and they are prerequisites of the pack: `npm publish
  // --dry-run` still refuses a version that is already live, so a dry run that
  // skipped the version rewrite would stop at "cannot publish over 0.0.1"
  // instead of packing. Verified by execution — that is exactly what the
  // unrewritten tree does.
  writeManifestVersion(packageSource, pkgRoot, version)
  pinSiblingDependency(packageSource, name, pkgRoot, version)

  // `npm publish` runs the package's own prepack (which builds it) and, with
  // OIDC trusted publishing configured on the workflow, attaches provenance.
  // --provenance is not passed explicitly: npm infers it from the OIDC
  // context, matching how @semantic-release/npm publishes these same packages
  // on the ordinary path.
  // cwd is the PACKAGE SOURCE, not the tooling root: `npm publish <dir>` runs
  // that package's prepack, which builds it, and the build has to resolve the
  // tag's own installed dependencies and workspace links. The npm BINARY still
  // comes from the tooling root — an npm 11 driving a build in the tag's tree.
  //
  // ONE COMMAND, TWO MODES. The dry run appends `--dry-run` and changes
  // nothing else. It is deliberately not a `return` before the command, which
  // is what the first version of this did: that left the whole build-and-pack
  // path unexercised, and the release was unrunnable because of a prepack
  // failure a dry run that reached prepack would have caught immediately. npm
  // resolves --dry-run inside its own publish implementation, after prepack and
  // after packing, and performs no registry write — so this executes everything
  // up to the write and nothing past it.
  const args = ["publish", absolutePkgRoot, "--tag", "latest", ...(dryRun ? ["--dry-run"] : [])]
  log(`${dryRun ? "[dry-run] publishing" : "publishing"} ${name}@${version} from ${absolutePkgRoot}`)
  const { stdout, stderr } = await run(npmBin, args, {
    cwd: packageSource,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (stdout.trim()) process.stdout.write(stdout)
  if (stderr.trim()) process.stderr.write(stderr)
  // The dry-run marker stays distinct from the real one: the rehearsal asserts
  // no `published` line appears, and that assertion is only worth anything if
  // a dry run cannot emit it.
  log(`${dryRun ? "[dry-run] packed" : "published"} ${name}@${version}`)
}

async function main(): Promise<void> {
  assertReleaseRef(process.env.GITHUB_REF)

  const dryRun = process.env.CONVERGE_RELEASE_DRY_RUN === "true"

  // Resolved before the registry is touched: a bad package source is a
  // configuration error, and configuration errors must surface before the run
  // has done anything a later failure would leave half-done.
  const packageSource = resolvePackageSource(process.env.CONVERGE_PACKAGE_SOURCE)

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
  //
  // Resolved on the DRY-RUN path too. A dry run exists to rehearse this exact
  // integration, and the publishing npm living in a different checkout from
  // the package source is the part most likely to be misconfigured. A rehearsal
  // that skipped the lookup would go green on a tooling checkout that has no
  // npm 11 in it at all — which is precisely the arrangement whose absence the
  // rehearsal is supposed to detect.
  const npmBin = resolveNpmBin(TOOLING_ROOT)

  log(`converging lockstep release ${version} (tag ${tag})`)
  log(`  release tooling: ${TOOLING_ROOT}`)
  log(`  package source:  ${packageSource}`)
  log(`  already live: ${state.published.join(", ")}`)
  log(`  to publish:   ${state.missing.join(", ")}`)

  // Publish in .releaserc.yaml order, not registry-response order, so the
  // dependency edges between the three packages are respected.
  for (const name of LOCKSTEP_PACKAGES) {
    if (!state.missing.includes(name)) {
      log(`skipping ${name} — already live at ${version}`)
      continue
    }
    await publishPackage(packageSource, name, version, state.missing, dryRun, npmBin)
  }

  log(`converged ${version}`)
}

// Only run when invoked as a script, so tests can import the helpers without
// triggering a registry read or a publish.
if (process.argv[1] && process.argv[1].endsWith("converge-release.ts")) {
  await main()
}
