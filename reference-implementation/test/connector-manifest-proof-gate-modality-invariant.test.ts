// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The setup planner (connection-setup-plan.ts) reads
 * `capabilities.proven.provider_auth_lifecycle` and
 * `capabilities.proven.static_secret_live.proven` straight from the
 * connector's manifest; there is no connector-key list.
 *
 * This file proves, independently of the planner and against every manifest actually shipped today,
 * not synthetic fixtures, that a manifest can never claim
 * `capabilities.proven.static_secret_live.proven` or
 * `capabilities.proven.provider_auth_lifecycle` without also declaring the
 * `setup.modality` that proof requires. These are PROOF GATES, not
 * classifications: they gate whether a connector may advertise
 * `open_provider_auth` / present as `static_secret_connect` (vs.
 * `experimental`) to the owner, so a wrong answer here is a
 * security-relevant regression, not just a UX one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

interface ManifestProvenCapabilities {
  capabilities?: {
    proven?: {
      provider_auth_lifecycle?: unknown;
      static_secret_live?: { proven?: unknown };
    };
  };
  connector_id?: string;
  connector_key?: string;
}

test("no manifest claims a proven capability its declared setup modality cannot support", () => {
  // Regression guard demanded by the task: a malformed manifest must not be
  // able to claim static_secret_live proof without declaring the
  // static_secret setup modality, or provider_auth_lifecycle proof without
  // declaring the provider_authorization setup modality.
  for (const { file: entry, manifest } of readPolyfillManifests()) {
    const raw = manifest as ManifestProvenCapabilities & {
      setup?: { modality?: unknown };
    };
    const proven = raw.capabilities?.proven;
    if (proven?.static_secret_live?.proven === true) {
      assert.equal(
        raw.setup?.modality,
        "static_secret",
        `${entry} declares capabilities.proven.static_secret_live.proven=true but setup.modality is not "static_secret"`
      );
    }
    if (proven?.provider_auth_lifecycle === true) {
      assert.equal(
        raw.setup?.modality,
        "provider_authorization",
        `${entry} declares capabilities.proven.provider_auth_lifecycle=true but setup.modality is not "provider_authorization"`
      );
    }
  }
});
