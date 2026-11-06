// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  AccessPolicyProposal,
  PreparedBindingAccess,
  WeakCoverageAcknowledgment,
} from "../../server/stores/connector-binding-access-policy-store.ts";

/** Fictional trusted preparation; never starts or grants a resource. */
export function preparedAccess(connectionId: string, ownerId = "owner_local"): PreparedBindingAccess {
  return {
    connectionId,
    expiresAt: 2_000_000_000_000,
    instances: [
      {
        accessIdentity: "fixture-prepared-files",
        accessRevision: "3",
        availability: "prepared",
        channels: [
          { coverage: "recorded", name: "filesystem.inputs" },
          { coverage: "not_observable", name: "filesystem.outputs" },
          { coverage: "enforced", name: "fixture.enforced" },
        ],
        consequentialActions: ["read archive"],
        effectiveConstraints: { outputs: [] },
        effectiveReach: { inputs: ["/fixture/selected"] },
        instanceKey: "files",
        kind: "filesystem",
        mechanism: "fixture-trusted-adapter",
        mechanismVersion: "2",
        purpose: "Read fixture archive",
        remainingAmbientAccess: ["unmediated filesystem"],
        requestedDeclaration: { constraints: { inputs: ["/fixture/request"] }, kind: "filesystem", required: true },
      },
    ],
    ownerId,
    phase: "PREPARED",
    policyIdentity: "fixture-access-policy-7",
  };
}
export function weakAck(snapshot: PreparedBindingAccess): WeakCoverageAcknowledgment[] {
  const [item] = snapshot.instances;
  if (!item) {
    throw new Error("fixture instance missing");
  }
  return [
    {
      accessIdentity: item.accessIdentity,
      accessRevision: item.accessRevision,
      channel: "filesystem.inputs",
      coverage: "recorded",
      instanceKey: item.instanceKey,
    },
  ];
}
export function policyAction(proposal: AccessPolicyProposal) {
  return {
    baseEpoch: proposal.baseEpoch,
    connectionId: proposal.snapshot.connectionId,
    ownerId: proposal.snapshot.ownerId,
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    snapshotDigest: proposal.snapshotDigest,
  };
}
