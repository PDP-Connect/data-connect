// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Descriptor conditions the owner decided not to show because they are false
// for DataConnect, by provider id. This is the only place that hides a fact:
// the match is the exact text, never a pattern, so a term the owner must see
// (retention, cost, limits with times) is never hidden by accident. A test
// reads the installed gozar definition and fails when the text there changes.
export const knownFalseConditions: Readonly<Record<string, ReadonlySet<string>>> = {
  // The provider documents no session limit and DataConnect asks for a
  // one-hour lifetime; the On card shows the real end time.
  "localhost-run": new Set(["the plan limits a session to 15 minutes"]),
};

export function isKnownFalseCondition(providerId: string | null | undefined, value: unknown): boolean {
  return typeof value === "string" && providerId != null && (knownFalseConditions[providerId]?.has(value) ?? false);
}
