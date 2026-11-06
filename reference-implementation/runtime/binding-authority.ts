// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BindingInstance } from "./binding-declarations.ts";

export type BindingLifecycle =
  | "granted"
  | "unsupported"
  | "denied"
  | "unavailable"
  | "revoked"
  | "optional_not_granted";
export type BindingCoverage = "enforced" | "recorded" | "not_observable";

export interface BindingResolution {
  readonly channels: Readonly<
    Record<
      string,
      {
        readonly coverage: BindingCoverage;
        readonly observedAttempts?: readonly string[];
      }
    >
  >;
  readonly effectiveConstraints?: Readonly<Record<string, unknown>>;
  readonly handleIdentity?: string;
  readonly instanceKey: string;
  readonly lifecycle: BindingLifecycle;
  readonly mechanism?: string;
  readonly mechanismVersion?: string;
  readonly remainingAmbientAccess?: readonly string[];
}

/** A trusted policy fact, already bound to the exact access decision and its revision. */
export interface WeakerCoverageAuthorization {
  readonly accessIdentity: string;
  readonly accessRevision: string;
  readonly channel: string;
  readonly connectionId: string;
  readonly expiresAt: number;
  readonly instanceKey: string;
  readonly ownerId: string;
  readonly policyIdentity: string;
  readonly revoked: boolean;
}

export interface BindingAuthorityInput {
  readonly accessIdentityByInstance: Readonly<Record<string, { readonly identity: string; readonly revision: string }>>;
  readonly connectionId: string;
  readonly instances: readonly BindingInstance[];
  readonly now: number;
  readonly ownerId: string;
  readonly policyIdentity: string;
  readonly resolutions: readonly BindingResolution[];
  readonly runId: string;
  readonly weakerCoverageAuthorizations: readonly WeakerCoverageAuthorization[];
}

export interface BindingAuthorityRecord {
  readonly connectionId: string;
  readonly instances: readonly {
    readonly instanceKey: string;
    readonly kind: string;
    readonly required: boolean;
    readonly requestedReach: "full_kind_reach" | "declared_constraints";
    readonly lifecycle: BindingLifecycle;
    readonly handleIdentity?: string;
    readonly mechanism?: string;
    readonly mechanismVersion?: string;
    readonly requestedDeclaration: Readonly<Record<string, unknown>>;
    readonly effectiveConstraints?: Readonly<Record<string, unknown>>;
    readonly remainingAmbientAccess?: readonly string[];
    readonly channels: readonly {
      readonly name: string;
      readonly coverage: BindingCoverage;
      readonly observedAttempts?: readonly string[];
      readonly resolutionPresent: boolean;
      readonly authorization?: WeakerCoverageAuthorization;
      readonly weakerCoverageAuthorized: boolean;
    }[];
  }[];
  readonly ownerId: string;
  readonly policyIdentity: string;
  readonly runId: string;
}

export interface BindingAuthorityDecision {
  readonly placeable: boolean;
  readonly record: BindingAuthorityRecord;
  readonly refusals: readonly { readonly instanceKey: string; readonly reason: string }[];
}

// Runtime-local minimum channels, not a normative registry. These expose the
// profile examples while making absent constraints mean the kind's full reach.
const MINIMUM_CHANNELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  browser: Object.freeze(["browser.navigate", "browser.connect"]),
  filesystem: Object.freeze(["filesystem.inputs", "filesystem.outputs"]),
  network: Object.freeze(["network.hosts"]),
});
const SUPPORTED_INTERFACES: Readonly<Record<string, string>> = Object.freeze({
  browser: "browser@1",
  filesystem: "filesystem@1",
  network: "network@1",
});

function immutableCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableCopy));
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: true,
        value: immutableCopy(entry),
        writable: false,
      });
    }
    return Object.freeze(copy);
  }
  return value;
}

function channelNames(instance: BindingInstance, supplied: BindingResolution | undefined): readonly string[] {
  const known = Object.hasOwn(MINIMUM_CHANNELS, instance.kind) ? MINIMUM_CHANNELS[instance.kind] : undefined;
  return [...new Set([...(known ?? []), ...Object.keys(supplied?.channels ?? {})])];
}

function isSupportedInstance(instance: BindingInstance): boolean {
  if (!Object.hasOwn(MINIMUM_CHANNELS, instance.kind)) {
    return false;
  }
  return instance.interface === undefined || instance.interface === SUPPORTED_INTERFACES[instance.kind];
}

function policyMatches(
  authorization: WeakerCoverageAuthorization,
  input: BindingAuthorityInput,
  instance: BindingInstance,
  channel: string
): boolean {
  const access = Object.hasOwn(input.accessIdentityByInstance, instance.key)
    ? input.accessIdentityByInstance[instance.key]
    : undefined;
  return (
    authorization.ownerId === input.ownerId &&
    authorization.connectionId === input.connectionId &&
    authorization.instanceKey === instance.key &&
    authorization.channel === channel &&
    authorization.policyIdentity === input.policyIdentity &&
    access !== undefined &&
    authorization.accessIdentity === access.identity &&
    authorization.accessRevision === access.revision &&
    authorization.expiresAt > input.now &&
    !authorization.revoked
  );
}

function hasActualGrantFacts(resolution: BindingResolution | undefined): resolution is BindingResolution & {
  readonly handleIdentity: string;
  readonly mechanism: string;
  readonly mechanismVersion: string;
} {
  return (
    resolution?.lifecycle === "granted" &&
    typeof resolution.handleIdentity === "string" &&
    resolution.handleIdentity.length > 0 &&
    typeof resolution.mechanism === "string" &&
    resolution.mechanism.length > 0 &&
    typeof resolution.mechanismVersion === "string" &&
    resolution.mechanismVersion.length > 0 &&
    resolution.effectiveConstraints !== undefined
  );
}

function determineLifecycle(
  instance: BindingInstance,
  supplied: BindingResolution | undefined,
  validGrantFacts: boolean
): BindingLifecycle {
  if (!isSupportedInstance(instance)) {
    return "unsupported";
  }
  if (supplied?.lifecycle === "granted" && !validGrantFacts) {
    return "unavailable";
  }
  if (supplied !== undefined) {
    return supplied.lifecycle;
  }
  return instance.required ? "unavailable" : "optional_not_granted";
}

function buildInstanceRecord(
  input: BindingAuthorityInput,
  instance: BindingInstance,
  supplied: BindingResolution | undefined
): {
  readonly record: BindingAuthorityRecord["instances"][number];
  readonly refusals: readonly { instanceKey: string; reason: string }[];
} {
  const validGrantFacts = isSupportedInstance(instance) && hasActualGrantFacts(supplied);
  const lifecycle = determineLifecycle(instance, supplied, validGrantFacts);
  const channels = channelNames(instance, supplied).map((name) => {
    const fact = supplied && Object.hasOwn(supplied.channels, name) ? supplied.channels[name] : undefined;
    const coverage = fact?.coverage ?? "not_observable";
    const authorization =
      lifecycle === "granted" && fact !== undefined && coverage !== "enforced"
        ? input.weakerCoverageAuthorizations.find((candidate) => policyMatches(candidate, input, instance, name))
        : undefined;
    return Object.freeze({
      coverage,
      name,
      ...(fact?.observedAttempts === undefined ? {} : { observedAttempts: Object.freeze([...fact.observedAttempts]) }),
      resolutionPresent: fact !== undefined,
      ...(authorization === undefined ? {} : { authorization: Object.freeze({ ...authorization }) }),
      weakerCoverageAuthorized: authorization !== undefined,
    });
  });
  const refusals: { instanceKey: string; reason: string }[] = [];
  if (instance.required && lifecycle !== "granted") {
    refusals.push({ instanceKey: instance.key, reason: `required instance lifecycle is ${lifecycle}` });
  }
  for (const channel of channels) {
    if (instance.required && lifecycle === "granted" && !channel.resolutionPresent) {
      refusals.push({ instanceKey: instance.key, reason: `required channel ${channel.name} has no resolution facts` });
    } else if (
      instance.required &&
      lifecycle === "granted" &&
      channel.coverage !== "enforced" &&
      !channel.weakerCoverageAuthorized
    ) {
      refusals.push({
        instanceKey: instance.key,
        reason: `required channel ${channel.name} lacks enforced coverage or matching authorization`,
      });
    }
  }
  const record = Object.freeze({
    instanceKey: instance.key,
    kind: instance.kind,
    lifecycle,
    requestedReach:
      Object.hasOwn(instance.declaration, "constraints") &&
      Object.keys((instance.declaration.constraints as Record<string, unknown> | undefined) ?? {}).length > 0
        ? ("declared_constraints" as const)
        : ("full_kind_reach" as const),
    required: instance.required,
    ...(validGrantFacts
      ? {
          ...(supplied.effectiveConstraints === undefined
            ? {}
            : {
                effectiveConstraints: immutableCopy(supplied.effectiveConstraints) as Readonly<Record<string, unknown>>,
              }),
          handleIdentity: supplied.handleIdentity,
          mechanism: supplied.mechanism,
          mechanismVersion: supplied.mechanismVersion,
        }
      : {}),
    channels: Object.freeze(channels),
    ...(validGrantFacts && supplied.remainingAmbientAccess !== undefined
      ? { remainingAmbientAccess: Object.freeze([...supplied.remainingAmbientAccess]) }
      : {}),
    requestedDeclaration: immutableCopy(instance.declaration) as Readonly<Record<string, unknown>>,
  });
  return { record, refusals: Object.freeze(refusals) };
}

/**
 * Builds a snapshot from caller-supplied trusted runtime facts. It does not
 * resolve or grant handles, verify fact truth, enforce constraints, authenticate
 * an owner, persist, observe, close revoked handles, or prove confinement. A
 * future adapter must establish those facts before calling this function.
 */
export function decideBindingAuthority(input: BindingAuthorityInput): BindingAuthorityDecision {
  const declaredKeys = new Set(input.instances.map((instance) => instance.key));
  if (declaredKeys.size !== input.instances.length) {
    throw new Error("duplicate binding instance");
  }
  const resolutionByKey = new Map<string, BindingResolution>();
  for (const resolution of input.resolutions) {
    if (!declaredKeys.has(resolution.instanceKey)) {
      throw new Error(`binding resolution names undeclared instance ${resolution.instanceKey}`);
    }
    if (resolutionByKey.has(resolution.instanceKey)) {
      throw new Error(`duplicate binding resolution for ${resolution.instanceKey}`);
    }
    resolutionByKey.set(resolution.instanceKey, resolution);
  }
  const built = input.instances.map((instance) =>
    buildInstanceRecord(input, instance, resolutionByKey.get(instance.key))
  );
  const refusals = built.flatMap(({ refusals: instanceRefusals }) => instanceRefusals);
  const record: BindingAuthorityRecord = Object.freeze({
    connectionId: input.connectionId,
    instances: Object.freeze(built.map(({ record: instanceRecord }) => instanceRecord)),
    ownerId: input.ownerId,
    policyIdentity: input.policyIdentity,
    runId: input.runId,
  });
  return Object.freeze({
    placeable: refusals.length === 0,
    record,
    refusals: Object.freeze(refusals.map(({ instanceKey, reason }) => Object.freeze({ instanceKey, reason }))),
  });
}
