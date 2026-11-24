// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres stream summaries must honor the grant's resource and time limits.
 *
 * `postgresListStreams` once returned the connection-wide COUNT and
 * MAX(emitted_at) for every granted stream, even when the grant entry limited
 * resources or time. The count and last-updated stamp then described records
 * the grant could not read. This test seeds visible and hidden records into
 * one stream and requires each constrained summary to cover only the visible
 * ones, while an unconstrained entry in the same grant keeps the full totals.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set (Compose Postgres proof
 * service). The test provisions its own disposable database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { postgresIngestRecord, postgresListStreams } from "../server/postgres-records.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = "pg_stream_summary_grant";
const INSTANCE_ID = "cin_pg_stream_summary_grant";
const OTHER_INSTANCE_ID = "cin_pg_stream_summary_grant_other";
const STREAM = "items";
const OPEN_STREAM = "notes";

const manifest = {
  connector_id: CONNECTOR_ID,
  display_name: "Stream summary grant visibility",
  manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [STREAM, OPEN_STREAM].map((name) => ({
    consent_time_field: "received_at",
    cursor_field: "received_at",
    name,
    primary_key: ["id"],
    schema: {
      properties: {
        id: { type: "string" },
        received_at: { format: "date-time", type: "string" },
      },
      required: ["id"],
      type: "object",
    },
  })),
  version: "1.0.0",
};

const attemptContext = {
  streams: Object.fromEntries(
    [STREAM, OPEN_STREAM].map((name) => [
      name,
      { consentTimeField: "received_at", cursorField: "received_at", primaryKey: ["id"] },
    ])
  ),
};

const RECORDS = [
  { id: "rec-1", at: "2026-05-18T12:00:00.000Z" },
  { id: "rec-2", at: "2026-05-18T12:01:00.000Z" },
  { id: "rec-3", at: "2026-05-18T12:05:00.000Z" },
];

if (POSTGRES_URL) {
  test("postgres stream summaries count only grant-visible records and timestamps", async () => {
    const databaseName = `pdpp_stream_summary_grant_${Date.now().toString(36)}`;
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (databaseUrl) => {
        initDb(":memory:");
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        try {
          const target = { connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID };
          const otherTarget = { connectorId: CONNECTOR_ID, connectorInstanceId: OTHER_INSTANCE_ID };
          for (const { id, at } of RECORDS) {
            for (const storageTarget of [target, otherTarget]) {
              for (const stream of [STREAM, OPEN_STREAM]) {
                // biome-ignore lint/performance/noAwaitInLoops: sequential seeding keeps emitted_at ordering deterministic.
                await postgresIngestRecord(
                  storageTarget,
                  { data: { id, received_at: at }, emitted_at: at, key: id, op: "upsert", stream },
                  { attemptContext }
                );
              }
            }
          }

          const summarize = async (entry: Record<string, unknown>) => {
            const [summary] = await postgresListStreams(
              target,
              { streams: [{ name: STREAM, ...entry }] } as never,
              manifest as never
            );
            return { last_updated: summary?.last_updated, record_count: summary?.record_count };
          };

          assert.deepEqual(await summarize({}), { last_updated: "2026-05-18T12:05:00.000Z", record_count: 3 });
          assert.deepEqual(await summarize({ resources: ["rec-1"] }), {
            last_updated: "2026-05-18T12:00:00.000Z",
            record_count: 1,
          });
          assert.deepEqual(await summarize({ resources: ["rec-1", "rec-2", "missing"] }), {
            last_updated: "2026-05-18T12:01:00.000Z",
            record_count: 2,
          });
          assert.deepEqual(
            await summarize({
              time_constraint: {
                field: "received_at",
                since: "2026-05-18T12:00:00.000Z",
                until: "2026-05-18T12:01:00.000Z",
              },
            }),
            { last_updated: "2026-05-18T12:00:00.000Z", record_count: 1 }
          );
          assert.deepEqual(
            await summarize({
              resources: ["rec-1", "rec-3"],
              time_constraint: { field: "received_at", until: "2026-05-18T12:03:00.000Z" },
            }),
            { last_updated: "2026-05-18T12:00:00.000Z", record_count: 1 }
          );
          assert.deepEqual(await summarize({ resources: ["missing"] }), { last_updated: null, record_count: 0 });

          // A constrained entry must not change the totals of an unconstrained one in the same grant.
          const mixed = await postgresListStreams(
            target,
            { streams: [{ name: STREAM, resources: ["rec-2"] }, { name: OPEN_STREAM }] } as never,
            manifest as never
          );
          assert.deepEqual(
            mixed.map((summary) => [summary.name, summary.record_count, summary.last_updated]),
            [
              [STREAM, 1, "2026-05-18T12:01:00.000Z"],
              [OPEN_STREAM, 3, "2026-05-18T12:05:00.000Z"],
            ]
          );
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
} else {
  test("postgres stream summary grant visibility (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
  }, () => {
    // skip
  });
}
