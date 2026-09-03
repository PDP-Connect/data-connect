// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed regression for the record-delete boundary.
 *
 * Two paths share one durable-tail construction in postgres-records.js:
 *
 *   1. `deleteAllRecords(storageTarget, stream)` — owner-authenticated
 *      per-stream reset (called from `rs.records.delete_stream`).
 *   2. `deleteAllRecordsForConnector(connectorId)` — connector-wide
 *      invalidation called by the polyfill manifest reconciler on the
 *      reference-fixture → polyfill transition.
 *
 * Before this fix, the connector-wide path was SQLite-only (so in
 * Postgres deployments the reconciler reported `deletedCount = 0` and
 * left stale records under the prior-shape manifest fingerprint), and
 * the per-stream postgres helper bundled its DELETEs into one
 * semicolon-separated string, which pg rejects when parameters are
 * present (extended-protocol prepared statements are single-statement).
 *
 * This test pins both paths together against a real Postgres so the
 * boundary stays consistent. The connector-wide path composes the
 * per-stream helper plus a blob_bindings drop; if the per-stream helper
 * regresses, the connector-wide test fails too.
 *
 * Env gate: `PDPP_TEST_POSTGRES_URL` must be set (Compose Postgres proof
 * service). Each scenario uses a uniquely-named `(connector_id,
 * connector_instance_id)` pair so concurrent runs do not collide on the
 * shared schema, and cleans up rows under those unique ids at teardown.
 *
 * Spec: openspec/changes/fix-polyfill-record-invalidation-postgres-routing/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { postgresIngestRecord } from "../server/postgres-records.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresSemanticVectorEmbedding,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { deleteAllRecords, deleteAllRecordsForConnector } from "../server/records.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  test("Postgres bootstrap applies the bloat-control autovacuum policy to heap tables and TOAST", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const result = await postgresQuery<{
        relname: string;
        reloptions: string[] | null;
        toast_reloptions: string[] | null;
      }>(
        `SELECT heap.relname, heap.reloptions, toast.reloptions AS toast_reloptions
           FROM pg_class AS heap
           LEFT JOIN pg_class AS toast ON toast.oid = heap.reltoastrelid
          WHERE heap.relnamespace = current_schema()::regnamespace
            AND heap.relname = ANY($1::text[])`,
        [["records", "record_changes", "blobs", "spine_events"]]
      );
      const expectedHeapOptions = [
        "autovacuum_enabled=true",
        "autovacuum_vacuum_threshold=1",
        "autovacuum_vacuum_scale_factor=0.01",
        "autovacuum_vacuum_insert_threshold=50",
        "autovacuum_vacuum_insert_scale_factor=0.02",
        "autovacuum_analyze_threshold=50",
        "autovacuum_analyze_scale_factor=0.02",
      ];
      const expectedToastOptions = [
        "autovacuum_enabled=true",
        "autovacuum_vacuum_threshold=1",
        "autovacuum_vacuum_scale_factor=0.01",
        "autovacuum_vacuum_insert_threshold=50",
        "autovacuum_vacuum_insert_scale_factor=0.02",
      ];

      assert.equal(result.rows.length, 4, "all high-churn tables exist in the active schema");
      for (const row of result.rows) {
        const heapOptions = new Set(row.reloptions ?? []);
        const toastOptions = new Set(row.toast_reloptions ?? []);
        for (const option of expectedHeapOptions) {
          assert.ok(heapOptions.has(option), `${row.relname} heap sets ${option}`);
        }
        for (const option of expectedToastOptions) {
          assert.ok(toastOptions.has(option), `${row.relname} TOAST sets ${option}`);
        }
      }
    } finally {
      await closePostgresStorage();
      closeDb();
    }
  });

  test("deleteAllRecordsForConnector invalidates Postgres-backed records", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `https://registry.pdpp.test/connectors/pg_invalidate_${suffix}`;
    const connectorInstanceId = `cin_pg_invalidate_${suffix}`;
    const streamA = "top_artists";
    const streamB = "saved_tracks";

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

      // Seed two streams under the same connector. The connector-wide
      // invalidation must reach both.
      await postgresIngestRecord(storageTarget, {
        data: {
          id: "spotify:artist:owner-real-1",
          name: "Real Owner Artist 1",
          source_updated_at: "2026-04-25T00:00:00.000Z",
        },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "spotify:artist:owner-real-1",
        op: "upsert",
        stream: streamA,
      });
      await postgresIngestRecord(storageTarget, {
        data: {
          id: "spotify:artist:owner-real-2",
          name: "Real Owner Artist 2",
          source_updated_at: "2026-04-25T00:00:00.000Z",
        },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "spotify:artist:owner-real-2",
        op: "upsert",
        stream: streamA,
      });
      await postgresIngestRecord(storageTarget, {
        data: {
          id: "spotify:track:owner-real-1",
          name: "Saved Track 1",
          saved_at: "2026-04-25T00:00:00.000Z",
        },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "spotify:track:owner-real-1",
        op: "upsert",
        stream: streamB,
      });

      // Baseline: three live records exist in Postgres for this connector.
      const baseline = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_id = $1 AND deleted = FALSE`,
        [connectorId]
      );
      assert.equal(
        Number(baseline.rows[0]?.count || 0),
        3,
        "baseline: three Postgres records present before invalidation"
      );

      // Invalidate via the connector-wide helper — the exact entry point
      // the polyfill manifest reconciler calls on the seed → polyfill
      // transition.
      const result = await deleteAllRecordsForConnector(connectorId);
      assert.equal(result.deletedCount, 3, "Postgres path reports a non-zero deletedCount matching the seeded rows");
      assert.deepEqual([...result.streams].sort(), [streamA, streamB].sort(), "returns both seeded streams");

      // Records, record_changes, version_counter, and blob_bindings are
      // all drained for this connector. The shared schema may carry rows
      // from other tests under different (connector_id, connector_instance_id)
      // pairs; scope every assertion by connector_id so we do not race them.
      const recordsAfter = await postgresQuery("SELECT COUNT(*)::int AS count FROM records WHERE connector_id = $1", [
        connectorId,
      ]);
      assert.equal(Number(recordsAfter.rows[0]?.count || 0), 0, "no records rows remain for the invalidated connector");

      const changesAfter = await postgresQuery(
        "SELECT COUNT(*)::int AS count FROM record_changes WHERE connector_id = $1",
        [connectorId]
      );
      assert.equal(
        Number(changesAfter.rows[0]?.count || 0),
        0,
        "no record_changes rows remain for the invalidated connector"
      );

      const counterAfter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1`,
        [connectorInstanceId]
      );
      assert.equal(
        Number(counterAfter.rows[0]?.count || 0),
        0,
        "version_counter rows for this connector_instance are dropped"
      );

      const bindingsAfter = await postgresQuery(
        "SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_id = $1",
        [connectorId]
      );
      assert.equal(Number(bindingsAfter.rows[0]?.count || 0), 0, "blob_bindings rows for this connector are dropped");
    } finally {
      try {
        await postgresQuery("DELETE FROM blob_bindings WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM record_changes WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });

  test("deleteAllRecords (per-stream) succeeds against Postgres and leaves sibling stream intact", async () => {
    // Companion regression for the sibling helper. Before the parameterized
    // multi-statement was split into individual DELETEs, this call threw
    // `cannot insert multiple commands into a prepared statement` and the
    // per-stream owner-reset path was effectively unusable on Postgres.
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `https://registry.pdpp.test/connectors/pg_stream_delete_${suffix}`;
    const connectorInstanceId = `cin_pg_stream_delete_${suffix}`;
    // `%` would match the sibling under an unescaped SQL LIKE predicate.
    const streamTarget = "a%b";
    const streamSibling = "axb";

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

      // Seed two streams. The per-stream delete must drop the target and
      // leave the sibling untouched.
      await postgresIngestRecord(storageTarget, {
        data: { id: "a-1", name: "Target A1", source_updated_at: "2026-04-25T00:00:00.000Z" },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "a-1",
        op: "upsert",
        stream: streamTarget,
      });
      await postgresIngestRecord(storageTarget, {
        data: { id: "a-2", name: "Target A2", source_updated_at: "2026-04-25T00:00:00.000Z" },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "a-2",
        op: "upsert",
        stream: streamTarget,
      });
      await postgresIngestRecord(storageTarget, {
        data: { id: "s-1", name: "Sibling S1", saved_at: "2026-04-25T00:00:00.000Z" },
        emitted_at: "2026-04-25T00:00:00.000Z",
        key: "s-1",
        op: "upsert",
        stream: streamSibling,
      });
      // `semantic_search_blob.embedding` is `vector` when pgvector is
      // available and `jsonb` otherwise, so the cast has to follow the same
      // branch the production writer uses (`insertSemanticRows` in
      // postgres-search.ts). A JSON array literal is valid input for both
      // types; hardcoding `::jsonb` fails on a pgvector database — which is
      // the production configuration — with
      // `column "embedding" is of type vector but expression is of type jsonb`.
      const embeddingCast = isPostgresSemanticVectorEmbedding() ? "vector" : "jsonb";
      await postgresQuery(
        `INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding)
         VALUES ($1, $2, $3, $4, $5::${embeddingCast}), ($1, $2, $6, $7, $5::${embeddingCast})`,
        [
          connectorId,
          connectorInstanceId,
          JSON.stringify([streamTarget, "body"]),
          "a-1",
          "[0.25, 0.75]",
          JSON.stringify([streamSibling, "body"]),
          "s-1",
        ]
      );

      const targetBaseline = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
        [connectorInstanceId, streamTarget]
      );
      assert.equal(Number(targetBaseline.rows[0]?.count || 0), 2, "baseline: two records on target stream");

      const deletedCount = await deleteAllRecords(storageTarget, streamTarget);
      assert.equal(deletedCount, 2, "per-stream delete reports the live-record count it removed");

      // Target stream is drained for records, record_changes, version_counter.
      const targetRecords = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget]
      );
      assert.equal(Number(targetRecords.rows[0]?.count || 0), 0, "target stream records are dropped");

      const targetChanges = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget]
      );
      assert.equal(Number(targetChanges.rows[0]?.count || 0), 0, "target stream record_changes are dropped");

      const targetCounter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget]
      );
      assert.equal(Number(targetCounter.rows[0]?.count || 0), 0, "target stream version_counter is dropped");

      // Sibling stream survives.
      const siblingRecords = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
        [connectorInstanceId, streamSibling]
      );
      assert.equal(
        Number(siblingRecords.rows[0]?.count || 0),
        1,
        "sibling stream records are untouched by the per-stream delete"
      );

      const siblingCounter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamSibling]
      );
      assert.equal(Number(siblingCounter.rows[0]?.count || 0), 1, "sibling stream version_counter row is untouched");

      const siblingSemantic = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM semantic_search_blob
           WHERE connector_instance_id = $1 AND scope_key = $2`,
        [connectorInstanceId, JSON.stringify([streamSibling, "body"])]
      );
      assert.equal(
        Number(siblingSemantic.rows[0]?.count || 0),
        1,
        "a wildcard-like stream name cannot delete a sibling semantic scope during record cleanup"
      );
    } finally {
      try {
        await postgresQuery("DELETE FROM blob_bindings WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM record_changes WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
        await postgresQuery("DELETE FROM semantic_search_blob WHERE connector_instance_id = $1", [connectorInstanceId]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  test("postgres record-delete routing (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
}
