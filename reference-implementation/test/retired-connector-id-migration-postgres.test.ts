// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres counterpart of retired-connector-id-migration.test.ts: the boot
 * migration renames stored retired connector ids once, behind a receipt, and a
 * collision it cannot resolve leaves every row as it was and the receipt
 * `blocked`. Requires `PDPP_TEST_POSTGRES_URL`; skipped, and declared as
 * skipped, when unset.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RETIRED_CONNECTOR_ID_MIGRATION_ID } from "../server/retired-connector-ids.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const NOW = "2026-11-14T00:00:00.000Z";

type Pool = ReturnType<typeof getPostgresPool>;

let tempCounter = 0;
async function withTempDb(baseUrl: string, fn: (url: string) => Promise<void>): Promise<void> {
  tempCounter += 1;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: `retired_ids_${process.pid}_${tempCounter}`,
    },
    fn
  );
}

async function seedConnector(pool: Pool, connectorId: string): Promise<void> {
  await pool.query("INSERT INTO connectors (connector_id, manifest, created_at) VALUES ($1, $2, $3)", [
    connectorId,
    JSON.stringify({ connector_id: connectorId, display_name: connectorId, streams: [] }),
    NOW,
  ]);
}

async function seedInstance(pool: Pool, instanceId: string, connectorId: string, binding: string): Promise<void> {
  await pool.query(
    `INSERT INTO connector_instances
       (connector_instance_id, owner_subject_id, connector_id, display_name, source_kind, source_binding_key, created_at, updated_at)
     VALUES ($1, 'owner_local', $2, $2, 'local_device', $3, $4, $4)`,
    [instanceId, connectorId, binding, NOW]
  );
}

async function ids(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ connector_id: string }>(`SELECT connector_id FROM ${table} ORDER BY connector_id`);
  return result.rows.map((row) => row.connector_id);
}

async function receiptStatus(pool: Pool): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM storage_migration_ledger WHERE migration_id = $1",
    [RETIRED_CONNECTOR_ID_MIGRATION_ID]
  );
  return result.rows[0]?.status;
}

async function rearm(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM storage_migration_ledger WHERE migration_id = $1", [RETIRED_CONNECTOR_ID_MIGRATION_ID]);
}

if (POSTGRES_URL) {
  test("boot renames retired ids across tables, parents first, and records a complete receipt", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      assert.equal(await receiptStatus(pool), "complete", "a store with no retired ids still completes the receipt");

      await seedConnector(pool, "claude_code");
      await seedInstance(pool, "inst_cc", "claude_code", "binding-a");
      await pool.query(
        `INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at)
         VALUES ('claude_code', 'inst_cc', 'sessions', '{}', $1)`,
        [NOW]
      );
      await pool.query(
        `INSERT INTO device_enrollment_codes (enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, created_at, expires_at)
         VALUES ('enc_1', 'h', 'owner_local', 'google_takeout', 'b', $1, $1)`,
        [NOW]
      );
      await rearm(pool);

      await bootstrapPostgresSchema();

      assert.deepEqual(await ids(pool, "connectors"), ["claude-code"]);
      assert.deepEqual(await ids(pool, "connector_instances"), ["claude-code"]);
      assert.deepEqual(await ids(pool, "connector_state"), ["claude-code"]);
      assert.deepEqual(await ids(pool, "device_enrollment_codes"), ["google-takeout"]);
      const manifest = await pool.query<{ manifest: { connector_id: string } }>("SELECT manifest FROM connectors");
      assert.equal(manifest.rows[0]?.manifest.connector_id, "claude-code");
      const label = await pool.query<{ display_name: string }>("SELECT display_name FROM connector_instances");
      assert.equal(label.rows[0]?.display_name, "claude-code", "a placeholder label equal to the old id follows the rename");
      assert.equal(await receiptStatus(pool), "complete");
    });
  });

  test("a complete receipt makes later boots skip the scan", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedConnector(pool, "apple_photos");
      await bootstrapPostgresSchema();
      assert.deepEqual(await ids(pool, "connectors"), ["apple_photos"], "receipt was already complete: no rewrite");
    });
  });

  test("an unresolvable collision aborts, keeps every row, and blocks the receipt until it is fixed", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedConnector(pool, "claude_code");
      await seedConnector(pool, "claude-code");
      await seedInstance(pool, "inst_old", "claude_code", "binding-a");
      await seedInstance(pool, "inst_new", "claude-code", "binding-a");
      await rearm(pool);

      await assert.rejects(bootstrapPostgresSchema(), /unique|duplicate/i);
      assert.equal(await receiptStatus(pool), "blocked");
      assert.deepEqual(await ids(pool, "connectors"), ["claude-code", "claude_code"]);
      assert.deepEqual(await ids(pool, "connector_instances"), ["claude-code", "claude_code"]);

      await pool.query("DELETE FROM connector_instances WHERE connector_instance_id = 'inst_new'");
      await bootstrapPostgresSchema();
      assert.equal(await receiptStatus(pool), "complete");
      assert.deepEqual(await ids(pool, "connector_instances"), ["claude-code"]);
      assert.deepEqual(await ids(pool, "connectors"), ["claude-code"]);
    });
  });
} else {
  test("retired connector id Postgres migration tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // Declared so a skipped run is visible rather than silently absent.
  });
}
