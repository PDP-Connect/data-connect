// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guard for the `rs.schema.get` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-schema-get-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox UI/page
 *     code, or `process.env`.
 *
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate).
 *
 * This file previously also asserted that pdpp's own `apps/site` sandbox
 * route and `_demo/builders.ts` no longer imported/exported
 * `buildLiveSchemaResponse` -- both pdpp-repo-root frontend paths that do not
 * exist in this repo (Move B did not bring `apps/site` along). Removed;
 * that demotion coverage belongs in pdpp's own suite, not here.
 */

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

test("rs.schema.get operation has no host or storage concretes", () => {
  const rel = "reference-implementation/operations/rs-schema-get/index.ts";
  assertOperationBoundary(read(rel), rel);
});
