// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-stream version allocation under independent-process contention,
 * Postgres backend (env-gated on `PDPP_TEST_POSTGRES_URL`).
 *
 * Three real OS processes ingest changed writes into one stream of one
 * database. Each round every writer parks just before its ingest call; the
 * parent sends each a resume. Child timestamps must show at least one round
 * with all calls started before any returns after commit. This observes call
 * overlap, not SQL lock timing.
 * Two layers protect the counter on Postgres: the per-connector-instance
 * transaction advisory lock taken by `withPostgresTransaction`, and the
 * single-statement allocator `allocateNextVersion`. The test asserts the
 * outcome, not the layer: unique, contiguous versions and no rejected write.
 * See the PR body for the seeded faults.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { assertContentionInvariants, runContention } from "./helpers/version-contention.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/version-contention";
const STREAM = "items";
const WRITERS = 3;
const WRITES_PER_WRITER = 6;

if (POSTGRES_URL) {
  test("[postgres] independent processes racing changed writes on one stream get unique contiguous versions", async () => {
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    try {
      // Children attach under a one-use capability (60 s TTL) minted while
      // `records` is still empty; mint right before spawning.
      // Sequential: concurrent CREATE TABLE IF NOT EXISTS races on pg_type.
      const attachments: string[] = [];
      for (let n = 0; n < WRITERS; n += 1) {
        attachments.push(await createAlreadyAdmittedTestDatabaseChildAttachment(POSTGRES_URL));
      }
      const result = await runContention({
        attachments,
        backend: "postgres",
        writers: WRITERS,
        writesPerWriter: WRITES_PER_WRITER,
      });
      for (const [n, child] of result.children.entries()) {
        assert.deepEqual(child.errors, [], `writer w${n} had rejected writes under contention`);
        assert.equal(child.code, 0, `writer w${n} must exit cleanly: ${child.stderr}`);
      }
      assert.ok(
        result.overlappedRounds > 0,
        `no overlapping ingest round: all ${WRITERS} children must resume before any commits in at least one of ${WRITES_PER_WRITER} rounds`
      );

      const rows = async (table: "record_changes" | "records") =>
        (
          await postgresQuery(
            `SELECT record_key, version::int AS version, record_json FROM ${table} WHERE connector_id = $1 AND stream = $2`,
            [CONNECTOR_ID, STREAM]
          )
        ).rows.map((row) => ({
          data: row.record_json,
          record_key: row.record_key,
          version: row.version,
        }));
      const counter = (
        await postgresQuery(
          "SELECT max_version::int AS v FROM version_counter WHERE connector_id = $1 AND stream = $2",
          [CONNECTOR_ID, STREAM]
        )
      ).rows[0]?.v;
      assertContentionInvariants({
        acks: result.acks,
        changes: await rows("record_changes"),
        counter: counter ?? null,
        current: await rows("records"),
        expectedWrites: WRITERS * WRITES_PER_WRITER,
      });
    } finally {
      for (const table of ["record_changes", "records", "version_counter"]) {
        await postgresQuery(`DELETE FROM ${table} WHERE connector_id = $1`, [CONNECTOR_ID]).catch(() => undefined);
      }
      await closePostgresStorage();
      closeDb();
    }
  });
}
