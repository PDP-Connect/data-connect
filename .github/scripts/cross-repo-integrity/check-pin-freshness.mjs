// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"

const {
  CURRENT_HEAD,
  GITHUB_EVENT_NAME,
  PINNED_SHA,
  RELEVANT_PATHS,
  REPO_ID,
  TRACK_REF,
} = process.env

for (const [name, value] of Object.entries({
  CURRENT_HEAD,
  GITHUB_EVENT_NAME,
  PINNED_SHA,
  RELEVANT_PATHS,
  REPO_ID,
  TRACK_REF,
})) {
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`)
  }
}

const relevantPaths = RELEVANT_PATHS.split(/\r?\n/)
  .map(path => path.trim())
  .filter(Boolean)
if (relevantPaths.length === 0) {
  throw new Error("RELEVANT_PATHS must contain at least one path")
}

const diff = execFileSync(
  "git",
  ["diff", "--name-only", PINNED_SHA, CURRENT_HEAD, "--", ...relevantPaths],
  { encoding: "utf8" }
).trim()

if (!diff) {
  console.log(
    `OK: no change under the guarded paths since ${REPO_ID}'s pinned SHA (${PINNED_SHA}).`
  )
  process.exit(0)
}

if (GITHUB_EVENT_NAME === "pull_request") {
  console.log(
    `::notice::${REPO_ID} pin is stale: this pull request changed paths backed by data-connectors' drift jobs since ${PINNED_SHA}. The main automation will open or update data-connectors' repin PR after this change merges.`
  )
  console.log("Changed paths:")
  console.log(diff)
  process.exit(0)
}

console.log(
  `::error::pin stale for guarded paths — ${REPO_ID}'s ${TRACK_REF} (${CURRENT_HEAD}) has changed these paths since the pinned commit (${PINNED_SHA}):`
)
console.log(diff)
process.exit(1)
