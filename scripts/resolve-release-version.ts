// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Decides what the npm-release workflow should do on this run, BEFORE
// semantic-release is invoked.
//
// This is the half of the atomic-release design that makes convergence
// REACHABLE. scripts/idempotent-npm-publish.mjs makes a re-run survivable
// (publishing a live version is a skip, not an E403); this script makes a
// re-run actually happen, by noticing that the newest tag names a release
// that is not finished.
//
// THE GAP THIS CLOSES
//
// semantic-release derives the next version from GIT TAGS ONLY — see
// semantic-release@25's lib/get-last-release.js, which reads branch.tags and
// never contacts a registry. So after a run that pushed tag v2.2.1 and then
// died partway through publishing, a re-run sees:
//
//     Found git tag v2.2.1 associated with version 2.2.1 on branch main
//     Found 0 commits since last release
//     Analysis of 0 commits complete: no release
//     There are no relevant changes, so no new version is released.
//
// The tag says 2.2.1 shipped. The registry says two thirds of it did not.
// semantic-release cannot see the disagreement because it only reads one of
// the two sources. Forcing a release does not help either: a forced release
// changes which COMMITS count as releasable, and there are no commits in the
// window to reclassify. Nothing in the tool's own lifecycle can finish the
// job, because the job it would compute is a different version.
//
// This script reconciles the two sources of truth and emits a decision:
//
//   converge  the newest tag's version is NOT fully published. The release
//             to run is that tag's version — not a new one. The workflow
//             checks the tag out and lets the idempotent publish plugin fill
//             in only the missing packages. Nothing is republished, no
//             version is burned, and the lockstep invariant ("all three
//             share a version") ends up TRUE rather than abandoned.
//
//   release   the newest tag is fully published (or there is no tag). This
//             is an ordinary release; semantic-release computes the next
//             version from commits exactly as before. This script gets out
//             of the way.
//
// WHY CONVERGE RATHER THAN BUMP
//
// Bumping all three to a fresh 2.2.2 needs no new mechanism, and that is its
// only advantage. It republishes connector-protocol with content identical
// to the live 2.2.1 purely to paper over a failed run; it permanently
// strands 2.2.1 as a version that exists for one package and can never exist
// for the other two, so the lockstep invariant becomes a claim the registry
// visibly contradicts; and it fixes nothing, because the next partial
// failure burns another version. Converging republishes nothing and leaves
// the invariant true.
//
// WHY THIS IS A PRE-FLIGHT AND NOT A PLUGIN
//
// The decision has to be made before semantic-release starts, because it
// determines which COMMIT gets checked out and released. A plugin runs
// inside a lifecycle that has already resolved a version from the wrong
// source. Reconciling first, then handing semantic-release a checkout where
// its own tag-based resolution produces the right answer, keeps the fix on
// the outside of the tool rather than fighting its internals.
//
// SAFETY: an UNKNOWN registry answer aborts. A registry outage must not be
// able to make a COMPLETE release look partial and pull the pipeline into
// re-releasing something that already shipped.

import { execFile } from "node:child_process"
import { appendFileSync } from "node:fs"
import { promisify } from "node:util"
import { lockstepRegistryState, LOCKSTEP_PACKAGES } from "./release-registry-state.js"

const run = promisify(execFile)

const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/

function fail(message: string): never {
  process.stderr.write(`[resolve-release-version] ${message}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`[resolve-release-version] ${message}\n`)
}

export function versionFromTag(tag: string): string | null {
  const match = TAG_PATTERN.exec(tag.trim())
  return match ? (match[1] as string) : null
}

// Sorts release tags by semantic version, newest first. `git tag --sort` uses
// `-v:refname`, which orders 2.10.0 above 2.9.0 correctly — plain lexical
// sorting does not.
export async function newestReleaseTag(cwd: string): Promise<string | null> {
  const { stdout } = await run("git", ["tag", "--list", "v*", "--sort=-v:refname", "--merged", "HEAD"], { cwd })
  for (const line of stdout.split("\n")) {
    const tag = line.trim()
    if (tag && versionFromTag(tag)) return tag
  }
  return null
}

export type Decision =
  | { mode: "release"; reason: string }
  | { mode: "converge"; tag: string; version: string; missing: readonly string[]; reason: string }

export async function decide(cwd: string): Promise<Decision> {
  const tag = await newestReleaseTag(cwd)
  if (!tag) {
    return { mode: "release", reason: "no release tag exists yet; nothing to converge on" }
  }

  const version = versionFromTag(tag)
  if (!version) {
    // newestReleaseTag only returns tags that parse, so this is unreachable;
    // kept as an explicit refusal rather than a non-null assertion.
    fail(`newest release tag ${tag} is not of the form vX.Y.Z`)
  }

  // Throws RegistryUnknownError if any read is unanswerable — see the SAFETY
  // note in this file's header.
  const state = await lockstepRegistryState(version)

  if (state.missing.length === 0) {
    return {
      mode: "release",
      reason: `newest tag ${tag} is fully published (${LOCKSTEP_PACKAGES.length}/${LOCKSTEP_PACKAGES.length} packages live at ${version})`,
    }
  }

  // A tag whose version has NONE of the three packages published is not a
  // partial release — it is a tag that was pushed and then everything failed,
  // or a tag from before these packages were published from this repo at all.
  // Converging on it would mean publishing a version from a commit that never
  // got past its first publish. That is a real release, so route it back to
  // the ordinary path rather than the convergence path.
  if (state.published.length === 0) {
    return {
      mode: "release",
      reason:
        `newest tag ${tag} has no published packages at ${version} — that is not a partially-completed ` +
        `release, so this runs as an ordinary release`,
    }
  }

  return {
    mode: "converge",
    tag,
    version,
    missing: state.missing,
    reason:
      `newest tag ${tag} is a partially-completed release: ` +
      `${state.published.join(", ")} live at ${version}, missing ${state.missing.join(", ")}`,
  }
}

function emit(outputs: Record<string, string>): void {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    for (const line of lines) process.stdout.write(`${line}\n`)
    return
  }
  appendFileSync(outputPath, `${lines.join("\n")}\n`)
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const decision = await decide(cwd)

  log(decision.reason)

  if (decision.mode === "converge") {
    log(`converging on ${decision.tag}; publishing only: ${decision.missing.join(", ")}`)
    emit({
      mode: "converge",
      "converge-tag": decision.tag,
      "converge-version": decision.version,
      "converge-missing": decision.missing.join(","),
    })
    return
  }

  emit({ mode: "release", "converge-tag": "", "converge-version": "", "converge-missing": "" })
}

// Only run when invoked as a script, so the exported helpers can be imported
// by tests without triggering a registry read.
if (process.argv[1] && process.argv[1].endsWith("resolve-release-version.ts")) {
  await main()
}
