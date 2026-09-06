// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.search.lexical` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-search-lexical-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox modules,
 *     the native `server/search.js` helper module, or `process` /
 *     `process.env`.
 *
 * The operation-module boundary check delegates to the shared helper so
 * the forbidden-import list is the single source of truth across
 * operations (see openspec/changes/add-reference-operation-boundary-gate).
 *
 * This file previously also asserted that pdpp's own `apps/site` sandbox
 * route and `_demo/builders.ts` no longer imported/exported
 * `buildLiveSearchResponse` -- both pdpp-repo-root frontend paths that do
 * not exist in this repo (Move B did not bring `apps/site` along). Removed;
 * that demotion coverage belongs in pdpp's own suite, not here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertOperationBoundary } from "./helpers/operation-boundary.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

test("rs.search.lexical operation has no host or storage concretes", () => {
  const rel = "reference-implementation/operations/rs-search-lexical/index.ts";
  assertOperationBoundary(read(rel), rel);
});

test("rs.search.lexical operation does not import server/search.js", () => {
  // The operation must not depend on the native `server/search.js` helper
  // module (which carries the FTS5/SQLite snapshot machinery). The shared
  // boundary already forbids `../server/...` imports for `auth`, `records`,
  // and `index`; this assertion adds explicit coverage for `search.js`.
  const rel = "reference-implementation/operations/rs-search-lexical/index.ts";
  const src = read(rel);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search['"]/;
  assert.equal(fromPattern.test(src), false, "operation must not import the native server/search.js helper module");
});

