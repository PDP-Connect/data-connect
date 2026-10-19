// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How many test files the gate runs at once: a per-profile cap, clamped by
 * available CPUs and by the number of selected files, never below 1. A
 * positive explicit override is subject to the same safety caps. The override arrives
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
 * Per-profile ceiling before the clamps. Both profiles cap at 8. Postgres was
 * held at 2 while files shared one restore database and one test dropped every
 * test database on the cluster; the runner now owns a restore database per
 * file and each run can use its own cluster (`npm run test:postgres`). The
 * measurements are in reference-implementation/docs/gate-concurrency.md.
 */
const PROFILE_CAPS: Record<TestProfile, number> = {
  "memory-default": 8,
  postgres: 8,
};

/** Cap for a profile, exposed so callers can report the policy they ran under. */
export function fileConcurrencyCap(profile: TestProfile): number {
  return PROFILE_CAPS[profile];
}

export function resolveFileConcurrency(input: FileConcurrencyInput): number {
  const { availableCpus, profile, requestedConcurrency, selectedFileCount } = input;

  const requested = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
    ? requestedConcurrency
    : PROFILE_CAPS[profile];
  return Math.max(1, Math.min(requested, PROFILE_CAPS[profile], availableCpus ?? 1, selectedFileCount || 1));
}
