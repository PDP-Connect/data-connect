// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
// biome-ignore lint/correctness/noUnresolvedImports: Node and tsc resolve the vendored exports; Biome reports a directory without index.
import { referenceManifests, validateResponse } from "@pdpp/reference-contract";

const RUN_PATH = /^\/(?:_ref|v1\/owner)\/runs(?:\/[^/]+(?:\/(?:timeline|cancel|interaction))?)?$/;
const RUN_ID_PATH = /\/runs\/[^/]+/;

/** Check the existing HTTP journeys against the published wire schema. */
export function assertRunResponseContract(url: string, method: string, status: number, body: unknown): void {
  const path = new URL(url).pathname;
  if (!RUN_PATH.test(path)) {
    return;
  }
  const contractPath = path.replace(RUN_ID_PATH, "/runs/{runId}");
  const manifest = referenceManifests.find((entry) => entry.method === method && entry.path === contractPath);
  assert.ok(manifest, `${method} ${contractPath} must declare a contract`);
  const result = validateResponse(manifest.id, { body, status });
  assert.deepEqual(result, { ok: true, skipped: false }, `${method} ${contractPath} ${status} must match its contract`);
}
