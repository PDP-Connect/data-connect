// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { runWithSqliteBusyRetry, runWithSqliteBusyRetrySync } from "./db-sqlite-busy-retry.ts";

for (const mode of ["sync", "async"] as const) {
  const run = async (work: () => string, maxAttempts: number, slept: number[]) => {
    if (mode === "sync") return runWithSqliteBusyRetrySync(work, { maxAttempts, sleepSync: ms => { slept.push(ms); } });
    return runWithSqliteBusyRetry(async () => work(), { maxAttempts, sleep: async ms => { slept.push(ms); } });
  };

  test(`SQLite ${mode}: an explicit non-transient code outranks the lock message`, async () => {
    let calls = 0;
    const slept: number[] = [];
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_IOERR" });
    await assert.rejects(run(() => { calls++; throw error; }, 2, slept), reason => reason === error);
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  test(`SQLite ${mode}: invalid attempt budgets reject before invoking work`, async () => {
    for (const invalid of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0, 1.5, NaN]) {
      let calls = 0;
      await assert.rejects(run(() => { calls++; return "unexpected"; }, invalid, []), RangeError);
      assert.equal(calls, 0);
    }
  });

  test(`SQLite ${mode}: a code-less lock still retries with a valid budget`, async () => {
    let calls = 0;
    const slept: number[] = [];
    assert.equal(await run(() => {
      if (++calls === 1) throw new Error("database table is locked");
      return "ok";
    }, 2, slept), "ok");
    assert.equal(calls, 2);
    assert.equal(slept.length, 1);
  });
}
