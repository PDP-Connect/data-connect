// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How many test files the gate runs at once: a per-profile cap, clamped by
 * available CPUs and by the number of selected files, never below 1. A
 * positive explicit override wins and is not clamped. The override arrives
 * already parsed with `Number.parseInt` in run-tests.ts (so `1.5` is 1 and
 * `abc` is NaN); non-positive or NaN falls back to the profile default, which
 * is then clamped by CPUs and file count.
 */

/** Storage profiles the gate runs under, as validated by test-profile-env.ts. */
export type TestProfile = "memory-default" | "postgres";

export interface FileConcurrencyInput {
  /** Files the runner selected for this invocation. */
  selectedFileCount: number;
  /** `availableParallelism()`, or null where the runtime does not report it. */
  availableCpus: number | null;
  /** Parsed `PDPP_TEST_CONCURRENCY`. NaN when unset or unparseable. */
  requestedConcurrency: number;
  profile: TestProfile;
}

/**
 * Per-profile ceiling before the clamps. `postgres` stays at 2: that lane's
 * restore target is shared across files. The measurement behind 8 is in
 * reference-implementation/docs/gate-concurrency.md.
 */
const PROFILE_CAPS: Record<TestProfile, number> = {
  "memory-default": 8,
  postgres: 2,
};

/** Cap for a profile, exposed so callers can report the policy they ran under. */
export function fileConcurrencyCap(profile: TestProfile): number {
  return PROFILE_CAPS[profile];
}

export function resolveFileConcurrency(input: FileConcurrencyInput): number {
  const { availableCpus, profile, requestedConcurrency, selectedFileCount } = input;

  // An explicit positive override is authoritative and unclamped.
  if (Number.isInteger(requestedConcurrency) && requestedConcurrency > 0) {
    return requestedConcurrency;
  }

  return Math.max(1, Math.min(PROFILE_CAPS[profile], availableCpus ?? 1, selectedFileCount || 1));
}
