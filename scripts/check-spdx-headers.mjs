#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fails if any first-party source file is missing its Apache-2.0 SPDX
 * header (see PR #4, "chore: add Apache-2.0 SPDX license headers").
 *
 * Exclusions (vendor, generated, fixture, and UI-primitive files) live in
 * scripts/spdx-header-config.mjs, the single shared source of truth for
 * both this guard and any future re-sweep — do not duplicate that list
 * here.
 *
 * Usage: node scripts/check-spdx-headers.mjs [--check]
 * The --check flag is accepted for consistency with this repo's other
 * scripts (see scripts/resolve-connectors.js) but is also the default
 * behavior: this script only ever reports, it never writes.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"
import { SOURCE_EXTENSIONS, isExcludedPath } from "./spdx-header-config.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const SPDX_MARKER = "SPDX-License-Identifier: Apache-2.0"

function listTrackedSourceFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--", ...SOURCE_EXTENSIONS.map(ext => `*${ext}`)],
    { cwd: ROOT, encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.split("\n").filter(Boolean)
}

export function findMissingHeaders(relativePaths, { readFile = defaultReadFile } = {}) {
  const missing = []
  for (const relativePath of relativePaths) {
    if (isExcludedPath(relativePath)) continue
    const content = readFile(relativePath)
    if (!content.includes(SPDX_MARKER)) {
      missing.push(relativePath)
    }
  }
  return missing
}

function defaultReadFile(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8")
}

function main() {
  const files = listTrackedSourceFiles()
  const missing = findMissingHeaders(files)

  if (missing.length === 0) {
    console.log(`[check-spdx-headers] ${files.length} source files checked, all headered.`)
    return
  }

  console.error(
    `[check-spdx-headers] ${missing.length} file(s) missing the Apache-2.0 SPDX header:`
  )
  for (const relativePath of missing) {
    console.error(`  ${relativePath}`)
  }
  console.error(
    "\nAdd the header (see PR #4) or, if this file is vendor/generated/fixture content, " +
      "add it to EXCLUDED_FILES in scripts/spdx-header-config.mjs with a reason."
  )
  process.exit(1)
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main()
}
