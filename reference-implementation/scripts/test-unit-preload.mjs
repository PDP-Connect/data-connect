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
// Two chokepoints, because resolution is not the only way in. Module
// resolution covers everything loaded by specifier, but a builtin can be
// fetched straight off the process object:
//
//   const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
//   new DatabaseSync(":memory:").prepare("select 42").get();
//
// That executes real SQL and never resolves anything, so a resolve hook cannot
// see it at all. `process.getBuiltinModule` is therefore wrapped as well (the
// CJS `require` path for builtins needs no separate wrap -- `registerHooks`
// already intercepts CJS resolution, see installBuiltinGuard's own doc
// comment). Wrapping the one function that returns builtins is what makes a
// COMPUTED name -- `"node:" + "sqlite"` -- as covered as a literal one: the
// check runs on the runtime value, after any computation.
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
// The lesson of that hole is worth stating, because enumerating spellings is a
// losing game: there is always one more way to name the same file. So the rule
// is not a list of forms but an IDENTITY. A denied target is denied by WHAT IT
// IS, whatever specifier reached it:
//
//   on disk   the resolved real path (symlinks resolved) of the driver's own
//             installed package root, or of a denied storage module
//   builtin   the canonical `node:` name, normalised from the runtime value
//
// The specifier rules below are kept as a cheap first check and as the only
// thing available when resolution itself fails, but they are no longer what
// makes the guard sound. Identity is. `pgvector`, `pg-boss` and `pgtools`
// resolve to their own package roots and so are outside the denied roots --
// a real directory boundary, not a string coincidence.
//
// What this boundary does and does not cover, stated precisely because a
// guard whose promise is vaguer than its rule invites the next surprise:
//
//  COVERED   any load of the installed driver package or a denied storage
//            module, by any specifier -- bare, subpath, relative, absolute,
//            file URL, dynamic, require, createRequire, pre-resolved path --
//            and any access to a denied builtin through import, require or
//            process.getBuiltinModule, by literal or computed name.
//
//  NOT       a COPY of a driver's source at a different real path. That is a
//  COVERED   different file on disk, and identifying it as the same driver
//            would need content fingerprinting, which this guard does not do.
//            A test that vendors its own copy of pg is not what this guard is
//            for; the classifier's source scan is what would notice that.
//            Also not covered: storage reached over a socket by hand-rolled
//            protocol code, or an unexecuted branch (both halves only see
//            what actually runs).

import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, sep } from "node:path";
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
 * Real installed root of each denied driver package, resolved once at install
 * time, keyed by package name. A driver that is not installed is absent.
 *
 * This is the driver's IDENTITY: the directory its own package.json sits in,
 * with symlinks resolved. Resolution and `realpathSync` are what establish it,
 * so a pnpm store path, a workspace symlink and a hoisted install all reduce
 * to the same answer without this file knowing anything about install layout.
 */
const deniedDriverRoots = new Map();

function driverRoots() {
  if (deniedDriverRoots.size > 0) {
    return deniedDriverRoots;
  }
  const require = createRequire(import.meta.url);
  for (const pkg of DENIED_SQL_DRIVERS) {
    if (pkg.startsWith("node:")) {
      continue;
    }
    for (const target of [`${pkg}/package.json`, pkg]) {
      try {
        const resolved = require.resolve(target);
        const root = target.endsWith("package.json") ? dirname(resolved) : resolved;
        deniedDriverRoots.set(pkg, normalizePath(realpathSync(root)));
        break;
      } catch {
        // Not installed, or `exports` hides package.json: try the entry point,
        // and if that also fails leave the package out. An absent driver
        // cannot be loaded, so it needs no rule.
      }
    }
  }
  return deniedDriverRoots;
}

/**
 * Does `resolved` land inside the real installed root of driver `pkg`?
 *
 * Matched on the resolved REAL path, not on a `node_modules/<pkg>/` substring.
 * That substring was an installation-layout heuristic: it happened to hold for
 * a hoisted npm tree and said nothing about identity, so it both missed a
 * driver installed somewhere else and would have caught an unrelated file that
 * merely sat under such a directory. Comparing against the root that
 * resolution itself reports removes the guesswork -- and the prefix boundary
 * that keeps `pgvector` and `pg-boss` out is now a real directory boundary
 * rather than a string coincidence.
 *
 * Builtins have no directory on disk; `matchesDeniedBuiltin` covers them.
 */
export function matchesDeniedDriverPath(resolved, pkg) {
  if (pkg.startsWith("node:")) {
    return false;
  }
  const root = driverRoots().get(pkg);
  if (!root) {
    return false;
  }
  const path = normalizePath(resolved);
  if (path === "") {
    return false;
  }
  let real = path;
  try {
    real = normalizePath(realpathSync(path));
  } catch {
    // Not a path that exists (a builtin, or a URL scheme we do not handle).
    // Fall through and compare the normalized form as given.
  }
  return real === root || real.startsWith(`${root}/`);
}

/**
 * Canonical `node:` name for a builtin request, or undefined if `name` does
 * not identify a builtin this guard denies.
 *
 * Normalisation is done on the runtime VALUE, which is what makes this immune
 * to how the name was written. `process.getBuiltinModule("node:" + "sqlite")`
 * and a literal `"node:sqlite"` arrive here as the same string, so a computed
 * name cannot evade the check the way it evades a source-text scan.
 */
export function matchesDeniedBuiltin(name) {
  if (typeof name !== "string" || name === "") {
    return;
  }
  const canonical = name.startsWith("node:") ? name : `node:${name}`;
  return DENIED_SQL_DRIVERS.find((pkg) => pkg === canonical);
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

  installBuiltinGuard();

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

/**
 * Close the route that does not resolve anything.
 *
 * `process.getBuiltinModule(name)` hands back a builtin directly, without
 * consulting module resolution, so the resolve hook cannot see it. Wrapping
 * that one function closes the route -- and because the check runs on the
 * argument's runtime value, a COMPUTED name is covered exactly as a literal
 * one is. That is the point of guarding the function rather than scanning for
 * spellings of the name.
 *
 * The CJS `require("node:sqlite")` path needs nothing here: `registerHooks`
 * intercepts CJS resolution as well, so the resolve hook above already denies
 * it. Verified by disabling this function and re-probing that route -- it
 * still fails. A second wrap of `Module._load` would be dead code around a
 * Node internal.
 */
function installBuiltinGuard() {
  const originalGetBuiltinModule = process.getBuiltinModule;
  if (typeof originalGetBuiltinModule === "function") {
    process.getBuiltinModule = function getBuiltinModule(name) {
      const denied = matchesDeniedBuiltin(name);
      if (denied) {
        throw deny({ kind: "sql-driver", rule: denied }, String(name), undefined);
      }
      return originalGetBuiltinModule.call(this, name);
    };
  }
}

/**
 * Record a violation and build the error to throw.
 *
 * `parent` is a parentURL when the resolve hook calls this and a filename when
 * the builtin guard does; both are only ever used for the diagnostic, so
 * either is accepted as-is.
 */
function deny(denied, specifier, parent) {
  const violation = {
    kind: denied.kind,
    parent: typeof parent === "string" ? parent : parent?.parentURL,
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
