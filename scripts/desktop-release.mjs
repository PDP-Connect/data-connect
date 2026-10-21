#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b))
    throw new Error("Expected stable X.Y.Z versions")
  const right = b.split(".").map(Number)
  for (const [i, n] of a.split(".").map(Number).entries()) {
    if (n !== right[i]) return n > right[i] ? 1 : -1
  }
  return 0
}

export function nextVersion(base, messages) {
  compareVersions(base, base)
  let bump = 0
  for (const message of messages) {
    const header = /^([a-z]+)(?:\([^\r\n]+\))?(!)?: .+/.exec(message)
    if (!header) continue
    // Explicit breaking markers override the ordinary non-release types.
    if (header[2] || /^BREAKING[ -]CHANGE: \S/m.test(message)) bump = 3
    else if (header[1] === "feat") bump = Math.max(bump, 2)
    else if (["fix", "perf"].includes(header[1])) bump = Math.max(bump, 1)
  }
  if (!bump) return null
  const [major, minor, patch] = base.split(".").map(Number)
  // Breaking changes use major even at 0.x: explicit, conventional SemVer.
  return bump === 3
    ? `${major + 1}.0.0`
    : bump === 2
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`
}

export function desktopBase(releases, reachableTags) {
  const candidates = releases.filter(
    r =>
      !r.draft &&
      !r.prerelease &&
      /^v\d+\.\d+\.\d+$/.test(r.tag_name) &&
      reachableTags.includes(r.tag_name) &&
      [
        /_arm64\.dmg$/,
        /_x86_64\.dmg$/,
        /\.deb$/,
        /\.AppImage$/,
        /-setup\.exe$/,
      ].every(pattern => r.assets.some(a => pattern.test(a.name)))
  )
  candidates.sort((a, b) =>
    compareVersions(b.tag_name.slice(1), a.tag_name.slice(1))
  )
  if (!candidates.length)
    throw new Error(
      "No reachable published desktop release with all five installers; inspect release history before seeding a baseline"
    )
  return candidates[0].tag_name
}

export function setBuildVersion(tag, path = "src-tauri/tauri.conf.json") {
  if (!tag.startsWith("v") || !VERSION.test(tag.slice(1)))
    throw new Error("Expected vX.Y.Z")
  const config = JSON.parse(readFileSync(path, "utf8"))
  config.version = tag.slice(1)
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

const git = args => execFileSync("git", args, { encoding: "utf8" }).trim()
const gh = args => execFileSync("gh", args, { encoding: "utf8" }).trim()

function prepare() {
  const repo = process.env.GITHUB_REPOSITORY
  const sha = git(["rev-parse", "HEAD"])
  // workflow_run can complete out of order. Only release the current main head.
  const main = JSON.parse(gh(["api", `repos/${repo}/git/ref/heads/main`]))
    .object.sha
  if (sha !== main) {
    console.log("Superseded by a newer main commit; skipping")
    return
  }
  const releases = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/releases?per_page=100`,
      "--jq",
      "[.[][] | {tag_name, draft, prerelease, assets: [.assets[] | {name}]}]",
    ])
  ).flat()
  const reachable = git(["tag", "--merged", "HEAD"]).split("\n")
  const base = desktopBase(releases, reachable)
  const messages = git(["log", "--format=%B%x00", `${base}..HEAD`])
    .split("\0")
    .map(s => s.trim())
  let version = nextVersion(base.slice(1), messages)
  if (!version) {
    console.log(`No releasable changes since ${base}`)
    return
  }
  const tags = new Set(git(["tag", "--list"]).split("\n"))
  // Legacy npm tags and abandoned drafts must never be moved or overwritten.
  while (tags.has(`v${version}`)) {
    const tagSha = git(["rev-parse", `v${version}^{commit}`])
    const existing = releases.find(r => r.tag_name === `v${version}`)
    if (tagSha === sha && (!existing || existing.draft)) break // recover tag-only reservations too
    if (tagSha === sha && existing && !existing.draft) {
      console.log("This commit is already released")
      return
    }
    version = nextVersion(version, ["fix: reserve the next unused version"])
  }
  const tag = `v${version}`
  if (!tags.has(tag)) {
    gh([
      "api",
      "--method",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${sha}`,
    ])
  }
  if (!releases.some(r => r.tag_name === tag)) {
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--verify-tag",
      "--draft",
      "--title",
      `DataConnect ${tag}`,
      "--generate-notes",
      "--notes-start-tag",
      base,
    ])
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nsha=${sha}\n`)
  console.log(`Release ${tag} from ${sha}; desktop baseline ${base}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "set-version") setBuildVersion(process.argv[3])
  else if (process.argv[2] === "prepare") prepare()
  else
    throw new Error("Usage: desktop-release.mjs prepare | set-version vX.Y.Z")
}
