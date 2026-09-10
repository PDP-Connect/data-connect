// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavioural cover for the gate's file-concurrency policy.
//
// These cases call the policy and assert the worker count it returns. They
// deliberately do not read run-tests.ts as text or match its comments: a test
// that asserts on source text passes for a file that says the right thing and
// does the wrong thing, and fails for a rewording that changes nothing. Every
// case below fails if the policy's arithmetic is wrong.
//
// The last case is the wiring control. Policy tests alone cannot tell whether
// the runner still calls the policy, so a runner that quietly kept its own
// inline default would leave every case above green.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fileConcurrencyCap, resolveFileConcurrency, type TestProfile } from "./file-concurrency.ts";

const NO_OVERRIDE = Number.NaN;

function resolve(
  profile: TestProfile,
  availableCpus: number | null,
  selectedFileCount: number,
  requestedConcurrency: number = NO_OVERRIDE
): number {
  return resolveFileConcurrency({ availableCpus, profile, requestedConcurrency, selectedFileCount });
}

test("each profile has its own cap, and postgres stays at 2", () => {
  assert.equal(fileConcurrencyCap("memory-default"), 8);
  assert.equal(
    fileConcurrencyCap("postgres"),
    2,
    "the postgres restore target is not per-file allocated; widening this lane needs its own evidence"
  );
});

test("with CPUs and files to spare, each profile runs up to its own cap", () => {
  assert.equal(resolve("memory-default", 24, 1000), 8);
  assert.equal(resolve("postgres", 24, 1000), 2);
});

test("available CPUs clamp the cap", () => {
  // 1 and 4 CPUs are the interesting hosted-runner shapes: both land below
  // the memory-default cap, so raising that cap cannot change them.
  assert.equal(resolve("memory-default", 1, 1000), 1);
  assert.equal(resolve("memory-default", 4, 1000), 4);
  assert.equal(resolve("memory-default", 24, 1000), 8, "24 CPUs must not exceed the cap");

  // The postgres cap is below every one of these CPU counts, so it governs.
  assert.equal(resolve("postgres", 1, 1000), 1);
  assert.equal(resolve("postgres", 4, 1000), 2);
  assert.equal(resolve("postgres", 24, 1000), 2);
});

test("the selected file count clamps the worker count", () => {
  assert.equal(resolve("memory-default", 24, 1), 1, "one file needs one worker");
  assert.equal(resolve("memory-default", 24, 3), 3);
  assert.equal(resolve("memory-default", 24, 8), 8);
  assert.equal(resolve("memory-default", 24, 9), 8, "more files than the cap still stops at the cap");
  assert.equal(resolve("postgres", 24, 1), 1);
  assert.equal(resolve("postgres", 24, 3), 2);
});

test("selecting no files still resolves to a single worker, never zero", () => {
  for (const profile of ["memory-default", "postgres"] as const) {
    assert.equal(resolve(profile, 24, 0), 1, `${profile} must not resolve to a zero-worker pool`);
    assert.equal(resolve(profile, 1, 0), 1);
  }
});

test("a runtime that does not report parallelism resolves to a single worker", () => {
  assert.equal(resolve("memory-default", null, 1000), 1);
  assert.equal(resolve("postgres", null, 1000), 1);
});

test("a non-positive CPU count still resolves to a single worker", () => {
  // The floor, not the clamps, is what covers this: `Math.min` of a
  // zero-or-negative CPU count is <= 0, and a zero-worker pool would leave the
  // runner with no worker to drain its queue. `availableParallelism()` does not
  // return these, but the input type permits them and the floor is cheap.
  for (const cpus of [0, -1, -4]) {
    assert.equal(
      resolve("memory-default", cpus, 1000),
      1,
      `${cpus} CPUs must still yield one worker, never zero or negative`
    );
    assert.equal(resolve("postgres", cpus, 1000), 1);
  }
});

test("a positive override wins and is not clamped by cap, CPUs or file count", () => {
  // Above both caps: an operator who names a number knows something about the
  // host that this policy does not.
  assert.equal(resolve("memory-default", 24, 1000, 32), 32);
  assert.equal(resolve("postgres", 24, 1000, 32), 32);
  // Above the CPU count and above the file count.
  assert.equal(resolve("memory-default", 4, 1000, 16), 16);
  assert.equal(resolve("memory-default", 24, 2, 16), 16);
  // Below the cap: honoured downwards too.
  assert.equal(resolve("memory-default", 24, 1000, 1), 1);
});

test("a non-positive or non-integer override is ignored, not honoured as zero", () => {
  for (const override of [0, -1, -8, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    assert.equal(
      resolve("memory-default", 24, 1000, override),
      8,
      `override ${String(override)} must fall back to the profile default`
    );
  }
});

test("the runner resolves concurrency through the policy rather than its own inline default", () => {
  // The wiring control. Policy arithmetic can be perfect while the runner
  // ignores it, and no other case in this file would notice.
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "run-tests.ts");
  const runner = readFileSync(runnerPath, "utf8");

  assert.match(
    runner,
    /import \{ resolveFileConcurrency \} from "\.\/file-concurrency\.ts";/,
    "run-tests.ts must import the policy"
  );
  assert.match(
    runner,
    /const fileConcurrency = resolveFileConcurrency\(\{/,
    "run-tests.ts must derive fileConcurrency from the policy"
  );
  assert.doesNotMatch(
    runner,
    /Math\.min\(\s*2\s*,/,
    "run-tests.ts must not retain the old inline cap expression alongside the policy"
  );
});
