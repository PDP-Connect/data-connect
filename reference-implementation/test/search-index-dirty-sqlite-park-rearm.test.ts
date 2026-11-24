// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SQLite twin of the Postgres park/backoff/rearm assertions in
// search-index-reconcile-scope-isolation.postgres.test.ts (record-failure.sql
// and rearm.sql are a separate implementation of the same schedule).

import assert from "node:assert/strict";
import test from "node:test";
import { exec, getOne } from "../lib/db.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  markSearchIndexDirtySqlite,
  parkSearchIndexDirtyScope,
  rearmSearchIndexDirtyScope,
  recordSearchIndexDirtyFailure,
} from "../server/stores/search-index-dirty-store.ts";

test("SQLite: a failure from a stale revision neither increments attempts nor delays a newer dirty generation", async () => {
  initDb(":memory:");
  try {
    const key = { connectorInstanceId: "cin_sqlite_stale", stream: "alpha" };
    markSearchIndexDirtySqlite({ ...key, connectorId: "c" }, new Date().toISOString()); // revision 1
    markSearchIndexDirtySqlite({ ...key, connectorId: "c" }, new Date().toISOString()); // revision 2: newer generation
    const applied = await recordSearchIndexDirtyFailure(key, 1, "stale attempt failed");
    assert.equal(applied, false);
    const row = getOne<{ attempts: number; dirty: number; next_attempt_at: string | null; revision: number }>(
      {
        sql: "SELECT attempts, dirty, next_attempt_at, revision FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?",
      } as never,
      [key.connectorInstanceId, key.stream]
    );
    assert.deepEqual({ ...row }, { attempts: 0, dirty: 1, next_attempt_at: null, revision: 2 });
    assert.equal(await recordSearchIndexDirtyFailure(key, 2, "current attempt failed"), true);
  } finally {
    closeDb();
  }
});

test("SQLite: an explicit park rejects an in-flight failure, backoff grows past 600s, and rearm fences stale work", async () => {
  initDb(":memory:");
  try {
    const key = { connectorInstanceId: "cin_sqlite_park", stream: "alpha" };
    markSearchIndexDirtySqlite({ ...key, connectorId: "c" }, new Date().toISOString());
    const read = () =>
      getOne<{ attempts: number; dirty: number; next_attempt_at: string | null; revision: number }>(
        {
          sql: "SELECT attempts, dirty, next_attempt_at, revision FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?",
        } as never,
        [key.connectorInstanceId, key.stream]
      );
    exec(
      {
        sql: "UPDATE search_index_dirty SET attempts = 60, next_attempt_at = NULL WHERE connector_instance_id = ?",
      } as never,
      [key.connectorInstanceId]
    );
    const before = Date.now();
    await recordSearchIndexDirtyFailure(key, 1, "persistent");
    const delay = (Date.parse(read()?.next_attempt_at as string) - before) / 1000;
    assert.ok(delay > 3600, `backoff ${delay}s`);

    const parkedRevision = read()?.revision as number;
    const delayBeforePark = read()?.next_attempt_at;
    assert.equal(await parkSearchIndexDirtyScope(key), true);
    assert.equal(await recordSearchIndexDirtyFailure(key, parkedRevision, "in-flight"), false);
    assert.equal(
      read()?.next_attempt_at,
      delayBeforePark,
      "an in-flight failure must not replace a park's existing delay"
    );

    const revisionBefore = read()?.revision as number;
    await rearmSearchIndexDirtyScope(key);
    assert.deepEqual({ ...read() }, { attempts: 0, dirty: 1, next_attempt_at: null, revision: revisionBefore + 1 });
  } finally {
    closeDb();
  }
});
