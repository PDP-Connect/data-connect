// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Checks for the unit storage guard. The matching rules are checked in
// process; the two properties that only hold end to end -- that the guard
// denies a real load through the real tsx/module chain, and that catching the
// denial still fails the run -- are checked by spawning actual child
// processes, because an in-process assertion about an exit code proves
// nothing about the exit code.

import { strict as assert } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyResolution,
  DENIED_SQL_DRIVERS,
  DENIED_STORAGE_MODULES,
  matchesDeniedSpecifier,
} from "./test-unit-preload.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(__dirname, "test-unit-preload.mjs");
const RI_ROOT = join(__dirname, "..");
const GUARD_MESSAGE_RE = /unit storage guard/;
const ONE_PASS_RE = /pass 1/;

/**
 * Run `source` as a test file under the guard, through the same
 * `--import tsx --import <preload>` chain the runner uses. Returns the child's
 * status and output so a test can assert on the real exit code.
 */
function runGuarded(source: string, { guard = "1" }: { guard?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-unit-guard-"));
  const file = join(dir, "subject.test.mjs");
  try {
    writeFileSync(file, source);
    // NODE_TEST_CONTEXT is set in this process because these checks
    // themselves run under `node --test`. Inherited, it makes the child
    // believe it is already inside a test run and skip its own files, so it
    // must be dropped for the child to actually execute anything.
    const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, "--test", file], {
      cwd: RI_ROOT,
      encoding: "utf8",
      env: { ...env, PDPP_TEST_UNIT_GUARD: guard },
      timeout: 120_000,
    });
    return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("the guard is inert unless explicitly enabled", () => {
  // Having the preload on disk, or importing it by accident, must never deny
  // storage to a real run. Activation is opt-in, exactly as the hermetic
  // network guard is.
  const result = runGuarded('import test from "node:test";\nimport "node:sqlite";\ntest("loads sqlite", () => {});\n', {
    guard: "0",
  });

  assert.equal(result.status, 0, result.output);
});

// Per specifier form. A rule that matches "pg/lib/client" but not "pg"
// reports zero violations on a file that plainly imports Postgres -- a silent
// false pass, and the worst thing this guard could do. Each form is asserted
// on its own so no single spelling can regress unnoticed.
for (const [form, specifier, pkg] of [
  ["bare package", "pg", "pg"],
  ["package subpath", "pg/lib/client", "pg"],
  ["deep package subpath", "pg/lib/connection-parameters", "pg"],
  ["native package", "better-sqlite3", "better-sqlite3"],
  ["node: builtin", "node:sqlite", "node:sqlite"],
  ["bare builtin", "sqlite", "node:sqlite"],
] as const) {
  test(`a denied ${form} specifier is matched`, () => {
    assert.equal(matchesDeniedSpecifier(specifier, pkg), true);
    assert.equal(classifyResolution(specifier, undefined)?.kind, "sql-driver");
  });
}

test("a package whose name merely begins with a denied name is allowed", () => {
  // pgvector and pg-boss are not pg. A guard with false positives is a guard
  // somebody switches off.
  for (const allowed of ["pgvector", "pg-boss", "pgtools/index.js"]) {
    assert.equal(matchesDeniedSpecifier(allowed, "pg"), false);
    assert.equal(classifyResolution(allowed, undefined), undefined);
  }
});

test("a storage module is matched on its resolved path, not its spelling", () => {
  // The specifier "../server/db.ts" names none of the denied strings on its
  // own; the resolved path is what identifies it.
  for (const module of DENIED_STORAGE_MODULES) {
    const resolved = `file:///repo/reference-implementation/${module}`;
    assert.equal(classifyResolution("../whatever.ts", resolved)?.kind, "storage-module");
  }
});

test("ordinary modules resolve untouched", () => {
  assert.equal(classifyResolution("node:path", "node:path"), undefined);
  assert.equal(classifyResolution("./helpers/fixture.ts", "file:///repo/test/helpers/fixture.ts"), undefined);
});

test("every denied driver is classified as a driver, not silently ignored", () => {
  for (const driver of DENIED_SQL_DRIVERS) {
    assert.equal(classifyResolution(driver, undefined)?.rule, driver);
  }
});

test("a test that loads a denied builtin fails the run", () => {
  const result = runGuarded('import test from "node:test";\nimport "node:sqlite";\ntest("loads sqlite", () => {});\n');

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
});

test("a test that loads a real storage module fails the run", () => {
  // The genuine article: the RI's own SQLite entry point, resolved through
  // tsx exactly as a real test file would reach it.
  const result = runGuarded(
    `import test from "node:test";\nimport "${join(RI_ROOT, "server", "db.ts").replaceAll("\\", "/")}";\ntest("loads db", () => {});\n`
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
});

test("catching the denial does not turn the run green", () => {
  // This is the property that makes the guard worth having. A mislabelled
  // file that wraps its own database import in try/catch, or asserts that the
  // import throws, would defeat a guard that only threw. The violation is
  // recorded outside the assertion and forced onto the exit code, so the run
  // still fails while every individual test reports as passing.
  const result = runGuarded(
    [
      'import test from "node:test";',
      'test("swallows the guard", async () => {',
      "  try {",
      '    await import("node:sqlite");',
      "  } catch {",
      "    // deliberately ignored",
      "  }",
      "});",
    ].join("\n")
  );

  assert.match(result.output, ONE_PASS_RE, result.output);
  assert.notEqual(result.status, 0, "a swallowed violation must still fail the run");
  assert.match(result.output, GUARD_MESSAGE_RE);
});

test("an admissible unit test passes unchanged under the guard", () => {
  // Resolution-only means an allowed test observes nothing different. If this
  // ever fails, the guard has started changing behaviour rather than just
  // watching it.
  const source = [
    'import { strict as assert } from "node:assert/strict";',
    'import { join } from "node:path";',
    'import test from "node:test";',
    'test("does arithmetic and path work", () => {',
    '  assert.equal(join("a", "b"), "a/b");',
    "  assert.equal(2 + 2, 4);",
    "});",
  ].join("\n");

  const guarded = runGuarded(source);
  const unguarded = runGuarded(source, { guard: "0" });

  assert.equal(guarded.status, 0, guarded.output);
  assert.equal(unguarded.status, 0, unguarded.output);
  assert.match(guarded.output, ONE_PASS_RE);
  assert.doesNotMatch(guarded.output, GUARD_MESSAGE_RE);
});
