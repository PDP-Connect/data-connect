// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { succeededRunSupersedesSchedulerBackoff } from "./scheduler-backoff-read.ts";

type Run = NonNullable<Parameters<typeof succeededRunSupersedesSchedulerBackoff>[0]>;
const succeeded = (last_at: string): Run => ({ status: "succeeded", last_at }) as Run;

test("keeps scheduler backoff when neither persisted failure timestamp is usable", () => {
  const run = succeeded("2026-01-01T01:00:00Z");
  for (const timestamps of [
    {},
    { last_started_at: "unparseable", last_finished_at: "also unparseable" },
  ]) {
    assert.equal(succeededRunSupersedesSchedulerBackoff(run, {
      scheduler_backoff: { consecutive_failures: 1 },
      ...timestamps,
    }), false);
  }
});

test("a clearly newer success supersedes a dated backoff", () => {
  const schedule = {
    scheduler_backoff: { consecutive_failures: 1 },
    last_started_at: "2026-01-01T00:00:00Z",
    last_finished_at: "2026-01-01T01:00:00Z",
  };
  assert.equal(succeededRunSupersedesSchedulerBackoff(succeeded("2026-01-01T02:00:00Z"), schedule), true);
  assert.equal(succeededRunSupersedesSchedulerBackoff(succeeded("2026-01-01T00:30:00Z"), schedule), false);
});
