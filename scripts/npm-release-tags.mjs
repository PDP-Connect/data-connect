#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { compareVersions } from "./desktop-release.mjs"

// The packages the npm-v* tag namespace was bootstrapped from. Later lockstep
// packages joined after the migration and do not take part in it.
export const MIGRATION_PACKAGES = [
  "@pdpp/connector-protocol",
  "@pdpp/collector-runtime",
  "@pdpp/local-collector",
]

// Bootstrap the new namespace from registry state, never from desktop v* tags.
// Using the highest live package version also preserves forward-only recovery
// from a partially published lockstep release.
export function migrationTag(versions, reachableTags) {
  if (reachableTags.some(tag => /^npm-v\d+\.\d+\.\d+$/.test(tag))) return null
  if (versions.length !== MIGRATION_PACKAGES.length)
    throw new Error("Expected a version for every migration package")
  const latest = [...versions].sort(compareVersions).at(-1)
  if (!reachableTags.includes(`v${latest}`)) {
    throw new Error(
      `Cannot migrate npm ${latest}: reachable legacy v${latest} tag missing`
    )
  }
  return { oldTag: `v${latest}`, newTag: `npm-v${latest}` }
}

function main() {
  const run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8" }).trim()
  const tags = run("git", ["tag", "--merged", "HEAD"]).split("\n")
  if (tags.some(tag => /^npm-v\d+\.\d+\.\d+$/.test(tag))) return
  const versions = MIGRATION_PACKAGES.map(pkg =>
    JSON.parse(run("npm", ["view", `${pkg}@latest`, "version", "--json"]))
  )
  const { oldTag, newTag } = migrationTag(versions, tags)
  const sha = run("git", ["rev-parse", `${oldTag}^{commit}`])
  const remote = run("git", ["ls-remote", "origin", `refs/tags/${newTag}`])
  if (remote) {
    if (remote.split(/\s+/)[0] !== sha)
      throw new Error(`${newTag} already points to a different commit`)
  } else {
    run("gh", [
      "api",
      "--method",
      "POST",
      `repos/${process.env.GITHUB_REPOSITORY}/git/refs`,
      "-f",
      `ref=refs/tags/${newTag}`,
      "-f",
      `sha=${sha}`,
    ])
  }
  run("git", ["fetch", "origin", `refs/tags/${newTag}:refs/tags/${newTag}`])
  console.log(`Migrated npm baseline ${oldTag} to ${newTag} at ${sha}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
