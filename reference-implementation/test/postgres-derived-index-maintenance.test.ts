// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  getLastPostgresDerivedIndexMaintenanceReceipt,
  parsePostgresDerivedIndexMaintenanceWindow,
  runPostgresDerivedIndexMaintenance,
} from "../server/postgres-derived-index-maintenance.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL ?? "postgres://postgres:pdpp_bloat_test_password@127.0.0.1:55448/pdpp_bloat_test";
let databaseCounter = 0;

function databaseName(): string {
  databaseCounter += 1;
  return `pdpp_derived_index_maintenance_${process.pid}_${databaseCounter}`;
}

test("derived-index maintenance defaults to a safe UTC off-peak window and accepts overrides", () => {
  assert.deepEqual(parsePostgresDerivedIndexMaintenanceWindow(""), { endMinute: 300, startMinute: 60 });
  assert.deepEqual(parsePostgresDerivedIndexMaintenanceWindow("01:30-04:00"), {
    endMinute: 240,
    startMinute: 90,
  });
  assert.equal(parsePostgresDerivedIndexMaintenanceWindow("disabled"), null);
  assert.throws(() => parsePostgresDerivedIndexMaintenanceWindow("overnight"), /HH:MM-HH:MM/);
});

test("derived-index maintenance vacuums known heavy tables and concurrently reindexes present static search indexes", async () => {
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName: databaseName() },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await postgresQuery(
          `INSERT INTO lexical_search_index (connector_id, connector_instance_id, stream, record_key, field, value)
           SELECT 'connector', 'instance', 'stream', 'record-' || series::text, 'field', repeat('searchable value ', 32)
             FROM generate_series(1, 3000) AS series`
        );
        await postgresQuery("DELETE FROM lexical_search_index WHERE record_key <> 'record-1'");
        await postgresQuery("ANALYZE lexical_search_index");

        const before = await postgresQuery<{ index_oid: string; last_vacuum: string | null }>(
          `SELECT stats.last_vacuum::text AS last_vacuum,
                  index_class.oid::text AS index_oid
             FROM pg_stat_user_tables AS stats
             JOIN pg_class AS index_class ON index_class.relname = 'idx_pg_lexical_search_document'
             JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
            WHERE stats.schemaname = current_schema()
              AND stats.relname = 'lexical_search_index'
              AND index_namespace.nspname = current_schema()`
        );
        assert.equal(before.rowCount, 1);

        const receipt = await runPostgresDerivedIndexMaintenance({
          // pg_stat_user_tables updates n_dead_tup asynchronously. Zero gates
          // make this real-database proof deterministic while still exercising
          // both maintenance predicates against the sampled statistics.
          minimumDeadTupleRatio: 0,
          minimumDeadTuples: 0,
          minimumTableBytes: 0,
          now: new Date("2026-09-03T02:00:00.000Z"),
          window: { endMinute: 180, startMinute: 60 },
        });
        const reindexableIndexes = [
          "idx_pg_lexical_search_document",
          "idx_pg_lexical_search_scope_document",
          "idx_pg_semantic_search_scope",
          "idx_pg_semantic_search_embedding_hnsw",
        ];
        const presentIndexes = await postgresQuery<{ relname: string }>(
          `SELECT index_class.relname
             FROM pg_class AS index_class
             JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
            WHERE namespace.nspname = current_schema()
              AND index_class.relname = ANY($1::text[])
            ORDER BY index_class.relname`,
          [reindexableIndexes]
        );
        const after = await postgresQuery<{ index_oid: string; last_analyze: string | null; last_vacuum: string | null }>(
          `SELECT stats.last_vacuum::text AS last_vacuum,
                  stats.last_analyze::text AS last_analyze,
                  index_class.oid::text AS index_oid
             FROM pg_stat_user_tables AS stats
             JOIN pg_class AS index_class ON index_class.relname = 'idx_pg_lexical_search_document'
             JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
            WHERE stats.schemaname = current_schema()
              AND stats.relname = 'lexical_search_index'
              AND index_namespace.nspname = current_schema()`
        );

        assert.equal(receipt.status, "completed");
        assert.deepEqual(
          receipt.tables.map((table) => table.tableName),
          ["blobs", "lexical_search_index", "record_changes", "records", "semantic_search_blob", "spine_events"],
          "the scheduled vacuum samples every known heavy table"
        );
        assert.ok(receipt.tables.some((table) => table.tableName === "lexical_search_index" && table.vacuumed));
        assert.deepEqual(
          [...receipt.reindexedIndexNames].sort(),
          presentIndexes.rows.map((row) => row.relname),
          "only present indexes from the static search-index allowlist are rebuilt"
        );
        assert.deepEqual(getLastPostgresDerivedIndexMaintenanceReceipt(), receipt);
        assert.ok(after.rows[0]?.last_vacuum, "VACUUM (ANALYZE) updates Postgres's manual vacuum statistic");
        assert.ok(after.rows[0]?.last_analyze, "VACUUM (ANALYZE) updates Postgres's analyze statistic");
        assert.notEqual(after.rows[0]?.index_oid, before.rows[0]?.index_oid, "REINDEX CONCURRENTLY replaces the index relation");

        const repeat = await runPostgresDerivedIndexMaintenance({
          minimumDeadTupleRatio: 0,
          minimumDeadTuples: 0,
          minimumTableBytes: 0,
          now: new Date("2026-09-03T02:15:00.000Z"),
          window: { endMinute: 180, startMinute: 60 },
        });
        assert.equal(repeat.status, "already-completed", "the scheduler runs no more than once in one UTC window");
        const outsideWindow = await runPostgresDerivedIndexMaintenance({
          now: new Date("2026-09-03T04:00:00.000Z"),
          window: { endMinute: 180, startMinute: 60 },
        });
        assert.equal(outsideWindow.status, "outside-window");
        assert.deepEqual(
          getLastPostgresDerivedIndexMaintenanceReceipt(),
          receipt,
          "routine outside-window polls do not hide the most recent completed maintenance receipt"
        );
      } finally {
        await closePostgresStorage();
      }
    }
  );
});
