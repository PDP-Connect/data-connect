// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { HostCapabilities, Observation, ProofSubject, RouteView as Route } from "@tnunamak/gozar";

export function hostCapability(capabilities: Partial<HostCapabilities>, id: string): Observation<boolean | string> {
  const value = capabilities[id];
  return Object.hasOwn(capabilities, id) && value ? value : { known: false, reason: "host-capability-undeclared" };
}

export function observationText(observation: Observation<unknown>): string {
  if (!observation.known) {
    return `Unknown: ${observation.reason}`;
  }
  if (observation.value === null) {
    return "None";
  }
  if (typeof observation.value === "string") {
    return observation.value === "" ? "(empty)" : observation.value;
  }
  return JSON.stringify(observation.value);
}

export function routePresentation(
  route: Route,
  current: ProofSubject | null,
  now: number,
  reason?: string
): {
  label: "Verified" | "Unpublished" | "Cleanup unconfirmed";
  actions: string[];
  reason: string | null;
} {
  if (reason === "proof_refresh_unsupported") {
    return { actions: ["stop"], label: "Unpublished", reason };
  }
  if (route.cleanup.state === "unconfirmed") {
    return { actions: ["stop"], label: "Cleanup unconfirmed", reason: "cleanup_unconfirmed" };
  }
  const proof = route.verification;
  const subject = proof.subject;
  const expiry = proof.validUntil;
  const routeExpiry = route.expiresAt;
  const sameSubject =
    current &&
    subject &&
    subject.origin === current.origin &&
    subject.target === current.target &&
    subject.instanceId === current.instanceId &&
    subject.bootId === current.bootId &&
    subject.handleGeneration === current.handleGeneration &&
    subject.handleGeneration === route.handle.generation;
  const verified =
    sameSubject &&
    route.state === "usable" &&
    route.routeState === "verified" &&
    route.published === current.origin &&
    route.origin === current.origin &&
    proof.status === "verified" &&
    proof.observedAt !== null &&
    proof.checkedAt !== null &&
    Number.isFinite(Date.parse(proof.observedAt)) &&
    Date.parse(proof.observedAt) <= now &&
    Number.isFinite(Date.parse(proof.checkedAt)) &&
    Date.parse(proof.checkedAt) <= now &&
    expiry.known &&
    Date.parse(expiry.value) > now &&
    routeExpiry.known &&
    Date.parse(routeExpiry.value) > now &&
    proof.results.every((result) => result.status === "passed") &&
    route.properties.proof.checks.every((check) =>
      proof.results.some((result) => result.check === check && result.status === "passed")
    );
  return { actions: route.actions, label: verified ? "Verified" : "Unpublished", reason: reason ?? null };
}
