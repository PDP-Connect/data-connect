// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  closePostgresStorage,
  initPostgresStorage,
  PostgresStatementTimeoutError,
  postgresQuery,
  postgresQueryBounded,
  withPostgresReadSnapshot,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

test("a timed-out bounded query does not poison its enclosing PostgreSQL read snapshot", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const connectionString = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(connectionString);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString,
      databaseName: `pdpp_bounded_snapshot_review_${randomUUID().replaceAll("-", "")}`,
      templateName: null,
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await withPostgresReadSnapshot(async () => {
          await postgresQuery("SET LOCAL statement_timeout = '5s'");
          await assert.rejects(postgresQueryBounded("SELECT pg_sleep(0.1)", [], 10), PostgresStatementTimeoutError);
          const timeout = await postgresQuery<{ statement_timeout: string }>("SHOW statement_timeout");
          assert.equal(timeout.rows[0]?.statement_timeout, "5s");
          const result = await postgresQuery<{ answer: number }>("SELECT 42 AS answer");
          assert.equal(result.rows[0]?.answer, 42);
        });
      } finally {
        await closePostgresStorage();
      }
    }
  );
});
