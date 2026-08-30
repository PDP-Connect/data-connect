// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorProtocolCapability,
  isConnectorProtocolCapabilityArray,
} from "@pdpp/connector-protocol";

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
  /** Bindings this runtime advertises as available. */
  readonly bindings: ReadonlySet<RuntimeBindingName>;
  /** Stable identifier of the runtime. Used in diagnostics. */
  readonly id: string;
  /** Protocol capabilities this runtime advertises as available. */
  readonly protocolCapabilities: ReadonlySet<ConnectorProtocolCapability>;
  /** Connector-protocol version this runtime recognizes. */
  readonly protocolVersion: string;
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
 *
 * Does NOT advertise `STREAM_EVIDENCE`: no local-collector connector
 * (`packages/local-collector/src/generated/collector-definitions.generated.ts`)
 * emits it today, and `collector-runner.ts`'s `handleMessage` only validates a
 * `STREAM_EVIDENCE` message and discards it — there is no durable outbox path
 * for it yet. Advertising the capability without a durable delivery path is
 * false advertising. `STREAM_EVIDENCE` is currently emitted only by the Gmail
 * connector on the server/reference runtime (a separate runtime profile in a
 * separate repository). Durable device-side propagation is real future work,
 * deliberately deferred rather than half-built here.
 */
export const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  bindings: new Set<RuntimeBindingName>(["network", "browser", "filesystem", "local_device"]),
  id: "collector",
  protocolCapabilities: new Set<ConnectorProtocolCapability>(),
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
};

export interface ConnectorRuntimeRequirements {
  readonly bindings?: Partial<Record<RuntimeBindingName, { readonly required?: boolean }>>;
}

/**
 * A connector-protocol 0.0.2+ definition. `protocol_capabilities` is
 * REQUIRED (even as `[]` for a non-emitter) — this is what makes an invalid
 * definition (one that simply omits the field) impossible to construct at
 * the type level.
 *
 * An earlier revision tried a caller-supplied `protocol_contract_version:
 * "0.0.1"` legacy identity tag as an escape hatch for connectors authored
 * before `protocol_capabilities` existed. It was REMOVED rather than fixed:
 * nothing separated a genuine legacy artifact from a caller merely claiming
 * to be one (the "legacy" branch was detected by KEY presence only, never by
 * any property that couldn't also be forged), so `{ protocol_contract_version:
 * "0.0.1", protocol_capabilities: [...] }` or a value with the tag under a
 * different string could bypass capability declaration entirely. There is no
 * verified artifact identity to hang a real legacy check on, so the bypass is
 * gone: every connector-protocol 0.0.2+ connector (which, with the bypass
 * removed, is now the only kind) must declare its protocol capabilities
 * explicitly, full stop.
 */
export interface ConnectorPlacementInput {
  readonly connector_id: string;
  readonly protocol_capabilities: readonly ConnectorProtocolCapability[];
  readonly runtime_requirements?: ConnectorRuntimeRequirements;
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
       * The input's `protocol_capabilities` is missing or malformed
       * (not an array). `ConnectorPlacementInput` requires this field at
       * the type level, so a well-typed caller cannot produce this; a
       * plain-JS caller (e.g. a value round-tripped through `JSON.parse`)
       * still can, so this runtime guard defends against that, not against
       * a legitimate legacy identity — there is no legacy path anymore.
       * Distinct from `"missing_capability"` because there is no known
       * list of capabilities to diff against the runtime yet — the
       * connector must declare its capabilities first.
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
 * `protocol_capabilities` is required by `ConnectorPlacementInput`, so a
 * well-typed caller always has it present. Call `hasMalformedCapabilities`
 * first and route a malformed input to the `"undeclared_capabilities"`
 * decision rather than calling this function.
 */
export function diffRequiredProtocolCapabilities(
  connector: ConnectorPlacementInput,
  runtime: RuntimeCapabilityProfile
): ConnectorProtocolCapability[] {
  return connector.protocol_capabilities.filter((capability) => !runtime.protocolCapabilities.has(capability));
}

/**
 * True when `connector.protocol_capabilities` is not an array, or is an
 * array containing any member that is not an allowed
 * {@link ConnectorProtocolCapability} value. `ConnectorPlacementInput`
 * requires this field at the type level, so this is unconstructable for
 * well-typed callers; a plain JS caller (or a value that has bypassed the
 * type checker, e.g. via `JSON.parse` producing an object with the field
 * missing, of the wrong shape, or containing a forged/garbage element) can
 * still produce such an object at runtime, so placement must refuse it
 * rather than silently treating it as `[]` or filtering the bad members out
 * — either silent handling is exactly how a forged capability (`"FORGED"`,
 * `null`, `{}`, or a mix of one valid and one invalid entry) would slip past
 * a fail-closed runtime. This is a defense against a non-TypeScript caller
 * sending garbage over JSON, not a "declare your legacy identity" path —
 * there is no legacy path anymore. Delegates to
 * {@link isConnectorProtocolCapabilityArray} — the ONE place the allowed
 * vocabulary is authored — rather than re-deriving its own copy of it.
 */
function hasMalformedCapabilities(connector: ConnectorPlacementInput): boolean {
  return !isConnectorProtocolCapabilityArray(connector.protocol_capabilities);
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
  if (hasMalformedCapabilities(connector)) {
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
 * Stable error code surfaced when a connector definition's
 * `protocol_capabilities` is missing or malformed. Distinct from
 * {@link RUNTIME_CAPABILITY_MISMATCH_CODE}: this is a connector-authoring
 * defect (the declaration is missing/malformed, not merely incompatible
 * with the runtime), so callers should not present it as "run this on a
 * different runtime" — the connector itself must declare its capabilities
 * (even as `[]`) before it can run anywhere. This is purely a defense
 * against a non-TypeScript caller sending garbage over JSON; there is no
 * legacy contract-version bypass to route through this error instead.
 */
export const RUNTIME_CAPABILITY_UNDECLARED_CODE = "runtime_capability_undeclared";

export class RuntimeCapabilityUndeclaredError extends Error {
  readonly code: typeof RUNTIME_CAPABILITY_UNDECLARED_CODE;
  readonly runtime: string;
  readonly connectorId: string;

  constructor(args: { connectorId: string; runtime: string }) {
    super(
      `Connector '${args.connectorId}' has a missing or malformed 'protocol_capabilities' ` +
        "field (expected an array, even if empty). Every connector-protocol connector " +
        "definition must declare its protocol capabilities explicitly (even as an empty array) " +
        `before it can be placed on runtime '${args.runtime}'. There is no legacy exemption — ` +
        "this is typically caused by a plain-JS or JSON-deserialized caller bypassing the " +
        "TypeScript type checker."
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
