// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const base = "3282ac2f5e4687419bf391c2294d2118dd63fd7c"
const scratchRoot = join(homedir(), ".tmp/mcp413-provenance")
mkdirSync(scratchRoot, { recursive: true })

// Exercise the entrypoints' real guards, stopping only at the expensive server
// capture/seed boundary. Runtime imports are mocked so these tests need no DB.
const runner = `
import { mock } from 'node:test';
import { execFileSync as realExec } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const source = process.env.GATE_SOURCE;
const target = process.env.GATE_TARGET;
mock.module('node:child_process', { namedExports: { execFileSync: (cmd, args, opts) => {
  if (cmd === 'git') return realExec(cmd, args, opts);
  throw new Error('REACHED_SEED');
}}});
mock.module(pathToFileURL(source + '/reference-implementation/server/db.ts').href, { namedExports: { getDb() {} } });
mock.module(pathToFileURL(source + '/reference-implementation/server/index.ts').href, { namedExports: { startServer() {} } });
for (const root of new Set([source, target])) mock.module(pathToFileURL(root + '/reference-implementation/test/helpers/mcp-existing-client-session.ts').href, { namedExports: {
  replay() {}, captureExistingClientContract() { throw new Error('REACHED_CAPTURE'); }, writeContract() {}
}});
await import(pathToFileURL(target + '/reference-implementation/' + process.env.GATE_ENTRY).href);
`

function withBase(run: (root: string, runnerPath: string) => void) {
  const scratch = mkdtempSync(join(scratchRoot, "base-"))
  const root = join(scratch, "worktree")
  try {
    execFileSync(
      "git",
      ["-C", source, "worktree", "add", "--detach", root, base],
      { stdio: "pipe" }
    )
    const runnerPath = join(scratch, "runner.mjs")
    writeFileSync(runnerPath, runner)
    run(root, runnerPath)
  } finally {
    execFileSync("git", ["-C", source, "worktree", "remove", "--force", root], {
      stdio: "pipe",
    })
    rmSync(scratch, { recursive: true, force: true })
  }
}

function apply(root: string) {
  execFileSync("bash", [
    join(
      source,
      "reference-implementation/test/scripts/apply-mcp-existing-client-gate.sh"
    ),
    root,
  ])
}

function probe(root: string, runnerPath: string, entry: string) {
  const generator = entry.startsWith("scripts/")
  if (generator) {
    for (const path of [
      "scripts/generate-mcp-existing-client-contract.ts",
      "test/helpers/mcp-existing-client-provenance.ts",
      "test/helpers/mcp-existing-client-session.ts",
    ]) {
      const destination = join(root, "reference-implementation", path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(source, "reference-implementation", path), destination)
    }
  }
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", runnerPath],
    {
      cwd: join(generator ? root : source, "reference-implementation"),
      encoding: "utf8",
      env: {
        ...env,
        GATE_SOURCE: source,
        GATE_TARGET: generator ? root : source,
        GATE_ENTRY: entry,
        MCP_AUDIENCE_MIGRATION_WORKTREE: source,
        MCP_AUDIENCE_MIGRATION_BASE_WORKTREE: root,
        MCP_STORED_ID_WORKTREE: source,
        MCP_STORED_ID_BASE_WORKTREE: root,
        MCP_STORED_ID_BASE_REV: base,
      },
    }
  )
  return `${result.stdout}${result.stderr}`
}

const entries = [
  "test/mcp-existing-client-audience-migration.test.ts",
  "test/mcp-stored-id-resolution.test.ts",
  "scripts/generate-mcp-existing-client-contract.ts",
] as const

test("documented overlay installs the audience command and passes audience provenance", () =>
  withBase((root, runnerPath) => {
    apply(root)
    const output = probe(root, runnerPath, entries[0])
    assert.match(output, /REACHED_SEED/, output)
    const pkg = JSON.parse(
      readFileSync(join(root, "reference-implementation/package.json"), "utf8")
    )
    assert.equal(
      pkg.scripts["test:mcp-audience-migration"],
      "node --import tsx --test test/mcp-existing-client-audience-migration.test.ts"
    )
  }))

test("overlay installs the documented audience npm command", () =>
  withBase(root => {
    apply(root)
    const pkg = JSON.parse(
      readFileSync(join(root, "reference-implementation/package.json"), "utf8")
    )
    assert.equal(
      pkg.scripts["test:mcp-audience-migration"],
      "node --import tsx --test test/mcp-existing-client-audience-migration.test.ts"
    )
  }))

for (const entry of entries) {
  test(`${entry}: unchanged pinned runtime reaches seed/capture`, () =>
    withBase((root, runnerPath) => {
      assert.match(probe(root, runnerPath, entry), /REACHED_(SEED|CAPTURE)/)
    }))
  for (const state of ["unstaged", "staged", "untracked"] as const) {
    test(`${entry}: rejects ${state} runtime before seed/capture`, () =>
      withBase((root, runnerPath) => {
        const path =
          state === "untracked"
            ? "reference-implementation/server/provenance-negative.ts"
            : "reference-implementation/server/auth.ts"
        writeFileSync(join(root, path), "// dirty runtime\n", {
          flag: state === "untracked" ? "w" : "a",
        })
        if (state === "staged") execFileSync("git", ["-C", root, "add", path])
        const output = probe(root, runnerPath, entry)
        assert.doesNotMatch(output, /REACHED_(SEED|CAPTURE)/, output)
        assert.match(output, /runtime.*clean|unexpected.*change/i, output)
      }))
  }
}

for (const entry of entries) {
  for (const change of [
    "dependency",
    "existing script",
    "extra script",
    "staged dependency",
  ] as const) {
    test(`${entry}: rejects ${change} package change`, () =>
      withBase((root, runnerPath) => {
        const path = join(root, "reference-implementation/package.json")
        const original = readFileSync(path, "utf8")
        const pkg = JSON.parse(original)
        if (change.includes("dependency"))
          pkg.dependencies["provenance-negative"] = "1.0.0"
        else
          pkg.scripts[
            change === "existing script" ? "test" : "provenance-negative"
          ] = "echo bad"
        writeFileSync(path, JSON.stringify(pkg))
        if (change === "staged dependency") {
          execFileSync("git", [
            "-C",
            root,
            "add",
            "reference-implementation/package.json",
          ])
          writeFileSync(path, original)
        }
        const output = probe(root, runnerPath, entry)
        assert.doesNotMatch(output, /REACHED_(SEED|CAPTURE)/, output)
        assert.match(output, /package|scripts/, output)
      }))
  }
  test(`${entry}: rejects unrelated test and runtime script overlays`, () =>
    withBase((root, runnerPath) => {
      for (const path of ["test/not-a-gate.ts", "scripts/not-a-gate.ts"]) {
        const fullPath = join(root, "reference-implementation", path)
        writeFileSync(fullPath, "// unrelated overlay\n")
        const output = probe(root, runnerPath, entry)
        assert.doesNotMatch(output, /REACHED_(SEED|CAPTURE)/, output)
        assert.match(output, /unexpected.*change|runtime.*clean/i, output)
        rmSync(fullPath)
      }
    }))
  test(`${entry}: accepts staged documented overlay`, () =>
    withBase((root, runnerPath) => {
      apply(root)
      execFileSync("git", [
        "-C",
        root,
        "add",
        "reference-implementation/package.json",
        "reference-implementation/scripts/generate-mcp-existing-client-contract.ts",
        "reference-implementation/test",
      ])
      assert.match(probe(root, runnerPath, entry), /REACHED_(SEED|CAPTURE)/)
    }))
}
