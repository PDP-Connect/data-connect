// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  type BindingRequirement,
  diffProtocolCapabilities,
  matchRuntimeBindings,
  NODE_BROWSER_FEATURES,
  NODE_NETWORK_FEATURES,
} from "@pdpp/collector-runtime/runtime-binding-support";
import { RuntimeCapabilityMismatchError } from "@pdpp/collector-runtime/runtime-capabilities";
import { invalidConnectorManifest, validateRuntimeRequirements } from "../server/connector-manifest-validation.ts";

// This child-process host provides the complete Node/Playwright interfaces.
// It has durable STREAM_EVIDENCE handling, but no BLOB or OBSERVATION handler.
// Collection Profile version and connector-protocol transport version differ.
export const REFERENCE_RUNTIME_CAPABILITIES = {
  bindingFeatures: new Map([
    ["browser", NODE_BROWSER_FEATURES],
    ["network", NODE_NETWORK_FEATURES],
  ]),
  bindings: new Set(["browser", "filesystem", "network"]),
  id: "reference",
  protocolCapabilities: new Set(["STREAM_EVIDENCE"]),
  protocolVersion: "0.1.0",
};

export function placeCollectionProfile(
  connectorId: string,
  manifest: {
    protocol_capabilities?: unknown;
    runtime_requirements?: { bindings?: Record<string, BindingRequirement> } | null;
  }
): Record<string, Record<string, never>> {
  // CP capabilities are optional. Unlike a connector-protocol collector
  // definition, omission here makes no claim about optional wire features.
  const capabilities = manifest.protocol_capabilities === undefined ? [] : manifest.protocol_capabilities;
  if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string" || !value.length)) {
    throw invalidConnectorManifest(
      "protocol_capabilities must be an array of non-empty strings when declared",
      "runtime_capability_undeclared"
    );
  }
  validateRuntimeRequirements(manifest, "runtime_binding_invalid");
  const bindings = matchRuntimeBindings(manifest.runtime_requirements?.bindings ?? {}, REFERENCE_RUNTIME_CAPABILITIES);
  const missing = [
    ...bindings.missing,
    ...diffProtocolCapabilities(capabilities as string[], REFERENCE_RUNTIME_CAPABILITIES.protocolCapabilities),
  ];
  if (missing.length) {
    throw new RuntimeCapabilityMismatchError({
      connectorId,
      missing,
      missingFeatures: bindings.missingFeatures,
      runtime: REFERENCE_RUNTIME_CAPABILITIES.id,
      unspecifiedFeatures: bindings.unspecifiedFeatures,
    });
  }
  return Object.fromEntries(
    [...REFERENCE_RUNTIME_CAPABILITIES.bindings]
      .filter((binding) => !bindings.omitted.includes(binding))
      .map((binding) => [binding, {}])
  );
}
