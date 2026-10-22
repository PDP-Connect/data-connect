// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test"
import assert from "node:assert/strict"
import { migrationTag } from "./npm-release-tags.mjs"

test("migrates the registry version rather than the highest desktop tag", () => {
  assert.deepEqual(
    migrationTag(["2.5.1", "2.5.1", "2.5.1"], ["v2.5.1", "v3.0.0"]),
    { oldTag: "v2.5.1", newTag: "npm-v2.5.1" }
  )
})
test("partial npm release continues above the highest live package version", () => {
  assert.deepEqual(migrationTag(["2.10.0", "2.9.0", "2.9.0"], ["v2.10.0"]), {
    oldTag: "v2.10.0",
    newTag: "npm-v2.10.0",
  })
})
test("migration is skipped once npm has its own reachable tags", () =>
  assert.equal(migrationTag([], ["npm-v2.5.1"]), null))
test("missing legacy tags and unknown registry values fail closed", () => {
  assert.throws(
    () => migrationTag(["2.5.1", "2.5.1", "2.5.1"], ["v0.7.63"]),
    /legacy/
  )
  assert.throws(() => migrationTag(["2.5.1", null, "2.5.1"], ["v2.5.1"]))
  assert.throws(() => migrationTag([], []))
})

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { load } from "js-yaml"

test("npm keeps all three publishers and no GitHub release publisher", () => {
  const config = load(
    readFileSync(new URL("../.releaserc.yaml", import.meta.url), "utf8")
  )
  assert.equal(config.tagFormat, "npm-v${version}")
  assert.equal(
    config.plugins.filter(p => p[0] === "@semantic-release/npm").length,
    3
  )
  assert.ok(
    !config.plugins.some(
      p =>
        p === "@semantic-release/github" || p[0] === "@semantic-release/github"
    )
  )
})

for (const mode of ["create", "recover", "conflict"]) {
  test(`npm migration CLI: ${mode}`, t => {
    const dir = mkdtempSync(join(tmpdir(), "npm-tag-migration-"))
    t.after(() => rmSync(dir, { recursive: true }))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    const log = join(dir, "calls")
    writeFileSync(log, "")
    const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([tool, ...a]) + '\\n');
let result;
if (tool === 'npm') result = JSON.stringify('2.5.1');
if (tool === 'gh' && a.includes('--method')) result = '';
if (tool === 'git') {
  if (a[0] === 'tag') result = 'v2.5.1\\nv3.0.0';
  if (a[0] === 'rev-parse') result = 'a'.repeat(40);
  if (a[0] === 'fetch') result = '';
  if (a[0] === 'ls-remote') result = process.env.MODE === 'create' ? '' : (process.env.MODE === 'conflict' ? 'b' : 'a').repeat(40) + '\\trefs/tags/npm-v2.5.1';
}
if (result === undefined) process.exit(1);
process.stdout.write(result);
`
    for (const name of ["git", "gh", "npm"]) {
      writeFileSync(join(bin, name), shim)
      chmodSync(join(bin, name), 0o755)
    }
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("npm-release-tags.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: log,
          MODE: mode,
          GITHUB_REPOSITORY: "PDP-Connect/data-connect",
        },
      }
    )
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(s => JSON.parse(s))
    assert.equal(r.status, mode === "conflict" ? 1 : 0, r.stderr)
    assert.equal(
      calls.some(c => c[0] === "gh"),
      mode === "create"
    )
    assert.equal(
      calls.some(c => c[1] === "fetch"),
      mode !== "conflict"
    )
    if (mode === "create") {
      assert.ok(
        calls.some(
          c =>
            c.includes("ref=refs/tags/npm-v2.5.1") &&
            c.includes(`sha=${"a".repeat(40)}`)
        )
      )
    }
  })
}
