// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { closeDb, initDb } from "../server/db.ts";
import { postgresPersistContentAddressedBlob } from "../server/postgres-records.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { codeToStatus } from "../server/routes/ref-error-status.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

test("blob publication conflict maps to HTTP 409 in the shared error envelope", () => {
  assert.equal(codeToStatus.blob_publication_conflict, 409);
});

test("blob publication reports a retryable conflict when reclamation wins its FK lock", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_blob_publish_conflict_${Date.now().toString(36)}`,
    },
    async (url) => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const cleanup = new pg.Client({ connectionString: url });
      let publication: ReturnType<typeof postgresPersistContentAddressedBlob> | undefined;
      try {
        await cleanup.connect();
        const args = {
          connectorId: "https://registry.pdpp.test/connectors/blob_publication_conflict",
          connectorInstanceId: "cin_blob_publication_doomed",
          data: Buffer.from("shared bytes for concurrent reclamation"),
          mimeType: "application/octet-stream",
          recordKey: "attachment-1",
          stream: "attachments",
        };
        const original = await postgresPersistContentAddressedBlob(args);
        await cleanup.query("BEGIN");
        const pid = await cleanup.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await cleanup.query("SELECT blob_id FROM blobs WHERE blob_id = $1 FOR UPDATE", [original.blob_id]);

        publication = postgresPersistContentAddressedBlob({
          ...args,
          connectorInstanceId: "cin_blob_publication_survivor",
        });
        publication.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 2000;
        while (!blocked && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: observe the FK lock before allowing deletion to commit.
          const result = await postgresQuery<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
               AND query LIKE 'INSERT INTO blob_bindings%') AS blocked`,
            [pid.rows[0]?.pid]
          );
          blocked = result.rows[0]?.blocked ?? false;
          if (!blocked) {
            await delay(10);
          }
        }
        assert.ok(blocked, "publication must wait on the reclaimed blob's FK lock");
        await cleanup.query("DELETE FROM blob_bindings WHERE blob_id = $1", [original.blob_id]);
        await cleanup.query("DELETE FROM blobs WHERE blob_id = $1", [original.blob_id]);
        await cleanup.query("COMMIT");
        await assert.rejects(publication, {
          code: "blob_publication_conflict",
          statusCode: 409,
          message: "Blob was reclaimed during publication; retry the upload.",
        });
        const retry = await postgresPersistContentAddressedBlob({
          ...args,
          connectorInstanceId: "cin_blob_publication_survivor",
        });
        assert.equal(retry.blob_id, original.blob_id);
        assert.equal(retry.binding_inserted, true);
      } finally {
        await cleanup.query("ROLLBACK").catch(() => undefined);
        await publication?.catch(() => undefined);
        await cleanup.end();
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
