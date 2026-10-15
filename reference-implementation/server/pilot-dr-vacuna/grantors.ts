// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `grantors` on a resolved grant (PDPP Core #378, spec-core.md "Grant fields"):
// "a non-empty list of distinct approving representatives. Each entry is
// exactly `{ id, capacity }`. ... `capacity` is an absolute URI".
//
// The vendored @pdpp/reference-contract ResolvedGrant schema predates #378 and
// is closed (additionalProperties: false), so auth.ts validates `grantors`
// here and the rest of the grant with the contract. Only accepted while the
// pilot flag is on; with it off a grant carrying `grantors` stays invalid.

import { isDrVacunaPilotEnabled } from "./config.ts";

export interface Grantor {
  capacity: string;
  id: string;
}

const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

export function isRepresentativeApprovalEnabled(): boolean {
  return isDrVacunaPilotEnabled();
}

/** Throws a plain Error describing the first violation. */
export function assertValidGrantors(value: unknown): asserts value is Grantor[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("grantors must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each grantor must be an object");
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "capacity" || keys[1] !== "id") {
      throw new Error("each grantor must be exactly { id, capacity }");
    }
    const { capacity, id } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("grantor id must be a non-empty string");
    }
    if (typeof capacity !== "string" || !ABSOLUTE_URI.test(capacity)) {
      throw new Error("grantor capacity must be an absolute URI");
    }
    if (seen.has(id)) {
      throw new Error("grantors must be distinct");
    }
    seen.add(id);
  }
}

/**
 * Split `grantors` off a grant candidate so the closed contract can validate
 * the rest. Returns the candidate unchanged when there is nothing to split or
 * the pilot is off (the contract then rejects `grantors` as before).
 */
export function splitGrantors(candidate: unknown): {
  grant: unknown;
  grantors: Grantor[] | null;
} {
  if (!(isRepresentativeApprovalEnabled() && candidate && typeof candidate === "object" && !Array.isArray(candidate))) {
    return { grant: candidate, grantors: null };
  }
  if (!("grantors" in candidate)) {
    return { grant: candidate, grantors: null };
  }
  const { grantors, ...rest } = candidate as Record<string, unknown>;
  assertValidGrantors(grantors);
  return { grant: rest, grantors };
}
