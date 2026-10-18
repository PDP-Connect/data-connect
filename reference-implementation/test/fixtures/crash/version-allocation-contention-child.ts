// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/records-version-allocation-contention*.test.ts: one of N
// independent OS processes that ingest changed writes into the SAME stream of
// the SAME store. Before each write transaction it parks at the crash point
// `ingest:before-write-transaction`, so the parent can line all children up
// and release them together.
//
// args: <sqlite|postgres> <sqlite-path|-> <writer-id> <writes>
// env:  PDPP_TEST_POSTGRES_URL (postgres), CONTENTION_CHILD_ATTACHMENT
//
// stdout, one JSON line per acknowledged write: {"writer","key","index"}.
// A rejected write prints {"writer","key","index","error"} and the child
// exits 1 after the loop, so the parent sees both the ack set and the failure.
import { closeDb, initDb } from "../../../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../../../server/postgres-storage.ts";
import { ingestRecord } from "../../../server/records.ts";
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

export const CONTENTION_CONNECTOR_ID = "https://test.pdpp.dev/connectors/version-contention";
export const CONTENTION_STREAM = "items";

const [backend, sqlitePath, writerId, writesArg] = process.argv.slice(2) as [string, string, string, string];
const writes = Number(writesArg);

if (backend === "postgres") {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error("postgres contention child requires PDPP_TEST_POSTGRES_URL");
  initDb(":memory:");
  const attachment = process.env.CONTENTION_CHILD_ATTACHMENT;
  await initPostgresStorage(
    { backend: "postgres", databaseUrl },
    attachment === undefined ? {} : { testOnlyAlreadyAdmittedChildAttachment: attachment }
  );
} else {
  initDb(sqlitePath);
}

let failed = false;
for (let index = 0; index < writes; index += 1) {
  // Even writes create a record owned by this writer; odd writes update the
  // one record every writer shares, so writers also contend on a single row.
  const key = index % 2 === 0 ? `own-${writerId}-${index}` : "shared";
  try {
    await ingestRecord(
      CONTENTION_CONNECTOR_ID,
      {
        data: { id: key, index, writer: writerId },
        emitted_at: "2026-10-18T00:00:00.000Z",
        key,
        op: "upsert",
        stream: CONTENTION_STREAM,
      },
      { deferIndexes: true }
    );
    process.stdout.write(`${JSON.stringify({ index, key, writer: writerId })}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error), index, key, writer: writerId })}\n`
    );
  }
}

if (backend === "postgres") await closePostgresStorage();
closeDb();
process.exit(failed ? 1 : 0);
