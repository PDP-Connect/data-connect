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
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/consumer-drift-signal.yml"
)

// Extracts the REAL `guarded_paths=( ... )` array out of the workflow's run script
// rather than restating it here. A test that keeps its own copy of the list would
// keep passing after someone edits the workflow, which is exactly the regression
// this file exists to catch.
function readGuardedPathsArrayLiteral(): string {
  const workflow = readFileSync(workflowPath, "utf8")
  const start = workflow.indexOf("guarded_paths=(")
  if (start === -1) throw new Error("Missing guarded_paths array in workflow")
  const end = workflow.indexOf("\n          )", start)
  if (end === -1)
    throw new Error("Unterminated guarded_paths array in workflow")
  return workflow
    .slice(start, end + "\n          )".length)
    .split("\n")
    .map(line => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  })
}

function write(root: string, relPath: string, contents: string) {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

let repo: string
let baseSha: string

// The set of files the guard must treat as INPUTS (a change to any one of them can
// change what data-connectors rebuilds and vendors), and the set it must treat as
// NON-inputs. Both are seeded into the base commit so each case is a modification.
const PACKED_INPUTS = [
  "packages/collector-runtime/src/index.ts",
  "packages/collector-runtime/src/nested/deep.ts",
  "packages/collector-runtime/README.md",
  "packages/collector-runtime/package.json",
  "packages/collector-runtime/scripts/build.ts",
  "packages/collector-runtime/tsconfig.build.json",
  "packages/connector-protocol/src/auth.ts",
  "packages/connector-protocol/README.md",
  "packages/connector-protocol/package.json",
  "packages/connector-protocol/scripts/build.ts",
  "packages/connector-protocol/tsconfig.build.json",
  "packages/local-collector/scripts/generate-collector-definitions-snapshot.ts",
  "packages/local-collector/src/generated/collector-definitions.generated.ts",
  "packages/local-collector/tsconfig.build.json",
  "packages/polyfill-connectors/connectors/codex/collector-definition.ts",
  "packages/polyfill-connectors/connectors/imessage/collector-definition.ts",
]

const NON_INPUTS = [
  // The receipt. Written BY the packaging script FROM the inputs above, kept out of
  // the published tarball by `files: ["dist/"]`, and read by nothing in
  // data-connectors. This is the case that blocked PR #104.
  "packages/collector-runtime/artifact.json",
  "packages/connector-protocol/artifact.json",
  // Tests: excluded from FIXED_INPUTS and absent from dist/.
  "packages/collector-runtime/src/index.test.ts",
  "packages/connector-protocol/src/auth.test.ts",
  // Lint/editor config, not build inputs.
  "packages/collector-runtime/biome.jsonc",
  "packages/collector-runtime/tsconfig.json",
  "packages/connector-protocol/biome.jsonc",
  "packages/connector-protocol/tsconfig.json",
  // scripts/ files that are not scripts/build.ts.
  "packages/collector-runtime/scripts/package-artifact.mjs",
  "packages/connector-protocol/scripts/package-artifact.mjs",
  // A non-.ts file under src/. An allow-list keyed on `src/**/*.ts` must not pick
  // this up; a bare `src` directory pathspec would, reintroducing the defect.
  "packages/collector-runtime/src/fixture.json",
  // Files that were never in scope at all.
  "src/app.tsx",
  "packages/collector-runtime/CHANGELOG.md",
]

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "consumer-drift-signal-"))
  git(repo, "init", "-q", "-b", "main")
  for (const path of [...PACKED_INPUTS, ...NON_INPUTS]) {
    write(repo, path, "base\n")
  }
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "base")
  baseSha = git(repo, "rev-parse", "HEAD").trim()
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

// Runs the workflow's own guarded-path comparison against a tree where `path` is the
// only file changed since the pinned SHA. Returns the paths the gate reports, i.e.
// empty when the gate would pass.
function changedGuardedPathsAfterEditing(path: string): string[] {
  git(repo, "checkout", "-q", "-B", "case", baseSha)
  write(repo, path, "changed\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", `edit ${path}`)

  const script = [
    "set -euo pipefail",
    readGuardedPathsArrayLiteral(),
    `git diff --name-only "${baseSha}" HEAD -- "\${guarded_paths[@]}"`,
  ].join("\n")

  return execFileSync("bash", ["-c", script], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
}

describe("consumer drift signal guarded paths", () => {
  it.each(PACKED_INPUTS)(
    "fails the pin gate when a packed input changes: %s",
    path => {
      expect(changedGuardedPathsAfterEditing(path)).toEqual([path])
    }
  )

  it.each(NON_INPUTS)(
    "passes the pin gate when a non-input changes: %s",
    path => {
      expect(changedGuardedPathsAfterEditing(path)).toEqual([])
    }
  )

  // The guard must stay an allow-list. A deny-list ("whole package, minus the files
  // we have so far noticed are harmless") makes every new file guarded by default,
  // so each non-input has to be discovered via a spurious red X on an unrelated PR —
  // which is how both the connector-protocol/auth.ts block and the artifact.json
  // block happened. Excludes are legitimate only to narrow a positive glob.
  it("enumerates guarded packages positively rather than excluding from them", () => {
    const literal = readGuardedPathsArrayLiteral()
    const entries = literal
      .split("\n")
      .slice(1, -1)
      .map(line => line.trim().replace(/^'|'$/g, ""))
      .filter(Boolean)

    for (const entry of entries) {
      if (!entry.startsWith(":(exclude")) continue
      expect(
        entry,
        `every exclude must narrow a src/**/*.ts glob, not carve a hole in a guarded directory`
      ).toMatch(/^:\(exclude,glob\)packages\/[^/]+\/src\/\*\*\/\*\.test\.ts$/)
    }

    // No entry may guard a whole package directory: that is the deny-list shape.
    for (const entry of entries) {
      expect(entry).not.toMatch(
        /^packages\/(collector-runtime|connector-protocol)$/
      )
    }
  })

  it("does not guard the artifact.json reproducibility receipts", () => {
    expect(readGuardedPathsArrayLiteral()).not.toContain("artifact.json")
  })
})
