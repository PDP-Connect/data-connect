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
 *    policy does not; a non-positive or non-integer override falls back to
 *    the profile default rather than being honoured as zero.
 *
 * The override this function receives has already been through
 * `Number.parseInt` in run-tests.ts, which truncates rather than rejects, so
 * the non-integer rule below only covers values that survive that parse.
 * `PDPP_TEST_CONCURRENCY=1.5` reaches this function as 1 and is honoured;
 * `0`, `-1` and `abc` reach it as 0, -1 and NaN and fall back. Rejecting
 * fractional text outright would mean changing that parser, which is a
 * deliberate behaviour change and not part of this one.
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
 * `memory-default` is 8, raised from the previous flat cap of 2.
 *
 * The clamps below make the cap an upper bound rather than a target, but they
 * do not leave small machines untouched: a 4-CPU host was already clamped to 2
 * by the old cap and now resolves to 4. It does not reach 8. So the raise does
 * change what a small machine does, and the clamps bound how far it can go
 * rather than proving the result is safe.
 *
 * What supports the raise is that the load-sensitive tests it exposes are
 * fixed ahead of it rather than papered over by keeping the gate slow: a
 * manual-upload fixture whose detached validation task could write into the
 * next test's database, a timeout oracle whose 150ms no-progress allowance had
 * to cover connector startup and the ingest round-trip in one stretch, and a
 * console build that ran inside a test without reaching the gate's output
 * watchdog. Each was a real defect that more concurrency made visible; none is
 * evidence that 8 is right for hardware nobody has measured.
 *
 * `docs/gate-concurrency.md` holds a wall-clock measurement taken on a 24-core
 * developer host and declines to generalize it to unknown hardware. Read that
 * file as it stands on the default branch with care: it names 6 as its
 * measured ceiling and advises against raising the cap at all. The rewrite
 * that records the 2-versus-8 comparison behind this number lands separately
 * and supersedes it, which is why that change has to merge first.
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

  // `Math.max(1, ...)` is what guarantees a well-formed worker count when
  // nothing was selected; `|| 1` and `?? 1` are interchangeable here.
  return Math.max(1, Math.min(PROFILE_CAPS[profile], availableCpus ?? 1, selectedFileCount || 1));
}
