// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Admission of a manifest's Collection Profile declaration, shared by the
// registration gate (server/connector-manifest-validation.ts) and the run
// path (runtime/index.ts) so both apply one rule set.
//
// Normative source: data-connectors docs spec sections 3.4 (protocol_version
// and capabilities) and 3.8 (diagnostic_descriptors). A manifest that declares
// diagnostic_descriptors or OBSERVATION declares protocol_version 0.2.0.

import {
  COLLECTION_PROFILE_VERSIONS,
  collectionProfileDeclarationError,
  OBSERVATION_CAPABILITY,
  STREAM_EVIDENCE_CAPABILITY,
} from "@pdpp/connector-protocol/connector-runtime-protocol";
import { type DiagnosticDescriptors, ObservationContractError, validateDiagnosticDescriptors } from "./observations.ts";

/** Implemented wire features, with outstanding full-profile obligations disclosed. */
export const REFERENCE_COLLECTION_PROFILE_SUPPORT = Object.freeze({
  compatible_protocol_versions: Object.freeze([...COLLECTION_PROFILE_VERSIONS]),
  conformance: Object.freeze({ outstanding: Object.freeze(["binding_authority"]), status: "partial" }),
  protocol_capabilities: Object.freeze([OBSERVATION_CAPABILITY, STREAM_EVIDENCE_CAPABILITY]),
  protocol_version: "0.2.0",
});

export interface CollectionProfileDeclaration {
  readonly descriptors: DiagnosticDescriptors;
  readonly observationDeclared: boolean;
}

/**
 * Returns the first problem with the declaration, as a bounded message, or
 * null when it is admissible. The message names the rule, never the
 * manifest's value.
 */
export function collectionProfileDeclarationProblem(manifest: Record<string, unknown>): string | null {
  const version = manifest.protocol_version === undefined ? "0.1.0" : manifest.protocol_version;
  if (!(COLLECTION_PROFILE_VERSIONS as readonly unknown[]).includes(version)) {
    return "protocol_version must be one of 0.1.0, 0.2.0";
  }
  const capabilityProblem = collectionProfileDeclarationError(version, manifest.protocol_capabilities);
  if (capabilityProblem !== null) {
    return capabilityProblem;
  }
  if (manifest.diagnostic_descriptors !== undefined && version !== "0.2.0") {
    return "diagnostic_descriptors require protocol_version 0.2.0";
  }
  try {
    validateDiagnosticDescriptors(manifest.diagnostic_descriptors);
  } catch (error) {
    if (error instanceof ObservationContractError) {
      return `diagnostic_descriptors rejected: ${error.code}`;
    }
    throw error;
  }
  return null;
}

/**
 * Reads an admitted declaration. Call only after `collectionProfileDeclarationProblem`
 * returns null; descriptor validation has then already passed.
 */
export function readCollectionProfileDeclaration(manifest: Record<string, unknown>): CollectionProfileDeclaration {
  const capabilities = Array.isArray(manifest.protocol_capabilities) ? manifest.protocol_capabilities : [];
  return {
    descriptors: validateDiagnosticDescriptors(manifest.diagnostic_descriptors),
    observationDeclared: capabilities.includes(OBSERVATION_CAPABILITY),
  };
}
