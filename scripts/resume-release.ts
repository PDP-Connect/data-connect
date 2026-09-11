// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Finishes a lockstep npm release that a previous run left half-published.
//
// WHY THIS EXISTS. semantic-release pushes the git tag BEFORE it publishes
// anything (semantic-release@25's index.js: tag and push at lines 208-210,
// plugins.publish at 215). A publish failure therefore leaves a durable tag
// and a partially-published set. That is exactly what happened to v2.2.1:
// the run tagged, published @pdpp/connector-protocol, then aborted in the
// publish-ordering barrier, leaving @pdpp/collector-runtime and
// @pdpp/local-collector unpublished at a version the tag already claims.
//
// None of the three existing paths can finish such a release:
//
//   - An ordinary re-run reads git tags, not the registry, to pick a
//     version. It finds v2.2.1 with 0 commits after it and resolves no
//     release at all.
//   - A forced release only swaps the commit-analyzer's releaseRules. It
//     changes WHICH commits count as releasable; it cannot manufacture a
//     commit. With an empty window there is nothing to match.
//   - Re-running at the same version dies on the first package.
//     @semantic-release/npm's publish.js calls `npm publish`
//     unconditionally — it has no already-published check — and npm rejects
//     republishing a live version with E403. It would never reach the two
//     missing packages.
//
// So this script publishes ONLY the missing packages, at the version the tag
// already committed to, through the same OIDC trusted publishing and in
// .releaserc.yaml's order. The alternative — bumping all three to a fresh
// patch — would republish connector-protocol byte-identically just to paper
// over a failed run, and would permanently strand 2.2.1 as a version the
// three packages demonstrably do NOT share, breaking the lockstep invariant
// rather than restoring it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not create a tag and does not
// create a GitHub release. The failed run already did both; doing them again
// would either fail or clobber real history.
//
// IT REFUSES RATHER THAN GUESSES. Every ambiguous state is an exit 1, never
// a best guess:
//
//   - nothing missing        -> refuse. A silent no-op "success" would let a
//                               dispatch report that it finished a release it
//                               did nothing to.
//   - nothing published      -> refuse. That is not a partial release; it is
//                               an unstarted one, and the ordinary (or
//                               forced) release path owns it. Publishing all
//                               three from here would bypass the release
//                               pipeline entirely.
//   - ref is not main        -> refuse. Same single-release-branch rule as
//                               .releaserc.yaml.
//   - registry error != 404  -> refuse. This is the important one. A 404 is
//                               the registry ANSWERING "not published". A
//                               500, a timeout, or an auth failure is the
//                               registry declining to answer, and "I could
//                               not tell" must never be read as "not
//                               published" — that reading would republish a
//                               live version, or skip a missing one.

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { load } from "js-yaml"
import { isMainModule } from "./is-main-module.js"
import { normalizeViewedVersion } from "./npm-propagation-retry.ts"

const run = promisify(execFile)

export class ResumeRefusal extends Error {}

/**
 * Publish order, read from .releaserc.yaml rather than duplicated here, so a
 * resume can never publish in a different order than a normal release. The
 * order matters: collector-runtime and local-collector both resolve against
 * connector-protocol.
 */
export function readPublishOrder(releasercPath: string): string[] {
  const doc = load(readFileSync(releasercPath, "utf8")) as {
    plugins?: unknown[]
  }
  const roots: string[] = []
  for (const plugin of doc.plugins ?? []) {
    if (!Array.isArray(plugin)) continue
    const [name, config] = plugin as [unknown, { pkgRoot?: string } | undefined]
    if (name === "@semantic-release/npm" && config?.pkgRoot) {
      roots.push(config.pkgRoot)
    }
  }
  if (roots.length === 0) {
    throw new ResumeRefusal(
      `No @semantic-release/npm pkgRoot entries found in ${releasercPath} — refusing to guess a publish order.`
    )
  }
  return roots
}

export function packageNameFor(pkgRoot: string, repoRoot: string): string {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, pkgRoot, "package.json"), "utf8")
  ) as { name?: string }
  if (!manifest.name) {
    throw new ResumeRefusal(`${pkgRoot}/package.json has no "name" — refusing to guess.`)
  }
  return manifest.name
}

/**
 * The version to resume at comes from the tag the failed run already pushed,
 * never from a package.json (those hold placeholders) and never from the
 * registry (which is the thing being repaired).
 */
export function versionFromTag(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
  if (!match) {
    throw new ResumeRefusal(
      `Tag "${tag}" is not of the form vX.Y.Z (.releaserc.yaml tagFormat) — refusing to guess a version.`
    )
  }
  return match[1] as string
}

export function assertReleaseRef(ref: string | undefined): void {
  if (!ref) {
    throw new ResumeRefusal(
      "No ref supplied (GITHUB_REF) — refusing to resume a release without knowing what it is resuming on."
    )
  }
  if (ref !== "refs/heads/main") {
    throw new ResumeRefusal(
      `Resume is only allowed on refs/heads/main (.releaserc.yaml's single release branch); got "${ref}".`
    )
  }
}

export type RegistryState = "published" | "missing"

/**
 * A 404 is the registry answering "this version does not exist". Anything
 * else is the registry failing to answer, and is escalated rather than
 * interpreted.
 */
export async function registryStateFor(
  name: string,
  version: string,
  viewVersion: (spec: string) => Promise<unknown>
): Promise<RegistryState> {
  const spec = `${name}@${version}`
  try {
    const resolved = normalizeViewedVersion(await viewVersion(spec))
    if (resolved !== version) {
      throw new ResumeRefusal(
        `${spec} resolved version "${String(resolved)}" instead of "${version}" — refusing to guess what is published.`
      )
    }
    return "published"
  } catch (error) {
    if (error instanceof ResumeRefusal) throw error
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes("E404")) return "missing"
    throw new ResumeRefusal(
      `Could not determine whether ${spec} is published: ${detail}\n` +
        `Refusing to continue — "I could not tell" is not "not published".`
    )
  }
}

export interface ResumePlan {
  version: string
  published: string[]
  missing: string[]
}

/**
 * Turns observed registry state into a plan, or refuses. Split out from all
 * I/O so every refusal is directly testable.
 */
export function planResume(
  version: string,
  states: { name: string; state: RegistryState }[]
): ResumePlan {
  const published = states.filter(s => s.state === "published").map(s => s.name)
  const missing = states.filter(s => s.state === "missing").map(s => s.name)

  if (missing.length === 0) {
    throw new ResumeRefusal(
      `All packages are already published at ${version} — there is nothing to resume. ` +
        `Refusing rather than reporting a no-op as a successful release.`
    )
  }
  if (published.length === 0) {
    throw new ResumeRefusal(
      `No package is published at ${version} — this is not a partially-completed release, ` +
        `so there is nothing to resume. Run an ordinary release instead.`
    )
  }
  return { version, published, missing }
}

export interface PublishDeps {
  npm: (args: string[], cwd: string) => Promise<void>
  log: (message: string) => void
}

/**
 * `npm version --no-git-tag-version` writes the resumed version into the
 * package.json before packing, the same thing @semantic-release/npm does in
 * a normal run (the committed version fields are placeholders). It is a
 * WRITE, so the dry-run guard in main() must return before this is ever
 * called — a dry run that edits tracked files is not a dry run.
 */
export async function publishPackage(
  pkgRoot: string,
  version: string,
  repoRoot: string,
  deps: PublishDeps
): Promise<void> {
  const cwd = resolve(repoRoot, pkgRoot)
  deps.log(`setting ${pkgRoot} version to ${version}`)
  await deps.npm(["version", version, "--no-git-tag-version", "--allow-same-version"], cwd)
  deps.log(`publishing ${pkgRoot}@${version}`)
  await deps.npm(["publish"], cwd)
}

function log(message: string): void {
  process.stdout.write(`[resume-release] ${message}\n`)
}

async function npmViewVersion(spec: string): Promise<unknown> {
  const { stdout } = await run("npm", ["view", spec, "version", "--json"])
  return JSON.parse(stdout.trim())
}

async function npm(args: string[], cwd: string): Promise<void> {
  await run("npm", args, { cwd })
}

async function currentTag(repoRoot: string): Promise<string> {
  const { stdout } = await run("git", ["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: repoRoot,
  })
  return stdout.trim()
}

export async function main(repoRoot: string): Promise<void> {
  assertReleaseRef(process.env.GITHUB_REF)

  const tag = process.env.RESUME_RELEASE_TAG?.trim() || (await currentTag(repoRoot))
  const version = versionFromTag(tag)

  const order = readPublishOrder(resolve(repoRoot, ".releaserc.yaml"))
  const packages = order.map(pkgRoot => ({
    pkgRoot,
    name: packageNameFor(pkgRoot, repoRoot),
  }))

  const states: { name: string; state: RegistryState }[] = []
  for (const pkg of packages) {
    states.push({
      name: pkg.name,
      state: await registryStateFor(pkg.name, version, npmViewVersion),
    })
  }

  const plan = planResume(version, states)

  log("Resuming partially-completed lockstep release")
  log(`  version:    ${plan.version}`)
  log(`  already:    ${plan.published.join(", ")}`)
  log(`  to publish: ${plan.missing.join(", ")}`)

  // Before any write. A dry run that mutates package.json is not a dry run —
  // an earlier revision of this script ran `npm version` first and edited two
  // manifests (and silently rewrote a non-ASCII character in one description)
  // during what was supposed to be an inert check.
  if (process.env.RESUME_RELEASE_DRY_RUN === "true") {
    log("RESUME_RELEASE_DRY_RUN=true — not publishing")
    return
  }

  for (const pkg of packages) {
    if (!plan.missing.includes(pkg.name)) {
      log(`skipping ${pkg.name} — already published at ${version}`)
      continue
    }
    await publishPackage(pkg.pkgRoot, version, repoRoot, { npm, log })
  }

  log(`resume complete: published ${plan.missing.join(", ")} at ${version}`)
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await main(process.cwd())
  } catch (error) {
    process.stderr.write(
      `[resume-release] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  }
}
