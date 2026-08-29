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

export interface ConnectorPlacementInput {
  readonly connector_id: string;
  /**
   * Protocol capabilities the connector will use on the wire.
   *
   * Omitting this field is only tolerated for a connector whose definition
   * predates the connector-protocol 0.0.2 capability-declaration contract —
   * see {@link ConnectorPlacementInput.trusted_legacy_artifact}. A 0.0.2+
   * connector definition MUST declare this explicitly, even as `[]`, or
   * placement fails with `"undeclared_capabilities"` rather than silently
   * treating the omission as "requires nothing".
   */
  readonly protocol_capabilities?: readonly ConnectorProtocolCapability[];
  readonly runtime_requirements?: ConnectorRuntimeRequirements;
  /**
   * Narrow escape hatch for a connector definition authored against the
   * legacy connector-protocol 0.0.1 contract, from before
   * `protocol_capabilities` existed. Set this ONLY for such an artifact.
   * When `true` and `protocol_capabilities` is omitted, placement treats the
   * omission as `[]` (today's pre-0.0.2 behavior). Defaults to `false`, so an
   * unmarked connector that omits `protocol_capabilities` is a hard
   * placement failure rather than a silently under-gated one — see
   * `diffRequiredProtocolCapabilities`.
   */
  readonly trusted_legacy_artifact?: boolean;
}

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
       * A 0.0.2+ connector omitted `protocol_capabilities` without setting
       * `trusted_legacy_artifact`. Distinct from `"missing_capability"`
       * because there is no known list of capabilities to diff against the
       * runtime yet — the connector must declare its capabilities first.
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
 * `connector.protocol_capabilities` being `undefined` is NOT the same as
 * `[]`: an omitted declaration only defaults to "requires nothing" when the
 * connector is marked `trusted_legacy_artifact` (a pre-0.0.2 connector that
 * predates this field). Any other omission is a caller error — call
 * `hasUndeclaredCapabilities` first and route it to the
 * `"undeclared_capabilities"` decision rather than calling this function.
 */
export function diffRequiredProtocolCapabilities(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): ConnectorProtocolCapability[] {
  return (connector.protocol_capabilities ?? []).filter((capability) => !runtime.protocolCapabilities.has(capability));
}

/**
 * True when a connector's protocol capabilities cannot be trusted as "none
 * required": `protocol_capabilities` is omitted and the connector is not
 * marked as a trusted legacy (pre-0.0.2) artifact. Placement must refuse
 * such a connector rather than silently treating the omission as `[]` —
 * that silent default is exactly how a 0.0.2+ `STREAM_EVIDENCE` emitter
 * that forgot to declare it would slip past a fail-closed runtime.
 */
function hasUndeclaredCapabilities(connector: ConnectorPlacementInput): boolean {
  return connector.protocol_capabilities === undefined && connector.trusted_legacy_artifact !== true;
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
 * Stable error code surfaced when a connector definition omits
 * `protocol_capabilities` without the narrow `trusted_legacy_artifact`
 * escape hatch. Distinct from {@link RUNTIME_CAPABILITY_MISMATCH_CODE}: this
 * is a connector-authoring defect (the declaration is missing, not merely
 * incompatible with the runtime), so callers should not present it as "run
 * this on a different runtime" — the connector itself must declare its
 * capabilities before it can run anywhere.
 */
export const RUNTIME_CAPABILITY_UNDECLARED_CODE = "runtime_capability_undeclared";

export class RuntimeCapabilityUndeclaredError extends Error {
  readonly code: typeof RUNTIME_CAPABILITY_UNDECLARED_CODE;
  readonly runtime: string;
  readonly connectorId: string;

  constructor(args: { connectorId: string; runtime: string }) {
    super(
      `Connector '${args.connectorId}' omits 'protocol_capabilities' and is not marked ` +
        "'trusted_legacy_artifact'. A connector-protocol 0.0.2+ connector definition must " +
        "declare its protocol capabilities explicitly (even as an empty array) before it can " +
        `be placed on runtime '${args.runtime}'. Only a connector authored against the legacy ` +
        "0.0.1 contract may omit this field, and only when explicitly marked trusted."
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
