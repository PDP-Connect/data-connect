// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile `runtime_requirements.bindings`: one shared validator for
// the registration gate, the stored-manifest read and the direct `runConnector`
// path, plus the pre-spawn placement plan that consumes its result.
//
// Normative sources (data-connectors a87edcdc099284e8582d24a60c9630474bd2af8b):
// docs/spec/collection-profile.md section 3.3 (registry, instance keys,
// interface, duplicate keys), 3.3.2-3.3.7 (constraint grammars, features,
// rationale), 3.3.8 (features), 3.3.9 (lifecycle outcome), and 3.4
// (capabilities.human_interaction). The wire grammar is the canonical
// `connector-manifest.schema.json` and `connector-binding-grammar.mjs` beside
// this file, byte copies of the pinned data-connectors files. Nothing here
// re-derives their host, endpoint, IDNA or IPv6 rules.
//
// Scope. This module decides two things: whether a declaration is well formed,
// and whether this runtime can supply each required contract at all. It does
// not decide authority. Passing validation is never a grant, never enforcement,
// and never a claim that a channel is `enforced` (section 3.3.10). The
// effective-authority record, per-channel coverage and the weaker-coverage
// policy source are not decided here.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  canonicalizeConnectHost,
  canonicalizeNetworkHost,
  canonicalizeWebHost,
  findDuplicateJsonKeys,
  GrammarError,
  normalizeFilesystemInputs,
} from "./connector-binding-grammar.mjs";
import manifestSchema from "./connector-manifest.schema.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A declaration or manifest text that the canonical rules reject. */
export class BindingDeclarationError extends Error {
  readonly code: "invalid_binding_declaration" | "duplicate_json_key";

  constructor(message: string, code: BindingDeclarationError["code"] = "invalid_binding_declaration") {
    super(message);
    this.name = "BindingDeclarationError";
    this.code = code;
  }
}

/** A required binding this runtime cannot supply. Refused before spawn. */
export class BindingPlacementError extends Error {
  readonly code = "unsupported_required_binding" as const;
  readonly bindingKeys: readonly string[];

  constructor(failures: readonly { key: string; reason: string }[]) {
    const detail = failures.map((failure) => `${failure.key} (${failure.reason})`).join("; ");
    super(`Runtime cannot satisfy required binding: ${failures.map((failure) => failure.key).join(", ")}. ${detail}`);
    this.name = "BindingPlacementError";
    this.bindingKeys = failures.map((failure) => failure.key);
  }
}

// ---------------------------------------------------------------------------
// Canonical registry and grammar, read from the vendored schema
// ---------------------------------------------------------------------------

/** Registry binding names (section 3.3). Read from the canonical schema. */
export const REGISTRY_BINDING_NAMES: ReadonlySet<string> = new Set(manifestSchema.$defs.registryBinding.enum);

/** Namespaced extension binding name `<domain>/<name>` (section 3.3). */
const NAMESPACED_BINDING_NAME = new RegExp(namespacedBindingPattern());

function namespacedBindingPattern(): string {
  const branch = manifestSchema.$defs.bindingName.anyOf.find((entry) => "pattern" in entry) as
    | { pattern: string }
    | undefined;
  if (branch === undefined) {
    throw new Error("connector-manifest.schema.json: bindingName has no namespaced pattern");
  }
  return branch.pattern;
}

// ---------------------------------------------------------------------------
// Raw JSON text
// ---------------------------------------------------------------------------

/**
 * Parses manifest JSON text, rejecting any object key that repeats anywhere in
 * the text, including nested keys and escaped spellings of the same key. The
 * duplicate check runs on the text as written, before `JSON.parse` collapses
 * repeats to the last value. Re-serializing an already-parsed object cannot
 * recover this, so callers must pass the original text when they have it.
 */
export function parseManifestJsonText(text: string): unknown {
  let duplicates: Array<{ path: string; key: string }>;
  try {
    duplicates = findDuplicateJsonKeys(text);
  } catch (error) {
    if (error instanceof GrammarError) {
      throw new SyntaxError(`manifest JSON is malformed: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const [first] = duplicates;
  if (first !== undefined) {
    throw new BindingDeclarationError(
      `manifest JSON repeats object key "${first.key}" at ${first.path}; a repeated key is rejected, not last-wins`,
      "duplicate_json_key"
    );
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Shape validation (canonical JSON Schema) and canonical grammar checks
// ---------------------------------------------------------------------------

export interface BindingInstance {
  /** Deep copy of the declaration. Binding-specific fields are preserved. */
  readonly declaration: Readonly<Record<string, unknown>>;
  /** Stated interface version, exactly as declared. Absent means unspecified. */
  readonly interface: string | undefined;
  /** Instance key exactly as declared. */
  readonly key: string;
  /** Resolved kind: the key for shorthand, `kind` for a free-form key. */
  readonly kind: string;
  readonly required: boolean;
}

let schemaValidator: ValidateFunction | null = null;

function bindingsValidator(): ValidateFunction {
  if (schemaValidator === null) {
    schemaValidator = new Ajv2020({ allErrors: false, strict: true }).compile(manifestSchema);
  }
  return schemaValidator;
}

const RUNTIME_REQUIREMENTS_BINDINGS_PREFIX = /^\/runtime_requirements\/bindings/;

function describeSchemaError(error: { instancePath: string; message?: string }): string {
  const relative = error.instancePath.replace(RUNTIME_REQUIREMENTS_BINDINGS_PREFIX, "").replaceAll("/", ".");
  return `runtime_requirements.bindings${relative} ${error.message ?? "is invalid"}`;
}

const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARACTERS, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new BindingDeclarationError(message);
}

/** Canonical host check: the stated form must equal its own canonicalization. */
function assertCanonicalHost(label: string, raw: unknown, canonicalize: (value: string) => string): void {
  if (typeof raw !== "string") {
    return;
  }
  let canonical: string;
  try {
    canonical = canonicalize(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`${label} "${raw}" is not a valid canonical form: ${reason}`);
  }
  if (canonical !== raw) {
    fail(`${label} "${raw}" must be stated in canonical form "${canonical}"`);
  }
}

function assertNonEmptyRationaleWhenExceptional(
  key: string,
  declaration: Record<string, unknown>,
  exceptional: boolean
): void {
  const { rationale } = declaration;
  if (rationale !== undefined && (typeof rationale !== "string" || rationale.trim().length === 0)) {
    fail(`runtime_requirements.bindings.${key}.rationale must be a non-empty string when declared`);
  }
  if (exceptional && (typeof rationale !== "string" || rationale.trim().length === 0)) {
    fail(
      `runtime_requirements.bindings.${key} declares an exceptional grant and must carry a non-empty rationale (section 3.3.13)`
    );
  }
}

/** The interface version must be `<kind>@<positive integer>` with no leading zero. */
function assertInterfaceVersion(key: string, kind: string, declaration: Record<string, unknown>): void {
  const iface = declaration.interface;
  if (iface === undefined) {
    return;
  }
  const expected = new RegExp(`^${escapeRegExp(kind)}@[1-9][0-9]*$`);
  if (typeof iface !== "string" || !expected.test(iface)) {
    fail(`runtime_requirements.bindings.${key}.interface must be "${kind}@<positive integer>" with no leading zero`);
  }
}

/** Both declared filesystem forms must agree (section 3.3.5), and env_var names must be unique. */
function assertFilesystemInputs(key: string, declaration: Record<string, unknown>): void {
  let inputs: unknown[] | undefined;
  try {
    inputs = normalizeFilesystemInputs(declaration as { inputs?: unknown[]; constraints?: { inputs?: unknown[] } });
  } catch (error) {
    fail(`runtime_requirements.bindings.${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const envVars = new Set<string>();
  for (const input of inputs ?? []) {
    const envVar = isRecord(input) ? input.env_var : undefined;
    if (typeof envVar === "string") {
      if (envVars.has(envVar)) {
        fail(`runtime_requirements.bindings.${key} repeats filesystem input env_var ${envVar}`);
      }
      envVars.add(envVar);
    }
  }
}

/**
 * Canonical-form checks for browser and network host constraints. Returns true
 * when the declaration is an exceptional grant (section 3.3.13).
 */
function assertHostConstraints(kind: string, constraints: Record<string, unknown>): boolean {
  if (kind === "browser") {
    for (const [index, host] of ((constraints.navigate as unknown[] | undefined) ?? []).entries()) {
      assertCanonicalHost(`browser.constraints.navigate[${index}]`, host, canonicalizeWebHost);
    }
    for (const [index, host] of ((constraints.connect as unknown[] | undefined) ?? []).entries()) {
      assertCanonicalHost(`browser.constraints.connect[${index}]`, host, canonicalizeConnectHost);
    }
    return false;
  }
  if (kind !== "network") {
    return false;
  }
  let exceptional = false;
  const hosts = (constraints.hosts as unknown[] | undefined) ?? [];
  for (const [index, entry] of hosts.entries()) {
    if (isRecord(entry)) {
      if (entry.allow_private === true) {
        exceptional = true;
      }
      continue;
    }
    assertCanonicalHost(`network.constraints.hosts[${index}]`, entry, canonicalizeNetworkHost);
  }
  return exceptional;
}

/** Constraint, interface and rationale checks the JSON Schema cannot express. */
function assertInstanceContract(key: string, kind: string, declaration: Record<string, unknown>): void {
  assertInterfaceVersion(key, kind, declaration);
  const constraints = isRecord(declaration.constraints) ? declaration.constraints : {};
  if (kind === "filesystem") {
    assertFilesystemInputs(key, declaration);
  }
  let exceptional = assertHostConstraints(kind, constraints);
  if (kind === "desktop_session" && Array.isArray(constraints.items) && constraints.items.length > 0) {
    // Access to a named sensitive resource is an exceptional grant (section 3.3.13).
    exceptional = true;
  }
  assertNonEmptyRationaleWhenExceptional(key, declaration, exceptional);
}

/**
 * Validates `runtime_requirements.bindings` and resolves each instance.
 *
 * Absent (`undefined`) bindings yield an empty list. `null` is rejected: the
 * canonical schema types the map as an object. The result keeps declaration
 * order, one entry per instance key, and never mutates its input.
 */
export function normalizeBindingDeclarations(bindings: unknown): readonly BindingInstance[] {
  if (bindings === undefined) {
    return [];
  }
  const validate = bindingsValidator();
  if (!validate({ runtime_requirements: { bindings } })) {
    const first = validate.errors?.[0];
    fail(first ? describeSchemaError(first) : "runtime_requirements.bindings is invalid");
  }
  if (!isRecord(bindings)) {
    fail("runtime_requirements.bindings must be an object");
  }

  return Object.entries(bindings).map(([key, value]) => {
    if (!isRecord(value)) {
      fail(`runtime_requirements.bindings.${key} must be an object`);
    }
    const shorthand = REGISTRY_BINDING_NAMES.has(key) || NAMESPACED_BINDING_NAME.test(key);
    // The schema has already rejected a shorthand key that carries `kind`, and
    // a free-form key without one. Here the kind is resolved from the key.
    const kind = shorthand ? key : (value.kind as string);
    assertInstanceContract(key, kind, value);
    return Object.freeze({
      declaration: Object.freeze(structuredClone(value)),
      interface: typeof value.interface === "string" ? value.interface : undefined,
      key,
      kind,
      required: value.required as boolean,
    });
  });
}

// ---------------------------------------------------------------------------
// Pre-spawn placement
// ---------------------------------------------------------------------------

/**
 * What this runtime supplies. It publishes no feature and enforces no
 * constraint, so any declared feature or constraint is an unmet contract.
 * `kinds` matches the static START.bindings advertisement in runtime/index.ts.
 */
export interface BindingSupport {
  readonly constraintKinds: ReadonlySet<string>;
  readonly features: ReadonlySet<string>;
  readonly interfaceVersions: ReadonlyMap<string, ReadonlySet<number>>;
  readonly kinds: ReadonlySet<string>;
}

export const RUNTIME_BINDING_SUPPORT: BindingSupport = {
  constraintKinds: new Set(),
  features: new Set(),
  interfaceVersions: new Map([
    ["browser", new Set([1])],
    ["filesystem", new Set([1])],
    ["network", new Set([1])],
  ]),
  kinds: new Set(["browser", "filesystem", "network"]),
};

/** Why an instance cannot be supplied, or `null` when the runtime supplies its contract. */
export function unsupportedReason(instance: BindingInstance, support: BindingSupport): string | null {
  if (!support.kinds.has(instance.kind)) {
    return `kind ${instance.kind} is not implemented by this runtime`;
  }
  if (instance.interface !== undefined) {
    const version = Number(instance.interface.slice(instance.interface.indexOf("@") + 1));
    if (!support.interfaceVersions.get(instance.kind)?.has(version)) {
      return `interface ${instance.interface} is not implemented by this runtime`;
    }
  }
  const { features } = instance.declaration;
  if (Array.isArray(features) && features.length > 0) {
    const unmet = features.filter((feature) => !support.features.has(String(feature)));
    if (unmet.length > 0) {
      return `features ${unmet.join(", ")} are not provided by this runtime`;
    }
  }
  const { constraints } = instance.declaration;
  const declaresConstraints = isRecord(constraints) && Object.keys(constraints).length > 0;
  const declaresInputs = Array.isArray(instance.declaration.inputs) && instance.declaration.inputs.length > 0;
  if ((declaresConstraints || declaresInputs) && !support.constraintKinds.has(instance.kind)) {
    return "constraints are declared, and this runtime does not enforce them";
  }
  if (instance.key !== instance.kind) {
    return "named binding instances need per-instance handles, which this runtime does not provide";
  }
  return null;
}

export interface BindingPlacement {
  /** Optional instances this runtime omits, with the reason. */
  readonly omitted: readonly { instance: BindingInstance; reason: string }[];
  /** Instances whose contract this runtime supplies. */
  readonly placed: readonly BindingInstance[];
}

/**
 * Plans placement before spawn. A required instance this runtime cannot supply
 * throws `BindingPlacementError`, and no connector code runs. An optional one
 * may be omitted (section 3.3), and the omission must show in START.
 */
export function planBindingPlacement(
  instances: readonly BindingInstance[],
  support: BindingSupport = RUNTIME_BINDING_SUPPORT
): BindingPlacement {
  const placed: BindingInstance[] = [];
  const omitted: { instance: BindingInstance; reason: string }[] = [];
  const failures: { key: string; reason: string }[] = [];
  for (const instance of instances) {
    const reason = unsupportedReason(instance, support);
    if (reason === null) {
      placed.push(instance);
    } else if (instance.required) {
      failures.push({ key: instance.key, reason });
    } else {
      omitted.push({ instance, reason });
    }
  }
  if (failures.length > 0) {
    throw new BindingPlacementError(failures);
  }
  return { omitted, placed };
}

/**
 * START.bindings for this run keeps the keys of resolved instances. An omitted
 * instance cannot borrow another instance's availability through their shared
 * kind. Undeclared kinds keep the existing static availability advertisement;
 * that advertisement is not a grant or a claim of channel enforcement.
 */
export function startBindingsFor(
  instances: readonly BindingInstance[],
  plan: BindingPlacement,
  support: BindingSupport = RUNTIME_BINDING_SUPPORT
): Record<string, Record<string, never>> {
  const declaredKinds = new Set(instances.map((instance) => instance.kind));
  const advertised: Record<string, Record<string, never>> = {};
  for (const kind of [...support.kinds].sort()) {
    if (!declaredKinds.has(kind)) {
      advertised[kind] = {};
    }
  }
  for (const instance of plan.placed) {
    advertised[instance.key] = {};
  }
  return advertised;
}
