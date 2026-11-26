// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins BROWSER_SURFACE_KINDS (connector-gap-bounding.ts) against the real
 * shipped manifests' `capabilities.browser_surface_kind` declaration.
 *
 * connector-gap-bounding.ts is on the connector-evidence spine-validation
 * hot path (imported by runtime/index.ts) and stays free of node:fs, so it
 * cannot itself scan the manifests directory to derive this set at load
 * time. This test is the substitute: it proves the hand-maintained Set is
 * exactly the set a manifest scan would produce, so a future manifest
 * gaining/losing a `browser_surface_kind` declaration without updating
 * BROWSER_SURFACE_KINDS fails CI instead of silently drifting — see
 * docs/inbox/report-clusters-bc-completion.md. 
 * BROWSER_SURFACE_KINDS is a hand-maintained Set, so this parity test is the
 * only oracle against drift.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readShippedManifests } from "./helpers/shipped-manifests.ts";

import { BROWSER_SURFACE_KINDS } from "../runtime/connector-gap-bounding.ts";

function manifestDeclaredBrowserSurfaceKinds(): string[] {
  const kinds: string[] = [];
  for (const entry of readShippedManifests()) {
    const raw = entry.manifest as { capabilities?: { browser_surface_kind?: unknown } };
    const kind = raw.capabilities?.browser_surface_kind;
    if (typeof kind === "string" && kind.trim().length > 0) {
      kinds.push(kind);
    }
  }
  // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
  return kinds.sort();
}

test("BROWSER_SURFACE_KINDS matches exactly the manifests declaring capabilities.browser_surface_kind", () => {
  const derived = manifestDeclaredBrowserSurfaceKinds();
  const hardcoded = [...BROWSER_SURFACE_KINDS].sort();
  assert.deepEqual(
    hardcoded,
    derived,
    "BROWSER_SURFACE_KINDS has drifted from the manifests' capabilities.browser_surface_kind declarations — update the constant (or the manifest) so they agree"
  );
});
