// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CONNECTOR_PROTOCOL_VERSION, type ConnectorProtocolCapability } from "@pdpp/connector-protocol";

/**
 * Runtime capability advertisement and pre-spawn placement gate.
 *
 * Connector manifests already declare their `runtime_requirements.bindings`
 * (network, browser, filesystem, local_device, etc). What was missing is
 * the runtime-side half of the contract: a runtime advertises which
 * bindings it can satisfy, and the orchestrator compares the two before
 * spawning the connector.
 *
 * This module is the runtime-side primitive. It does NOT duplicate
 * connector manifest semantics — it only describes what a runtime can
 * provide and how to compare a connector against it.
 *
 * Spec: openspec/changes/introduce-local-collector-runner/design.md
 */
export type RuntimeBindingName = "network" | "browser" | "filesystem" | "local_device";

export interface RuntimeCapabilityProfile {
  /** Connector-protocol version this runtime recognizes. */
  readonly protocolVersion: string;
  /** Protocol capabilities this runtime advertises as available. */
  readonly protocolCapabilities: ReadonlySet<ConnectorProtocolCapability>;
  /** Bindings this runtime advertises as available. */
  readonly bindings: ReadonlySet<RuntimeBindingName>;
  /** Stable identifier of the runtime. Used in diagnostics. */
  readonly id: string;
}

/**
 * Default capability profile for the provider/control-plane runtime.
 *
 * The provider/control-plane runtime CAN reach the network and read its
 * own filesystem. It CANNOT render a visible browser (headless workloads
 * are allowed via the connector runtime's headless gate but never count
 * as advertising a `browser` binding) and CANNOT see the operator's
 * local devices.
 *
 * If a deployment proves the provider runtime can render a visible
 * browser (e.g. an X11/VNC environment with `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`),
 * the deployment can override this profile by passing a different
 * profile to `evaluatePlacement`.
 */
export const PROVIDER_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  bindings: new Set<RuntimeBindingName>(["network", "filesystem"]),
  id: "provider",
  protocolCapabilities: new Set<ConnectorProtocolCapability>(),
  protocolVersion: "0.0.1",
};

/**
 * Default capability profile for the local collector runtime.
 *
 * A local collector runs on a host the operator owns; it can render a
 * visible browser, reach the network, read the local filesystem, and
 * see local-device-style sources (Codex CLI, Claude Code, iMessage).
 */
export const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  bindings: new Set<RuntimeBindingName>(["network", "browser", "filesystem", "local_device"]),
  id: "collector",
  protocolCapabilities: new Set<ConnectorProtocolCapability>(["STREAM_EVIDENCE"]),
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
};

export interface ConnectorRuntimeRequirements {
  readonly bindings?: Partial<Record<RuntimeBindingName, { readonly required?: boolean }>>;
}

interface ConnectorPlacementInputBase {
  readonly connector_id: string;
  readonly runtime_requirements?: ConnectorRuntimeRequirements;
}

/**
 * A connector-protocol 0.0.2+ definition. `protocol_capabilities` is
 * REQUIRED here (even as `[]` for a non-emitter) — this is what makes an
 * invalid 0.0.2 definition (one that simply omits the field) impossible to
 * construct at the type level.
 */
export interface DeclaredConnectorPlacementInput extends ConnectorPlacementInputBase {
  readonly protocol_capabilities: readonly ConnectorProtocolCapability[];
}

/**
 * A connector definition authored against the legacy connector-protocol
 * 0.0.1 contract, from before `protocol_capabilities` existed. The
 * discriminant is a closed literal identity tag, not a boolean: JS has no
 * runtime cryptographic attestation, so this is still caller-supplied, but
 * the discriminant name and literal type make clear this branch means
 * specifically "this is a pre-0.0.2 connector-protocol contract" — it can no
 * longer be set as a blanket trust bypass for unrelated code paths (e.g. an
 * arbitrary custom-command dev entrypoint), because the type system makes
 * "legacy" and "declares capabilities" mutually exclusive branches of the
 * union: this variant MUST NOT also carry `protocol_capabilities`.
 */
export interface LegacyConnectorPlacementInput extends ConnectorPlacementInputBase {
  readonly protocol_contract_version: "0.0.1";
}

/**
 * Discriminated union: either a 0.0.2+ connector that explicitly declares
 * its protocol capabilities, or a legacy 0.0.1 connector identified by a
 * closed literal tag. Omission of `protocol_capabilities` is only legal via
 * the latter branch — there is no freeform boolean escape hatch.
 */
export type ConnectorPlacementInput = DeclaredConnectorPlacementInput | LegacyConnectorPlacementInput;

export type RuntimeCapabilityName = RuntimeBindingName | ConnectorProtocolCapability;

export type PlacementDecision =
  | { readonly kind: "ok"; readonly satisfied: readonly RuntimeBindingName[] }
  | {
      readonly kind: "missing_capability";
      readonly missing: readonly RuntimeCapabilityName[];
      readonly runtime: string;
      readonly connectorId: string;
    }
  | {
      /**
       * The input object matches NEITHER union branch: it has no
       * `protocol_capabilities` array AND no `protocol_contract_version:
       * "0.0.1"` tag. TypeScript's discriminated union prevents this for
       * well-typed callers, but plain JS callers (not just TS) can still
       * construct a malformed object at runtime that satisfies neither
       * branch, so this runtime guard stays even though the type system
       * now makes the two legitimate branches exhaustive. Distinct from
       * `"missing_capability"` because there is no known list of
       * capabilities to diff against the runtime yet — the connector must
       * declare its capabilities (or its legacy identity) first.
       */
      readonly kind: "undeclared_capabilities";
      readonly runtime: string;
      readonly connectorId: string;
    };

/**
 * Returns the list of bindings the connector requires that the runtime
 * does NOT advertise. Empty array means the connector is eligible to
 * run in this runtime.
 */
export function diffRequiredBindings(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): RuntimeBindingName[] {
  const declared = connector.runtime_requirements?.bindings ?? {};
  const missing: RuntimeBindingName[] = [];
  for (const [name, decl] of Object.entries(declared) as [RuntimeBindingName, { required?: boolean }][]) {
    if (decl.required && !runtime.bindings.has(name)) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Returns the protocol capabilities a connector requires that the runtime
 * does not advertise. A missing capability is a pre-spawn incompatibility.
 *
 * A legacy (`protocol_contract_version: "0.0.1"`) connector has no
 * `protocol_capabilities` array by construction — its omission defaults to
 * "requires nothing" (today's pre-0.0.2 behavior). Any other connector that
 * lacks a `protocol_capabilities` array is a malformed, runtime-only input
 * that neither union branch permits statically — call
 * `hasUndeclaredCapabilities` first and route it to the
 * `"undeclared_capabilities"` decision rather than calling this function.
 */
export function diffRequiredProtocolCapabilities(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): ConnectorProtocolCapability[] {
  const declared = "protocol_capabilities" in connector ? connector.protocol_capabilities : [];
  return declared.filter((capability) => !runtime.protocolCapabilities.has(capability));
}

/**
 * True when a connector input satisfies NEITHER legitimate union branch: it
 * has no `protocol_capabilities` array and no `protocol_contract_version:
 * "0.0.1"` tag. TypeScript's discriminated union makes this unconstructable
 * for well-typed callers, but a plain JS caller (or a value that has
 * bypassed the type checker, e.g. via `JSON.parse`) can still produce such
 * an object at runtime, so placement must refuse it rather than silently
 * treating the omission as `[]` — that silent default is exactly how a
 * 0.0.2+ `STREAM_EVIDENCE` emitter that forgot to declare it would slip past
 * a fail-closed runtime.
 */
function hasUndeclaredCapabilities(connector: ConnectorPlacementInput): boolean {
  return !("protocol_capabilities" in connector) && !("protocol_contract_version" in connector);
}

/**
 * Pre-spawn placement decision. Compares connector requirements against
 * runtime capabilities and returns a typed result the orchestrator can
 * branch on.
 */
export function evaluatePlacement(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): PlacementDecision {
  if (hasUndeclaredCapabilities(connector)) {
    return {
      connectorId: connector.connector_id,
      kind: "undeclared_capabilities",
      runtime: runtime.id,
    };
  }
  const missingBindings = diffRequiredBindings(connector, runtime);
  const missingProtocolCapabilities = diffRequiredProtocolCapabilities(connector, runtime);
  const missing: RuntimeCapabilityName[] = [...missingBindings, ...missingProtocolCapabilities];
  if (missing.length === 0) {
    const declared = connector.runtime_requirements?.bindings ?? {};
    const satisfied = (Object.keys(declared) as RuntimeBindingName[]).filter(
      (name) => declared[name]?.required && runtime.bindings.has(name)
    );
    return { kind: "ok", satisfied };
  }
  return {
    connectorId: connector.connector_id,
    kind: "missing_capability",
    missing,
    runtime: runtime.id,
  };
}

/**
 * Stable error code surfaced when pre-spawn capability gating refuses
 * to run a connector. Mirrored in dashboard error states.
 */
export const RUNTIME_CAPABILITY_MISMATCH_CODE = "runtime_capability_mismatch";

export class RuntimeCapabilityMismatchError extends Error {
  readonly code: typeof RUNTIME_CAPABILITY_MISMATCH_CODE;
  readonly missing: readonly RuntimeCapabilityName[];
  readonly runtime: string;
  readonly connectorId: string;

  constructor(args: {
    connectorId: string;
    runtime: string;
    missing: readonly RuntimeCapabilityName[];
  }) {
    super(
      `Runtime '${args.runtime}' cannot satisfy connector '${args.connectorId}': missing capabilities [${args.missing.join(", ")}]. ` +
        "Run this connector in a runtime that advertises the required bindings (typically the local collector runtime)."
    );
    this.name = "RuntimeCapabilityMismatchError";
    this.code = RUNTIME_CAPABILITY_MISMATCH_CODE;
    this.missing = args.missing;
    this.runtime = args.runtime;
    this.connectorId = args.connectorId;
  }
}

/**
 * Stable error code surfaced when a connector definition matches neither
 * `ConnectorPlacementInput` union branch. Distinct from
 * {@link RUNTIME_CAPABILITY_MISMATCH_CODE}: this is a connector-authoring
 * defect (the declaration is missing, not merely incompatible with the
 * runtime), so callers should not present it as "run this on a different
 * runtime" — the connector itself must declare its capabilities (or its
 * legacy identity) before it can run anywhere.
 */
export const RUNTIME_CAPABILITY_UNDECLARED_CODE = "runtime_capability_undeclared";

export class RuntimeCapabilityUndeclaredError extends Error {
  readonly code: typeof RUNTIME_CAPABILITY_UNDECLARED_CODE;
  readonly runtime: string;
  readonly connectorId: string;

  constructor(args: { connectorId: string; runtime: string }) {
    super(
      `Connector '${args.connectorId}' omits 'protocol_capabilities' and does not carry ` +
        "'protocol_contract_version: \"0.0.1\"'. A connector-protocol 0.0.2+ connector " +
        "definition must declare its protocol capabilities explicitly (even as an empty array) " +
        `before it can be placed on runtime '${args.runtime}'. Only a connector authored ` +
        "against the legacy 0.0.1 contract may omit 'protocol_capabilities', and only by " +
        "carrying the 'protocol_contract_version: \"0.0.1\"' identity tag."
    );
    this.name = "RuntimeCapabilityUndeclaredError";
    this.code = RUNTIME_CAPABILITY_UNDECLARED_CODE;
    this.runtime = args.runtime;
    this.connectorId = args.connectorId;
  }
}

/**
 * Convenience: throw a typed mismatch error if placement is not ok.
 * Returns the satisfied bindings on success so callers can record them
 * in run diagnostics.
 */
export function assertPlacementOrThrow(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): readonly RuntimeBindingName[] {
  const decision = evaluatePlacement(connector, runtime);
  if (decision.kind === "ok") {
    return decision.satisfied;
  }
  if (decision.kind === "undeclared_capabilities") {
    throw new RuntimeCapabilityUndeclaredError({
      connectorId: decision.connectorId,
      runtime: decision.runtime,
    });
  }
  throw new RuntimeCapabilityMismatchError({
    connectorId: decision.connectorId,
    missing: decision.missing,
    runtime: decision.runtime,
  });
}
