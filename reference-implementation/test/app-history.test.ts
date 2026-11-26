// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { readAppHistory } from "../lib/app-history.ts";
type Write = (sql: string, values: unknown[]) => Promise<unknown>;
async function fixture(write: Write) {
  let seq = 0;
  for (const [type, shape, source, count, error] of [
    ["disclosure.served", "record_list", "mail", 20, null],
    ["disclosure.served", "record_detail", "mail", null, null],
    ["disclosure.served", "search", null, 12, null],
    ["disclosure.served", "schema", "mail", null, null],
    ["disclosure.served", "stream_list", "mail", null, null],
    ["query.rejected", "record_list", "mail", null, "grant_revoked"],
    ["query.rejected", "record_list", "mail", null, "invalid_request"],
    ["consent.approved", null, "mail", null, null],
    ["consent.denied", null, null, null, null],
    ["grant.revoked", null, "mail", null, null],
  ]) {
    seq++;
    await write(`INSERT INTO spine_events(event_id,event_seq,event_type,occurred_at,recorded_at,scenario_id,trace_id,
      actor_type,actor_id,subject_id,object_type,object_id,status,client_id,source_kind,source_id,data_json,version)
      VALUES (?, ?, ?, ?, ?, 'test', ?, 'client', 'app', 'owner', 'query', 'q', 'succeeded', 'app', 'connector', ?, ?, '1')`,
      [`event_${seq}`, seq, type, "2026-11-24T23:30:00.000Z", "2026-11-24T23:30:00.000Z", `trace_${seq}`, source,
      JSON.stringify({ query_shape: shape, ...(count !== null ? { record_count: count } : {}), ...(error ? { error: { code: error } } : {}) })]);
  }
  await write(`INSERT INTO spine_events(event_id,event_seq,event_type,occurred_at,recorded_at,scenario_id,trace_id,
    actor_type,actor_id,subject_id,object_type,object_id,status,client_id,data_json,version)
    VALUES ('foreign', 11, 'disclosure.served', '2026-11-24T23:30:00.000Z','2026-11-24T23:30:00.000Z','test','foreign','client','other','foreign','query','q','succeeded','foreign','{}','1')`, []);
}
async function check(backend: "sqlite" | "postgres") {
  const input = { first: "2026-11-25", last: "2026-11-25", offset: 120 };
  const result = await readAppHistory("owner", input, backend);
  assert.equal(result.mode, "days");
  if (result.mode !== "days") throw new Error("wrong mode");
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.reads, 3);
  assert.equal(result.data[0]?.permission_refusals, 1);
  assert.equal(result.data[0]?.across_sources, 1);
  assert.equal(result.data[0]?.sources[0]?.reads, 2);
  assert.equal(result.data[0]?.sources[0]?.records, 20);
  assert.equal(result.changes.length, 3);
  const west = await readAppHistory("owner", { ...input, first: "2026-11-24", last: "2026-11-24", offset: -360 }, backend);
  assert.equal(west.data.length, 1);
  const page = await readAppHistory("owner", { ...input, day: input.first, client_ids: ["app"], limit: 3 }, backend);
  assert.equal(page.mode, "reads");
  assert.equal(page.has_more, true);
  if (page.mode !== "reads") throw new Error("wrong mode");
  assert.equal(page.data.length, 3);
  assert.equal(page.data.filter(row => row.refused).length, 2);
  const next = await readAppHistory("owner", { ...input, day: input.first, client_ids: ["app"], limit: 5, ...(page.next_cursor ? { cursor: page.next_cursor } : {}) }, backend);
  assert.equal(next.data.length, 4);
  assert.equal(next.has_more, false);
  assert.equal((await readAppHistory("owner", { ...input, client_ids: ["foreign"] }, backend)).data.length, 0);
  const scoped = await readAppHistory("owner", { ...input, connection_id: "mail" }, backend);
  if (scoped.mode !== "days") throw new Error("wrong mode");
  assert.equal(scoped.data[0]?.reads, 2);
}
test("SQLite app days exclude discovery, retain unknown source reads and separate permission refusals", async () => {
  initDb();
  try { await fixture(async (sql, values) => getDb().prepare(sql).run(...values)); await check("sqlite"); }
  finally { closeDb(); }
});
test("Postgres app days and single reads match the SQLite fixture", { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
  await withTemporaryPostgresDatabase({ connectionString: process.env.PDPP_TEST_POSTGRES_URL as string,
    databaseName: `dc_hist_test_${randomUUID().replaceAll("-", "")}`, closeConnections: closePostgresStorage }, async databaseUrl => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await fixture(async (sql, values) => { let n = 0; return postgresQuery(sql.replaceAll("?", () => `$${++n}`), values); });
      await check("postgres");
    });
});
