// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-stream version allocation under independent-process contention,
 * SQLite backend.
 *
 * records-version-allocation-atomic.test.ts proves the allocator one write at
 * a time in one process. This file runs three real OS processes against one
 * SQLite file (WAL, the production busy handling from initDb). Each round
 * every writer parks just before its ingest call; the parent sends each a
 * resume while a separate SQLite connection holds a writer lock. It releases
 * only after all writers reach ingest. This observes call overlap, not SQL
 * lock timing. Rounds repeat; odd writes update one shared record.
 *
 * What protects the counter on SQLite is the `BEGIN IMMEDIATE` in
 * `writeTransaction` (lib/db.ts): the write lock is taken before the counter
 * is touched. Weakening it to a deferred transaction makes concurrent writers
 * fail with SQLITE_BUSY instead of waiting, which this test reports as
 * unacknowledged writes. See the PR body for the seeded faults.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import {
  assertContentionInvariants,
  type ChangeRow,
  type CurrentRow,
  runContention,
} from "./helpers/version-contention.ts";

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/version-contention";
const STREAM = "items";
const WRITERS = 3;
// Use enough deterministic rounds to cover both distinct and shared keys.
const WRITES_PER_WRITER = 20;

function readRows(): {
  changes: ChangeRow[];
  counter: number | null;
  current: CurrentRow[];
} {
  const db = getDb();
  const parse = (json: string | null) => (json === null ? null : JSON.parse(json));
  const changes = (
    db
      .prepare("SELECT record_key, version, record_json FROM record_changes WHERE connector_id = ? AND stream = ?")
      .all(CONNECTOR_ID, STREAM) as {
      record_json: string | null;
      record_key: string;
      version: number;
    }[]
  ).map((row) => ({
    data: parse(row.record_json),
    record_key: row.record_key,
    version: row.version,
  }));
  const current = (
    db
      .prepare("SELECT record_key, version, record_json FROM records WHERE connector_id = ? AND stream = ?")
      .all(CONNECTOR_ID, STREAM) as {
      record_json: string | null;
      record_key: string;
      version: number;
    }[]
  ).map((row) => ({
    data: parse(row.record_json),
    record_key: row.record_key,
    version: row.version,
  }));
  const counterRow = db
    .prepare("SELECT max_version FROM version_counter WHERE connector_id = ? AND stream = ?")
    .get(CONNECTOR_ID, STREAM) as { max_version: number } | undefined;
  return { changes, counter: counterRow?.max_version ?? null, current };
}

test("[sqlite] independent processes racing changed writes on one stream get unique contiguous versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-version-contention-"));
  const sqlitePath = join(dir, "pdpp.sqlite");
  try {
    initDb(sqlitePath);
    closeDb();

    const gate = new SqliteDriver(sqlitePath, { timeout: 60000 });
    const result = await (async () => {
      try {
        return await runContention({
          backend: "sqlite",
          sqlitePath,
          writers: WRITERS,
          writesPerWriter: WRITES_PER_WRITER,
          holdWriteLock: {
            acquire: () => { gate.exec("BEGIN IMMEDIATE"); },
            release: () => { gate.exec("ROLLBACK"); },
          },
        });
      } finally {
        gate.close();
      }
    })();
    for (const [n, child] of result.children.entries()) {
      assert.deepEqual(child.errors, [], `writer w${n} had rejected writes under contention`);
      assert.equal(child.code, 0, `writer w${n} must exit cleanly: ${child.stderr}`);
    }
    assert.equal(result.overlappedRounds, WRITES_PER_WRITER, "every SQLite round must start all writers before any can commit");

    initDb(sqlitePath);
    try {
      assertContentionInvariants({
        acks: result.acks,
        ...readRows(),
        expectedWrites: WRITERS * WRITES_PER_WRITER,
      });
    } finally {
      closeDb();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
