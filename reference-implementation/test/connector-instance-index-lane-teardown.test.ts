// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { drainConnectorInstanceIndexWorkForTests, ingestRecord } from "../server/records.ts";

// `ingestRecord` acknowledges before its index maintenance finishes: the work
// is scheduled onto a per-instance lane that the returned promise does not
// cover. A test that awaits only the ingest and then calls `closeDb()` can
// therefore close the database out from under work it started, which surfaces
// as "[db] No database is open" from a lane nobody is awaiting -- an
// unhandled rejection attributed to whichever test happens to be running.
//
// Whether that happens is a timing question, so it stays invisible on an idle
// machine and appears when the gate runs more files at once. This asserts the
// ordering directly instead of trying to lose the race on purpose.

const STREAM = "messages";

function target(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function record(key: string) {
  return { data: { id: key }, emitted_at: "2026-07-16T00:00:00.000Z", key, stream: STREAM };
}

test("draining the index lane leaves no work that a later closeDb could break", async () => {
  initDb(":memory:");
  try {
    await ingestRecord(target("lane-teardown", "cin_lane_teardown"), record("k1"));

    // The contract the teardown order depends on: once this resolves, the
    // lane is empty. If deferred work were still queued this would either
    // wait for it or throw ConnectorInstanceIndexWorkDrainTimeoutError, and
    // in neither case would it resolve leaving work behind.
    await drainConnectorInstanceIndexWorkForTests();

    // A second drain over an already-empty lane is the observable proof that
    // nothing is outstanding: it returns immediately rather than waiting.
    const startedAt = Date.now();
    await drainConnectorInstanceIndexWorkForTests();
    assert.ok(Date.now() - startedAt < 1000, "a drained lane must not have work left to wait on");
  } finally {
    closeDb();
  }
});

test("every SQLite teardown in the writer-path tests drains before it closes", async () => {
  // A wiring control. The property above only helps if the file that hit this
  // in continuous integration actually applies it, and the failure mode it
  // prevents is invisible on an unloaded machine -- so nothing else here would
  // notice the drain being dropped again.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./connector-instance-writer-paths.test.ts", import.meta.url), "utf8")
  );

  const closes = source.split("closeDb();").length - 1;
  const drains = source.split("drainConnectorInstanceIndexWorkForTests();").length - 1;

  // The Postgres case tears down through closePostgresStorage instead, so it
  // is the one closeDb that does not need the SQLite lane drained.
  assert.equal(
    drains,
    closes - 1,
    `expected every SQLite teardown to drain the index lane first (${closes} closeDb, ${drains} drains)`
  );
});
