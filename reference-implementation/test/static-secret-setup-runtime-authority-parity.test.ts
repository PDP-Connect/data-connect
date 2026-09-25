// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest-authority checks for setup classification and run-time resolution.
 * The retired generated registry is not part of the current runtime contract:
 * both consumers now inspect the installed manifest. These tests ensure a new
 * manifest needs no connector-specific registration and keep manifest-shape
 * validation fail-closed at the setup boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import {
  type ConnectorManifestLike,
  isStaticSecretConnector as isStaticSecretConnectorForSetup,
} from "../server/connection-setup-plan.ts";
import { isStaticSecretProfileManifest } from "../server/stores/static-secret-run-credentials.ts";

function connectorKeyOf(manifest: ConnectorManifestLike): string | null {
  return manifest.connector_key?.trim() || manifest.connector_id?.trim() || null;
}

test("every shipped manifest: setup and run-time static-secret classification agree", () => {
  const entries = readPolyfillManifests();
  assert.ok(entries.length > 0, "expected at least one shipped connector manifest");

  const disagreements: string[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest as ConnectorManifestLike;
    const connectorKey = connectorKeyOf(manifest);
    if (!connectorKey) {
      continue;
    }
    const setupSaysYes = isStaticSecretConnectorForSetup(connectorKey, manifest);
    const runtimeSaysYes = isStaticSecretProfileManifest(manifest);
    if (setupSaysYes !== runtimeSaysYes) {
      disagreements.push(`${connectorKey}: setup=${setupSaysYes} runtime=${runtimeSaysYes}`);
    }
  }

  assert.deepEqual(disagreements, [], `setup and run-time classification disagree for: ${disagreements.join(", ")}`);
});

test("venmo is classified from its installed profile manifest", () => {
  const entry = readPolyfillManifests().find((candidate) => candidate.file === "venmo.json");
  if (!entry) {
    throw new Error("no polyfill manifest found for venmo.json");
  }
  const manifest = entry.manifest as ConnectorManifestLike;
  assert.equal(isStaticSecretConnectorForSetup("venmo", manifest), true);
  assert.equal(isStaticSecretProfileManifest(manifest), true);
});

test('password-without-secret probe: both classifiers treat type:"password" as secret', () => {
  const manifest: ConnectorManifestLike = {
    connector_key: "password-type-probe",
    setup: {
      credential_capture: {
        fields: [{ env: ["PASSWORD_TYPE_PROBE"], label: "Probe token", name: "secret", type: "password" }],
        kind: "api_key",
        label: "Probe token",
      },
      modality: "static_secret",
    },
  };
  assert.equal(isStaticSecretConnectorForSetup("password-type-probe", manifest), true);
  assert.equal(isStaticSecretProfileManifest(manifest), true);
});

test("setup rejects a secret field without a label", () => {
  const manifest: ConnectorManifestLike = {
    connector_key: "missing-label-probe",
    setup: {
      credential_capture: {
        fields: [{ env: ["MISSING_LABEL_PROBE"], name: "secret", secret: true }],
        kind: "api_key",
      },
      modality: "static_secret",
    },
  };
  assert.throws(() => isStaticSecretConnectorForSetup("missing-label-probe", manifest), /label/i);
});

test("setup rejects a secret field without env aliases", () => {
  const manifest: ConnectorManifestLike = {
    connector_key: "empty-env-probe",
    setup: {
      credential_capture: {
        fields: [{ env: [], label: "Probe token", name: "secret", secret: true }],
        kind: "api_key",
      },
      modality: "static_secret",
    },
  };
  assert.throws(() => isStaticSecretConnectorForSetup("empty-env-probe", manifest), /env/i);
});

test("a new static-secret manifest is recognized by setup and run-time without registry edits", () => {
  const connectorKey = "synthetic-static-secret-probe";
  const manifest: ConnectorManifestLike = {
    connector_id: `https://registry.pdpp.dev/connectors/${connectorKey}`,
    connector_key: connectorKey,
    setup: {
      credential_capture: {
        fields: [
          {
            env: ["SYNTHETIC_STATIC_SECRET_TOKEN"],
            label: "Probe token",
            name: "secret",
            required: true,
            secret: true,
            type: "password",
          },
        ],
        kind: "api_key",
        label: "Probe token",
      },
      modality: "static_secret",
    },
  };

  assert.equal(isStaticSecretConnectorForSetup(connectorKey, manifest), true);
  assert.equal(isStaticSecretProfileManifest(manifest), true);
});
