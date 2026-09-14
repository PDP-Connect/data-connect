// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { closeDb, initDb } from "../server/db.ts";
import { postgresPersistContentAddressedBlob } from "../server/postgres-records.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { deleteConnectionRecordRowsPostgres } from "../server/records.ts";
import { codeToStatus } from "../server/routes/ref-error-status.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
// Arbitrary advisory-lock namespace, unique to this file's scheduling seam.
const LOCK_KEY = 590_912;

test("blob publication conflict maps to HTTP 409 in the shared error envelope", () => {
  assert.equal(codeToStatus.blob_publication_conflict, 409);
});

/**
 * The test below pauses publication at the `blob_bindings` INSERT, where the FK
 * violation surfaces. There is an EARLIER window: the `blobs` INSERT is
 * `ON CONFLICT DO NOTHING`, so when the row already exists it no-ops, and
 * reclamation can commit its delete before the following SELECT reads the row
 * back. That path never reaches the binding INSERT, so the FK handler never
 * sees it. It is the same reclaimed-during-publication race and equally
 * retryable, so it must report the same retryable conflict rather than a
 * generic server fault that tells callers not to retry.
 *
 * The statement trigger is a scheduling seam only: the production INSERT runs
 * in full, then parks before the production SELECT can start. Every other
 * statement — the publication, the reclamation and the retry — is real.
 */
test("blob publication reports a retryable conflict when reclamation wins the pre-binding window", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_blob_publish_prebind_${Date.now().toString(36)}`,
    },
    async (url) => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const gate = new pg.Client({ connectionString: url });
      const cleanup = new pg.Client({ connectionString: url });
      let publication: ReturnType<typeof postgresPersistContentAddressedBlob> | undefined;
      try {
        await gate.connect();
        await cleanup.connect();
        const args = {
          connectorId: "https://registry.pdpp.test/connectors/blob_publication_prebind",
          connectorInstanceId: "cin_blob_prebind_doomed",
          data: Buffer.from("shared bytes reclaimed before the binding insert"),
          mimeType: "application/octet-stream",
          recordKey: "attachment-1",
          stream: "attachments",
        };
        const original = await postgresPersistContentAddressedBlob(args);
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await gate.query("SELECT pg_advisory_lock($1, 1)", [LOCK_KEY]);
        await postgresQuery(
          `CREATE FUNCTION pdpp_pause_blob_insert() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN PERFORM pg_advisory_xact_lock(${LOCK_KEY}, 1); RETURN NULL; END $$`
        );
        await postgresQuery(
          "CREATE TRIGGER pdpp_pause_blob_insert AFTER INSERT ON blobs FOR EACH STATEMENT EXECUTE FUNCTION pdpp_pause_blob_insert()"
        );

        publication = postgresPersistContentAddressedBlob({
          ...args,
          connectorInstanceId: "cin_blob_prebind_survivor",
        });
        publication.catch(() => undefined);
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (!blocked && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: observe the parked INSERT before allowing reclamation to commit.
          const observed = await postgresQuery<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
               AND query LIKE 'INSERT INTO blobs%') AS blocked`,
            [gatePid]
          );
          blocked = observed.rows[0]?.blocked ?? false;
          if (!blocked) {
            await delay(10);
          }
        }
        assert.ok(blocked, "publication must park after its blobs INSERT, before the read-back");

        // Real production reclamation, not a hand-written DELETE.
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL lock_timeout = '2000ms'");
        await deleteConnectionRecordRowsPostgres(cleanup, "cin_blob_prebind_doomed");
        await cleanup.query("COMMIT");
        assert.equal(
          (await postgresQuery("SELECT blob_id FROM blobs WHERE blob_id = $1", [original.blob_id])).rows.length,
          0,
          "reclamation committed the delete while publication was parked"
        );

        await gate.query("SELECT pg_advisory_unlock($1, 1)", [LOCK_KEY]);
        await assert.rejects(publication, {
          code: "blob_publication_conflict",
          message: "Blob was reclaimed during publication; retry the upload.",
          statusCode: 409,
        });

        await postgresQuery("DROP TRIGGER pdpp_pause_blob_insert ON blobs");
        const retry = await postgresPersistContentAddressedBlob({
          ...args,
          connectorInstanceId: "cin_blob_prebind_survivor",
        });
        assert.equal(retry.blob_id, original.blob_id);
        assert.equal(retry.binding_inserted, true);
        const restored = await postgresQuery<{ data: Buffer }>("SELECT data FROM blobs WHERE blob_id = $1", [
          original.blob_id,
        ]);
        assert.ok(
          restored.rows[0]?.data.equals(args.data),
          "the advertised retry restores the exact payload, so the 409 is actionable"
        );
      } finally {
        await cleanup.query("ROLLBACK").catch(() => undefined);
        await gate.query("SELECT pg_advisory_unlock($1, 1)", [LOCK_KEY]).catch(() => undefined);
        await publication?.catch(() => undefined);
        await gate.end().catch(() => undefined);
        await cleanup.end().catch(() => undefined);
        await closePostgresStorage();
        closeDb();
      }
    }
  );
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
