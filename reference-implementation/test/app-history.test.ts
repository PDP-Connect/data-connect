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
  await write(`INSERT INTO oauth_clients(client_id,registration_mode,token_endpoint_auth_method,metadata_json,created_at,updated_at)
    VALUES ('app','dynamic','none',?,'2026-11-24T00:00:00.000Z','2026-11-24T00:00:00.000Z')`, [JSON.stringify({client_name:"Test app",redirect_uris:["https://app.example/return"]})]);
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
  await write("UPDATE spine_events SET connector_instance_id='mail_account' WHERE event_id IN ('event_1','event_2')",[]);
  await write(`INSERT INTO spine_events(event_id,event_seq,event_type,occurred_at,recorded_at,scenario_id,trace_id,actor_type,actor_id,subject_type,subject_id,object_type,object_id,status,request_id,grant_id,run_id,source_kind,source_id,client_id,stream_id,token_id,interaction_id,data_json,version,connector_instance_id) SELECT 'event_12',12,event_type,occurred_at,recorded_at,scenario_id,'trace_12',actor_type,actor_id,subject_type,subject_id,object_type,object_id,status,request_id,grant_id,run_id,source_kind,NULL,client_id,stream_id,token_id,interaction_id,?,version,connector_instance_id FROM spine_events WHERE event_id='event_1'`,[JSON.stringify({query_shape:"field_window",record_count:5})]);
  await write(`INSERT INTO spine_events(event_id,event_seq,event_type,occurred_at,recorded_at,scenario_id,trace_id,
    actor_type,actor_id,subject_id,object_type,object_id,status,client_id,data_json,version)
    VALUES ('foreign', 11, 'disclosure.served', '2026-11-24T23:30:00.000Z','2026-11-24T23:30:00.000Z','test','foreign','client','other','foreign','query','q','succeeded','foreign','{}','1')`, []);
}
async function check(backend: "sqlite" | "postgres") {
  const write: Write = backend === "sqlite" ? async (sql,values) => getDb().prepare(sql).run(...values) : async (sql,values) => {let i=0; return postgresQuery(sql.replaceAll("?",()=>`$${++i}`), values);};
  await write(`INSERT INTO spine_events(event_id,event_seq,event_type,occurred_at,recorded_at,scenario_id,trace_id,actor_type,actor_id,subject_id,object_type,object_id,status,client_id,data_json,version)
    VALUES ('console',99,'grant.issued','2026-11-24T23:30:00.000Z','2026-11-24T23:30:00.000Z','test','console','client','console','owner','grant','g','succeeded','dataconnect-console','{}','1')`,[]);
  const input = { first: "2026-11-25", last: "2026-11-25", offset: 120 };
  const result = await readAppHistory("owner", input, backend);
  assert.equal(result.mode, "days");
  if (result.mode !== "days") throw new Error("wrong mode");
  assert.equal(result.data.length, 1);
  assert.equal(result.identities[0]?.client_name,"Test app");
  assert.equal(result.identities[0]?.return_host,"app.example");
  assert.equal(result.data[0]?.reads, 4);
  assert.equal(result.data[0]?.permission_refusals, 1);
  assert.equal(result.data[0]?.across_sources, 1);
  assert.equal(result.data[0]?.sources[0]?.reads, 3);
  assert.equal(result.data[0]?.sources[0]?.records, 25);
  assert.equal(result.changes.length, 3);
  const dates = await readAppHistory("owner",{...input,first:"1970-01-01",days:7},backend);
  assert.equal(dates.first_day,"2026-11-25");
  assert.equal(dates.before_day,null);
  assert.equal((await readAppHistory("owner",{...input,first:"1970-01-01",days:7,before:"2026-11-25"},backend)).data.length,0);
  const west = await readAppHistory("owner", { ...input, first: "2026-11-24", last: "2026-11-24", offset: -360 }, backend);
  assert.equal(west.data.length, 1);
  const page = await readAppHistory("owner", { ...input, day: input.first, client_ids: ["app"], limit: 3 }, backend);
  assert.equal(page.mode, "reads");
  assert.equal(page.has_more, true);
  if (page.mode !== "reads") throw new Error("wrong mode");
  assert.equal(page.data.length, 3);
  assert.equal(page.data.filter(row => row.refused).length, 2);
  const next = await readAppHistory("owner", { ...input, day: input.first, client_ids: ["app"], limit: 5, ...(page.next_cursor ? { cursor: page.next_cursor } : {}) }, backend);
  assert.equal(next.data.length, 3);
  if(next.mode!=="reads")throw Error("mode");
  assert.equal(next.discovery?.reduce((n,row)=>n+(row.occurrences ?? 0),0),2);
  assert.equal(next.has_more, false);
  assert.equal((await readAppHistory("owner", { ...input, client_ids: ["foreign"] }, backend)).data.length, 0);
  const scoped = await readAppHistory("owner", { ...input, connection_id: "mail_account" }, backend);
  if (scoped.mode !== "days") throw new Error("wrong mode");
  assert.equal(scoped.data[0]?.reads, 3);
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
