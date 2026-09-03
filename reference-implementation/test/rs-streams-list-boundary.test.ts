// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guard for the `rs.streams.list` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-streams-list-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, or `process.env`.
 *
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate).
 *
 * This file previously also asserted that pdpp's own `apps/site` sandbox
 * route and `_demo/builders.ts` no longer imported/exported
 * `buildLiveStreamsList` -- both pdpp-repo-root frontend paths that do not
 * exist in this repo (Move B did not bring `apps/site` along). Removed;
 * that demotion coverage belongs in pdpp's own suite, not here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertOperationBoundary } from "./helpers/operation-boundary.ts";

const TOP_LEVEL_REGEX_3 =
  /async function listExplicitPolyfillOwnerStreams[\s\S]*buildOwnerReadGrantForManifest\(ownerResolved\.manifest\)[\s\S]*ctx\.listStreamsAcrossBindings\(/;
const TOP_LEVEL_REGEX_4 = /listSummaries:\s*async\s*\(\)\s*=>\s*ctx\.listAllStreams\(ownerResolved\.storageBinding\)/;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

test("rs.streams.list operation has no host or storage concretes", () => {
  const rel = "reference-implementation/operations/rs-streams-list/index.ts";
  assertOperationBoundary(read(rel), rel);
});

test("polyfill owner stream list is manifest-scoped, not raw storage-scoped", () => {
  const src = read("reference-implementation/server/routes/rs-read.ts");
  assert.match(src, TOP_LEVEL_REGEX_3, "explicit polyfill owner stream lists must use manifest-grant-scoped summaries");
  assert.equal(
    TOP_LEVEL_REGEX_4.test(src),
    false,
    "explicit owner connector scope must not expose raw storage streams that manifest/detail/records routes reject"
  );
});
