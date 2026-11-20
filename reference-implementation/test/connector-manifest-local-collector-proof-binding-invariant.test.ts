// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The planner reads `capabilities.proven.local_collector` from each manifest;
 * no connector key list stands behind it. This file checks that the invariant
 * the generator and connector-manifest-validation.ts's
 * validateProvenModalityConsistency both assume — a connector cannot claim
 * `capabilities.proven.local_collector` without also declaring
 * `runtime_requirements.bindings.filesystem` — holds for every manifest
 * actually shipped today, not just synthetic fixtures.
 * (`capabilities.proven.local_collector` is a proof gate, not a
 * classification: `runtime_requirements.bindings.filesystem` alone marks 13
 * shipped manifests as filesystem-backed, but only a subset has a proven,
 * connector-specific local-collector enrollment path — 6 today.)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

test("no manifest with a filesystem binding advertises capabilities.proven.local_collector unless it also has runtime_requirements.bindings.filesystem", () => {
  // Guards the inverse direction: a manifest cannot claim the local-collector
  // proof without also declaring the binding that makes the capability
  // meaningful. This is the regression the task's method explicitly calls
  // out: "a malformed manifest ever claims a capability its declared setup
  // modality cannot support."
  for (const { file: entry, manifest } of readPolyfillManifests()) {
    const raw = manifest as {
      connector_key?: string;
      runtime_requirements?: { bindings?: Record<string, unknown> };
      capabilities?: { proven?: { local_collector?: unknown } };
    };
    if (raw.capabilities?.proven?.local_collector === true) {
      const bindings = raw.runtime_requirements?.bindings;
      const hasFilesystemBinding = Boolean(
        bindings && typeof bindings === "object" && Object.hasOwn(bindings, "filesystem")
      );
      assert.ok(
        hasFilesystemBinding,
        `${entry} declares capabilities.proven.local_collector=true but has no runtime_requirements.bindings.filesystem — a proven local-collector connector must be filesystem-bound`
      );
    }
  }
});
