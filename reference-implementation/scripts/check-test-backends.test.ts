// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture-driven checks for the backend classifier. Each case builds the
// exact disagreement it is about -- a manifest that omits a file, one that
// names a file that no longer exists, one that declares a database-importing
// file as needing no database -- and asserts the checker rejects it. The
// positive controls matter as much as the negative ones: a checker that
// rejects everything is as useless as one that rejects nothing.

import { strict as assert } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type Backend,
  checkBackendManifest,
  enumerateTestEntries,
  importedSpecifiers,
  specifierNamesPackage,
  specifierNamesStorageModule,
  storageImports,
} from "./check-test-backends.ts";
import { trackedFiles } from "./test-accounting/inventory.ts";

const NO_SOURCE = () => "";
const NOT_ONE_OF_RE = /not one of/;
const STORAGE_MODULE_RE = /storage module/;
const MISSING_OR_STALE_RE = /missing-entry|stale-entry/;
const USAGE_RE = /usage/;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-test-backends.ts");
const RI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run the checker as a real command and return its actual exit code.
 *
 * The exit code is the entire contract of a CLI gate, and an in-process
 * assertion cannot observe it: before the entry guard existed, calling the
 * exported `main` rejected a bad manifest while running the file as a command
 * exited 0 and printed nothing.
 */
function runCli(args: readonly string[]) {
  const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: RI_ROOT,
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Write a manifest to a scratch file and hand its path to the CLI. */
function runCliWithManifest(manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-backend-cli-"));
  try {
    const file = join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    return runCli([file]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function sourcesFor(sources: Record<string, string>) {
  return (path: string) => sources[path] ?? "";
}

test("a manifest that matches the enumerated entries exactly is accepted", () => {
  const enumerated = ["reference-implementation/test/a.test.ts", "reference-implementation/test/b.test.ts"];
  const violations = checkBackendManifest(
    {
      entries: [
        { backend: "none", path: "reference-implementation/test/a.test.ts" },
        { backend: "postgres", path: "reference-implementation/test/b.test.ts" },
      ],
    },
    enumerated,
    NO_SOURCE
  );

  assert.deepEqual(violations, []);
});

test("an enumerated entry absent from the manifest is rejected as missing", () => {
  const violations = checkBackendManifest(
    { entries: [{ backend: "none", path: "reference-implementation/test/a.test.ts" }] },
    ["reference-implementation/test/a.test.ts", "reference-implementation/test/unclassified.test.ts"],
    NO_SOURCE
  );

  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.path]),
    [["missing-entry", "reference-implementation/test/unclassified.test.ts"]]
  );
});

test("a manifest entry with no enumerated test entry is rejected as stale", () => {
  const violations = checkBackendManifest(
    {
      entries: [
        { backend: "none", path: "reference-implementation/test/a.test.ts" },
        { backend: "sqlite", path: "reference-implementation/test/deleted.test.ts" },
      ],
    },
    ["reference-implementation/test/a.test.ts"],
    NO_SOURCE
  );

  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.path]),
    [["stale-entry", "reference-implementation/test/deleted.test.ts"]]
  );
});

test("a path declared twice is rejected as a duplicate before the set conversion hides it", () => {
  // The two entries disagree about the backend. A map-keyed manifest would
  // keep only the last one and report a clean run, which is the bug this
  // array-plus-duplicate-check shape exists to prevent.
  const violations = checkBackendManifest(
    {
      entries: [
        { backend: "postgres", path: "reference-implementation/test/a.test.ts" },
        { backend: "none", path: "reference-implementation/test/a.test.ts" },
      ],
    },
    ["reference-implementation/test/a.test.ts"],
    NO_SOURCE
  );

  assert.deepEqual(
    violations.map((violation) => violation.kind),
    ["duplicate-entry"]
  );
});

test("a backend outside the declared set is rejected", () => {
  const violations = checkBackendManifest(
    {
      entries: [{ backend: "mixed" as unknown as Backend, path: "reference-implementation/test/a.test.ts" }],
    },
    ["reference-implementation/test/a.test.ts"],
    NO_SOURCE
  );

  assert.deepEqual(
    violations.map((violation) => violation.kind),
    ["unknown-backend"]
  );
  assert.match(violations[0]?.detail ?? "", NOT_ONE_OF_RE);
});

test("a file importing a database cannot be declared as needing none", () => {
  const violations = checkBackendManifest(
    { entries: [{ backend: "none", path: "reference-implementation/test/a.test.ts" }] },
    ["reference-implementation/test/a.test.ts"],
    sourcesFor({
      "reference-implementation/test/a.test.ts": 'import { getDb } from "../server/db.ts";\n',
    })
  );

  assert.deepEqual(
    violations.map((violation) => violation.kind),
    ["storage-import-in-none"]
  );
  assert.match(violations[0]?.detail ?? "", STORAGE_MODULE_RE);
});

test("the same file declared with a real backend is accepted", () => {
  // The import check adds obligations; it never invents them. Declaring the
  // backend the code actually needs must pass, or the checker would just be
  // banning database tests.
  const violations = checkBackendManifest(
    { entries: [{ backend: "sqlite", path: "reference-implementation/test/a.test.ts" }] },
    ["reference-implementation/test/a.test.ts"],
    sourcesFor({
      "reference-implementation/test/a.test.ts": 'import { getDb } from "../server/db.ts";\n',
    })
  );

  assert.deepEqual(violations, []);
});

// Per-specifier-form coverage. A deny rule that matches a subpath but not the
// bare specifier reports zero violations on a file that genuinely imports
// Postgres -- a silent false pass. Every form is asserted separately so no
// single spelling can regress unnoticed.
for (const [form, specifier, pkg] of [
  ["bare package", "pg", "pg"],
  ["package subpath", "pg/lib/client", "pg"],
  ["node: builtin", "node:sqlite", "node:sqlite"],
  ["bare builtin", "sqlite", "node:sqlite"],
  ["native package", "better-sqlite3", "better-sqlite3"],
] as const) {
  test(`a denied ${form} specifier is detected`, () => {
    assert.equal(specifierNamesPackage(specifier, pkg), true);
  });
}

test("a package whose name merely starts with a denied name is not detected", () => {
  // "pgvector" is not "pg". Without a separator boundary this check would
  // deny unrelated packages, and a checker with false positives gets disabled.
  assert.equal(specifierNamesPackage("pgvector", "pg"), false);
  assert.equal(specifierNamesPackage("pg-boss", "pg"), false);
});

// Loader paths. A storage import counts however it is written, because the
// choice between static import, dynamic import and require is not a
// meaningful difference in backend obligation.
for (const [loader, source] of [
  ["static import", 'import { getDb } from "../server/db.ts";'],
  ["bare side-effect import", 'import "../server/db.ts";'],
  ["literal dynamic import", 'const db = await import("../server/db.ts");'],
  ["require", 'const db = require("../server/db.ts");'],
  ["createRequire", 'const db = createRequire(import.meta.url)("better-sqlite3");'],
  // Resolving a driver and importing the resulting path is a load whose own
  // import carries no package name. Naming the driver in `resolve` is the last
  // point at which source reading can see it, so it counts here.
  ["resolve then import", 'const url = pathToFileURL(req.resolve("pg")).href;\nconst pg = await import(url);'],
  ["resolve then require", 'const pg = req(req.resolve("pg"));'],
] as const) {
  test(`a storage dependency loaded by ${loader} is detected`, () => {
    assert.notDeepEqual(storageImports(source), []);
  });
}

test("resolving an unrelated package or path is not a storage dependency", () => {
  // `resolve` is a general-purpose call. Only a denied driver name makes it
  // interesting, or every file that uses path.resolve would be flagged.
  for (const source of [
    'const v = req.resolve("pgvector");',
    'const p = path.resolve("a", "b");',
    'const p = resolve(dir, "fixture.json");',
  ]) {
    assert.deepEqual(storageImports(source), []);
  }
});

test("a computed specifier yields no literal to detect, which bounds this check", () => {
  // Recorded deliberately: source reading cannot recover a computed
  // specifier, so this checker cannot be the only control. The runtime guard
  // in scripts/test-unit-preload.mjs covers the executed case.
  assert.deepEqual(storageImports('const db = await import(base + "/db.ts");'), []);
});

test("ordinary non-storage imports are not flagged", () => {
  assert.deepEqual(storageImports('import { join } from "node:path";\nimport test from "node:test";'), []);
});

test("importedSpecifiers recovers each literal specifier once", () => {
  assert.deepEqual(importedSpecifiers('import a from "node:path";\nimport a2 from "node:path";\nrequire("pg");'), [
    "node:path",
    "pg",
  ]);
});

test("a storage module is recognised through any relative spelling", () => {
  assert.equal(specifierNamesStorageModule("../server/db.ts"), "server/db.ts");
  assert.equal(specifierNamesStorageModule("../../reference-implementation/server/db.ts"), "server/db.ts");
  assert.equal(specifierNamesStorageModule("./helpers/fixture.ts"), undefined);
});

test("enumeration selects tracked RI test entries and nothing else", () => {
  const entries = enumerateTestEntries([
    "reference-implementation/test/a.test.ts",
    "reference-implementation/runtime/b.test.ts",
    "reference-implementation/scripts/c.test.mjs",
    "reference-implementation/server/streaming/d.test.ts",
    // Not test entries: a helper, a product source file, and a test that
    // belongs to a different package.
    "reference-implementation/test/helpers/fixture.ts",
    "reference-implementation/server/db.ts",
    "packages/polyfill-connectors/src/x.test.ts",
  ]);

  assert.deepEqual(entries, [
    "reference-implementation/runtime/b.test.ts",
    "reference-implementation/scripts/c.test.mjs",
    "reference-implementation/server/streaming/d.test.ts",
    "reference-implementation/test/a.test.ts",
  ]);
});

test("every violation kind reports the path it concerns", () => {
  const violations = checkBackendManifest(
    {
      entries: [
        { backend: "none", path: "reference-implementation/test/dup.test.ts" },
        { backend: "none", path: "reference-implementation/test/dup.test.ts" },
        { backend: "none", path: "reference-implementation/test/stale.test.ts" },
      ],
    },
    ["reference-implementation/test/dup.test.ts", "reference-implementation/test/absent.test.ts"],
    NO_SOURCE
  );

  assert.deepEqual(
    violations.map((violation) => [violation.path, violation.kind]),
    [
      ["reference-implementation/test/absent.test.ts", "missing-entry"],
      ["reference-implementation/test/dup.test.ts", "duplicate-entry"],
      ["reference-implementation/test/stale.test.ts", "stale-entry"],
    ]
  );
  for (const violation of violations) {
    assert.notEqual(violation.detail, "");
  }
});

// The command surface. `main` is exported and unit-testable, but a checker is
// only a gate if running it as a command actually fails the caller, so each
// case below asserts on a real process exit code.
test("the command rejects a manifest with a violation", () => {
  const result = runCliWithManifest({
    entries: [{ backend: "none", path: "reference-implementation/test/does-not-exist.test.ts" }],
  });

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, MISSING_OR_STALE_RE);
});

test("the command reports usage and fails when given no manifest", () => {
  // A missing argument must not be a silent success.
  const result = runCli([]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, USAGE_RE);
});

test("the command fails rather than passing when the manifest is unreadable", () => {
  const result = runCli([join(tmpdir(), "pdpp-no-such-manifest-6f2a.json")]);

  assert.notEqual(result.status, 0, result.output);
});

test("the command accepts a manifest that classifies every tracked test entry", () => {
  // The positive control: without it, a checker that rejected everything would
  // pass every test above. The backend value is uniform because this asserts
  // the manifest/tree agreement, not per-file obligations.
  const entries = enumerateTestEntries(trackedFiles(join(RI_ROOT, ".."))).map((path) => ({
    backend: "sqlite" as const,
    path,
  }));
  assert.ok(entries.length > 0, "expected the tracked tree to contain test entries");

  const result = runCliWithManifest({ entries });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`${entries.length} entries classified`));
});
