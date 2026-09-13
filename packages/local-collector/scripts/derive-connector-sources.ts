#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Derive the set of `packages/polyfill-connectors/src/` modules the bundled
 * connectors actually reach, by walking their import graph.
 *
 * WHY THIS EXISTS. A bundled connector's source lives under
 * `packages/polyfill-connectors/connectors/<entry>/`, but every connector also
 * imports shared modules a level up, at `../../src/*.ts`. Those shared modules
 * are a real part of what the collector compiles and ships, and until now they
 * were named by hand in two places that had no way to stay honest:
 *
 *   - `tsconfig.build.json`'s `include` array listed seven `src/` files, and
 *   - the cross-repo vendored-source drift check scopes to `connectors/<id>/`
 *     only, so it cannot see a `src/` module at all.
 *
 * Neither list is derived from the imports, so a connector that starts
 * importing a new shared module compiles in the repo that owns the connector
 * and fails here — the import names a path this repo does not have, or has but
 * does not compile. That is not hypothetical: `claude_code/artifact-capture.ts`
 * began importing `../../src/artifact-capture-env.ts`, a module that existed
 * only upstream, and the hand-lists had no reason to notice.
 *
 * The fix is to stop hand-listing. The connectors' own `import` statements
 * already state which shared modules they need; this walks them and reports the
 * closure. Callers that used to carry a list now ask for the derived set, so
 * the compile list and the drift guard agree by construction rather than by
 * two people remembering to edit the same two files.
 *
 * SCOPE. Only relative imports are followed, and only into
 * `packages/polyfill-connectors/`. Bare specifiers (`@pdpp/collector-runtime`,
 * `node:fs`) are ordinary dependencies resolved by npm and are deliberately not
 * part of this closure. `*.test.ts` files are not roots: this derives what
 * SHIPS, and the published tarball carries no tests.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
export const POLYFILL_CONNECTORS_ROOT = resolve(packageRoot, "../polyfill-connectors");

/**
 * Match the module specifier of a static `import`/`export ... from` and of a
 * dynamic `import(...)`.
 *
 * Deliberately a regex and not a TypeScript parse. This runs as a build-time
 * guard with no compiler on hand, and the only construct it must read reliably
 * is a quoted specifier after `from` or `import(`. A specifier hidden behind a
 * computed expression cannot be resolved statically by any means, so it is out
 * of reach of a parser here too; see `readRelativeImports` for how that case is
 * surfaced rather than silently dropped.
 */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/**
 * Strip comments and template/ordinary string bodies before scanning.
 *
 * Without this, a specifier quoted inside a doc comment (these files carry long
 * explanatory headers that cite module paths) is picked up as a real edge, and
 * the derived set grows entries nothing imports. Removing comment bodies first
 * keeps the closure equal to what the compiler sees.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``");
}

/** A relative specifier that could not be resolved to a file on disk. */
export interface UnresolvedImport {
  /** Repo-relative path of the file containing the import. */
  from: string;
  /** The specifier exactly as written. */
  specifier: string;
}

function readRelativeImports(absFile: string): string[] {
  const source = stripCommentsAndStrings(readFileSync(absFile, "utf8"));
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) out.push(specifier);
  }
  return out;
}

/**
 * Resolve a relative specifier the way this codebase writes them.
 *
 * These sources use `allowImportingTsExtensions`, so an import names the `.ts`
 * file outright (`./connector-runtime.ts`). The extensionless and `/index.ts`
 * forms are accepted too so that a future import written the ordinary Node way
 * still resolves instead of being reported as missing.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        if (readdirSync(dirname(candidate)).includes(candidate.split("/").pop() ?? "")) {
          return candidate;
        }
      } catch {
        // Unreadable directory: fall through to the next candidate.
      }
    }
  }
  return null;
}

export interface DerivedConnectorSources {
  /**
   * Every reachable file, repo-relative to `packages/polyfill-connectors/`,
   * sorted. Includes the connector entry files themselves.
   */
  files: string[];
  /**
   * The reachable `src/*.ts` modules, as the `../polyfill-connectors/src/...`
   * strings `tsconfig.build.json` writes in its `include` array, sorted.
   */
  tsconfigIncludes: string[];
  /** Relative imports that named a file this checkout does not have. */
  unresolved: UnresolvedImport[];
}

/**
 * Walk the import graph rooted at each bundled connector's non-test sources.
 *
 * `entries` are connector directory names (`LOCAL_COLLECTOR_DEFINITIONS[].entry`),
 * which is what the packaging globs name — not `connector_id`. The two coincide
 * for today's six bundled connectors, but the protocol keeps them distinct, so
 * this takes the one that is structurally meaningful to the path.
 *
 * An unresolvable relative import is collected rather than thrown on, so one
 * call reports every break at once instead of stopping at the first.
 */
export function deriveConnectorSources(entries: readonly string[]): DerivedConnectorSources {
  const seen = new Set<string>();
  const unresolved: UnresolvedImport[] = [];
  const stack: string[] = [];

  for (const entry of entries) {
    const dir = join(POLYFILL_CONNECTORS_ROOT, "connectors", entry);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      // Tests are not roots: this derives what ships, and tests do not.
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      stack.push(join(dir, name));
    }
  }

  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of readRelativeImports(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved) {
        unresolved.push({
          from: relative(POLYFILL_CONNECTORS_ROOT, file),
          specifier,
        });
        continue;
      }
      // Stay inside polyfill-connectors: anything outside it is another
      // package's concern, resolved as an ordinary dependency.
      if (!resolved.startsWith(`${POLYFILL_CONNECTORS_ROOT}/`)) continue;
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }

  const files = [...seen].map((f) => relative(POLYFILL_CONNECTORS_ROOT, f)).sort();
  const tsconfigIncludes = files
    .filter((f) => f.startsWith("src/"))
    .map((f) => `../polyfill-connectors/${f}`)
    .sort();

  return { files, tsconfigIncludes, unresolved };
}

/**
 * The `src/` entries currently written into `tsconfig.build.json`'s `include`.
 *
 * Read from the same file tsc compiles, with `//` comments stripped first —
 * tsconfig is JSONC and this one carries substantial commentary. Connector
 * globs and non-polyfill entries are filtered out; only the `src/` file list,
 * which is the hand-maintained part this deriver replaces, is returned.
 */
export function readTsconfigSrcIncludes(tsconfigPath: string): string[] {
  const text = readFileSync(tsconfigPath, "utf8");
  const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  if (!Array.isArray(parsed.include)) {
    throw new Error(`${tsconfigPath} has no "include" array`);
  }
  return parsed.include
    .filter((e: unknown): e is string => typeof e === "string")
    .filter((e: string) => e.startsWith("../polyfill-connectors/src/"))
    .sort();
}
