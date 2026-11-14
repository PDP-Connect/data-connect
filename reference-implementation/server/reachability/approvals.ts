// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Approval as RouteApproval, Candidate as RouteCandidate, Action as SetupAction } from "@tnunamak/gozar";

type SetupApproval = import("@tnunamak/gozar").RunSetupActionRequest["approval"];

export class ReachabilityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// These checks reject wrong-kind input before invoking the library. Gozar must
// independently enforce the same binding across its controller boundary.
export function requireSetupApproval(action: SetupAction, input: unknown): SetupApproval {
  const approval = input as Partial<SetupApproval> | null;
  if (!approval || approval.kind !== "setup") {
    throw new ReachabilityError("consent_kind_mismatch");
  }
  if (!action.consent?.facts || action.consent.disclosures === undefined || action.consent.disclosures === null) {
    throw new ReachabilityError("consent_details_unavailable");
  }
  if (
    action.consent.scope.kind !== "setup" ||
    action.consent.scope.actionId !== action.id ||
    action.consent.scope.actionDigest !== action.digest ||
    action.consent.scope.disclosureRevision !== action.disclosure.revision
  ) {
    throw new ReachabilityError("consent_changed");
  }
  if (
    approval.digest !== action.digest ||
    approval.disclosureRevision !== action.disclosure.revision ||
    approval.consentFactsDigest !== action.consent.consentFactsDigest
  ) {
    throw new ReachabilityError("consent_changed");
  }
  return {
    consentFactsDigest: approval.consentFactsDigest,
    digest: approval.digest,
    disclosureRevision: approval.disclosureRevision,
    kind: "setup",
  };
}

export function requireRouteApproval(candidate: RouteCandidate, input: unknown): RouteApproval {
  const approval = input as Partial<RouteApproval> | null;
  if (!approval || approval.kind !== "route") {
    throw new ReachabilityError("consent_kind_mismatch");
  }
  if (
    !candidate.consent ||
    !candidate.consent.facts ||
    !candidate.consent.disclosures ||
    candidate.consent.scope.kind !== "route" ||
    candidate.consent.consentFactsDigest !== candidate.consentFactsDigest
  ) {
    throw new ReachabilityError("consent_details_unavailable");
  }
  if (
    !candidate.candidateToken ||
    approval.candidateToken !== candidate.candidateToken ||
    approval.disclosureRevision !== candidate.disclosure.revision ||
    approval.consentFactsDigest !== candidate.consentFactsDigest
  ) {
    throw new ReachabilityError("consent_changed");
  }
  return {
    candidateToken: approval.candidateToken,
    consentFactsDigest: approval.consentFactsDigest,
    disclosureRevision: approval.disclosureRevision,
    kind: "route",
  };
}
