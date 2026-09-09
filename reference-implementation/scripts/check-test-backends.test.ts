// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture-driven checks for the backend classifier. Each case builds the
// exact disagreement it is about -- a manifest that omits a file, one that
// names a file that no longer exists, one that declares a database-importing
// file as needing no database -- and asserts the checker rejects it. The
// positive controls matter as much as the negative ones: a checker that
// rejects everything is as useless as one that rejects nothing.

import { strict as assert } from "node:assert/strict";
import test from "node:test";

import {
  type Backend,
  checkBackendManifest,
  enumerateTestEntries,
  importedSpecifiers,
  specifierNamesPackage,
  specifierNamesStorageModule,
  storageImports,
} from "./check-test-backends.ts";

const NO_SOURCE = () => "";
const NOT_ONE_OF_RE = /not one of/;
const STORAGE_MODULE_RE = /storage module/;

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
] as const) {
  test(`a storage dependency loaded by ${loader} is detected`, () => {
    assert.notDeepEqual(storageImports(source), []);
  });
}

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
