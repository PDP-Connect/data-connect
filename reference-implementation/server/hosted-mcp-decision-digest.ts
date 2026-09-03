// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's approval artifact digest (spec-core.md:873-885, AS-conformance
 * #15) — and nothing else.
 *
 * Extracted from `routes/as-consent-ui-helpers.ts` so the APPROVING SURFACE
 * can compute it without importing a 3,600-line HTML renderer. That matters
 * now that there are two approving surfaces: the server-rendered picker form
 * and the console's consent page. The digest's whole security property is
 * that the surface which DISPLAYED the decision commits to it, and the AS
 * independently recomputes it from what it resolved — so both surfaces must
 * compute the same bytes from the same function, never two implementations
 * that agree until they don't.
 *
 * Deliberately dependency-light: `node:crypto` and nothing else. No store, no
 * renderer, no route types.
 */

import { createHash } from "node:crypto";

/**
 * Canonical JSON ordering, so an insignificant difference in key order cannot
 * change the digest. Arrays keep their order — for the decision below, order
 * is normalized by the caller via sort, because "which streams" is a set.
 */
function canonicalizeForDigest(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForDigest(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeForDigest((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** The exact decision the owner reviewed, in the shape the page displayed. */
export interface HostedMcpPickerSubmittedDecision {
  accessMode: string;
  clientId: string;
  /** Sorted `sourceKey -> sorted stream names`, exactly as approved. */
  sources: Array<{ sourceKey: string; streamNames: string[] }>;
}

/**
 * Digest over the owner's exact decision. Stable across key order; any change
 * to the selected sources, the selected streams within them, the access mode,
 * or the client identity changes it.
 */
export function computeHostedMcpDecisionDigest(decision: HostedMcpPickerSubmittedDecision): string {
  const normalized = {
    accessMode: decision.accessMode,
    clientId: decision.clientId,
    sources: [...decision.sources]
      .map((source) => ({ sourceKey: source.sourceKey, streamNames: [...source.streamNames].sort() }))
      .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeForDigest(normalized))).digest("base64url")}`;
}
