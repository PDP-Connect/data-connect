// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.dataset.summary` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-ref-dataset-summary-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Express, Next, SQLite,
 *     Postgres, a raw SQL handle, sandbox modules, the native
 *     `server/records.js` helper module, the native `server/index.js`
 *     module, or `process` / `process.env`.
 *
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate).
 *
 * This file previously also asserted that pdpp's own `apps/site` sandbox
 * route, `_demo/builders.ts`, and `_demo/data-source.ts` no longer built a
 * live dataset-summary envelope locally -- all pdpp-repo-root frontend paths
 * that do not exist in this repo (Move B did not bring `apps/site` along).
 * Removed; that demotion coverage belongs in pdpp's own suite, not here.
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

test("ref.dataset.summary operation has no host or storage concretes", () => {
  const rel = "reference-implementation/operations/ref-dataset-summary/index.ts";
  assertOperationBoundary(read(rel), rel);
});

test("ref.dataset.summary operation does not import server/records.js", () => {
  // The operation must not depend on the native `server/records.js` helper
  // module (which carries the SQLite aggregates and bounded-row helpers).
  // The shared boundary already forbids `../server/...` imports for `auth`,
  // `records`, and `index`; this assertion adds explicit coverage so a
  // future bypass via a relative-path or differently-spelled import still
  // fails the gate.
  const rel = "reference-implementation/operations/ref-dataset-summary/index.ts";
  const src = read(rel);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/records['"]/;
  assert.equal(fromPattern.test(src), false, "operation must not import the native server/records.js helper module");
});

