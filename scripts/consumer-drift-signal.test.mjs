// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const comparatorPath = join(
  repositoryRoot,
  ".github/scripts/cross-repo-integrity/check-pin-freshness.mjs"
)
const workflow = readFileSync(
  join(repositoryRoot, ".github/workflows/consumer-drift-signal.yml"),
  "utf8"
)

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "consumer-pin-freshness-"))
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  writeFileSync(join(root, "README.md"), "base\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "base")
  const pinnedSha = git(root, "rev-parse", "HEAD")

  writeFileSync(join(root, "README.md"), "unrelated change\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "change unrelated source")
  const unrelatedHead = git(root, "rev-parse", "HEAD")

  const changedPath = "packages/collector-runtime/src/index.ts"
  mkdirSync(join(root, "packages/collector-runtime/src"), { recursive: true })
  writeFileSync(join(root, changedPath), "export const changed = true;\n")
  writeFileSync(join(root, "README.md"), "another unrelated change\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "change guarded source")
  const currentHead = git(root, "rev-parse", "HEAD")

  return { root, pinnedSha, unrelatedHead, currentHead, changedPath }
}

function runComparator(fixture, eventName, currentHead = fixture.currentHead) {
  let status = 0
  let stdout = ""
  try {
    stdout = execFileSync(process.execPath, [comparatorPath], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        CURRENT_HEAD: currentHead,
        GITHUB_EVENT_NAME: eventName,
        PINNED_SHA: fixture.pinnedSha,
        RELEVANT_PATHS:
          "packages/collector-runtime\npackages/connector-protocol",
        REPO_ID: "data-connect",
        TRACK_REF: "main",
      },
    })
  } catch (error) {
    status = error.status ?? 1
    stdout = error.stdout ?? ""
  }
  return { status, stdout }
}

describe("consumer pin freshness decisions", () => {
  it("routes clean, pull-request, push, and manual outcomes by event", () => {
    const fixture = makeFixture()
    try {
      const clean = runComparator(
        fixture,
        "workflow_dispatch",
        fixture.unrelatedHead
      )
      expect(clean.status).toBe(0)
      expect(clean.stdout).toContain("OK: no change")

      const pullRequest = runComparator(fixture, "pull_request")
      expect(pullRequest.status).toBe(0)
      expect(pullRequest.stdout).toContain(
        "::notice::data-connect pin is stale"
      )
      expect(pullRequest.stdout).toContain(fixture.changedPath)

      const mainPush = runComparator(fixture, "push")
      expect(mainPush.status).toBe(1)
      expect(mainPush.stdout).toContain("::error::pin stale")
      expect(mainPush.stdout).toContain(fixture.changedPath)

      const manual = runComparator(fixture, "workflow_dispatch")
      expect(manual.status).toBe(1)
      expect(manual.stdout).toContain("::error::pin stale")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("wires main push, pull request, and manual dispatch to the guarded workflow", () => {
    expect(workflow).toMatch(/  push:\n    branches: \[main\]/)
    expect(workflow).toContain("  pull_request:")
    expect(workflow).toContain("  workflow_dispatch: {}")
    expect(workflow).toContain(
      '      - ".github/scripts/cross-repo-integrity/check-pin-freshness.mjs"'
    )
    expect(workflow).toContain("check-pin-freshness.mjs")
  })
})
