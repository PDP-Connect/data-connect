#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SNAPSHOT_DIR = join(ROOT, "reference-implementation", "test", "fixtures", "shipped-manifests")
const CONNECTORS_DIR = join(SNAPSHOT_DIR, "connectors")
const PROVENANCE_PATH = join(SNAPSHOT_DIR, "provenance.json")
const REMOTE = process.env.DATA_CONNECTORS_REMOTE ?? "https://github.com/PDP-Connect/data-connectors.git"
const SHA_PATTERN = /^[0-9a-f]{40}$/

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "inherit"] })
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function assertFullManifest(sourcePath, bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"))
  if (typeof manifest.source?.id !== "string" || !Array.isArray(manifest.streams) || !manifest.runtime_requirements) {
    throw new Error(`${sourcePath} is missing source.id, streams, or runtime_requirements`)
  }
  if (!manifest.streams.every((stream) => stream.schema && typeof stream.schema === "object")) {
    throw new Error(`${sourcePath} has a stream without its full schema`)
  }
}

function sourceRepository(commit) {
  const localRepo = process.env.DATA_CONNECTORS_REPO
  if (localRepo) return { cwd: localRepo, cleanup: () => {} }

  const scratchBase = process.env.RUNNER_TEMP ?? join(homedir(), ".tmp")
  mkdirSync(scratchBase, { recursive: true })
  const scratch = mkdtempSync(join(scratchBase, "dc-shipped-manifests-"))
  try {
    execFileSync("git", ["init", "--quiet", scratch])
    execFileSync("git", ["-C", scratch, "fetch", "--quiet", "--depth=1", REMOTE, commit])
    return { cwd: scratch, cleanup: () => rmSync(scratch, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}

function sourceManifestPaths(repo, commit) {
  return git(["ls-tree", "-r", "--name-only", commit, "connectors"], repo)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((path) => /^connectors\/[^/]+\/manifest\.json$/.test(path))
    .sort()
}

function snapshotDigests() {
  const digests = {}
  for (const connector of readdirSync(CONNECTORS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const path = join(CONNECTORS_DIR, connector.name, "manifest.json")
    const relativePath = relative(SNAPSHOT_DIR, path).split("\\").join("/")
    digests[relativePath] = sha256(readFileSync(path))
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)))
}

function checkSnapshot() {
  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"))
  if (!SHA_PATTERN.test(provenance.commit ?? "")) throw new Error("provenance commit must be a full 40-character SHA")
  const actual = snapshotDigests()
  const expected = provenance.files
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = Object.keys(expected ?? {}).filter((path) => !(path in actual))
    const unexpected = Object.keys(actual).filter((path) => !(path in (expected ?? {})))
    const changed = Object.keys(expected ?? {}).filter((path) => actual[path] && actual[path] !== expected[path])
    throw new Error(
      `snapshot does not match provenance: ${[
        ...missing.map((path) => `missing ${path}`),
        ...unexpected.map((path) => `unexpected ${path}`),
        ...changed.map((path) => `sha256 mismatch ${path}`),
      ].join(", ")}`
    )
  }

  const main = execFileSync("git", ["ls-remote", REMOTE, "refs/heads/main"], { encoding: "utf8" }).trim().split(/\s+/)[0]
  if (main && main !== provenance.commit) {
    console.warn(
      `[shipped-manifests] snapshot pin ${provenance.commit} differs from data-connectors main ${main}; informational only. Regenerate with --commit <sha> when ready.`
    )
  }
  console.log(`[shipped-manifests] ${Object.keys(actual).length} manifests match provenance at ${provenance.commit}`)
}

function syncSnapshot(commit) {
  if (!SHA_PATTERN.test(commit ?? "")) throw new Error("usage: sync-shipped-manifests.mjs --commit <full-40-character-sha>")
  const source = sourceRepository(commit)
  try {
    const paths = sourceManifestPaths(source.cwd, commit)
    if (paths.length === 0) throw new Error(`no connectors/*/manifest.json files found at ${commit}`)
    rmSync(CONNECTORS_DIR, { recursive: true, force: true })
    mkdirSync(CONNECTORS_DIR, { recursive: true })
    const files = {}
    for (const sourcePath of paths) {
      const bytes = git(["show", `${commit}:${sourcePath}`], source.cwd)
      assertFullManifest(sourcePath, bytes)
      const targetPath = join(SNAPSHOT_DIR, sourcePath)
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, bytes)
      files[relative(SNAPSHOT_DIR, targetPath).split("\\").join("/")] = sha256(bytes)
    }
    writeFileSync(
      PROVENANCE_PATH,
      `${JSON.stringify({ repository: "PDP-Connect/data-connectors", commit, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`
    )
    checkSnapshot()
  } finally {
    source.cleanup()
  }
}

const commitIndex = process.argv.indexOf("--commit")
if (commitIndex !== -1) syncSnapshot(process.argv[commitIndex + 1])
else if (process.argv.length === 2 || process.argv[2] === "--check") checkSnapshot()
else throw new Error("usage: sync-shipped-manifests.mjs [--check | --commit <sha>]")
