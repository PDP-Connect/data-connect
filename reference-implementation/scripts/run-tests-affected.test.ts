// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  collectChangeSet,
  formatDepthSummary,
  parseDepth,
  selectAffectedTests,
  validateFilesFrom,
} from "./run-tests-affected.ts";

const scratchRoot = join(homedir(), ".tmp", "testeng", "dcri");
const roots: string[] = [];
const staticImport = (specifier: string) =>
  ["import ", JSON.stringify(specifier), ";"].join("");
const dynamicImport = (specifier: string) =>
  ["const load = () => import(", JSON.stringify(specifier), ");"].join("");
const inventorySource = `const ${["test", "Dir"].join("")} = __dirname; await ${["re", "addir"].join("")}(${["test", "Dir"].join("")}, { withFileTypes: true });`;

async function tree(files: Record<string, string>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "fast-test-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  return root;
}

/** Commit `files` in a fresh git repo; returns [gitRoot, referenceImplementationDir]. */
async function gitTree(
  files: Record<string, string>,
): Promise<[string, string]> {
  const root = await tree(files);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base", "--no-gpg-sign");
  return [root, join(root, "reference-implementation")];
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("selects a directly changed test", async () => {
  const root = await tree({
    "test/direct.test.ts": "test('x', () => {});",
    "test/other.test.ts": "test('y', () => {});",
  });
  const result = await selectAffectedTests(
    root,
    ["test/direct.test.ts", "test/other.test.ts"],
    {
      addedOrModified: ["reference-implementation/test/direct.test.ts"],
      deleted: [],
    },
  );
  assert.deepEqual(result.files, ["test/direct.test.ts"]);
});

test("selects test-tree inventory tests when a test file is added", async () => {
  const root = await tree({
    "test/new.test.ts": "test('new', () => {});",
    "test/inventory.test.ts": inventorySource,
    "test/other.test.ts": "test('other', () => {});",
  });
  const result = await selectAffectedTests(
    root,
    ["test/new.test.ts", "test/inventory.test.ts", "test/other.test.ts"],
    {
      added: ["reference-implementation/test/new.test.ts"],
      addedOrModified: ["reference-implementation/test/new.test.ts"],
      deleted: [],
    },
  );
  assert.deepEqual(result.files, [
    "test/inventory.test.ts",
    "test/new.test.ts",
  ]);
  assert.match(result.reason, /changed test selects test-tree inventory tests/);
});

test("a removed test file falls back to discovery including inventory tests", async () => {
  const root = await tree({
    "test/inventory.test.ts": inventorySource,
    "test/other.test.ts": "test('other', () => {});",
  });
  const result = await selectAffectedTests(
    root,
    ["test/inventory.test.ts", "test/other.test.ts"],
    {
      addedOrModified: [],
      deleted: ["reference-implementation/test/removed.test.ts"],
    },
  );
  assert.equal(result.fallback, true);
  assert.deepEqual(result.files, [
    "test/inventory.test.ts",
    "test/other.test.ts",
  ]);
});

test("selects a test for a transitive import two hops away with all", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/one.ts"),
    "server/one.ts": staticImport("./two.ts"),
    "server/two.ts": "export const value = 1;",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts"],
    {
      addedOrModified: ["reference-implementation/server/two.ts"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});

const rankedTree = () =>
  tree({
    "test/direct.test.ts": staticImport("../server/leaf.ts"),
    "test/twohop.test.ts": staticImport("../server/middle.ts"),
    "test/unrelated.test.ts": "test('u', () => {});",
    "server/middle.ts": staticImport("./leaf.ts"),
    "server/leaf.ts": "export const value = 1;",
  });
const rankedTests = [
  "test/direct.test.ts",
  "test/twohop.test.ts",
  "test/unrelated.test.ts",
];
const leafChange = {
  addedOrModified: ["reference-implementation/server/leaf.ts"],
  deleted: [],
};

test("default depth selects direct importers and ranks the two-hop test behind", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(root, rankedTests, leafChange);
  assert.deepEqual(result.files, ["test/direct.test.ts"]);
  assert.equal(result.depth, 1);
  assert.deepEqual(result.countsByDepth, { 1: 1, 2: 1 });
});

test("depth 2 adds the two-hop test", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(root, rankedTests, leafChange, {
    depth: 2,
  });
  assert.deepEqual(result.files, ["test/direct.test.ts", "test/twohop.test.ts"]);
});

test("all selects the full closure and omits unrelated tests", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(root, rankedTests, leafChange, {
    depth: "all",
  });
  assert.deepEqual(result.files, ["test/direct.test.ts", "test/twohop.test.ts"]);
  assert.equal(result.depth, "all");
});

test("a changed test file is distance 0 and always selected", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(
    root,
    rankedTests,
    {
      addedOrModified: ["reference-implementation/test/twohop.test.ts"],
      deleted: [],
    },
    { depth: 0 },
  );
  assert.deepEqual(result.files, ["test/twohop.test.ts"]);
  assert.deepEqual(result.countsByDepth, { 0: 1 });
});

test("a changed module also selects tests whose basename starts with it", async () => {
  const root = await tree({
    "test/records.test.ts": "test('r', () => {});",
    "test/records-extra.test.ts": "test('re', () => {});",
    "test/other.test.ts": staticImport("../server/wrapper.ts"),
    "server/wrapper.ts": staticImport("./records.ts"),
    "server/records.ts": "export const value = 1;",
  });
  const tests = [
    "test/records.test.ts",
    "test/records-extra.test.ts",
    "test/other.test.ts",
  ];
  const change = {
    addedOrModified: ["reference-implementation/server/records.ts"],
    deleted: [],
  };
  const fast = await selectAffectedTests(root, tests, change);
  assert.deepEqual(fast.files, [
    "test/records-extra.test.ts",
    "test/records.test.ts",
  ]);
  const all = await selectAffectedTests(root, tests, change, { depth: "all" });
  assert.deepEqual(all.files, ["test/other.test.ts"]);
});

test("the generic index basename does not match tests by name", async () => {
  const root = await tree({
    "test/index-routes.test.ts": "test('i', () => {});",
    "test/far.test.ts": staticImport("../server/mid.ts"),
    "server/mid.ts": staticImport("../operations/x/index.ts"),
    "operations/x/index.ts": "export const value = 1;",
  });
  const result = await selectAffectedTests(
    root,
    ["test/index-routes.test.ts", "test/far.test.ts"],
    {
      addedOrModified: ["reference-implementation/operations/x/index.ts"],
      deleted: [],
    },
  );
  assert.deepEqual(result.files, []);
});

test("depth selection keeps inventory tests when a test file is added", async () => {
  const root = await tree({
    "test/new.test.ts": "test('new', () => {});",
    "test/inventory.test.ts": inventorySource,
    "test/far.test.ts": staticImport("../server/mid.ts"),
    "server/mid.ts": staticImport("./leaf.ts"),
    "server/leaf.ts": "export const value = 1;",
  });
  const result = await selectAffectedTests(
    root,
    [
      "test/new.test.ts",
      "test/inventory.test.ts",
      "test/far.test.ts",
    ],
    {
      added: ["reference-implementation/test/new.test.ts"],
      addedOrModified: [
        "reference-implementation/test/new.test.ts",
        "reference-implementation/server/leaf.ts",
      ],
      deleted: [],
    },
  );
  assert.deepEqual(result.files, [
    "test/inventory.test.ts",
    "test/new.test.ts",
  ]);
});

test("a fallback keeps full discovery whatever the depth", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(
    root,
    rankedTests,
    {
      addedOrModified: ["reference-implementation/package.json"],
      deleted: [],
    },
    { depth: 1 },
  );
  assert.equal(result.fallback, true);
  assert.deepEqual(result.files, rankedTests);
  assert.deepEqual(formatDepthSummary(result), []);
});

test("parses --depth and refuses the removed --all", () => {
  assert.equal(parseDepth([]), 1);
  assert.equal(parseDepth(["--depth", "3"]), 3);
  assert.throws(() => parseDepth(["--depth", "x"]), /non-negative integer/);
  assert.throws(() => parseDepth(["--depth"]), /non-negative integer/);
  assert.throws(() => parseDepth(["--all"]), /no selection is complete/);
});

test("the depth summary prints per-depth counts and the widen command", async () => {
  const root = await rankedTree();
  const result = await selectAffectedTests(root, rankedTests, leafChange);
  const lines = formatDepthSummary(result);
  assert.match(lines[0] ?? "", /d1=1 d2=1 \(closure 2\); depth used: 1/);
  assert.match(lines[1] ?? "", /--depth N .*still heuristic/);
});

test("resolves a .js import to its .ts source", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/impl.js"),
    "server/impl.ts": "export const value = 1;",
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/server/impl.ts"],
    deleted: [],
  });
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("follows a literal dynamic import", async () => {
  const root = await tree({
    "test/a.test.ts": dynamicImport("../server/later.ts"),
    "server/later.ts": "export const value = 1;",
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/server/later.ts"],
    deleted: [],
  });
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("a JSON asset reached only by new URL falls back", async () => {
  const root = await tree({
    "test/a.test.ts":
      'const path = new URL("../server/config.json", import.meta.url);',
    "server/config.json": '{"enabled":true}',
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/server/config.json"],
    deleted: [],
  });
  assert.deepEqual(result.files, ["test/a.test.ts"]);
  assert.equal(result.fallback, true);
});

test("a changed SQL asset falls back even when a module names it", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/query.ts"),
    "server/query.ts": 'readFileSync("../sql/schema.sql");',
    "sql/schema.sql": "select 1;",
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/sql/schema.sql"],
    deleted: [],
  });
  assert.deepEqual(result.files, ["test/a.test.ts"]);
  assert.equal(result.fallback, true);
});

test("a changed JSON fixture falls back even when a module names it", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/query.ts"),
    "server/query.ts": 'readFileSync("fixture.json");',
    "fixtures/fixture.json": '{"value":1}',
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/fixtures/fixture.json"],
    deleted: [],
  });
  assert.deepEqual(result.files, ["test/a.test.ts"]);
  assert.equal(result.fallback, true);
});

test("falls back for an unreferenced asset", async () => {
  const root = await tree({
    "test/a.test.ts": "test('x', () => {});",
    "assets/readme.txt": "x",
  });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/assets/readme.txt"],
    deleted: [],
  });
  assert.equal(result.fallback, true);
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("falls back for package.json", async () => {
  const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: ["reference-implementation/package.json"],
    deleted: [],
  });
  assert.equal(result.fallback, true);
});

test("falls back for a deleted module", async () => {
  const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: [],
    deleted: ["reference-implementation/server/gone.ts"],
  });
  assert.equal(result.fallback, true);
  assert.match(result.reason, /deleted module/);
});

test("selects nothing for an empty change set", async () => {
  const root = await tree({ "test/a.test.ts": "test('x', () => {});" });
  const result = await selectAffectedTests(root, ["test/a.test.ts"], {
    addedOrModified: [],
    deleted: [],
  });
  assert.deepEqual(result.files, []);
  assert.equal(result.fallback, false);
});

test("rejects a files-from entry outside standalone discovery", async () => {
  await assert.rejects(
    validateFilesFrom(["server/not-a-test.ts"], ["test/a.test.ts"]),
    /outside test discovery/,
  );
});

test("skips full-suite named mapping finalization for files-from runs", async () => {
  const runner = await readFile(
    new URL("./run-tests.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /if \(\s*filesFromIndex === -1 &&\s*!failed &&/,
  );
});

test("a changed root lockfile falls back to full discovery", async () => {
  const [root, riRoot] = await gitTree({
    "package-lock.json": '{"lockfileVersion":3}',
    "reference-implementation/test/a.test.ts": "test('x', () => {});",
    "reference-implementation/test/b.test.ts": "test('y', () => {});",
  });
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":4}');
  const result = await selectAffectedTests(
    riRoot,
    ["test/a.test.ts", "test/b.test.ts"],
    collectChangeSet(riRoot, "HEAD"),
  );
  assert.equal(result.fallback, true);
  assert.deepEqual(result.files, ["test/a.test.ts", "test/b.test.ts"]);
});

test("a changed root package.json falls back to full discovery", async () => {
  const [root, riRoot] = await gitTree({
    "package.json": '{"name":"root"}',
    "reference-implementation/test/a.test.ts": "test('x', () => {});",
  });
  await writeFile(join(root, "package.json"), '{"name":"changed"}');
  const result = await selectAffectedTests(
    riRoot,
    ["test/a.test.ts"],
    collectChangeSet(riRoot, "HEAD"),
  );
  assert.equal(result.fallback, true);
});

test("a changed file unrelated to the RI does not force a fallback", async () => {
  const [root, riRoot] = await gitTree({
    "docs/note.md": "a",
    "reference-implementation/test/a.test.ts": "test('x', () => {});",
  });
  await writeFile(join(root, "docs/note.md"), "b");
  const result = await selectAffectedTests(
    riRoot,
    ["test/a.test.ts"],
    collectChangeSet(riRoot, "HEAD"),
  );
  assert.equal(result.fallback, false);
  assert.deepEqual(result.files, []);
});

test("a renamed test file triggers the test-tree inventory tests", async () => {
  const body = "test('same body so git detects a rename', () => {});\n".repeat(
    20,
  );
  const [root, riRoot] = await gitTree({
    "reference-implementation/test/old-name.test.ts": body,
    "reference-implementation/test/inventory.test.ts": inventorySource,
    "reference-implementation/test/other.test.ts": "test('o', () => {});",
  });
  git(
    root,
    "mv",
    "reference-implementation/test/old-name.test.ts",
    "reference-implementation/test/new-name.test.ts",
  );
  const result = await selectAffectedTests(
    riRoot,
    ["test/new-name.test.ts", "test/inventory.test.ts", "test/other.test.ts"],
    collectChangeSet(riRoot, "HEAD"),
  );
  assert.equal(result.fallback, true);
  assert.match(result.reason, /deleted module/);
  assert.ok(result.files.includes("test/inventory.test.ts"));
});

test("a changed asset read by several modules falls back", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/a.ts"),
    "test/b.test.ts": staticImport("../server/b.ts"),
    "server/a.ts": 'readFileSync("shared.sql");',
    "server/b.ts": 'readFileSync("shared.sql");',
    "sql/shared.sql": "select 1;",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/sql/shared.sql"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.deepEqual(result.files, ["test/a.test.ts", "test/b.test.ts"]);
  assert.equal(result.fallback, true);
});

test("a JSON asset with an import edge falls back", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/a.ts"),
    "test/b.test.ts": staticImport("../server/b.ts"),
    "server/a.ts": `import data from "../fixtures/data.json";`,
    "server/b.ts": 'readFileSync("data.json");',
    "fixtures/data.json": '{"v":1}',
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/fixtures/data.json"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.deepEqual(result.files, ["test/a.test.ts", "test/b.test.ts"]);
  assert.equal(result.fallback, true);
});

test("a non-JSON asset with a URL reader falls back", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/a.ts"),
    "test/b.test.ts": staticImport("../server/b.ts"),
    "server/a.ts": 'const template = new URL("../fixtures/template.txt", import.meta.url);',
    "server/b.ts": 'readFileSync("fixtures/template.txt");',
    "fixtures/template.txt": "hello",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/fixtures/template.txt"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.deepEqual(result.files, ["test/a.test.ts", "test/b.test.ts"]);
  assert.equal(result.fallback, true);
});

test("a file name in a comment never narrows an asset change", async () => {
  // The real reader builds the asset path at run time; a comment that merely
  // names the file must not stand in for it and suppress the fallback.
  const root = await tree({
    "test/a.test.ts": staticImport("../server/a.ts"),
    "test/b.test.ts": staticImport("../server/b.ts"),
    "server/a.ts": '// formerly loaded "other/template.txt"\nexport const a = 1;',
    "server/b.ts": 'readFileSync(["tem", "plate.txt"].join(""));',
    "fixtures/template.txt": "hello",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/fixtures/template.txt"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.equal(result.fallback, true);
  assert.deepEqual(result.files, ["test/a.test.ts", "test/b.test.ts"]);
});

test("a literal require in a CommonJS module is an import edge", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/a.cjs"),
    "test/b.test.ts": staticImport("../server/b.ts"),
    "server/a.cjs": 'const leaf = require("./leaf.cjs");',
    "server/leaf.cjs": "module.exports = 1;",
    "server/b.ts": "export const b = 1;",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/server/leaf.cjs"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.equal(result.fallback, false);
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});

test("an edited existing test also selects the test-tree inventory tests", async () => {
  const root = await tree({
    "test/edited.test.ts": "test('edited', () => {}); // initPostgresStorage",
    "test/inventory.test.ts": inventorySource,
    "test/other.test.ts": "test('other', () => {});",
  });
  const result = await selectAffectedTests(
    root,
    ["test/edited.test.ts", "test/inventory.test.ts", "test/other.test.ts"],
    {
      addedOrModified: ["reference-implementation/test/edited.test.ts"],
      deleted: [],
    },
  );
  assert.deepEqual(result.files, ["test/edited.test.ts", "test/inventory.test.ts"]);
});

// Known recall gap, kept visible on purpose: a static graph cannot see an
// import whose specifier is computed at run time, so the second consumer of a
// changed leaf module is not selected. This test pins the gap as it is (it
// does not use `todo`, whose failing body the RI reporter counts as a failed
// event); if selection learns to see the consumer, update it.
// test:fast is an edit-loop heuristic; the full RI gate is the backstop.
test("known gap: a variable import of a changed module is not selected", async () => {
  const root = await tree({
    "test/a.test.ts": staticImport("../server/leaf.ts"),
    "test/b.test.ts": 'const name = "../server/" + "leaf.ts"; await import(name);',
    "server/leaf.ts": "export const leaf = 1;",
  });
  const result = await selectAffectedTests(
    root,
    ["test/a.test.ts", "test/b.test.ts"],
    {
      addedOrModified: ["reference-implementation/server/leaf.ts"],
      deleted: [],
    },
    { depth: "all" },
  );
  assert.equal(result.fallback, false);
  assert.deepEqual(result.files, ["test/a.test.ts"]);
});
