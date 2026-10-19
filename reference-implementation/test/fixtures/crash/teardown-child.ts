// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/records-teardown-failure-matrix.test.ts: runs the real
// connector-wide teardown (`deleteAllRecordsForConnector`) against a SQLite
// file or the private Postgres database, with crash points armed by the parent.
//
// args: <sqlite|postgres> <sqlite-path|-> <connector-id>
// env:  PDPP_TEST_POSTGRES_URL, TEARDOWN_CHILD_ATTACHMENT (postgres)
import { closeDb, initDb } from "../../../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../../../server/postgres-storage.ts";
import { deleteAllRecordsForConnector } from "../../../server/records.ts";
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

const [backend, sqlitePath, connectorId] = process.argv.slice(2) as [string, string, string];

if (backend === "postgres") {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error("postgres teardown child requires PDPP_TEST_POSTGRES_URL");
  initDb(":memory:");
  const attachment = process.env.TEARDOWN_CHILD_ATTACHMENT;
  await initPostgresStorage(
    { backend: "postgres", databaseUrl },
    attachment === undefined ? {} : { testOnlyAlreadyAdmittedChildAttachment: attachment }
  );
} else {
  initDb(sqlitePath);
}

const result = await deleteAllRecordsForConnector(connectorId);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (backend === "postgres") await closePostgresStorage();
closeDb();
process.exit(0);
