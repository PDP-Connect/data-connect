// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/records-ingest-kill-durability*.test.ts: performs ONE ingest
// scenario against a real SQLite file or the private Postgres database, with
// crash points armed by the parent. The parent seeds the baseline in its own
// process (no hook installed there), so every armed point is hit by the
// scenario write itself.
//
// args: <sqlite|postgres> <sqlite-path|-> <connector-id> <scenario>
// scenarios: upsert (change record "a"), delete ("a"), batch (change "a" then "b"
//            through ingestRecords, one durable unit per record)
// env:  PDPP_TEST_POSTGRES_URL, KILL_CHILD_ATTACHMENT (postgres)
import { closeDb, initDb } from "../../../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../../../server/postgres-storage.ts";
import { ingestRecord, ingestRecords } from "../../../server/records.ts";
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

const [backend, sqlitePath, connectorId, scenario] = process.argv.slice(2) as [string, string, string, string];
const STREAM = "items";
const EMITTED_AT = "2026-10-18T00:00:00.000Z";

if (backend === "postgres") {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error("postgres ingest-kill child requires PDPP_TEST_POSTGRES_URL");
  initDb(":memory:");
  const attachment = process.env.KILL_CHILD_ATTACHMENT;
  await initPostgresStorage(
    { backend: "postgres", databaseUrl },
    attachment === undefined ? {} : { testOnlyAlreadyAdmittedChildAttachment: attachment }
  );
} else {
  initDb(sqlitePath);
}

const change = (key: string, v: number) => ({
  data: { id: key, v },
  emitted_at: EMITTED_AT,
  key,
  op: "upsert" as const,
  stream: STREAM,
});

if (scenario === "upsert") {
  await ingestRecord(connectorId, change("a", 2), { deferIndexes: true });
} else if (scenario === "delete") {
  await ingestRecord(
    connectorId,
    {
      data: { id: "a" },
      emitted_at: EMITTED_AT,
      key: "a",
      op: "delete",
      stream: STREAM,
    },
    { deferIndexes: true }
  );
} else if (scenario === "batch") {
  await ingestRecords(connectorId, [change("a", 2), change("b", 2)]);
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

process.stdout.write("done\n");
if (backend === "postgres") await closePostgresStorage();
closeDb();
process.exit(0);
