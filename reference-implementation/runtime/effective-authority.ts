// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile 3.3.9 leaves member names provisional. This versioned
// record describes the local Node child deployment, which has no forced
// egress boundary or per-instance filesystem/browser confinement.
export interface AuthorityBindingRequest {
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly inputs?: readonly unknown[];
  readonly interface?: string;
  readonly kind?: string;
  readonly required?: boolean;
}

export interface AuthorityChannel {
  readonly coverage: "not_observable";
  readonly observation: {
    readonly status: "not_observable";
    readonly attempts: readonly unknown[];
  };
}

export interface AuthorityInstance {
  readonly channels: Readonly<Record<string, AuthorityChannel>>;
  readonly declared: boolean;
  readonly effective_constraints: null;
  readonly effective_reach: "unconfined" | "none";
  readonly interface: string | null;
  readonly kind: string;
  readonly lifecycle: "granted" | "unsupported" | "optional_not_granted";
  readonly mechanism: {
    readonly name: "node-child-process";
    readonly version: string;
  } | null;
  readonly requested_constraints: Readonly<Record<string, unknown>> | null;
  readonly required: boolean;
}

export interface EffectiveAuthorityRecord {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly instances: Readonly<Record<string, AuthorityInstance>>;
  readonly object: "effective_authority";
  readonly owner_subject_id: string;
  readonly policy: {
    readonly id: "reference-local-child-v1";
    readonly weaker_coverage: readonly {
      readonly instance: string;
      readonly channel: string;
      readonly coverage: "not_observable";
      readonly rationale: string;
    }[];
  };
  readonly recorded_at: string;
  readonly remaining_ambient_access: readonly string[];
  readonly run_id: string;
  readonly schema_version: 1;
}

function requestedConstraints(request: AuthorityBindingRequest | undefined): Readonly<Record<string, unknown>> | null {
  if (!(request?.constraints || request?.inputs)) {
    return null;
  }
  // The manifest validator owns alias agreement. Normalize for this record
  // so both forms retain the same request and per-input channel identities.
  return structuredClone({ ...request.constraints, ...(request.inputs ? { inputs: request.inputs } : {}) });
}

function channelNames(kind: string, constraints: Readonly<Record<string, unknown>> | null): string[] {
  switch (kind) {
    case "browser":
      return ["navigate", "connect", "frames"];
    case "network":
      return ["hosts"];
    case "filesystem": {
      const slots: string[] = ["paths"];
      for (const slotType of ["inputs", "outputs"]) {
        const slotsValue = constraints?.[slotType];
        if (!Array.isArray(slotsValue)) {
          continue;
        }
        for (const [index, slot] of slotsValue.entries()) {
          const identifier = slotType === "inputs" ? slot?.env_var : slot?.slot;
          slots.push(`${slotType}.${typeof identifier === "string" ? identifier : index}`);
        }
      }
      return slots;
    }
    case "desktop_session": {
      const items = constraints?.items;
      return Array.isArray(items) ? items.map((_, index) => `items.${index}`) : ["access"];
    }
    default:
      return ["access"];
  }
}

/**
 * Receives exactly the bindings that will be sent in START, keyed by instance.
 * Handle values are deliberately never inspected or persisted: they may carry
 * endpoint credentials. Missing declarations remain visible, as do undeclared
 * handles this deployment actually gives the child.
 */
export function buildEffectiveAuthorityRecord(input: {
  readonly runId: string;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly requestedBindings: Readonly<Record<string, AuthorityBindingRequest>>;
  readonly effectiveBindings: Readonly<object>;
  readonly recordedAt?: string;
}): EffectiveAuthorityRecord {
  const instances: Record<string, AuthorityInstance> = {};
  const weakerCoverage: EffectiveAuthorityRecord["policy"]["weaker_coverage"][number][] = [];
  const keys = new Set([...Object.keys(input.requestedBindings), ...Object.keys(input.effectiveBindings)]);
  for (const key of keys) {
    const request = input.requestedBindings[key];
    const kind = request?.kind ?? key;
    const constraints = requestedConstraints(request);
    const granted = Object.hasOwn(input.effectiveBindings, key);
    const channels: Record<string, AuthorityChannel> = {};
    for (const channel of channelNames(kind, constraints)) {
      channels[channel] = {
        coverage: "not_observable",
        observation: { attempts: [], status: "not_observable" },
      };
      if (granted) {
        weakerCoverage.push({
          channel,
          coverage: "not_observable",
          instance: key,
          rationale: "The reference local-process deployment permits unconfined child access on this channel.",
        });
      }
    }
    const missingLifecycle = request?.required ? "unsupported" : "optional_not_granted";
    instances[key] = {
      channels,
      declared: request !== undefined,
      effective_constraints: null,
      effective_reach: granted ? "unconfined" : "none",
      interface: request?.interface ?? null,
      kind,
      lifecycle: granted ? "granted" : missingLifecycle,
      mechanism: granted ? { name: "node-child-process", version: process.versions.node } : null,
      requested_constraints: constraints,
      required: request?.required === true,
    };
  }
  return {
    connector_id: input.connectorId,
    connector_instance_id: input.connectorInstanceId,
    instances,
    object: "effective_authority",
    owner_subject_id: input.ownerSubjectId,
    policy: { id: "reference-local-child-v1", weaker_coverage: weakerCoverage },
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    remaining_ambient_access: ["host_network", "host_filesystem", "inherited_run_credentials", "child_processes"],
    run_id: input.runId,
    schema_version: 1,
  };
}
