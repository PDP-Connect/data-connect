// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// package-verify.yml's classify step maps changed paths to the workspaces
// whose `verify` must run. Its package roots are written out in shell, so
// these tests hold them to the lockstep list in .releaserc.yaml and run the
// step itself against a stubbed `git diff`.

import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"
import { lockstepPackages } from "./lockstep-packages.js"

const REPO_ROOT = resolve(import.meta.dirname, "..")

interface Workflow {
  jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }>
}

const workflow = load(readFileSync(join(REPO_ROOT, ".github/workflows/package-verify.yml"), "utf8")) as Workflow
const classify = workflow.jobs.classify?.steps?.find((step) => step.id === "changes")?.run ?? ""
const SELECTED_ROOT = /packages\+="([^" ]+) "/g

function selectedFor(changedFiles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "package-verify-classify-"))
  try {
    const git = join(dir, "git")
    writeFileSync(join(dir, "changed.txt"), `${changedFiles.join("\n")}\n`)
    writeFileSync(git, `#!/bin/sh\ncat "${join(dir, "changed.txt")}"\n`)
    chmodSync(git, 0o755)
    const output = join(dir, "output")
    writeFileSync(output, "")
    execFileSync("bash", ["-c", classify], {
      env: {
        BASE_SHA: "base",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: output,
        HEAD_SHA: "head",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: dir,
      },
      stdio: ["ignore", "ignore", "inherit"],
    })
    return readFileSync(output, "utf8").replace(/^packages=/, "").trim()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

describe("package-verify classify step", () => {
  const roots = lockstepPackages(REPO_ROOT).map((pkg) => pkg.root)

  it("selects from exactly the lockstep packages, in publish order", () => {
    expect([...classify.matchAll(SELECTED_ROOT)].map((match) => match[1])).toEqual(roots)
  })

  it("verifies every lockstep package when the release config changes", () => {
    expect(selectedFor([".releaserc.yaml"])).toBe(roots.join(" "))
  })

  it("verifies a package and the packages that depend on it when only that package changes", () => {
    expect(selectedFor(["packages/collector-runtime/src/index.ts"])).toBe(
      "packages/collector-runtime packages/local-collector reference-implementation/vendor/cli reference-implementation/vendor/mcp-server"
    )
  })

  it("selects nothing for a change outside every package input", () => {
    expect(selectedFor(["docs/release-process.md"])).toBe("")
  })
})
