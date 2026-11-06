#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// CI tests, the Docker image and the desktop app must launch the same Chromium.
// Each Patchright or Playwright version fixes one Chromium revision, and three
// lock files decide which version each target gets:
//
//   package-lock.json                patchright, patchright-core: CI and the
//                                    Docker image (which installs the
//                                    reference implementation's exact pin)
//   pdpp-runtime/package-lock.json   patchright, patchright-core: the desktop
//                                    connector runtime
//   playwright-runner/package-lock.json
//                                    playwright-core: the Chromium the desktop
//                                    release bundles
//
// This check fails when any of those entries, at any depth, resolves to a
// different version. Bump them together.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isMainModule } from "./is-main-module.js"

export const LOCKS = [
  { path: "package-lock.json", packages: ["patchright", "patchright-core"] },
  {
    path: "pdpp-runtime/package-lock.json",
    packages: ["patchright", "patchright-core"],
  },
  {
    path: "playwright-runner/package-lock.json",
    packages: ["playwright-core"],
  },
]

/** Every `<lock>: <entry path> <version>` row for the named packages, at any depth. */
export function lockEntries(lockPath, lock, packageNames) {
  const rows = []
  for (const [entryPath, entry] of Object.entries(lock.packages ?? {})) {
    const name = entryPath.split("node_modules/").at(-1)
    if (packageNames.includes(name)) {
      rows.push({ lock: lockPath, entry: entryPath, version: entry.version })
    }
  }
  return rows
}

/** Returns an error message, or null when every entry resolves to one version. */
export function checkPatchrightVersion(readLock) {
  const rows = []
  for (const { path, packages } of LOCKS) {
    const found = lockEntries(path, readLock(path), packages)
    if (found.length === 0) {
      return `${path} has no ${packages.join(" or ")} entry; the check cannot confirm its browser version.`
    }
    rows.push(...found)
  }
  const versions = new Set(rows.map(row => row.version))
  if (versions.size === 1) return null
  const listing = rows
    .map(row => `  ${row.lock}: ${row.entry} ${row.version}`)
    .join("\n")
  return `Patchright and the desktop's bundled Playwright must resolve to one version, so CI tests the Chromium that ships. Found ${[...versions].join(", ")}:\n${listing}`
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const error = checkPatchrightVersion(path =>
    JSON.parse(readFileSync(join(root, path), "utf8"))
  )
  if (error) {
    console.error(error)
    process.exit(1)
  }
  console.log("Patchright and the bundled Playwright resolve to one version.")
}
