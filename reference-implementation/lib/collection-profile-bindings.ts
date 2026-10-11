// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Ajv2020 } from "ajv/dist/2020.js";
import {
  findDuplicateJsonKeys,
  isCanonicalConnectHost,
  isCanonicalNetworkHost,
  isCanonicalWebHost,
  normalizeFilesystemInputs
} from "./collection-profile/connector-binding-grammar.mjs";
import schema from "./collection-profile/connector-manifest.schema.json" with { type: "json" };

// The schema and grammar are copied unchanged from data-connectors PR #298,
// commit 8df6405e4adaecba5e70e32493d31856286d57d6. The installed tools package
// predates that revision; pin these two normative assets without upgrading
// unrelated installer/runtime behavior.
const validate = new Ajv2020({ allErrors: true, strict: false }).compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/bindings"
});

export interface BindingDeclaration {
  kind?: string;
  interface?: string;
  required?: boolean;
  features?: string[];
  constraints?: Record<string, unknown>;
  inputs?: Array<{
    env_var: string;
    kind: string;
    access: string;
    accepted_extensions?: string[];
  }>;
}

export type BindingDeclarations = Record<string, BindingDeclaration>;
export type BindingDescriptors = Record<string, Record<string, unknown>>;

export function bindingInstanceKind(key: string, declaration: BindingDeclaration): string {
  return declaration.kind ?? key;
}

export function parseManifestJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  const duplicate = findDuplicateJsonKeys(text)[0];
  if (duplicate) {
    throw new Error(`Duplicate manifest JSON key at ${duplicate.path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector manifest must be an object");
  }
  return value as Record<string, unknown>;
}

function assertUniqueEntries(entries: readonly Record<string, unknown>[] | undefined, member: string): void {
  if (!entries) return;
  const values = entries.map((entry) => entry[member]);
  if (new Set(values).size !== values.length) {
    throw new Error(`filesystem ${member} values must be unique`);
  }
}

export function validateBindingDeclarations(bindings: unknown): asserts bindings is BindingDeclarations {
  if (!validate(bindings)) {
    throw new Error(
      `runtime_requirements.bindings: ${validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ")}`
    );
  }
  for (const [key, declaration] of Object.entries(bindings as BindingDeclarations)) {
    // START.bindings.interactive is the legacy host interaction-capability
    // signal. Until that signal has its own namespace, an author-local name
    // must not manufacture it or hide it through optional-kind negotiation.
    if (key === "interactive") {
      throw new Error("runtime_requirements.bindings.interactive is reserved for the host interaction capability");
    }
    const kind = bindingInstanceKind(key, declaration);
    if (declaration.interface !== undefined) {
      const prefix = `${kind}@`;
      if (
        !declaration.interface.startsWith(prefix) ||
        !/^[1-9][0-9]*$/.test(declaration.interface.slice(prefix.length))
      ) {
        throw new Error(`runtime_requirements.bindings.${key}.interface must be ${kind}@<positive integer>`);
      }
    }
    const constraints = declaration.constraints;
    for (const [member, canonical] of kind === "browser"
      ? ([
          ["navigate", isCanonicalWebHost],
          ["connect", isCanonicalConnectHost]
        ] as const)
      : kind === "network"
        ? ([["hosts", isCanonicalNetworkHost]] as const)
        : []) {
      for (const value of (constraints?.[member] ?? []) as unknown[]) {
        if (typeof value === "string" && !canonical(value)) {
          throw new Error(`runtime_requirements.bindings.${key}.constraints.${member} must contain canonical hosts`);
        }
      }
    }
    if (kind === "filesystem") {
      const inputs = normalizeFilesystemInputs(declaration) as BindingDeclaration["inputs"];
      assertUniqueEntries(declaration.inputs, "env_var");
      assertUniqueEntries(constraints?.inputs as Record<string, unknown>[] | undefined, "env_var");
      assertUniqueEntries(inputs, "env_var");
    }
  }
}

export interface BindingNegotiation {
  bindings: BindingDescriptors;
  missingRequiredBindings: Array<{ instanceKey: string; kind: string }>;
}

/** Produce the exact START map without throwing for unsupported requirements.
 * Item 11 can persist the placement record before asserting this result.
 * Descriptor members are runtime-specific (CP 5.1). Named metadata describes
 * declarations, not enforced authority; shorthand keeps its existing shape.
 * This resolves kinds; it does not establish provider feature support.
 * Values remain child-facing handles, not safe read-API payloads. */
export function negotiateBindingInstances(
  bindings: BindingDeclarations,
  available: BindingDescriptors
): BindingNegotiation {
  validateBindingDeclarations(bindings);
  const descriptors = { ...available };
  const missingRequiredBindings: BindingNegotiation["missingRequiredBindings"] = [];
  for (const [key, declaration] of Object.entries(bindings)) {
    const kind = bindingInstanceKind(key, declaration);
    if (!Object.hasOwn(available, kind)) {
      if (declaration.required) missingRequiredBindings.push({ instanceKey: key, kind });
      // A named instance can collide with an extra legacy host descriptor.
      // Absence must reflect its requested kind, not that unrelated name.
      delete descriptors[key];
      continue;
    }
    const descriptor = { ...available[kind] };
    if (declaration.kind !== undefined) {
      descriptor.kind = kind;
      if (declaration.interface !== undefined) descriptor.interface = declaration.interface;
      if (declaration.features !== undefined) descriptor.features = [...declaration.features];
    }
    if (declaration.constraints !== undefined) descriptor.constraints = structuredClone(declaration.constraints);
    if (kind === "filesystem") {
      const inputs = normalizeFilesystemInputs(declaration);
      if (inputs !== undefined) {
        descriptor.constraints = {
          ...(descriptor.constraints as Record<string, unknown> | undefined),
          inputs: structuredClone(inputs)
        };
      }
    }
    descriptors[key] = descriptor;
  }
  return { bindings: descriptors, missingRequiredBindings };
}

export function assertRequiredBindings(negotiation: BindingNegotiation): void {
  const missing = negotiation.missingRequiredBindings[0];
  if (missing) throw new Error(`Runtime cannot satisfy required binding: ${missing.instanceKey} (${missing.kind})`);
}
