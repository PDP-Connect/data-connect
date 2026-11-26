// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector manifest that claims `capabilities.proven.local_collector` must
 * have a bundled local-collector definition, and a bundled definition must
 * have a manifest that claims the proof. Setup, the console and the local
 * collector read the claim from the manifest; this keeps the claim and the
 * code that backs it from drifting for the connectors this build vendors.
 *
 * The check reads the vendored manifests and the bundled definitions. It
 * names no connector and does not gate one: a connector installed from the
 * catalog is judged by its own manifest at install and setup.
 *
 * A bundled definition names its connector with the underscore spelling the
 * connector package uses for bundle directories, while the manifest key uses
 * hyphens, so a definition matches a manifest under either spelling.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_COLLECTOR_DEFINITIONS } from "@pdpp/polyfill-connectors/collectors";
import { readShippedManifests } from "./helpers/shipped-manifests.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";

interface ManifestLike {
  capabilities?: { proven?: { local_collector?: unknown } };
}

const vendored = readShippedManifests().flatMap(({ manifest }) => {
  const key = canonicalConnectorKeyFromManifest(manifest as Record<string, unknown>);
  return key === null
    ? []
    : [{ key, proven: (manifest as ManifestLike).capabilities?.proven?.local_collector === true }];
});
const provenKeys = new Set(vendored.filter((entry) => entry.proven).map((entry) => entry.key));
const manifestKeyByBundleId = new Map(
  vendored.flatMap(({ key }) => [
    [key, key],
    [key.replace(/-/g, "_"), key],
  ])
);

test("the vendored manifests and the bundled definitions are not empty", () => {
  assert.ok(vendored.length > 0, "no vendored manifests were read");
  assert.ok(LOCAL_COLLECTOR_DEFINITIONS.length > 0, "no bundled local-collector definitions were read");
});

test("every manifest that proves local_collector has a bundled definition", () => {
  const defined = new Set(
    LOCAL_COLLECTOR_DEFINITIONS.flatMap((definition) => manifestKeyByBundleId.get(definition.connector_id) ?? [])
  );
  const missing = [...provenKeys].filter((key) => !defined.has(key));
  assert.deepEqual(
    missing,
    [],
    "capabilities.proven.local_collector is true with no LocalCollectorDefinition in the connector package's " +
      "collector registry. Wire the definition or remove the claim."
  );
});

test("every bundled definition belongs to a manifest that proves local_collector", () => {
  const unproven = LOCAL_COLLECTOR_DEFINITIONS.filter((definition) => {
    const key = manifestKeyByBundleId.get(definition.connector_id);
    return key === undefined || !provenKeys.has(key);
  }).map((definition) => definition.connector_id);
  assert.deepEqual(
    unproven,
    [],
    "a bundled definition has no vendored manifest that declares capabilities.proven.local_collector. " +
      "Declare the proof in the manifest or remove the definition."
  );
});
