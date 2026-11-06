// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { refuseBindingControl } from "../runtime/binding-control.ts";

export type BrowserBindingApprovalLifetime =
  | { readonly approvalMaxAgeMs: number; readonly policyExpiresAt?: never }
  | { readonly policyExpiresAt: number; readonly approvalMaxAgeMs?: never };

/** Derives a new proposal's horizon, never an extension to an active approval. */
export function newBrowserBindingApprovalExpiry(lifetime: BrowserBindingApprovalLifetime, now: number): number {
  const keys = Object.keys(lifetime);
  if (keys.length !== 1 || !Number.isSafeInteger(now)) {
    return refuseBindingControl();
  }
  let expiry: number;
  if (keys[0] === "approvalMaxAgeMs") {
    const age = lifetime.approvalMaxAgeMs;
    if (!Number.isSafeInteger(age) || Number(age) <= 0) {
      return refuseBindingControl();
    }
    expiry = now + Number(age);
  } else if (keys[0] === "policyExpiresAt") {
    expiry = Number(lifetime.policyExpiresAt);
    if (typeof lifetime.policyExpiresAt !== "number") {
      return refuseBindingControl();
    }
  } else {
    return refuseBindingControl();
  }
  if (!Number.isSafeInteger(expiry) || expiry <= now || !Number.isFinite(new Date(expiry).getTime())) {
    return refuseBindingControl();
  }
  return expiry;
}
