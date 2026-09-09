// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Resolution-only storage guard for test entries classified as `unit`.
//
// A test file can be labelled `unit` in scripts/test-backends.json and still
// pull in a real database: the label is a declaration, not a proof. The
// backend classifier (scripts/check-test-backends.ts) derives the same
// obligation statically from the import graph, but static analysis cannot see
// every edge -- computed specifiers, code generation and native loading all
// resolve at runtime. This preload is the runtime half of that pair: it
// watches what the process actually resolves and records a violation when a
// unit-classified test reaches a storage module or a SQL driver.
//
// Wiring mirrors scripts/hermetic/preload.ts:
//
//   node --import tsx --import <this file> <unit test files>
//
// tsx registers first so the hook sees the specifiers the test source really
// wrote, before type stripping rewrites anything. This file is inert unless
// PDPP_TEST_UNIT_GUARD === "1", so having it on disk -- or an accidental
// --import of it -- can never deny storage to a real operator or product run.
//
// Two properties matter and are tested in test-unit-preload.test.ts:
//
//  1. Resolution only. The hook rejects at `resolve`, before any module
//     evaluates. It never loads, patches or mocks a database module, so it
//     cannot change what a passing test observes -- an admissible unit test
//     runs byte-identically with the guard on or off.
//
//  2. Violations are recorded outside test assertions. The hook throws at the
//     denied import so the offending load cannot silently proceed, but it
//     also records the violation in module state and forces a non-zero exit
//     code from a `process.on("exit")` handler. A test that wraps its own
//     import in try/catch, or asserts that the import throws, therefore still
//     fails the run. Catching the guard cannot turn a mislabelled file green.
//
// Denial is per specifier FORM, not per file. A pattern that matches
// "pg/lib/client" but not the bare specifier "pg" reports zero violations on a
// file that genuinely imports Postgres, which is a silent false pass -- the
// worst failure mode available to a guard like this. Each denied package is
// therefore matched as: the bare specifier, any subpath under it, and (for
// builtins) the `node:` prefixed form. Relative and absolute specifiers are
// matched on the resolved path instead, so `./db.ts`, `../server/db.ts` and a
// file URL all reach the same rule.
//
// Matching the raw specifier is NOT sufficient on its own, and a guard that
// stops there has an executed hole. A caller can resolve the driver itself and
// import the resulting location, at which point no denied package name is ever
// spelled as a specifier:
//
//   const url = pathToFileURL(createRequire(import.meta.url).resolve("pg")).href;
//   await import(url);   // specifier is "file:///.../node_modules/pg/lib/index.js"
//
// That load reaches the real driver without suppressing an error or opening a
// connection, so neither the specifier rule nor the error path sees it. A
// denied driver is therefore ALSO matched on its resolved package identity --
// the `node_modules/<pkg>/` segment its resolved path must contain -- so every
// spelling that lands inside the driver's own package is denied regardless of
// how it was named. `pgvector`, `pg-boss` and `pgtools` keep resolving, since
// the segment must match the package name exactly and not merely start with it.

import { registerHooks } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Storage modules denied to unit-classified tests, as RI-relative paths.
 * Matched against the RESOLVED path, so every spelling of the same file --
 * relative, absolute, or file URL -- is covered by one entry.
 */
export const DENIED_STORAGE_MODULES = ["server/db.ts", "lib/db.ts", "server/postgres-storage.ts"];

/**
 * SQL drivers denied to unit-classified tests, as package/builtin specifiers.
 * Matched per specifier form: bare, subpath, and the `node:` builtin form.
 */
export const DENIED_SQL_DRIVERS = ["pg", "better-sqlite3", "node:sqlite"];

/** Normalize a specifier or resolved URL to a POSIX-ish path for matching. */
function normalizePath(value) {
  if (!value) {
    return "";
  }
  let path = value;
  if (path.startsWith("file:")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return "";
    }
  }
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Does `specifier` name `pkg` in any of its denied forms?
 *
 * Covers the four forms d3 names, so no single spelling slips through:
 *   bare package     "pg"                -> denied
 *   subpath          "pg/lib/client"     -> denied
 *   node: builtin    "node:sqlite"       -> denied
 *   bare builtin     "sqlite"            -> denied when pkg is "node:sqlite"
 *
 * A prefix test alone would accept "pg" but also wrongly deny "pgvector", so
 * the boundary after the package name must be a path separator or nothing.
 */
export function matchesDeniedSpecifier(specifier, pkg) {
  if (typeof specifier !== "string" || specifier === "") {
    return false;
  }
  const bare = pkg.startsWith("node:") ? pkg.slice("node:".length) : pkg;
  const candidates = pkg.startsWith("node:") ? [pkg, bare] : [pkg, `node:${pkg}`];
  for (const candidate of candidates) {
    if (specifier === candidate) {
      return true;
    }
    if (specifier.startsWith(`${candidate}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Does `resolved` land inside the package `pkg` owns on disk?
 *
 * A resolved driver path always carries the package name as a
 * `node_modules/<pkg>/` segment, so that segment is the driver's identity
 * independent of how it was spelled. The trailing separator is required: it is
 * what keeps `node_modules/pgvector/index.js` and `node_modules/pg-boss/index.js`
 * out while keeping `node_modules/pg/lib/index.js` in. The last occurrence is
 * not special-cased -- a nested `node_modules/foo/node_modules/pg/...` install
 * is still the denied driver and is still matched.
 *
 * Builtins (`node:sqlite`) have no package directory; they are covered by the
 * specifier rule alone, which is exact for them because a builtin cannot be
 * reached through a file path.
 */
export function matchesDeniedDriverPath(resolved, pkg) {
  if (pkg.startsWith("node:")) {
    return false;
  }
  const path = normalizePath(resolved);
  if (path === "") {
    return false;
  }
  return path.includes(`/node_modules/${pkg}/`);
}

/** Does a resolved URL/path point at one of the denied storage modules? */
export function matchesDeniedModule(resolved) {
  const path = normalizePath(resolved);
  if (path === "") {
    return;
  }
  return DENIED_STORAGE_MODULES.find((module) => path.endsWith(`/${module}`) || path === module);
}

/**
 * Classify one resolution. Returns the denied rule, or undefined when the
 * load is admissible. Both the raw specifier and the resolved location are
 * inspected, and for drivers BOTH directions are needed: the specifier rule
 * catches a driver named directly even when resolution fails, while the
 * resolved-path rule catches a driver reached through a pre-resolved file URL
 * or absolute path that never spells the package name. A storage module is
 * likewise caught by resolved path even when it is reached through an alias or
 * a relative specifier that names none of the denied strings.
 */
export function classifyResolution(specifier, resolvedUrl) {
  for (const driver of DENIED_SQL_DRIVERS) {
    if (matchesDeniedSpecifier(specifier, driver) || matchesDeniedDriverPath(resolvedUrl, driver)) {
      return { kind: "sql-driver", rule: driver };
    }
  }
  const module = matchesDeniedModule(resolvedUrl) ?? matchesDeniedModule(specifier);
  if (module) {
    return { kind: "storage-module", rule: module };
  }
}

const violations = [];

/** Violations recorded so far, in resolution order. */
export function recordedViolations() {
  return [...violations];
}

function describe(violation) {
  return `${violation.kind} "${violation.rule}" via specifier "${violation.specifier}"${
    violation.parent ? ` from ${violation.parent}` : ""
  }`;
}

/**
 * Install the guard. Idempotent per process: a second call is a no-op, so an
 * accidental double --import cannot double-count a violation.
 */
let installed = false;
export function installUnitStorageGuard() {
  if (installed) {
    return;
  }
  installed = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Resolve first so aliases, package exports and extensionless
      // specifiers are matched on where they actually land, not on how they
      // were spelled. A specifier that fails to resolve is left to Node's own
      // error, except when its raw form already names a denied driver.
      let resolution;
      try {
        resolution = nextResolve(specifier, context);
      } catch (error) {
        const bySpecifier = classifyResolution(specifier, undefined);
        if (bySpecifier) {
          throw deny(bySpecifier, specifier, context);
        }
        throw error;
      }
      const denied = classifyResolution(specifier, resolution?.url);
      if (denied) {
        throw deny(denied, specifier, context);
      }
      return resolution;
    },
  });

  // Recording the violation outside the thrown error is what makes this
  // guard uncatchable by the code under test: even if every denied import is
  // wrapped in try/catch, or asserted to throw, this handler still fails the
  // process.
  process.on("exit", (code) => {
    if (violations.length === 0) {
      return;
    }
    const lines = violations.map((violation) => `  - ${describe(violation)}`).join("\n");
    process.stderr.write(
      `\nunit storage guard: ${violations.length} denied load(s) in a test classified as unit:\n${lines}\n` +
        "Reclassify the entry in scripts/test-backends.json, or remove the storage dependency.\n"
    );
    if (code === 0) {
      process.exitCode = 1;
    }
  });
}

function deny(denied, specifier, context) {
  const violation = {
    kind: denied.kind,
    parent: context?.parentURL,
    rule: denied.rule,
    specifier,
  };
  violations.push(violation);
  const error = new Error(
    `unit storage guard denied ${describe(violation)}. A test classified as unit must not reach a database.`
  );
  error.code = "ERR_PDPP_UNIT_STORAGE_DENIED";
  return error;
}

if (process.env.PDPP_TEST_UNIT_GUARD === "1") {
  installUnitStorageGuard();
}
