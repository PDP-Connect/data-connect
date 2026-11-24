// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const MCP_EXISTING_CLIENT_BASE =
  "3282ac2f5e4687419bf391c2294d2118dd63fd7c"

// This is the complete installer overlay, not a directory exemption. Runtime
// scripts and unrelated tests must still be clean at the pinned revision.
export const MCP_GATE_OVERLAY_FILES = [
  "scripts/generate-mcp-existing-client-contract.ts",
  "test/README.md",
  "test/fixtures/mcp-existing-client-contract.json",
  "test/fixtures/mcp-existing-client-gate-inventory.json",
  "test/helpers/mcp-existing-client-provenance.ts",
  "test/helpers/mcp-existing-client-session.ts",
  "test/mcp-existing-client-audience-migration.test.ts",
  "test/mcp-existing-client-gate.test.ts",
  "test/mcp-stored-id-resolution.test.ts",
  "test/scripts/run-mcp-existing-client-gate.mjs",
  "test/scripts/seed-mcp-audience-migration-fixture.ts",
]

export const MCP_GATE_SCRIPTS = {
  "test:mcp-existing-client-gate":
    "node test/scripts/run-mcp-existing-client-gate.mjs",
  "test:mcp-audience-migration":
    "node --import tsx --test test/mcp-existing-client-audience-migration.test.ts",
  "refresh:mcp-existing-client-contract":
    "node --import tsx scripts/generate-mcp-existing-client-contract.ts && prettier --write test/fixtures/mcp-existing-client-contract.json",
}

export function assertMcpBaseProvenance(
  root: string,
  expectedRevision = MCP_EXISTING_CLIENT_BASE
): string {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  const revision = git("rev-parse", "HEAD").trim()
  assert.equal(
    revision,
    expectedRevision,
    `MCP seeder/contract requires pinned base ${expectedRevision}; got ${revision}`
  )
  const packagePath = "reference-implementation/package.json"
  const allowed = new Set(
    MCP_GATE_OVERLAY_FILES.map(path => `reference-implementation/${path}`)
  )
  const status = git(
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames"
  )
  for (const entry of status.split("\0").filter(Boolean)) {
    const path = entry.slice(3)
    assert(
      path === packagePath || allowed.has(path),
      `MCP base runtime must be clean; unexpected change: ${entry}`
    )
    assert(
      !entry.slice(0, 2).includes("D"),
      `MCP gate overlay must not delete ${path}`
    )
  }

  const original = JSON.parse(git("show", `HEAD:${packagePath}`))
  // Check both index and working tree: a dirty staged package must not hide
  // behind a restored working copy (or the reverse).
  for (const text of [
    git("show", `:${packagePath}`),
    readFileSync(join(root, packagePath), "utf8"),
  ]) {
    const current = JSON.parse(text)
    for (const [name, command] of Object.entries(MCP_GATE_SCRIPTS)) {
      if (current.scripts?.[name] !== original.scripts?.[name]) {
        assert.equal(
          current.scripts?.[name],
          command,
          `package overlay may only install the exact ${name} command`
        )
        if (Object.hasOwn(original.scripts ?? {}, name))
          current.scripts[name] = original.scripts[name]
        else delete current.scripts[name]
      }
    }
    assert.deepEqual(
      current,
      original,
      "MCP base package changes may only install the exact gate scripts"
    )
  }
  return revision
}
