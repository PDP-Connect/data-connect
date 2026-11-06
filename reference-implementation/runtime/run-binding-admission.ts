// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import {
  createConnectorBindingAuthorityStore,
  encodeBindingAuthority,
} from "../server/stores/connector-binding-authority-store.ts";
import { type BindingAuthorityRecord, decideBindingAuthority } from "./binding-authority.ts";
import { BrowserBindingPlacementRefused } from "./binding-control.ts";
import { type BindingInstance, unsupportedReason } from "./binding-declarations.ts";

// Placement support is not authority. This is the implemented adapter set;
// actual resources and current policy still come from the trusted handoff.
const SUPPORT = {
  constraintKinds: new Set<string>(),
  features: new Set<string>(),
  interfaceVersions: new Map([["browser", new Set([1])]]),
  kinds: new Set(["browser"]),
};

export function requiresProtectedBindingAdmission(instances: readonly BindingInstance[]): boolean {
  return instances.some((instance) => unsupportedReason(instance, SUPPORT) === null);
}

/** Must run before legacy browser allocation, as well as at the direct entrypoint. */
export function assertBindingAdmissionAvailable(instances: readonly BindingInstance[], available: boolean): void {
  for (const instance of instances) {
    if (!instance.required) {
      continue;
    }
    const reason = unsupportedReason(instance, SUPPORT);
    if (reason !== null) {
      throw new BrowserBindingPlacementRefused(instance.key, reason);
    }
    if (!available) {
      throw new BrowserBindingPlacementRefused(
        instance.key,
        "Protected binding admission is not configured for this run",
        "binding_unavailable"
      );
    }
  }
}

export interface RunBindingScope {
  readonly connectionId: string;
  readonly ownerId: string;
  readonly runId: string;
}

/** No resources are acquired here. Even optional omissions have a durable, scoped outcome. */
export async function recordUnprovidedBindings(
  scope: RunBindingScope,
  instances: readonly BindingInstance[]
): Promise<BindingAuthorityRecord> {
  assertBindingAdmissionAvailable(instances, false);
  const { record } = decideBindingAuthority({
    ...scope,
    accessIdentityByInstance: {},
    instances,
    now: Date.now(),
    policyIdentity: "runtime:no-binding-adapter:v1",
    resolutions: instances.map((instance) => ({
      channels: {},
      instanceKey: instance.key,
      lifecycle: unsupportedReason(instance, SUPPORT) === null ? "optional_not_granted" : "unsupported",
    })),
    weakerCoverageAuthorizations: [],
  });
  await createConnectorBindingAuthorityStore().put({ ...scope, policyIdentity: record.policyIdentity, record });
  return record;
}

/**
 * The caller supplies a current trusted handoff, never an environment-derived
 * handle. Reuse the authority decision to check grant facts and each channel;
 * a persisted flag alone cannot renew an expired or mismatched authorization.
 */
export function admittedStartBindings(
  scope: RunBindingScope,
  instances: readonly BindingInstance[],
  record: BindingAuthorityRecord | void,
  now = Date.now()
): Record<string, Record<string, never>> {
  const refuse = (): never => {
    throw new BrowserBindingPlacementRefused(
      instances[0]?.key ?? "browser",
      "A current authority record for the exact run and declarations is required",
      "binding_unavailable"
    );
  };
  if (!record) {
    return refuse();
  }
  try {
    encodeBindingAuthority({ ...scope, policyIdentity: record.policyIdentity, record });
  } catch {
    return refuse();
  }
  if (
    record.instances.length !== instances.length ||
    instances.some((instance, index) => {
      const actual = record.instances[index];
      return (
        !actual ||
        actual.instanceKey !== instance.key ||
        actual.kind !== instance.kind ||
        actual.required !== instance.required ||
        !isDeepStrictEqual(actual.requestedDeclaration, instance.declaration)
      );
    })
  ) {
    return refuse();
  }
  const accessIdentityByInstance: Record<string, { identity: string; revision: string }> = {};
  const authorizations = record.instances.flatMap((instance) =>
    instance.channels.flatMap((channel) => {
      if (!channel.authorization) {
        return [];
      }
      const authorization = channel.authorization;
      const previous = accessIdentityByInstance[instance.instanceKey];
      if (
        previous &&
        (previous.identity !== authorization.accessIdentity || previous.revision !== authorization.accessRevision)
      ) {
        return refuse();
      }
      accessIdentityByInstance[instance.instanceKey] = {
        identity: authorization.accessIdentity,
        revision: authorization.accessRevision,
      };
      return [authorization];
    })
  );
  const decision = decideBindingAuthority({
    ...scope,
    accessIdentityByInstance,
    // Validate every supplied handle, including an optional granted instance.
    instances: instances.map((instance, index) =>
      record.instances[index]?.lifecycle === "granted" ? { ...instance, required: true } : instance
    ),
    now,
    policyIdentity: record.policyIdentity,
    resolutions: record.instances.map((instance) => ({
      ...instance,
      channels: Object.fromEntries(
        instance.channels
          .filter((channel) => channel.resolutionPresent)
          .map((channel) => [
            channel.name,
            {
              coverage: channel.coverage,
              ...(channel.observedAttempts === undefined ? {} : { observedAttempts: channel.observedAttempts }),
            },
          ])
      ),
    })),
    weakerCoverageAuthorizations: authorizations,
  });
  if (
    !decision.placeable ||
    decision.record.instances.some(
      (instance, index) =>
        !isDeepStrictEqual({ ...instance, required: record.instances[index]?.required }, record.instances[index])
    )
  ) {
    return refuse();
  }
  return Object.fromEntries(
    record.instances
      .filter((instance) => instance.lifecycle === "granted")
      .map((instance) => [instance.instanceKey, {}])
  );
}
