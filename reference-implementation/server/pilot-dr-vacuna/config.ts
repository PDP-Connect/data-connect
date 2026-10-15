// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Dominican Republic "Vacuna al día" pilot: representative (parent) approval.
//
// Everything under server/pilot-dr-vacuna/ is a throwaway pilot demo. It is
// inert unless PDPP_PILOT_DR_VACUNA=1; with the flag off the reference server
// behaves exactly as before (no routes, no tables, no grant-shape changes).

export const PILOT_FLAG_ENV = "PDPP_PILOT_DR_VACUNA";

export function isDrVacunaPilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PILOT_FLAG_ENV] === "1";
}

/**
 * The reference server keeps its single instance owner as the data holder
 * (the national vaccination register). Grants issued by a parent name the
 * child as `subject`; connector instances stay owned by this subject.
 */
export function registerOwnerSubjectId(env: NodeJS.ProcessEnv = process.env): string {
  return env.PDPP_PILOT_DR_VACUNA_REGISTER_SUBJECT || "owner_local";
}

/** Source whose pending consents are routed to the parent consent surface. */
export function pilotSourceId(env: NodeJS.ProcessEnv = process.env): string {
  return env.PDPP_PILOT_DR_VACUNA_SOURCE_ID || "https://registry.pdpp.dev/connectors/dr-vacuna-registry";
}

/** Fixed demo password for every synthetic Cuenta Única account. */
export function demoPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env.PDPP_PILOT_DR_VACUNA_DEMO_PASSWORD || "vacuna-demo-2026";
}

/** Optional simulated latency for each civil-registry lookup (ms). */
export function registryLatencyMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PDPP_PILOT_DR_VACUNA_REGISTRY_LATENCY_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Capacity URIs (#378: "`capacity` is an absolute URI that names the basis on
 * which that person approved ... defined by a profile or deployment"). URNs
 * are absolute URIs and avoid implying a real government namespace.
 */
export const CAPACITY_URIS = {
  legal_guardian: "urn:pdpp:pilot:dr-vacuna:capacity:legal-guardian",
  parent: "urn:pdpp:pilot:dr-vacuna:capacity:parent",
} as const;

export type GuardianCapacity = keyof typeof CAPACITY_URIS;

/** Spine event types written by the pilot (free-form in the reference spine). */
export const PILOT_EVENTS = {
  authorityRefused: "representative.authority_refused",
  authorityVerified: "representative.authority_verified",
  grantRevoked: "representative.grant_revoked",
  managementRefused: "representative.management_refused",
} as const;

export const PILOT_PATHS = {
  authorizations: "/pilot/vacuna/autorizaciones",
  consent: "/pilot/vacuna/consent",
  login: "/pilot/cuenta-unica/login",
  logout: "/pilot/cuenta-unica/logout",
} as const;
