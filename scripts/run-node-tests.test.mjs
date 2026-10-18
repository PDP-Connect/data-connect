// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { localNodeTestArgs } from "./run-node-tests.mjs";

function withCi(value, run) {
  const prior = process.env.CI;
  if (value === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = value;
  }
  try {
    run();
  } finally {
    if (prior === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = prior;
    }
  }
}

for (const ci of [undefined, "", "1", "true"]) {
  test(`adds the default test concurrency when CI=${JSON.stringify(ci)}`, () => {
    withCi(ci, () => {
      assert.deepEqual(localNodeTestArgs(["--import", "tsx", "--test", "a.test.ts"]), [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=2",
        "a.test.ts",
      ]);
    });
  });
}

test("keeps an explicit --test-concurrency value, even under CI", () => {
  withCi("1", () => {
    const spaced = ["--test", "--test-concurrency", "8", "a.test.ts"];
    const joined = ["--test", "--test-concurrency=8", "a.test.ts"];
    assert.deepEqual(localNodeTestArgs(spaced), spaced);
    assert.deepEqual(localNodeTestArgs(joined), joined);
  });
});

test("leaves invocations without --test untouched, even under CI", () => {
  withCi("1", () => {
    const args = ["--import", "tsx", "script.ts"];
    assert.deepEqual(localNodeTestArgs(args), args);
  });
});
