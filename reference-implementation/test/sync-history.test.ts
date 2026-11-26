// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { readSyncHistory } from "../lib/sync-history.ts";

type Write = (sql: string, values: unknown[]) => Promise<unknown>;
async function fixture(write: Write) {
  await write(`INSERT INTO run_history(run_id,connector_instance_id,connector_id,source_json,status,started_at)
    VALUES ('now','other_account','mail','{}','running','2026-11-25T03:00:00.000Z')`,[]);
  for (const [id, status, time, trigger, records] of [
    ["one", "succeeded", "2026-11-24T23:30:00.000Z", "manual", 14],
    ["two", "failed", "2026-11-25T01:00:00.000Z", null, 2],
    ["three", "skipped", "2026-11-25T02:00:00.000Z", null, 0],
    ["four", "surface_failed", "2026-11-25T02:30:00.000Z", null, 0],
    ["five", "cancelled", "2026-11-23T23:00:00.000Z", null, 3],
    ["six", "abandoned", "2026-11-23T22:00:00.000Z", null, 1],
  ]) {
    await write(`INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status,
      records_emitted, started_at, completed_at, trigger_kind, failure_reason) VALUES (?, 'mail_account', 'mail', '{}', ?, ?, ?, ?, ?, ?)`,
    [id, status, records, time, time, trigger, status === "failed" ? "auth_failed" : null]);
  }
}
async function check(backend: "sqlite" | "postgres") {
  const input = { first: "2026-11-25", last: "2026-11-25", offset: 120 };
  const east = await readSyncHistory(input, backend);
  assert.equal(east.mode, "days");
  if (east.mode !== "days") throw new Error("wrong response");
  assert.equal(east.data.length, 1);
  assert.deepEqual(east.data[0], {
    day: "2026-11-25", connection_id: "mail_account", connector_id: "mail", ran: 2,
    finished: 1, failed: 1, stopped: 0, interrupted: 0, could_not_start: 2, records: 16,
    last_at: "2026-11-25T01:00:00.000Z", last_outcome: "failed", manual: 1, cause: "auth_failed",
  });
  const single = await readSyncHistory({ ...input, run_id: "one" }, backend);
  assert.equal(single.mode, "syncs"); assert.equal(single.data.length, 1);
  const west = await readSyncHistory({ ...input, first: "2026-11-24", last: "2026-11-24", offset: -360 }, backend);
  assert.equal(west.mode, "days");
  if (west.mode !== "days") throw new Error("wrong response");
  assert.equal(west.data[0]?.ran, 2);
  assert.equal(west.data[0]?.day, "2026-11-24");
  const detail = await readSyncHistory({ ...input, day: input.first, connection_id: "mail_account", limit: 2 }, backend);
  assert.equal(detail.mode, "syncs");
  assert.equal(detail.has_more, true);
  if (detail.mode !== "syncs") throw new Error("wrong response");
  assert.deepEqual(detail.data.map((row) => row.outcome), ["could_not_start", "could_not_start"]);
  const next = await readSyncHistory({ ...input, day: input.first, connection_id: "mail_account", limit: 2, ...(detail.next_cursor ? { cursor: detail.next_cursor } : {}) }, backend);
  assert.equal(next.mode, "syncs");
  if (next.mode !== "syncs") throw new Error("wrong response");
  assert.deepEqual(next.data.map((row) => row.id), ["two", "one"]);
  assert.equal(next.has_more, false);
  assert.equal((await readSyncHistory({ ...input, connection_id: "absent" }, backend)).data.length, 0);
  const problems = await readSyncHistory({ ...input, only_problems: true }, backend);
  assert.equal(problems.data.length, 1);
}
test("SQLite sync days use the person's UTC distance and keep attempts separate", async () => {
  initDb();
  try {
    await fixture(async (sql, values) => getDb().prepare(sql).run(...values));
    await check("sqlite");
  } finally { closeDb(); }
});
test("Postgres sync days and paging match the SQLite fixture", { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await withTemporaryPostgresDatabase({
    connectionString: process.env.PDPP_TEST_POSTGRES_URL as string,
    databaseName: `dc_hist_test_${randomUUID().replaceAll("-", "")}`,
    closeConnections: closePostgresStorage,
  }, async (databaseUrl) => {
    await initPostgresStorage({ backend: "postgres", databaseUrl });
    await fixture(async (sql, values) => { let n = 0; return postgresQuery(sql.replaceAll("?", () => `$${++n}`), values); });
    await check("postgres");
  });
});
