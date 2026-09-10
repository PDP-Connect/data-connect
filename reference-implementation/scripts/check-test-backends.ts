// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend classifier for reference-implementation test entries.
 *
 * Every RI test entry has a backend obligation -- it needs SQLite, it needs
 * Postgres, it needs both, or it needs no database at all -- and today that
 * obligation is implicit. It lives in whichever fixtures a file happens to
 * import, so the only way to learn it is to run the file and watch what it
 * connects to. That makes the obligation invisible to scheduling: a case that
 * requires Postgres and a case that requires nothing look identical to the
 * runner, so the runner cannot allocate a database to the first without
 * allocating one to the second, and cannot tell a Postgres case that silently
 * skipped from one that actually ran.
 *
 * This module makes the obligation explicit and checkable. A manifest
 * declares one entry per test file with a backend; this checker independently
 * enumerates the tracked test files and rejects any disagreement.
 *
 * Two rules carry the weight:
 *
 *   Exact set equality. The manifest must name every enumerated entry and no
 *   others. A missing entry (a new test file nobody classified), a stale
 *   entry (a classification for a deleted file), a duplicate entry and an
 *   unknown backend value all fail. Set equality is what makes the manifest
 *   trustworthy as a scheduling input -- a manifest that merely permits
 *   unlisted files tells the runner nothing about the files it omits.
 *
 *   Declaration is not proof. An entry claiming `none` -- no database -- is
 *   checked against its actual imports, and an entry whose import closure
 *   reaches a storage module or SQL driver is rejected however it is
 *   labelled. There is no override. A label can only ever add an obligation,
 *   never remove one the code demonstrably has.
 *
 * The import scan here is deliberately shallow: it reads the entry file's own
 * static and literal-dynamic imports, and it does not follow the graph
 * transitively or resolve aliases, computed specifiers or generated code.
 * That bounds what it can prove. It catches a file that imports a database
 * directly, which is the common mislabelling; it cannot catch one that
 * reaches storage three modules deep. scripts/test-unit-preload.mjs is the
 * runtime counterpart that closes that gap for executed edges, and the two
 * are meant to be read together -- neither alone is sufficient.
 *
 * Scope note: this checker ships with a fixture-driven test suite and no
 * production manifest. Classifying the full RI inventory is separate work;
 * shipping a partial manifest would be worse than shipping none, because set
 * equality against a partial list is not a meaningful check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compareStrings, EXECUTABLE_TEST_SUFFIX, normalizePath, trackedFiles } from "./test-accounting/inventory.ts";

/** Backends an entry may declare. */
export const BACKENDS = ["none", "sqlite", "postgres", "sqlite+postgres"] as const;
export type Backend = (typeof BACKENDS)[number];

/** One declared test entry. */
export interface BackendEntry {
  /** The backend this entry requires. */
  backend: Backend;
  /** Repository-relative path to the test file. */
  path: string;
}

/**
 * The manifest is an ARRAY, not a map keyed by path. A map cannot represent a
 * duplicate -- a second entry for the same path silently overwrites the first
 * during parsing, so the check would never see it. Duplicates are rejected
 * below, before any conversion to a set.
 */
export interface BackendManifest {
  entries: BackendEntry[];
}

/** Storage modules whose import proves a database obligation. */
export const STORAGE_MODULES = ["server/db.ts", "lib/db.ts", "server/postgres-storage.ts"];

/** SQL driver packages whose import proves a database obligation. */
export const SQL_DRIVERS = ["pg", "better-sqlite3", "node:sqlite"];

/** Directories enumerated for RI test entries, relative to the RI root. */
export const TEST_ROOTS = ["test", "runtime", "scripts", join("server", "streaming")];

export interface Violation {
  detail: string;
  kind: "missing-entry" | "stale-entry" | "duplicate-entry" | "unknown-backend" | "storage-import-in-none";
  path: string;
}

/**
 * Enumerate tracked RI test entries independently of the manifest.
 *
 * Enumeration reads the git index rather than walking the filesystem, so an
 * untracked scratch file cannot enter the inventory and a tracked file cannot
 * hide from it by being absent from a directory listing.
 */
export function enumerateTestEntries(trackedPaths: readonly string[]): string[] {
  const prefix = "reference-implementation/";
  const roots = TEST_ROOTS.map((root) => `${prefix}${normalizePath(root)}/`);
  return trackedPaths
    .map((path) => normalizePath(path))
    .filter((path) => EXECUTABLE_TEST_SUFFIX.test(path) && roots.some((root) => path.startsWith(root)))
    .sort(compareStrings);
}

const STATIC_IMPORT_RE = /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm;
const BARE_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
// `createRequire(import.meta.url)("better-sqlite3")` loads a module without
// the specifier ever appearing inside a call spelled `require(...)`: the
// specifier sits in a call on the RESULT of createRequire. server/db.ts uses
// exactly this shape to reach better-sqlite3, so a scan that only looked for
// `require(` would miss the repository's own primary SQLite entry point.
const CREATE_REQUIRE_CALL_RE = /\bcreateRequire\s*\([^)]*\)\s*\(\s*["']([^"']+)["']\s*\)/g;
// `req.resolve("pg")` turns a package name into a path, which can then be
// imported as a file URL or absolute path. The load that follows carries no
// package name at all, so a scan that ignored `resolve` would report a file
// reaching Postgres as having no storage dependency. Naming a denied driver
// here is treated as reaching it: the only reason to resolve a driver is to
// load it.
const RESOLVE_CALL_RE = /\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g;
// `process.getBuiltinModule("node:sqlite")` returns a builtin without any
// import or require, so it appears in none of the patterns above. The runtime
// guard covers it by wrapping the function; source reading covers the literal
// form here so a mislabelled file is caught before it is ever run.
const GET_BUILTIN_MODULE_RE = /\bgetBuiltinModule\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Literal module specifiers this source uses to reach a module, by any of the
 * loader routes above -- import, require, createRequire, resolve, or
 * process.getBuiltinModule.
 *
 * Only literal specifiers are recoverable by reading source. A computed
 * specifier -- `import(base + name)` -- yields no string here, which is
 * precisely why this checker cannot be the only control.
 */
export function importedSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    STATIC_IMPORT_RE,
    BARE_IMPORT_RE,
    DYNAMIC_IMPORT_RE,
    REQUIRE_RE,
    CREATE_REQUIRE_CALL_RE,
    RESOLVE_CALL_RE,
    GET_BUILTIN_MODULE_RE,
  ]) {
    pattern.lastIndex = 0;
    for (const [, specifier] of source.matchAll(pattern)) {
      if (specifier) {
        found.add(specifier);
      }
    }
  }
  return [...found].sort(compareStrings);
}

/**
 * Does `specifier` name `pkg`, in any of the forms a specifier can take?
 *
 * Matching only the subpath form ("pg/lib/client") while missing the bare
 * form ("pg") reports zero violations on a file that plainly imports
 * Postgres. That is a silent false pass, so every form is matched: bare
 * package, subpath, and both spellings of a builtin. The boundary after the
 * package name must be `/` or end-of-string, or "pg" would also match the
 * unrelated "pgvector".
 */
export function specifierNamesPackage(specifier: string, pkg: string): boolean {
  const bare = pkg.startsWith("node:") ? pkg.slice("node:".length) : pkg;
  const forms = pkg.startsWith("node:") ? [pkg, bare] : [pkg, `node:${pkg}`];
  return forms.some((form) => specifier === form || specifier.startsWith(`${form}/`));
}

/** Does `specifier` point at a known storage module, however it is spelled? */
export function specifierNamesStorageModule(specifier: string): string | undefined {
  const normalized = specifier.replaceAll("\\", "/");
  return STORAGE_MODULES.find((module) => normalized === module || normalized.endsWith(`/${module}`));
}

/**
 * Storage dependencies this source demonstrably has, as human-readable
 * reasons. Empty means "no storage import found by this scan" -- which is a
 * weaker statement than "this file touches no database".
 */
export function storageImports(source: string): string[] {
  const reasons: string[] = [];
  for (const specifier of importedSpecifiers(source)) {
    const driver = SQL_DRIVERS.find((pkg) => specifierNamesPackage(specifier, pkg));
    if (driver) {
      reasons.push(`reaches SQL driver "${specifier}"`);
      continue;
    }
    const module = specifierNamesStorageModule(specifier);
    if (module) {
      reasons.push(`imports storage module "${specifier}"`);
    }
  }
  return reasons;
}

/**
 * Check a manifest against the enumerated entries and the files themselves.
 *
 * Returns every violation found rather than throwing on the first, so one run
 * reports the whole gap instead of revealing it one commit at a time.
 */
export function checkBackendManifest(
  manifest: BackendManifest,
  enumerated: readonly string[],
  readSource: (path: string) => string
): Violation[] {
  const violations: Violation[] = [];
  const entries = manifest.entries ?? [];

  // Duplicates first: this must precede any set conversion, because the
  // conversion is exactly what makes a duplicate invisible.
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (seen.has(path)) {
      violations.push({ detail: "declared more than once", kind: "duplicate-entry", path });
    }
    seen.add(path);
  }

  for (const entry of entries) {
    if (!BACKENDS.includes(entry.backend)) {
      violations.push({
        detail: `backend "${entry.backend}" is not one of ${BACKENDS.join(", ")}`,
        kind: "unknown-backend",
        path: normalizePath(entry.path),
      });
    }
  }

  // Exact set equality in both directions.
  const enumeratedSet = new Set(enumerated.map((path) => normalizePath(path)));
  for (const path of enumeratedSet) {
    if (!seen.has(path)) {
      violations.push({ detail: "test entry is not classified in the manifest", kind: "missing-entry", path });
    }
  }
  for (const path of seen) {
    if (!enumeratedSet.has(path)) {
      violations.push({ detail: "manifest classifies a path that is not a test entry", kind: "stale-entry", path });
    }
  }

  // Declaration is not proof: a `none` entry must survive its own imports.
  for (const entry of entries) {
    if (entry.backend !== "none" || !enumeratedSet.has(normalizePath(entry.path))) {
      continue;
    }
    const path = normalizePath(entry.path);
    for (const reason of storageImports(readSource(path))) {
      violations.push({
        detail: `declared backend "none" but ${reason}`,
        kind: "storage-import-in-none",
        path,
      });
    }
  }

  return violations.sort(
    (a, b) => compareStrings(a.path, b.path) || compareStrings(a.kind, b.kind) || compareStrings(a.detail, b.detail)
  );
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((violation) => `${violation.path}: ${violation.kind}: ${violation.detail}`).join("\n");
}

/**
 * CLI: check a manifest file against the current tracked tree.
 *
 * Returns the intended exit code rather than calling `process.exit`, so the
 * tests can drive it directly.
 */
export function main(manifestPath: string, repoRoot: string): number {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackendManifest;
  const enumerated = enumerateTestEntries(trackedFiles(repoRoot));
  const violations = checkBackendManifest(manifest, enumerated, (path) => readFileSync(join(repoRoot, path), "utf8"));
  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n`);
    return 1;
  }
  process.stdout.write(`test backend manifest: ${enumerated.length} entries classified\n`);
  return 0;
}

// Executed directly, this file is a command and must behave like one. Without
// this guard `node scripts/check-test-backends.ts <bad-manifest>` exited 0 and
// printed nothing -- a checker that passes silently when it was asked to
// check, which is the one failure mode a checker must not have. A missing
// argument is also a failure, not a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , manifestPath] = process.argv;
  if (!manifestPath) {
    process.stderr.write("usage: check-test-backends <manifest.json>\n");
    process.exit(2);
  }
  process.exit(main(manifestPath, join(import.meta.dirname, "..", "..")));
}
