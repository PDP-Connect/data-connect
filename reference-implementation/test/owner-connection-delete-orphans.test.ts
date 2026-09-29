// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner connection delete must leave no per-connection rows behind.
 *
 * Default-account connection ids are deterministic (hash of owner +
 * connector), and an explicit owner re-connect clears the tombstone and
 * re-creates the SAME id. Any per-connection table the `deleteConnection`
 * cascade does not erase therefore re-attaches its stale rows to the
 * re-created connection. This suite seeds one row per such table for the
 * deleted connection and for a sibling, deletes, re-creates the same id, and
 * asserts the deleted connection's rows are gone while the sibling's survive.
 *
 * Deliberately NOT covered (kept by design): spine_events and run_history
 * (audit / run history), grants, connector_instance_tombstones,
 * stream_evidence_run_registry (a run_id claim must never become reusable),
 * and the browser-surface replacement ledger.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

const NOW = "2026-09-28T12:00:00.000Z";
const LATER = "2026-09-28T12:01:00.000Z";
const OWNER = "owner_delete_orphans";
const CONNECTOR = "orphans_target";
const SIBLING_CONNECTOR = "orphans_sibling";
const DEVICE_ID = "dexp_delete_orphans";
const TARGET_ID = makeDefaultAccountConnectorInstanceId(OWNER, CONNECTOR);
const SIBLING_ID = makeDefaultAccountConnectorInstanceId(OWNER, SIBLING_CONNECTOR);

type Row = Record<string, string | number>;

interface OrphanTable {
  readonly row: (connectionId: string, connectorId: string, tag: string) => Row;
  readonly table: string;
}

// One entry per per-connection table the cascade must erase. Each row fills
// every NOT NULL column that has no default, on both backends.
const ORPHAN_TABLES: readonly OrphanTable[] = [
  {
    row: (id, connectorId, tag) => ({
      connector_id: connectorId,
      connector_instance_id: id,
      created_at: NOW,
      gap_id: `gap_${tag}`,
      source_json: "{}",
      stream: "messages",
      updated_at: NOW,
    }),
    table: "connector_detail_gaps",
  },
  {
    row: (id, connectorId) => ({
      connector_id: connectorId,
      connector_instance_id: id,
      last_run_time_ms: 1,
      updated_at: NOW,
    }),
    table: "scheduler_last_run_times",
  },
  {
    row: (id, connectorId, tag) => ({
      action: "schedule_run",
      body_hash: "hash",
      connector_id: connectorId,
      connector_instance_id: id,
      event_id: `evt_${tag}`,
      owner_subject_id: OWNER,
      run_id: `run_${tag}`,
      source_id: `src_${tag}`,
      started_at: NOW,
      trace_id: `trace_${tag}`,
    }),
    table: "source_webhook_run_receipts",
  },
  {
    row: (id, connectorId, tag) => ({
      batch_id: `batch_${tag}`,
      body_hash: "hash",
      connector_id: connectorId,
      connector_instance_id: id,
      created_at: NOW,
      device_id: DEVICE_ID,
      source_instance_id: `dsrc_${tag}`,
      status: "accepted",
    }),
    table: "device_ingest_batch_outcomes",
  },
  {
    row: (id, connectorId) => ({ connector_id: connectorId, connector_instance_id: id }),
    table: "retained_size_connection",
  },
  {
    row: (id, connectorId) => ({ connector_id: connectorId, connector_instance_id: id, stream: "messages" }),
    table: "retained_size_stream",
  },
  {
    row: (id, connectorId) => ({
      connector_id: connectorId,
      connector_instance_id: id,
      record_family: "family",
      stream: "messages",
    }),
    table: "retained_size_record_family",
  },
  {
    row: (id, connectorId) => ({
      connector_id: connectorId,
      connector_instance_id: id,
      marked_at: NOW,
      stream: "messages",
    }),
    table: "search_index_dirty",
  },
  {
    row: (id) => ({
      accumulator_json: "{}",
      connector_instance_id: id,
      source_revision: "0",
      started_at: NOW,
      updated_at: NOW,
    }),
    table: "connector_summary_evidence_repair_chunk",
  },
  {
    // The connection as a recovered fragment grouped under another canonical
    // connection. Left behind, the re-created id would be hidden again.
    row: (id) => ({
      canonical_connector_instance_id: "cin_orphans_canonical",
      connector_instance_id: id,
      grouped_at: NOW,
      grouped_by: "test",
      owner_subject_id: OWNER,
      reason: "test",
    }),
    table: "connector_instance_groups",
  },
];

// Record phase stubbed: this suite covers the store's own cascade statements,
// not the record-family purge `server/records.ts` owns.
const stubPurge = {
  deleteRecordRejectionsPostgres: () => Promise.resolve(0),
  deleteRecordRejectionsSqlite: () => 0,
  deleteRecordRowsPostgres: () => Promise.resolve(0),
  deleteRecordRowsSqlite: () => 0,
  enumerateStreams: () => Promise.resolve({ connectorId: "", connectorInstanceId: "", streams: [] }),
  teardownProjection: () => Promise.resolve(),
};

interface Backend {
  readonly count: (table: string, connectionId: string) => Promise<number>;
  readonly insert: (table: string, row: Row) => Promise<void>;
}

const sqliteBackend: Backend = {
  count: (table, connectionId) =>
    Promise.resolve(
      (
        getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`).get(connectionId) as {
          n: number;
        }
      ).n
    ),
  insert: (table, row) => {
    const columns = Object.keys(row);
    getDb()
      .prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
    return Promise.resolve();
  },
};

const postgresBackend: Backend = {
  count: async (table, connectionId) => {
    const result = await postgresQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${table} WHERE connector_instance_id = $1`,
      [connectionId]
    );
    return Number(result.rows[0]?.n ?? 0);
  },
  insert: async (table, row) => {
    const columns = Object.keys(row);
    await postgresQuery(
      `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    );
  },
};

interface StoreLike {
  clearDefaultAccountTombstone: (args: { ownerSubjectId: string; connectorId: string }) => unknown;
  deleteConnection: (
    connectorInstanceId: string,
    args: { ownerSubjectId: string; now: string; purge: typeof stubPurge }
  ) => unknown;
  ensureDefaultAccountConnection: (args: {
    ownerSubjectId: string;
    connectorId: string;
    now?: string;
  }) => { connectorInstanceId: string } | Promise<{ connectorInstanceId: string }>;
}

async function seedOrphanRows(backend: Backend): Promise<void> {
  for (const { table, row } of ORPHAN_TABLES) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential fixture inserts.
    await backend.insert(table, row(TARGET_ID, CONNECTOR, "target"));
    await backend.insert(table, row(SIBLING_ID, SIBLING_CONNECTOR, "sibling"));
  }
}

async function deleteAndRecreate(store: StoreLike): Promise<void> {
  for (const connectorId of [CONNECTOR, SIBLING_CONNECTOR]) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup.
    await store.ensureDefaultAccountConnection({ connectorId, now: NOW, ownerSubjectId: OWNER });
  }
  await store.deleteConnection(TARGET_ID, { now: LATER, ownerSubjectId: OWNER, purge: stubPurge });
  await store.clearDefaultAccountTombstone({ connectorId: CONNECTOR, ownerSubjectId: OWNER });
  const recreated = await store.ensureDefaultAccountConnection({
    connectorId: CONNECTOR,
    now: LATER,
    ownerSubjectId: OWNER,
  });
  assert.equal(recreated.connectorInstanceId, TARGET_ID, "re-connect reuses the deterministic connection id");
}

async function assertNoOrphans(backend: Backend): Promise<void> {
  const leftovers: string[] = [];
  const siblingLosses: string[] = [];
  for (const { table } of ORPHAN_TABLES) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential count reads.
    if ((await backend.count(table, TARGET_ID)) !== 0) {
      leftovers.push(table);
    }
    if ((await backend.count(table, SIBLING_ID)) !== 1) {
      siblingLosses.push(table);
    }
  }
  assert.deepEqual(leftovers, [], "the re-created connection inherits no rows from the deleted one");
  assert.deepEqual(siblingLosses, [], "the sibling connection keeps its rows");
}

test("SQLite deleteConnection leaves no per-connection rows for a re-created default-account id", async () => {
  initDb();
  try {
    const db = getDb();
    for (const connectorId of [CONNECTOR, SIBLING_CONNECTOR]) {
      db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
        connectorId,
        JSON.stringify({ connector_id: connectorId }),
        NOW
      );
    }
    db.prepare(
      "INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(DEVICE_ID, OWNER, "Orphans device", NOW, NOW);
    await seedOrphanRows(sqliteBackend);
    await deleteAndRecreate(createSqliteConnectorInstanceStore() as unknown as StoreLike);
    await assertNoOrphans(sqliteBackend);
  } finally {
    closeDb();
  }
});

test("Postgres deleteConnection leaves no per-connection rows for a re-created default-account id (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "PDPP_TEST_POSTGRES_URL is required for this test");
  const ids = [TARGET_ID, SIBLING_ID];
  const cleanup = async () => {
    for (const { table } of ORPHAN_TABLES) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture cleanup.
      await postgresQuery(`DELETE FROM ${table} WHERE connector_instance_id = ANY($1::text[])`, [ids]);
    }
    await postgresQuery("DELETE FROM device_exporters WHERE device_id = $1", [DEVICE_ID]);
    await postgresQuery("DELETE FROM connector_instance_tombstones WHERE owner_subject_id = $1", [OWNER]);
    await postgresQuery("DELETE FROM connector_instances WHERE owner_subject_id = $1", [OWNER]);
  };
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanup();
    for (const connectorId of [CONNECTOR, SIBLING_CONNECTOR]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup.
      await postgresQuery(
        `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)
           ON CONFLICT(connector_id) DO NOTHING`,
        [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
      );
    }
    await postgresQuery(
      "INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [DEVICE_ID, OWNER, "Orphans device", NOW, NOW]
    );
    await seedOrphanRows(postgresBackend);
    await deleteAndRecreate(createPostgresConnectorInstanceStore() as unknown as StoreLike);
    await assertNoOrphans(postgresBackend);
  } finally {
    await cleanup();
    await postgresQuery("DELETE FROM connectors WHERE connector_id = ANY($1::text[])", [
      [CONNECTOR, SIBLING_CONNECTOR],
    ]);
    await closePostgresStorage();
  }
});
