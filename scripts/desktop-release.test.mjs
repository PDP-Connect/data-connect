// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nextVersion,
  desktopBase,
  setBuildVersion,
} from "./desktop-release.mjs"

for (const [message, expected] of [
  ["fix: repair launch", "1.2.4"],
  ["fix(desktop): repair launch", "1.2.4"],
  ["perf(core): reduce allocations", "1.2.4"],
  ["feat: add export", "1.3.0"],
  ["feat(desktop): add export", "1.3.0"],
  ["fix!: remove API", "2.0.0"],
  ["feat(api)!: remove API", "2.0.0"],
  ["refactor!: remove API", "2.0.0"],
  ["fix: remove API\n\nBREAKING CHANGE: old API removed", "2.0.0"],
  ["chore(core): remove API\n\nBREAKING-CHANGE: old API removed", "2.0.0"],
  ...[
    "test",
    "docs",
    "ci",
    "chore",
    "style",
    "refactor",
    "build",
    "revert",
  ].map(type => [`${type}: housekeeping`, null]),
  ["Merge pull request #123", null],
  ["not conventional\n\nBREAKING CHANGE: example", null],
])
  test(message, () => assert.equal(nextVersion("1.2.3", [message]), expected))

test("highest bump wins regardless of order or ignored commits", () => {
  const messages = [
    "feat: export",
    "docs: help",
    "perf: speed",
    "fix!: remove API",
  ]
  assert.equal(nextVersion("1.2.3", messages), "2.0.0")
  assert.equal(nextVersion("1.2.3", messages.reverse()), "2.0.0")
  assert.equal(nextVersion("1.2.3", ["fix: bug", "feat: feature"]), "1.3.0")
  assert.equal(nextVersion("1.2.3", []), null)
})
test("breaking changes use major at 0.x", () =>
  assert.equal(nextVersion("0.7.63", ["feat!: break"]), "1.0.0"))
test("malformed versions fail closed", () =>
  assert.throws(() => nextVersion("1.2", ["fix: bug"])))

const assets = [
  "DataConnect_0.7.63_arm64.dmg",
  "DataConnect_0.7.63_x86_64.dmg",
  "app.deb",
  "app.AppImage",
  "app-setup.exe",
].map(name => ({ name }))
const release = (tag_name, overrides = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  assets,
  ...overrides,
})
test("baseline excludes empty npm releases, drafts, prereleases and unreachable tags", () => {
  const releases = [
    release("v0.7.63"),
    release("v2.5.1", { assets: [] }),
    release("v3.0.0", { draft: true }),
    release("v4.0.0", { prerelease: true }),
    release("v5.0.0"),
    release("npm-v6.0.0"),
  ]
  assert.equal(
    desktopBase(releases, [
      "v0.7.63",
      "v2.5.1",
      "v3.0.0",
      "v4.0.0",
      "npm-v6.0.0",
    ]),
    "v0.7.63"
  )
})
test("baseline uses semantic order and refuses missing installers", () => {
  assert.equal(
    desktopBase([release("v1.9.0"), release("v1.10.0")], ["v1.9.0", "v1.10.0"]),
    "v1.10.0"
  )
  assert.throws(
    () =>
      desktopBase([release("v1.0.0", { assets: assets.slice(1) })], ["v1.0.0"]),
    /No reachable/
  )
})
test("materializes the tag version without altering other Tauri settings", t => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-version-"))
  t.after(() => rmSync(dir, { recursive: true }))
  const path = join(dir, "tauri.conf.json")
  writeFileSync(
    path,
    JSON.stringify({
      version: "0.7.63",
      productName: "DataConnect",
      bundle: { active: true },
    })
  )
  setBuildVersion("v1.3.0", path)
  assert.deepEqual(JSON.parse(readFileSync(path)), {
    version: "1.3.0",
    productName: "DataConnect",
    bundle: { active: true },
  })
  assert.throws(() => setBuildVersion("npm-v1.3.0", path))
})

// Exercise the actual coordinator CLI with fake git/gh executables. These tests
// cannot contact GitHub or create real tags, and assert the intended API writes.
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

function prepareFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-prepare-"))
  t.after(() => rmSync(dir, { recursive: true }))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  const fixture = {
    sha: "a".repeat(40),
    main: "a".repeat(40),
    tags: ["v0.7.63"],
    messages: ["fix: launch"],
    releases: [release("v0.7.63")],
    refs: {},
    ...overrides,
  }
  const data = join(dir, "fixture.json")
  const log = join(dir, "calls.jsonl")
  const output = join(dir, "output")
  writeFileSync(data, JSON.stringify(fixture))
  writeFileSync(log, "")
  writeFileSync(output, "")
  const shim = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const f = JSON.parse(fs.readFileSync(process.env.FIXTURE));
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([tool, ...args]) + '\\n');
let result;
if (tool === 'git') {
  if (args[0] === 'rev-parse') result = args[1] === 'HEAD' ? f.sha : f.refs[args[1]];
  if (args[0] === 'tag') result = f.tags.join('\\n');
  if (args[0] === 'log') result = f.messages.join('\\0');
} else if (tool === 'gh') {
  if (args.includes('--method')) { if (f.apiFailure) process.exit(1); result = ''; }
  else if (args[0] === 'release') result = '';
  else if (args[1].includes('/git/ref/heads/main')) result = JSON.stringify({object:{sha:f.main}});
  else if (args.includes('--slurp')) result = JSON.stringify([f.releases]);
}
if (result === undefined) { console.error('Unexpected command', tool, args); process.exit(1); }
process.stdout.write(result);
`
  for (const name of ["git", "gh"]) {
    writeFileSync(join(bin, name), shim)
    chmodSync(join(bin, name), 0o755)
  }
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("desktop-release.mjs", import.meta.url)), "prepare"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE: data,
        CALL_LOG: log,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "PDP-Connect/data-connect",
      },
    }
  )
  return {
    ...result,
    output: readFileSync(output, "utf8"),
    calls: readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(s => JSON.parse(s)),
  }
}

test("coordinator reserves exact tested SHA and a draft, then emits reusable-build inputs", t => {
  const r = prepareFixture(t)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.output, `tag=v0.7.64\nsha=${"a".repeat(40)}\n`)
  assert.ok(
    r.calls.some(
      c =>
        c.includes("ref=refs/tags/v0.7.64") &&
        c.includes(`sha=${"a".repeat(40)}`)
    )
  )
  const draft = r.calls.find(c => c[0] === "gh" && c[1] === "release")
  assert.ok(draft.includes("--draft"))
  assert.ok(draft.includes("--verify-tag"))
  assert.equal(draft.at(-1), "v0.7.63")
})
test("coordinator skips superseded main heads before reading releases or writing anything", t => {
  const r = prepareFixture(t, { main: "b".repeat(40) })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.output, "")
  assert.equal(r.calls.filter(c => c[0] === "gh").length, 1)
})
test("coordinator makes no API writes for a non-release batch", t => {
  const r = prepareFixture(t, { messages: ["docs: explain", "ci: lint"] })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.output, "")
  assert.ok(!r.calls.some(c => c.includes("--method") || c[1] === "release"))
})
test("coordinator skips an occupied legacy npm version without moving its tag", t => {
  const r = prepareFixture(t, {
    tags: ["v0.7.63", "v0.7.64"],
    refs: { "v0.7.64^{commit}": "b".repeat(40) },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /tag=v0.7.65/)
  assert.ok(!r.calls.some(c => c.includes("ref=refs/tags/v0.7.64")))
})
test("coordinator retries the same draft without another ref or release write", t => {
  const r = prepareFixture(t, {
    tags: ["v0.7.63", "v0.7.64"],
    refs: { "v0.7.64^{commit}": "a".repeat(40) },
    releases: [
      release("v0.7.63"),
      release("v0.7.64", { draft: true, assets: [] }),
    ],
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /tag=v0.7.64/)
  assert.ok(!r.calls.some(c => c.includes("--method") || c[1] === "release"))
})
test("coordinator fails closed without a desktop baseline or when tag creation fails", t => {
  for (const overrides of [
    { releases: [release("v0.7.63", { assets: [] })] },
    { apiFailure: true },
  ]) {
    const r = prepareFixture(t, overrides)
    assert.notEqual(r.status, 0)
    assert.equal(r.output, "")
    assert.ok(!r.calls.some(c => c[1] === "release"))
  }
})
test("coordinator recovers a tag reservation if draft creation previously failed", t => {
  const r = prepareFixture(t, {
    tags: ["v0.7.63", "v0.7.64"],
    refs: { "v0.7.64^{commit}": "a".repeat(40) },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /tag=v0.7.64/)
  assert.ok(!r.calls.some(c => c.includes("--method")))
  assert.ok(
    r.calls.some(
      c => c[1] === "release" && c.includes("v0.7.64") && c.includes("--draft")
    )
  )
})

import { load } from "js-yaml"
test("late stale or failed CI events cannot replace the current release's pending slot", () => {
  const workflow = load(
    readFileSync(
      new URL("../.github/workflows/desktop-release.yml", import.meta.url),
      "utf8"
    )
  )
  const expression = workflow.concurrency.group.match(/\$\{\{ (.*) \}\}/)[1]
  const group = (
    event,
    head,
    current,
    conclusion,
    runId,
    ref = "refs/heads/main"
  ) => {
    const value = expression
      .replaceAll("github.event_name", JSON.stringify(event))
      .replaceAll("github.event.workflow_run.head_sha", JSON.stringify(head))
      .replaceAll(
        "github.event.workflow_run.conclusion",
        JSON.stringify(conclusion)
      )
      .replaceAll("github.ref", JSON.stringify(ref))
      .replaceAll("github.sha", JSON.stringify(current))
      .replaceAll("github.run_id", JSON.stringify(runId))
    return new Function(`return ${value}`)()
  }
  assert.equal(group("workflow_run", "new", "new", "success", 1), "main")
  assert.equal(group("workflow_run", "old", "new", "success", 2), 2)
  assert.equal(group("workflow_run", "new", "new", "failure", 3), 3)
  assert.equal(group("workflow_dispatch", "", "new", "", 4), "main")
  assert.equal(
    group("workflow_dispatch", "", "new", "", 5, "refs/heads/other"),
    5
  )
  assert.equal(workflow.concurrency["cancel-in-progress"], true)
})
