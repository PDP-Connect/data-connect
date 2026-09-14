// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Prints the one line the release log says about a version an earlier run
// left half-published.
//
// This is REPORTING, not a gate. The superseded version stays incomplete.
// Recovery is a later release at a new version; this script only reports that
// supersession. The message names the version, what of it is live, and which
// release supersedes it.

import { supersededMessage } from "./resolve-release-version.js"

function fail(message: string): never {
  process.stderr.write(`[report-superseded-release] ${message}\n`)
  process.exit(1)
}

export async function main(): Promise<void> {
  const [tag, missing, newVersion] = process.argv.slice(2)
  if (!tag || !missing || !newVersion) {
    fail("Usage: report-superseded-release.ts <tag> <comma-separated-missing> <new-version>")
  }

  const version = tag.replace(/^v/, "")
  const missingPackages = missing.split(",").filter(Boolean)
  if (missingPackages.length === 0) {
    fail(`no missing packages supplied for ${tag}; nothing to report`)
  }

  process.stdout.write(`${supersededMessage({ tag, version, missing: missingPackages }, newVersion)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith("report-superseded-release.ts")) {
  await main()
}
