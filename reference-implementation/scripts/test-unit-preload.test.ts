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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyResolution,
  DENIED_SQL_DRIVERS,
  DENIED_STORAGE_MODULES,
  matchesDeniedBuiltin,
  matchesDeniedDriverPath,
  matchesDeniedSpecifier,
} from "./test-unit-preload.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(__dirname, "test-unit-preload.mjs");
const RI_ROOT = join(__dirname, "..");
const GUARD_MESSAGE_RE = /unit storage guard/;
const ONE_PASS_RE = /pass 1/;
const LOADED_DRIVER_RE = /LOADED DRIVER/;
const ALLOWED_OK_RE = /ALLOWED OK/;
const SQL_RESULT_RE = /SQL RESULT/;
const PAST_CATCH_RE = /PAST CATCH/;

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

/**
 * Like `runGuarded`, but the subject file is written INSIDE the RI tree.
 *
 * Node resolves bare specifiers from the importing file's location, so a
 * subject in the OS temp directory cannot reach the repo's `node_modules` and
 * `require.resolve("pg")` throws MODULE_NOT_FOUND there. The pre-resolved-path
 * routes below must resolve the genuine installed driver to be worth anything,
 * so they need a subject that sits where a real test file sits.
 */
function runGuardedInTree(source: string, { guard = "1" }: { guard?: string } = {}) {
  const dir = mkdtempSync(join(RI_ROOT, ".pdpp-unit-guard-"));
  const file = join(dir, "subject.test.mjs");
  try {
    writeFileSync(file, source);
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

// A driver reached through its already-resolved location never spells the
// package name as a specifier, so the specifier rule alone cannot see it. These
// use the REAL installed drivers rather than synthetic path strings, because
// the rule is now the driver's real resolved root: a made-up path under a
// directory named `node_modules/pg` is not the driver and must not be treated
// as proof that it is.
const requireHere = createRequire(import.meta.url);

for (const [form, target, pkg] of [
  ["entry point", "pg", "pg"],
  ["package subpath file", "pg/lib/client.js", "pg"],
  ["native package entry", "better-sqlite3", "better-sqlite3"],
] as const) {
  test(`the real installed driver reached by ${form} is matched on its identity`, () => {
    const resolved = requireHere.resolve(target);
    const asFileUrl = pathToFileURL(resolved).href;

    assert.equal(matchesDeniedDriverPath(resolved, pkg), true);
    assert.equal(matchesDeniedDriverPath(asFileUrl, pkg), true);
    // Neither spelling names the package, so identity is the only thing that
    // can catch them.
    assert.equal(matchesDeniedSpecifier(resolved, pkg), false);
    assert.equal(classifyResolution(asFileUrl, asFileUrl)?.kind, "sql-driver");
  });
}

test("a path that merely contains a denied package name is not the driver", () => {
  // This is what replaced the old `node_modules/<pkg>/` substring rule. That
  // rule was an installation-layout guess: it would have called every path
  // below a directory of that name a driver, and missed a driver installed
  // anywhere else. Identity is the resolved real root, so these are not
  // matched -- they do not resolve inside it.
  for (const notTheDriver of [
    "/nowhere/node_modules/pg/lib/index.js",
    "file:///nowhere/node_modules/better-sqlite3/lib/index.js",
    "/tmp/vendor/pg/lib/client.js",
  ]) {
    assert.equal(matchesDeniedDriverPath(notTheDriver, "pg"), false);
    assert.equal(matchesDeniedDriverPath(notTheDriver, "better-sqlite3"), false);
  }
});

test("a genuinely installed lookalike package is outside the denied roots", () => {
  // sqlite-vec is really installed, so this compares real root against real
  // root rather than trusting a string boundary.
  const lookalike = requireHere.resolve("sqlite-vec");

  assert.equal(matchesDeniedDriverPath(lookalike, "pg"), false);
  assert.equal(matchesDeniedDriverPath(lookalike, "better-sqlite3"), false);
  assert.equal(classifyResolution(lookalike, pathToFileURL(lookalike).href), undefined);
});

test("a builtin has no package directory and is covered by the builtin rule", () => {
  // `node:sqlite` cannot be reached through a file path, so a path rule for it
  // would be dead weight.
  assert.equal(matchesDeniedDriverPath("/repo/node_modules/node:sqlite/index.js", "node:sqlite"), false);
  assert.equal(classifyResolution("node:sqlite", "node:sqlite")?.kind, "sql-driver");
  assert.equal(matchesDeniedBuiltin("node:sqlite"), "node:sqlite");
});

// The executed half of the resolved-identity rule. These spawn real child
// processes and assert on the real exit code, because the bypass they close
// was an exit-0 run that loaded the genuine driver: an in-process assertion
// about matching would not have caught it.
test("a driver imported by pre-resolved file URL fails the run", () => {
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'test("reaches pg through a computed file URL", async () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = await import(pathToFileURL(req.resolve("pg")).href);',
      '  console.log("LOADED DRIVER", typeof loaded.default.Client);',
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  // The driver must not have evaluated. Resolution-only denial means the
  // import never returns, so the marker can never be printed.
  assert.doesNotMatch(result.output, LOADED_DRIVER_RE);
});

test("a driver imported by pre-resolved absolute path fails the run", () => {
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'test("reaches better-sqlite3 through its absolute path", async () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = await import(req.resolve("better-sqlite3"));',
      '  console.log("LOADED DRIVER", typeof loaded.default);',
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  assert.doesNotMatch(result.output, LOADED_DRIVER_RE);
});

test("a driver reached through createRequire fails the run", () => {
  // `createRequire(import.meta.url)("better-sqlite3")` is how the RI's own
  // server/db.ts reaches SQLite, so this form must never be admissible.
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'test("reaches better-sqlite3 through createRequire", () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = req("better-sqlite3");',
      '  console.log("LOADED DRIVER", typeof loaded);',
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  assert.doesNotMatch(result.output, LOADED_DRIVER_RE);
});

test("a driver required by its own resolved path fails the run", () => {
  // createRequire combined with the resolved-path route: neither the call nor
  // the specifier names the package.
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'test("requires pg by resolved path", () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = req(req.resolve("pg"));',
      '  console.log("LOADED DRIVER", typeof loaded.Client);',
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  assert.doesNotMatch(result.output, LOADED_DRIVER_RE);
});

test("catching a pre-resolved driver denial does not turn the run green", () => {
  // The combination that section-level review is most concerned with: a
  // computed file URL AND a swallowed error. Every assertion passes and the
  // body completes, yet the run still fails on the recorded violation.
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'test("swallows a computed-URL denial", async () => {',
      "  const req = createRequire(import.meta.url);",
      "  try {",
      '    await import(pathToFileURL(req.resolve("pg")).href);',
      "  } catch {",
      "    // deliberately ignored",
      "  }",
      "});",
    ].join("\n")
  );

  assert.match(result.output, ONE_PASS_RE, result.output);
  assert.notEqual(result.status, 0, "a swallowed computed-URL violation must still fail the run");
  assert.match(result.output, GUARD_MESSAGE_RE);
});

test("a real installed lookalike package still loads under the guard", () => {
  // sqlite-vec is genuinely installed and resolves through
  // node_modules/sqlite-vec/, so this is the false-positive control against
  // real resolution rather than a synthetic path string.
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'test("loads sqlite-vec", async () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = await import(req.resolve("sqlite-vec"));',
      '  console.log("ALLOWED OK", typeof loaded);',
      "});",
    ].join("\n")
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, GUARD_MESSAGE_RE);
  assert.match(result.output, ALLOWED_OK_RE);
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

// `process.getBuiltinModule` returns a builtin without resolving anything, so
// the resolve hook never sees it. Before the builtin guard existed, the first
// case below printed a real query result and exited 0. Each route is asserted
// separately, and the computed-name case matters most: it is the one a scan for
// literal names could never cover, and it is covered here because the check
// runs on the argument's runtime value.
test("a builtin fetched through getBuiltinModule fails the run", () => {
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'test("executes real SQL through getBuiltinModule", () => {',
      '  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");',
      '  const db = new DatabaseSync(":memory:");',
      '  console.log("SQL RESULT", db.prepare("select 42 AS answer").get().answer);',
      "  db.close();",
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  // No query may have run: denial happens before the module is handed over.
  assert.doesNotMatch(result.output, SQL_RESULT_RE);
});

test("a builtin fetched by computed name fails the run", () => {
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'test("computes the builtin name", () => {',
      '  const name = "node:" + "sqlite";',
      "  const { DatabaseSync } = process.getBuiltinModule(name);",
      '  const db = new DatabaseSync(":memory:");',
      '  console.log("SQL RESULT", db.prepare("select 7 AS answer").get().answer);',
      "  db.close();",
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  assert.doesNotMatch(result.output, SQL_RESULT_RE);
});

test("catching a getBuiltinModule denial does not turn the run green", () => {
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'test("swallows the builtin denial", () => {',
      "  try {",
      '    process.getBuiltinModule("node:sqlite");',
      "  } catch {",
      "    // deliberately ignored",
      "  }",
      '  console.log("PAST CATCH");',
      "});",
    ].join("\n")
  );

  // The body completes and its assertions pass, and the run still fails.
  assert.match(result.output, PAST_CATCH_RE, result.output);
  assert.match(result.output, ONE_PASS_RE);
  assert.notEqual(result.status, 0, "a swallowed builtin violation must still fail the run");
});

test("a builtin required through createRequire fails the run", () => {
  // require() of a builtin is served from the builtin table without consulting
  // the resolve hook, so this needs the CJS side of the builtin guard.
  const result = runGuardedInTree(
    [
      'import test from "node:test";',
      'import { createRequire } from "node:module";',
      'test("requires the builtin", () => {',
      "  const req = createRequire(import.meta.url);",
      '  const loaded = req("node:sqlite");',
      '  console.log("LOADED DRIVER", typeof loaded.DatabaseSync);',
      "});",
    ].join("\n")
  );

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, GUARD_MESSAGE_RE);
  assert.doesNotMatch(result.output, LOADED_DRIVER_RE);
});

// The false-positive side of the builtin rule. Every test file in the
// repository reaches for node:path and node:fs, so a rule that caught them
// would break the whole lane rather than guard it.
for (const [form, source] of [
  [
    "getBuiltinModule",
    'const p = process.getBuiltinModule("node:path");\nconsole.log("ALLOWED OK", p.join("a", "b"));',
  ],
  [
    "createRequire",
    'import { createRequire } from "node:module";\nconst p = createRequire(import.meta.url)("node:path");\nconsole.log("ALLOWED OK", p.join("a", "b"));',
  ],
] as const) {
  test(`an allowed builtin reached through ${form} still loads`, () => {
    const result = runGuardedInTree(`import test from "node:test";\n${source}\ntest("uses path", () => {});\n`);

    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, GUARD_MESSAGE_RE);
    assert.match(result.output, ALLOWED_OK_RE);
  });
}

// The name rule itself, on runtime values rather than source text.
test("a denied builtin is recognised by canonical name, however it is written", () => {
  assert.equal(matchesDeniedBuiltin("node:sqlite"), "node:sqlite");
  // The bare name canonicalises to the same builtin.
  assert.equal(matchesDeniedBuiltin("sqlite"), "node:sqlite");
  // A computed value is just a string by the time it arrives here.
  assert.equal(matchesDeniedBuiltin(`node:${"sqlite"}`), "node:sqlite");
});

test("allowed builtins and non-strings are not denied", () => {
  for (const allowed of ["node:path", "path", "node:fs", "node:assert", "sqlite-vec", ""]) {
    assert.equal(matchesDeniedBuiltin(allowed), undefined);
  }
  assert.equal(matchesDeniedBuiltin(undefined), undefined);
  assert.equal(matchesDeniedBuiltin(null), undefined);
});

test("a driver is denied by its real installed root, not by a path substring", () => {
  // The rule is identity: the driver's own resolved package root. A file that
  // merely sits under some directory named like the package is not the driver.
  const realDriver = createRequire(import.meta.url).resolve("pg");

  assert.equal(classifyResolution(realDriver, realDriver)?.kind, "sql-driver");
  // A path that contains the package name as a plain substring is not matched
  // on that basis -- it does not resolve inside the real root.
  assert.equal(classifyResolution("/somewhere/pg/lib/index.js", "/somewhere/pg/lib/index.js"), undefined);
});
