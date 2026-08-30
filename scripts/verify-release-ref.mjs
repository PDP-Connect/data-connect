#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isMainModule } from "./is-main-module.js"

function fail(message) {
  throw new Error(message)
}

export function assertReleaseIdentity({
  configVersion,
  headSha,
  releaseTag,
  tagSha,
}) {
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
    fail(`Release tag must have form vX.Y.Z: ${releaseTag}`)
  }
  if (headSha !== tagSha) {
    fail(
      `Checked-out commit ${headSha} does not match ${releaseTag} commit ${tagSha}`
    )
  }
  if (configVersion !== releaseTag.slice(1)) {
    fail(
      `tauri.conf.json version ${configVersion} does not match ${releaseTag}`
    )
  }
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--release-tag" || !argv[1]) {
    fail("Usage: --release-tag <vX.Y.Z>")
  }
  const releaseTag = argv[1]
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
  assertReleaseIdentity({
    configVersion: config.version,
    headSha: git(["rev-parse", "HEAD^{commit}"]),
    releaseTag,
    tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
  })
  console.log(`[verify-release-ref] ${releaseTag} matches HEAD and app version`)
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
