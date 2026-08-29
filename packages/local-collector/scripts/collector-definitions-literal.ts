// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure literal-emission helpers for
 * `generate-collector-definitions-snapshot.ts`, split out so they are
 * testable without needing this repository's (absent) copy of
 * `packages/polyfill-connectors/src/collector-registry.ts` — see that
 * script's module doc for why the generator itself cannot be exercised
 * against real data in this checkout.
 */

import { isConnectorProtocolCapabilityArray } from "@pdpp/connector-protocol";

export interface CollectorDefinitionSource {
  readonly bindings: Readonly<Record<string, { required: boolean }>>;
  readonly connector_id: string;
  readonly enforces_source_roots?: boolean;
  readonly entry: string;
  readonly protocol_capabilities: readonly string[];
  readonly source_root_scopable_streams?: readonly string[];
  readonly streams: readonly string[];
  readonly time_scopable_streams?: readonly string[];
}

export function jsonStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function bindingsLiteral(bindings: Readonly<Record<string, { required: boolean }>>): string {
  const keys = Object.keys(bindings).sort((a, b) => a.localeCompare(b));
  const lines = keys.map((key) => `      ${JSON.stringify(key)}: { required: ${bindings[key]?.required === true} },`);
  return `{\n${lines.join("\n")}\n    }`;
}

/**
 * Renders one connector's `LocalCollectorDefinition` as a JS object literal.
 *
 * Throws if `definition.protocol_capabilities` is not an array of allowed
 * {@link ConnectorProtocolCapability} values: the authoring type
 * (`LocalCollectorDefinition`) has required this field for three repair
 * rounds now, so a source definition that lacks it, has it malformed, or
 * declares a member outside the closed vocabulary (a forged string, `null`,
 * an object, or a mix of one valid and one invalid entry) is a defect in the
 * upstream source, not something this generator should quietly paper over
 * by emitting it verbatim. Delegates to `isConnectorProtocolCapabilityArray`
 * — the ONE place the allowed vocabulary is authored — rather than
 * re-deriving its own copy of it.
 */
export function definitionLiteral(definition: CollectorDefinitionSource): string {
  if (!isConnectorProtocolCapabilityArray(definition.protocol_capabilities)) {
    throw new Error(
      `collector definition '${definition.connector_id}' has a missing or malformed protocol_capabilities ` +
        "(expected an array whose every member is an allowed ConnectorProtocolCapability value, even if " +
        "empty). Every LocalCollectorDefinition must declare it explicitly."
    );
  }
  const lines: string[] = [
    `    connector_id: ${JSON.stringify(definition.connector_id)},`,
    `    entry: ${JSON.stringify(definition.entry)},`,
    `    bindings: ${bindingsLiteral(definition.bindings)},`,
    // Mirrors the connector-protocol 0.0.2 mandatory capability-declaration
    // contract: protocol_capabilities is required, so it is always emitted
    // (even as []), never inventing a value it did not author. See
    // runtime-capabilities.ts.
    `    protocol_capabilities: ${jsonStringArray(definition.protocol_capabilities)},`,
    `    streams: ${jsonStringArray(definition.streams)},`,
  ];
  if (definition.time_scopable_streams) {
    lines.push(`    time_scopable_streams: ${jsonStringArray(definition.time_scopable_streams)},`);
  }
  if (definition.source_root_scopable_streams) {
    lines.push(`    source_root_scopable_streams: ${jsonStringArray(definition.source_root_scopable_streams)},`);
  }
  if (definition.enforces_source_roots) {
    lines.push("    enforces_source_roots: true,");
  }
  return `  {\n${lines.join("\n")}\n  },`;
}
