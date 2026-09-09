// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Orphan-blob reclamation at the per-stream delete site.
 *
 * `blobs` rows are content-addressed and GLOBALLY deduplicated: the insert in
 * `postgresPersistContentAddressedBlob` conflicts on `blob_id` alone, with no
 * connector or instance in the conflict target, so byte-identical content
 * uploaded by two different connections resolves to ONE `blobs` row plus two
 * `blob_bindings` rows. The FK from `blob_bindings.blob_id` is
 * `ON DELETE CASCADE`, so deleting a `blobs` row destroys every sibling
 * binding — including bindings owned by a connection that was never deleted.
 *
 * That is why blob reclamation must be refcount-gated rather than
 * supersede-and-delete. The whole-connection delete already gets this right
 * (`deleteConnectionRecordRowsPostgres` in records.ts, and the SQLite sibling
 * `delete-blobs-by-instance.sql`): it deletes bindings first, then deletes
 * only those `blobs` rows that no binding still references.
 *
 * The per-stream arm of the connector-wide delete did NOT: it dropped
 * `blob_bindings` for the stream and left the now-unreferenced `blobs` rows
 * behind forever, since no orphan collector exists anywhere in the codebase.
 * These fixtures pin both halves of the corrected behavior:
 *
 *   1. a blob whose last binding the delete removes is reclaimed, and
 *   2. a blob still bound by a LIVE sibling connection survives.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { exec, getOne, referenceQueries } from "../lib/db.ts"
import { closeDb, initDb } from "../server/db.ts"
import {
  postgresIngestRecord,
  postgresPersistContentAddressedBlob,
} from "../server/postgres-records.ts"
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts"
import { deleteAllRecordsForConnector } from "../server/records.ts"
import { getChangeHistoryLimit } from "../server/storage-utils.ts"
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts"

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL
const STREAM = "attachments"

async function countBlobs(blobId: string): Promise<number> {
  const result = await postgresQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM blobs WHERE blob_id = $1",
    [blobId]
  )
  return Number(result.rows[0]?.count || 0)
}

async function countBindings(blobId: string): Promise<number> {
  const result = await postgresQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM blob_bindings WHERE blob_id = $1",
    [blobId]
  )
  return Number(result.rows[0]?.count || 0)
}

/** Ingest a record that carries `data.blob_ref.blob_id`, then persist its bytes. */
async function seedRecordWithBlob({
  connectorId,
  connectorInstanceId,
  recordKey,
  bytes,
}: {
  bytes: Buffer
  connectorId: string
  connectorInstanceId: string
  recordKey: string
}): Promise<string> {
  const persisted = await postgresPersistContentAddressedBlob({
    connectorId,
    connectorInstanceId,
    data: bytes,
    mimeType: "application/octet-stream",
    recordKey,
    stream: STREAM,
  })
  await postgresIngestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    {
      data: { blob_ref: { blob_id: persisted.blob_id }, id: recordKey },
      emitted_at: "2026-09-03T00:00:00.000Z",
      key: recordKey,
      op: "upsert",
      stream: STREAM,
    }
  )
  return persisted.blob_id
}

if (POSTGRES_URL) {
  test("per-stream connector delete reclaims blobs whose last binding it removed", async () => {
    const databaseName = `pdpp_orphan_blob_reclaim_${Date.now().toString(36)}`
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName,
      },
      async url => {
        initDb(":memory:")
        await initPostgresStorage({ backend: "postgres", databaseUrl: url })
        try {
          const connectorId =
            "https://registry.pdpp.test/connectors/orphan_blob_reclaim"
          const connectorInstanceId = "cin_orphan_blob_reclaim"
          const blobId = await seedRecordWithBlob({
            bytes: Buffer.alloc(64 * 1024, 0x5a),
            connectorId,
            connectorInstanceId,
            recordKey: "att-1",
          })

          assert.equal(
            await countBlobs(blobId),
            1,
            "baseline: the blob row exists"
          )
          assert.equal(
            await countBindings(blobId),
            1,
            "baseline: exactly one binding references it"
          )

          await deleteAllRecordsForConnector(connectorId)

          assert.equal(
            await countBindings(blobId),
            0,
            "the delete drops the stream's blob_bindings"
          )
          assert.equal(
            await countBlobs(blobId),
            0,
            "a blob left with no binding is reclaimed rather than leaked as junk"
          )
        } finally {
          await closePostgresStorage()
          closeDb()
        }
      }
    )
  })

  test("per-stream connector delete retains a blob still bound by a live sibling connection", async () => {
    const databaseName = `pdpp_shared_blob_retained_${Date.now().toString(36)}`
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName,
      },
      async url => {
        initDb(":memory:")
        await initPostgresStorage({ backend: "postgres", databaseUrl: url })
        try {
          // Byte-identical content under two different connectors. Global
          // content addressing collapses them onto ONE `blobs` row with two
          // bindings, so deleting the row on behalf of either connector would
          // cascade away the other's binding and break a live record.
          const sharedBytes = Buffer.alloc(64 * 1024, 0x5a)
          const doomedConnectorId =
            "https://registry.pdpp.test/connectors/shared_blob_doomed"
          const survivingConnectorId =
            "https://registry.pdpp.test/connectors/shared_blob_survivor"

          const doomedBlobId = await seedRecordWithBlob({
            bytes: sharedBytes,
            connectorId: doomedConnectorId,
            connectorInstanceId: "cin_shared_blob_doomed",
            recordKey: "att-1",
          })
          const survivingBlobId = await seedRecordWithBlob({
            bytes: sharedBytes,
            connectorId: survivingConnectorId,
            connectorInstanceId: "cin_shared_blob_survivor",
            recordKey: "att-1",
          })
          assert.equal(
            doomedBlobId,
            survivingBlobId,
            "fixture premise: identical bytes dedupe to a single content-addressed blob row"
          )
          assert.equal(
            await countBindings(doomedBlobId),
            2,
            "baseline: two connections bind the same blob"
          )

          await deleteAllRecordsForConnector(doomedConnectorId)

          assert.equal(
            await countBlobs(doomedBlobId),
            1,
            "a blob another live connection still binds must NOT be deleted"
          )
          const survivorBindings = await postgresQuery<{
            connector_id: string
          }>("SELECT connector_id FROM blob_bindings WHERE blob_id = $1", [
            doomedBlobId,
          ])
          assert.deepEqual(
            survivorBindings.rows.map(row => row.connector_id),
            [survivingConnectorId],
            "the surviving connection keeps its binding; only the deleted connector's binding is removed"
          )
        } finally {
          await closePostgresStorage()
          closeDb()
        }
      }
    )
  })
  /**
   * Why superseded blobs are NOT deleted at the point of supersession.
   *
   * The obvious "never create junk" move — delete the old blob in the same
   * transaction that writes the new one — is unsafe here, and this fixture
   * pins the two schema facts that make it unsafe so a future attempt fails
   * loudly instead of silently breaking reads:
   *
   *   1. `record_changes` retains `data.blob_ref.blob_id` for EVERY superseded
   *      revision, and change-history pruning is off by default
   *      (`getChangeHistoryLimit()` reads PDPP_CHANGE_HISTORY_LIMIT, default
   *      0 = unbounded). A `changes_since` reader can therefore still be
   *      handed a superseded revision; `decorateRecordBlobRefs` emits its
   *      `fetch_url` without checking the blob exists, so deleting the bytes
   *      turns that into a URL that 404s.
   *   2. Blob rows are globally content-addressed, so a "superseded" blob may
   *      be byte-identical to one a different live record still uses — the
   *      case the sibling-connection fixture above covers.
   *
   * So reclamation is bound to the points where a reference is genuinely
   * dropped (connection delete, and now per-stream delete), refcount-gated,
   * rather than to supersession. If history pruning is ever made the default
   * or `record_changes` stops carrying blob refs, revisit this.
   */
  test("superseded revisions keep their blob reference in history, so supersession must not delete blobs", async () => {
    const databaseName = `pdpp_superseded_blob_refs_${Date.now().toString(36)}`
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName,
      },
      async url => {
        initDb(":memory:")
        await initPostgresStorage({ backend: "postgres", databaseUrl: url })
        try {
          const connectorId =
            "https://registry.pdpp.test/connectors/superseded_blob_refs"
          const connectorInstanceId = "cin_superseded_blob_refs"
          const blobIds: string[] = []
          for (let revision = 0; revision < 3; revision += 1) {
            blobIds.push(
              // biome-ignore lint/performance/noAwaitInLoops: each revision is one sequential ingest.
              await seedRecordWithBlob({
                bytes: Buffer.alloc(1024, revision),
                connectorId,
                connectorInstanceId,
                recordKey: "att-1",
              })
            )
          }
          assert.equal(
            new Set(blobIds).size,
            3,
            "fixture premise: each changed payload mints a distinct blob"
          )

          assert.equal(
            getChangeHistoryLimit(),
            0,
            "change history is unbounded by default, so superseded revisions stay readable indefinitely"
          )

          const history = await postgresQuery<{ blob_id: string | null }>(
            `SELECT record_json->'blob_ref'->>'blob_id' AS blob_id
               FROM record_changes
              WHERE connector_instance_id = $1
              ORDER BY version`,
            [connectorInstanceId]
          )
          assert.deepEqual(
            history.rows.map(row => row.blob_id),
            blobIds,
            "every superseded revision still names its own blob, including the ones no longer current"
          )

          // The superseded bytes are consequently still present and reachable
          // from history. Deleting them at supersession would leave these
          // revisions pointing at blobs that no longer exist.
          const supersededBlobIds = blobIds.slice(0, -1)
          for (const blobId of supersededBlobIds) {
            assert.equal(
              // biome-ignore lint/performance/noAwaitInLoops: small fixed fixture set.
              await countBlobs(blobId),
              1,
              `superseded blob ${blobId} is retained while history still references it`
            )
          }
        } finally {
          await closePostgresStorage()
          closeDb()
        }
      }
    )
  })
} else {
  test(
    "postgres orphan-blob reclamation (skipped: PDPP_TEST_POSTGRES_URL unset)",
    { skip: true },
    () => {
      /* intentionally empty */
    }
  )
}

/**
 * SQLite arm of the same reclaim. Runs unconditionally — no Postgres needed —
 * because the SQLite per-stream delete had the identical gap and now runs the
 * identical refcount-gated pair (`recordsDeleteDeleteBlobBindingsByStream`
 * then `recordsDeleteDeleteBlobsByStream`). Both halves are asserted here:
 * reclaim the unbound blob, retain the shared one.
 */
test("sqlite per-stream connector delete reclaims orphans but retains shared blobs", async () => {
  initDb(":memory:")
  try {
    const connectorId =
      "https://registry.pdpp.test/connectors/sqlite_orphan_blob"
    const doomedInstanceId = "cin_sqlite_orphan_doomed"
    const sharedBlobId =
      "blob_sha256_1111111111111111111111111111111111111111111111111111111111111111"
    const orphanBlobId =
      "blob_sha256_2222222222222222222222222222222222222222222222222222222222222222"

    const insertBlob = (blobId: string, instanceId: string) => {
      exec(referenceQueries.blobsInsertBlob, [
        blobId,
        connectorId,
        instanceId,
        STREAM,
        "att-1",
        "application/octet-stream",
        16,
        blobId.replace("blob_sha256_", ""),
        Buffer.alloc(16, 1),
      ])
    }
    const insertBinding = (blobId: string, instanceId: string) => {
      exec(referenceQueries.blobsInsertBinding, [
        blobId,
        connectorId,
        instanceId,
        STREAM,
        "att-1",
      ])
    }

    // `orphanBlobId` is bound only by the connection about to be deleted.
    insertBlob(orphanBlobId, doomedInstanceId)
    insertBinding(orphanBlobId, doomedInstanceId)
    // `sharedBlobId` is owned by the doomed connection but ALSO bound by a
    // sibling connection that is not being deleted — the cascade hazard.
    insertBlob(sharedBlobId, doomedInstanceId)
    insertBinding(sharedBlobId, doomedInstanceId)
    insertBinding(sharedBlobId, "cin_sqlite_orphan_survivor")

    exec(referenceQueries.recordsDeleteDeleteBlobBindingsByStream, [
      doomedInstanceId,
      STREAM,
    ])
    exec(referenceQueries.recordsDeleteDeleteBlobsByStream, [
      doomedInstanceId,
      STREAM,
    ])

    assert.ok(
      !getOne(referenceQueries.blobsGetRowById, [orphanBlobId]),
      "the unbound blob is reclaimed rather than leaked"
    )
    assert.ok(
      getOne(referenceQueries.blobsGetRowById, [sharedBlobId]),
      "a blob a sibling connection still binds must survive the delete"
    )
  } finally {
    closeDb()
  }
})
