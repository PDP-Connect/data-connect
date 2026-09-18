#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The vendored `reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz`
// tarball (README-documented pin, re-vendored by hand or via
// scripts/revendor-polyfill-connectors.sh) is a committed snapshot, not a live
// dependency: nothing re-fetches it, so an upstream fix (e.g. a manifest icon
// correction) can merge to data-connectors main and never reach this repo's console
// no matter how many times the console is restaged. This check makes that staleness
// loud instead of silent: it fails once the pinned commit falls more than
// MAX_STALE_DAYS behind data-connectors main.
//
// This is deliberately a freshness alarm, not an auto-updater — the owner has
// decided to deprecate @pdpp/polyfill-connectors for OCI-distributed connector
// artifacts, so this check exists to prevent silent drift until that migration
// lands, not to grow into permanent re-vendor tooling.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const README_PATH = join(ROOT, "reference-implementation", "vendor", "README.md")
const UPSTREAM_REMOTE = "https://github.com/PDP-Connect/data-connectors.git"
const MAX_STALE_DAYS = 7
const PIN_PATTERN = /pin moved.*?commit\s*\n?`([0-9a-f]{40})`/gs

function fail(message) {
  console.error(`[check-polyfill-connectors-tarball-freshness] ${message}`)
  process.exitCode = 1
}

export function currentPin(readmeText) {
  const matches = [...readmeText.matchAll(PIN_PATTERN)]
  if (matches.length === 0) {
    throw new Error(`no "pin moved to ... commit" entry found in ${README_PATH}`)
  }
  return matches.at(-1)[1]
}

function commitDateIso(sha, { spawn = spawnSync } = {}) {
  const result = spawn(
    "git",
    ["log", "-1", "--format=%cI", sha],
    { cwd: ROOT, encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(
      `git log for ${sha} exited with status ${result.status ?? "unknown"}: ${result.stderr}`
    )
  }
  const date = result.stdout.trim()
  if (!date) {
    throw new Error(`git does not know commit ${sha} — fetch it first`)
  }
  return date
}

export function daysBetween(fromIso, toIso) {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (1000 * 60 * 60 * 24)
}

function main() {
  const pin = currentPin(readFileSync(README_PATH, "utf8"))

  const fetch = spawnSync(
    "git",
    ["fetch", "--quiet", UPSTREAM_REMOTE, "main", pin],
    { cwd: ROOT, encoding: "utf8" }
  )
  if (fetch.status !== 0) {
    fail(
      `could not fetch data-connectors to check pin ${pin} freshness: ${fetch.stderr}`
    )
    return
  }

  let pinDate
  let mainDate
  try {
    pinDate = commitDateIso(pin)
    mainDate = commitDateIso("FETCH_HEAD")
  } catch (error) {
    fail(error.message)
    return
  }

  const staleDays = daysBetween(pinDate, mainDate)
  if (staleDays > MAX_STALE_DAYS) {
    fail(
      `pinned data-connectors commit ${pin} is ${staleDays.toFixed(1)} days behind ` +
        `main (threshold: ${MAX_STALE_DAYS}). Re-vendor the tarball — see ` +
        `reference-implementation/vendor/README.md for the procedure.`
    )
    return
  }

  console.log(
    `[check-polyfill-connectors-tarball-freshness] pin ${pin} is ${staleDays.toFixed(1)} days behind main (within the ${MAX_STALE_DAYS}-day threshold)`
  )
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url)
if (isMainModule) {
  main()
}
