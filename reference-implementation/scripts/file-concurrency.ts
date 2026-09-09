// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How many test files the gate runs at once.
 *
 * This lived inline in run-tests.ts as a single expression, which meant the
 * only way to check it was to read it. Here it is a function with an explicit
 * input record, so the policy can be exercised directly across profiles, CPU
 * counts and file counts instead of asserted against the runner's source text.
 *
 * The policy is deliberately small:
 *
 *  - Each profile has a cap. `postgres` keeps the long-standing cap of 2:
 *    that lane's restore target is not per-file allocated, so files sharing it
 *    contend on a single resource, and a cap alone does not establish that
 *    sharing it more widely is safe.
 *  - The cap is clamped by the CPUs actually available and by the number of
 *    files selected. Running four workers for two files just idles two.
 *  - The result is never below 1, including when nothing was selected.
 *  - A positive explicit override wins outright and is NOT clamped. An
 *    operator who names a number knows something about the host that this
 *    policy does not; a non-positive or non-integer override is ignored
 *    rather than honoured as zero.
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
 * Per-profile ceiling before the CPU and file-count clamps apply.
 *
 * `memory-default` is 8, raised from the previous flat cap of 2. Two things
 * make that raise safe rather than optimistic:
 *
 *  - The clamps below mean the cap is an upper bound, not a target. A hosted
 *    4-CPU runner resolves to 4 and never reaches 8, so raising the ceiling
 *    cannot change what CI actually runs there.
 *  - The two known load-sensitive tests are fixed ahead of this change rather
 *    than papered over by keeping concurrency low: a manual-upload fixture
 *    whose detached validation task could write into the next test's database,
 *    and a timeout oracle whose 150ms no-progress allowance had to cover
 *    connector startup and the ingest round-trip in one stretch.
 *
 * `docs/gate-concurrency.md` holds the wall-clock measurement, taken on a
 * 24-core developer host, and declines to generalize the number to unknown
 * hardware -- which is exactly what the clamps handle.
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

  // `|| 1` rather than `?? 1`: a zero file count must clamp to 1, not 0, so a
  // runner with nothing selected still has a well-formed worker count.
  return Math.max(1, Math.min(PROFILE_CAPS[profile], availableCpus ?? 1, selectedFileCount || 1));
}
