// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reports what the registry holds for the newest release tag, BEFORE
// semantic-release is invoked.
//
// THE POLICY THIS IMPLEMENTS
//
// A release that is interrupted partway through publishing stays explicitly
// incomplete. It is not finished later from its own tag.
//
// There is no retry that finishes it. semantic-release pushes the git tag
// BEFORE it publishes, so an interrupted release leaves the tag on the commit
// it ran at. Re-running that same run resolves zero commits since the last
// release and therefore no version at all — the publish step is never
// reached. Executed against semantic-release@25.0.9 with this repo's
// commit-analyzer rules: with the tag on HEAD, "Analysis of 0 commits
// complete: no release".
//
// So the incomplete version stays incomplete, and recovery is forward only:
// the next in-scope commit on main — or any commit plus a forced dispatch —
// produces the next version, which supersedes it. The lockstep
// invariant — the three packages share whatever version a run publishes — is
// satisfied by the new version. The old one keeps whatever partial set it
// got, and the pipeline says so out loud instead of blocking.
//
// WHAT THIS SCRIPT THEREFORE DOES
//
// It always resolves to an ordinary release. semantic-release computes the
// next version from commits exactly as it always has. What this script adds
// is the REPORT: when the newest tag is partially published, the decision
// carries that tag, its version, and the packages missing from it, so the
// workflow can name the superseded version in its log rather than leaving a
// half-published release undiscovered.
//
// It runs as a pre-flight rather than a plugin because the report has to be
// available to jobs that run before and after semantic-release, not only
// inside its lifecycle.
//
// SAFETY: an UNKNOWN registry answer aborts. The pipeline must not publish
// while it cannot tell what the registry already holds.

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

// Every decision is a release. `superseded` is present only when the newest
// tag is partially published: it is the incomplete version this run's release
// supersedes, carried for reporting and never used to gate anything.
export interface Decision {
  mode: "release"
  reason: string
  superseded?: { tag: string; version: string; missing: readonly string[] }
}

export async function decide(cwd: string): Promise<Decision> {
  const tag = await newestReleaseTag(cwd)
  if (!tag) {
    return { mode: "release", reason: "no release tag exists yet; there is no prior release to report on" }
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
  // partially-completed release — it is a tag that was pushed and then
  // everything failed, or a tag from before these packages were published
  // from this repo at all. There is no partial set to report as superseded.
  if (state.published.length === 0) {
    return {
      mode: "release",
      reason:
        `newest tag ${tag} has no published packages at ${version} — nothing of it reached the registry, ` +
        `so there is no partial release to report`,
    }
  }

  // Partially published. This still runs as an ordinary release; the partial
  // version is reported, not repaired.
  return {
    mode: "release",
    reason:
      `newest tag ${tag} is incomplete on npm: ` +
      `${state.published.join(", ")} live at ${version}, missing ${state.missing.join(", ")}. ` +
      `The next successful release will supersede it.`,
    superseded: { tag, version, missing: state.missing },
  }
}

// The one line CI prints about a superseded version. `newVersion` is the
// version this run is publishing, which is what makes the sentence true.
export function supersededMessage(
  superseded: NonNullable<Decision["superseded"]>,
  newVersion: string
): string {
  const short = superseded.missing.map(name => name.replace(/^@pdpp\//, ""))
  const live = LOCKSTEP_PACKAGES.filter(name => !superseded.missing.includes(name)).map(name =>
    name.replace(/^@pdpp\//, "")
  )
  return (
    `${superseded.tag} is incomplete on npm (${live.join(", ")} only; missing ${short.join(", ")}) ` +
    `and is superseded by ${newVersion}`
  )
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

  // Emitted for reporting only. No job is gated on these: a partially
  // published prior version does not change what this run publishes.
  emit({
    mode: decision.mode,
    "superseded-tag": decision.superseded?.tag ?? "",
    "superseded-version": decision.superseded?.version ?? "",
    "superseded-missing": decision.superseded?.missing.join(",") ?? "",
  })
}

// Only run when invoked as a script, so the exported helpers can be imported
// by tests without triggering a registry read.
if (process.argv[1] && process.argv[1].endsWith("resolve-release-version.ts")) {
  await main()
}
